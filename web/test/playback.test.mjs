/**
 * 播放链路测试：ALAC → FLAC 缓存 + /api/play 的授权边界。
 *
 * 这两件事都值得钉死：
 *
 *  1. **转码必须真的产出 FLAC**。浏览器放不了 ALAC（Chrome:
 *     `MSE audio/mp4; codecs="alac"` → false），所以"转成功"不能只看
 *     ffmpeg 退出码为 0 —— 要 ffprobe 确认编码真的是 flac，否则页面上
 *     会得到一个"能下载但放不出声"的文件。
 *  2. /api/play 不能变成任意文件读取。它接受 path 参数，如果不做
 *     库内成员校验，传 /etc/shadow 也能读出来。这里把这条边界测死。
 *
 * 运行：npm run build && node test/playback.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIST = new URL("../dist/", import.meta.url);
if (!fs.existsSync(new URL("index.js", DIST))) {
    console.error("找不到 dist/index.js —— 先跑 npm run build");
    process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-web-play-"));
process.env.DATA_DIR = tmp;
process.env.PORT = "0";
process.env.ADMIN_USER = "";
process.env.ADMIN_PASSWORD = "";
process.env.LITE_SERVER = "http://wrapper.invalid:12340";
process.env.MUSIC_DIR = path.join(tmp, "music");
process.env.AMDL_NO_LISTEN = "1";
fs.mkdirSync(process.env.MUSIC_DIR, { recursive: true });

const { app } = await import(new URL("index.js", DIST).href);
const { store } = await import(new URL("store.js", DIST).href);
const { issueSession, hashPassword } = await import(new URL("auth.js", DIST).href);
const { cachePath, isCached, keyForPath, transcodeToCache, cacheStats } = await import(
    new URL("playcache.js", DIST).href
);

/* 没有 ffmpeg 的机器上不该"静默通过" —— 那样等于没测 */
function hasFfmpeg() {
    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}
if (!hasFfmpeg()) {
    console.error("需要 ffmpeg 才能跑这个测试");
    process.exit(2);
}

let cookieHeader = "";
const { hash, salt } = hashPassword("playback-test");
const user = store.addUser("play-tester", hash, salt);
issueSession({ cookie: (_n, v) => (cookieHeader = `amdl_session=${v}`) }, user);

const server = app.listen(0);
const port = await new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server.address().port));
    server.once("error", reject);
});
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const check = async (name, fn) => {
    try {
        await fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
};

/** 造一个 1 秒的 ALAC 文件（约几十 KB，测试跑得动）。 */
function makeAlac(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("ffmpeg", [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:a", "alac",
        file
    ]);
}

function probeCodec(file) {
    const out = execFileSync("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_name",
        "-of", "default=nw=1:nk=1",
        file
    ]).toString();
    return out.trim().split(/\r?\n/)[0];
}

try {
    const alacFile = path.join(process.env.MUSIC_DIR, "ALAC", "Test", "01. tone.m4a");
    makeAlac(alacFile);
    assert.equal(probeCodec(alacFile), "alac", "源文件应该是 alac");

    /* 放进库里 —— allTracks 读的就是 job.tracks */
    const job = store.addJob(user.id, "https://music.apple.com/cn/album/1", "alac");
    store.updateJob(job.id, {
        status: "done",
        finishedAt: Date.now(),
        tracks: [{ path: alacFile, artist: "Test", album: "Test", song: "tone" }]
    });

    /* ------------------------------------------------------- 1. 缓存键 */
    await check("缓存键对同一路径稳定、对不同路径不同", () => {
        const a = keyForPath(alacFile);
        assert.equal(a, keyForPath(alacFile));
        assert.notEqual(a, keyForPath(alacFile + "x"));
        assert.match(a, /^[0-9a-f]{40}$/, "键必须是纯十六进制（拿来做文件名）");
    });

    /* ------------------------------------------------ 2. 转码产出真的 FLAC */
    await check("转码产出的是 FLAC，不是只改了扩展名", async () => {
        const key = keyForPath(alacFile);
        assert.equal(isCached(key), false, "转码前不该已在缓存");
        const out = await transcodeToCache(alacFile, key);
        assert.equal(out, cachePath(key));
        assert.ok(fs.statSync(out).size > 0, "缓存文件不能是空的");
        assert.equal(probeCodec(out), "flac", "必须是 flac，浏览器才放得了");
    });

    await check("命中缓存不重复转码（mtime 不变）", async () => {
        const key = keyForPath(alacFile);
        const before = fs.statSync(cachePath(key)).mtimeMs;
        await new Promise((r) => setTimeout(r, 30));
        await transcodeToCache(alacFile, key);
        assert.equal(fs.statSync(cachePath(key)).mtimeMs, before, "已缓存就该直接返回");
    });

    await check("stats 统计到缓存用量", () => {
        const s = cacheStats();
        assert.equal(s.files, 1);
        assert.ok(s.bytes > 0);
        assert.ok(s.limit > 0);
    });

    /* --------------------------------------------------- 3. 授权边界 */
    await check("不在库里的路径 → 404（不能读任意文件）", async () => {
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent("/etc/passwd")}`, {
            headers: { cookie: cookieHeader }
        });
        assert.equal(r.status, 404);
        const body = await r.json();
        assert.match(body.error, /不在音乐库/);
    });

    await check("库里但文件已删 → 404 且说明原因", async () => {
        const ghost = path.join(process.env.MUSIC_DIR, "gone.m4a");
        const j = store.addJob(user.id, "https://music.apple.com/cn/album/2", "alac");
        store.updateJob(j.id, {
            status: "done",
            finishedAt: Date.now(),
            tracks: [{ path: ghost, artist: "T", album: "T", song: "gone" }]
        });
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(ghost)}`, {
            headers: { cookie: cookieHeader }
        });
        assert.equal(r.status, 404);
        assert.match((await r.json()).error, /文件不存在/);
    });

    await check("缺 path 参数 → 400", async () => {
        const r = await fetch(`${base}/api/play`, { headers: { cookie: cookieHeader } });
        assert.equal(r.status, 400);
    });

    await check("未登录 → 401", async () => {
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`);
        assert.equal(r.status, 401);
    });

    /* -------------------------------------- 4. 正常播放：FLAC + Range */
    await check("库内文件 → 200 audio/flac", async () => {
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`, {
            headers: { cookie: cookieHeader }
        });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-type"), "audio/flac");
        assert.equal(r.headers.get("accept-ranges"), "bytes", "拖动进度条靠 Range");
        const buf = Buffer.from(await r.arrayBuffer());
        assert.ok(buf.length > 0);
        assert.equal(buf.subarray(0, 4).toString("latin1"), "fLaC", "响应体必须是 FLAC 流");
    });

    await check("Range 请求返回 206 与正确长度", async () => {
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`, {
            headers: { cookie: cookieHeader, range: "bytes=0-99" }
        });
        assert.equal(r.status, 206);
        assert.match(r.headers.get("content-range") ?? "", /^bytes 0-99\//);
        assert.equal(Buffer.from(await r.arrayBuffer()).length, 100);
    });
} finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failed > 0) {
        console.log(`\n${failed} 项失败`);
        process.exit(1);
    }
    console.log("\n全部通过");
}
