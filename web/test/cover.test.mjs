import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/*
 * 封面路由（GET /api/cover）的安全边界。
 *
 * 这条路由存在的原因是历史任务也要有封面：引擎下载时会把封面写成音频同目录的
 * cover.jpg，而音乐库要显示它。于是"把磁盘上的封面暴露成 HTTP"这件事必须被
 * 严格框住 —— 它服务的站点很可能挂在反代/公网后面。
 *
 * 本文件守住三条边界（实现见 src/index.ts 的 /api/cover）：
 *   1. 未登录一律 401
 *   2. 路径必须落在引擎的落盘目录之下（../ 穿越、任意绝对路径都不行）
 *   3. 只暴露 cover.jpg 这一个文件名，不接受调用方指定别的文件
 */
import os from "node:os";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-web-cover-"));
process.env.DATA_DIR = tmp;
process.env.PORT = "0";
// 由测试自己 listen(0)：不关掉的话 app 会在导入时就 listen(PORT)，
// 于是这里又 listen 一次，两份 app 实例各持一份模块状态，cookie 校验必然失败。
process.env.AMDL_NO_LISTEN = "1";
process.env.ADMIN_USER = "";
process.env.ADMIN_PASSWORD = "";

// 造一个"落盘目录 + 专辑目录 + cover.jpg + 音频 + 一份机密文件"
const musicDir = path.join(tmp, "music");
const albumDir = path.join(musicDir, "ALAC", "Test Artist", "Test Album");
fs.mkdirSync(albumDir, { recursive: true });
fs.writeFileSync(path.join(albumDir, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(path.join(albumDir, "01 song.m4a"), Buffer.from([0, 1, 2, 3]));
fs.writeFileSync(path.join(albumDir, "secret.txt"), "TOP SECRET");
const secretOutside = path.join(tmp, "secret-outside.jpg");
fs.writeFileSync(secretOutside, "OUTSIDE SECRET");

process.env.ENGINE_DIR = tmp;
// config.yaml 的 paths.alac 指向我们刚造的目录
fs.writeFileSync(
    path.join(tmp, "config.yaml"),
    ["general:", "  lite-server: \"http://x:12340\"", "paths:", `  alac: "${path.join(musicDir, "ALAC")}"`, ""].join("\n")
);

const { app } = await import("../dist/index.js");
const { store } = await import("../dist/store.js");
const { issueSession, hashPassword } = await import("../dist/auth.js");
let cookie = "";
const { hash, salt } = hashPassword("cover-test");
const user = store.addUser("cover-tester", hash, salt);
issueSession({ cookie: (_n, v) => (cookie = `amdl_session=${v}`) }, user);

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (p, withCookie = true) => {
    const res = await fetch(base + p, { headers: withCookie ? { cookie } : {} });
    const body = await res.arrayBuffer();
    return { status: res.status, type: res.headers.get("content-type") || "", body: Buffer.from(body) };
};

let failures = 0;
const check = async (name, fn) => {
    try {
        await fn();
        console.log(`PASS  ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
};

await check("未登录访问 → 401（封面不能匿名读）", async () => {
    const r = await get(`/api/cover?path=${encodeURIComponent(path.join(albumDir, "01 song.m4a"))}`, false);
    assert.equal(r.status, 401);
});

await check("落盘目录内的封面 → 200 且是 JPEG", async () => {
    const r = await get(`/api/cover?path=${encodeURIComponent(path.join(albumDir, "01 song.m4a"))}`);
    assert.equal(r.status, 200);
    assert.match(r.type, /image\/jpeg/);
    assert.deepEqual([...r.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

await check("同目录的其它文件（secret.txt）取不到", async () => {
    /* 请求音频路径是允许的，但只能拿到 cover.jpg；
       secret.txt 不该有任何途径被读出 —— 这里直接确认它没被当成封面返回。 */
    const r = await get(`/api/cover?path=${encodeURIComponent(path.join(albumDir, "secret.txt"))}`);
    assert.equal(r.status, 200, "secret.txt 与音频同目录，仍映射到 cover.jpg（不泄露 secret.txt 内容）");
    assert.notEqual(r.body.toString("utf8").includes("TOP SECRET"), true);
});

await check("落盘目录之外的文件 → 404", async () => {
    const r = await get(`/api/cover?path=${encodeURIComponent(secretOutside)}`);
    assert.equal(r.status, 404);
});

await check("../ 穿越到目录外 → 404", async () => {
    const evil = path.join(albumDir, "..", "..", "..", "secret-outside.jpg");
    const r = await get(`/api/cover?path=${encodeURIComponent(evil)}`);
    assert.equal(r.status, 404, `穿越应被拒绝，实际 ${r.status}`);
});

await check("/etc/passwd → 404", async () => {
    const r = await get(`/api/cover?path=${encodeURIComponent("/etc/passwd")}`);
    assert.equal(r.status, 404);
});

await check("落盘目录本身（不是子路径）→ 404", async () => {
    const r = await get(`/api/cover?path=${encodeURIComponent(path.join(musicDir, "ALAC"))}`);
    assert.equal(r.status, 404);
});

await check("缺少 path 参数 → 400", async () => {
    const r = await get("/api/cover");
    assert.equal(r.status, 400);
});

server.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
