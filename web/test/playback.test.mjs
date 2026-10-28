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
const {
    cachePath, isCached, keyForPath, transcodeToCache, cacheStats,
    patchTotalSamples, flacSampleRate
} = await import(new URL("playcache.js", DIST).href);

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

    /* ------------------------------- 4. 首次播放：边转边发（不等整首） */
    const key = keyForPath(alacFile);
    fs.rmSync(cachePath(key), { force: true }); // 回到"没缓存"的冷状态

    await check("冷启动：首个数据块远早于整首转完", async () => {
        const t0 = performance.now();
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`, {
            headers: { cookie: cookieHeader }
        });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-type"), "audio/flac");

        const reader = r.body.getReader();
        const first = await reader.read();
        const firstMs = performance.now() - t0;
        assert.ok(!first.done, "必须能读到数据");
        assert.equal(Buffer.from(first.value).subarray(0, 4).toString("latin1"), "fLaC");

        /*
         * 冷启动整首转完约 1.8 s（4 分钟曲目），首个块只要几百毫秒。
         * 这里给 1.2 s 的宽松上限：测的是"没有等整首"，不是精确性能。
         */
        assert.ok(firstMs < 1200, `首个数据块用了 ${firstMs.toFixed(0)}ms，像是等整首转完了`);

        /* 把剩下的读干净，确保缓存文件写完整 */
        for (;;) {
            const { done } = await reader.read();
            if (done) break;
        }
    });

    await check("流式播完后缓存文件就绪", () => {
        assert.equal(isCached(key), true, "边转边发的同时必须把缓存落好");
        assert.equal(probeCodec(cachePath(key)), "flac");
    });

    await check("流式输出的 FLAC 头带总样本数（否则浏览器没有时长）", () => {
        /*
         * ffmpeg 往管道写时 total_samples 是 0，会导致进度条 0:00、无法 seek。
         * 这条断言直接读 STREAMINFO 的 36 位字段 —— 只测"能播"是发现不了它的。
         */
        const head = Buffer.alloc(32);
        const fd = fs.openSync(cachePath(key), "r");
        fs.readSync(fd, head, 0, 32, 0);
        fs.closeSync(fd);
        assert.equal(head.subarray(0, 4).toString("latin1"), "fLaC");
        const total = ((head[21] & 0x0f) * 0x100000000) + head.readUInt32BE(22);
        assert.ok(total > 0, "total_samples 仍是 0 —— 浏览器会拿不到时长");
        /* 采样率必须还在：补总样本数只该动那 5 个字节的低位 */
        assert.equal(flacSampleRate(head), 44100, "采样率被改坏了");
    });

    await check("patchTotalSamples 不动采样率/声道/位深", () => {
        const buf = Buffer.from([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0x22,
            0x12, 0x00, 0x12, 0x00, 0, 0, 0, 0, 0, 0,
            0x0b, 0xb8, 0x03, 0x70, 0, 0, 0, 0, 0]);
        const before = buf.subarray(18, 21).toString("hex");
        assert.equal(patchTotalSamples(buf, 0x0b025c0f6), true);
        assert.equal(buf.subarray(18, 21).toString("hex"), before, "前 3 字节不该被碰");
        const total = ((buf[21] & 0x0f) * 0x100000000) + buf.readUInt32BE(22);
        assert.equal(total, 0x0b025c0f6);
    });

    /* ------------------------------ 5. 命中缓存：完整 Range 支持（可 seek） */
    await check("热缓存 → 200 且声明 Accept-Ranges", async () => {
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`, {
            headers: { cookie: cookieHeader }
        });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-type"), "audio/flac");
        assert.equal(r.headers.get("accept-ranges"), "bytes", "拖动进度条靠 Range");
        const buf = Buffer.from(await r.arrayBuffer());
        assert.equal(buf.subarray(0, 4).toString("latin1"), "fLaC");
    });

    await check("Range 请求返回 206 与正确长度", async () => {
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`, {
            headers: { cookie: cookieHeader, range: "bytes=0-99" }
        });
        assert.equal(r.status, 206);
        assert.match(r.headers.get("content-range") ?? "", /^bytes 0-99\//);
        assert.equal(Buffer.from(await r.arrayBuffer()).length, 100);
    });

    await check("浏览器首载的 bytes=0- 也走流式（不因带 Range 就变慢）", async () => {
        fs.rmSync(cachePath(key), { force: true });
        const t0 = performance.now();
        const r = await fetch(`${base}/api/play?path=${encodeURIComponent(alacFile)}`, {
            headers: { cookie: cookieHeader, range: "bytes=0-" }
        });
        const reader = r.body.getReader();
        const first = await reader.read();
        const firstMs = performance.now() - t0;
        assert.ok(!first.done);
        assert.ok(firstMs < 1200, `bytes=0- 用了 ${firstMs.toFixed(0)}ms，说明被当成 seek 处理了`);
        for (;;) {
            const { done } = await reader.read();
            if (done) break;
        }
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
