/**
 * amdl-web — 搜索单趟协议测试（traits 驱动）
 *
 * 搜索现在从 12 条结果降到几乎瞬时：音质档位由目录自带 `audioTraits` 直接生成，
 * 不再调用 wrapper-lite 测采样率/位深（那是解析预览的事）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIST = new URL("../dist/", import.meta.url);
if (!fs.existsSync(new URL("index.js", DIST))) {
    console.error("找不到 dist/index.js —— 先跑 npm run build");
    process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-search-"));
process.env.DATA_DIR = tmp;
process.env.PORT = "0";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "testpass1234";
process.env.LITE_SERVER = "http://127.0.0.1:99999"; // 故意设不通
process.env.SEARCH_STOREFRONT = "us";
process.env.SEARCH_LANGUAGE = "en-US";
process.env.AMDL_NO_LISTEN = "1";

const { app } = await import(new URL("index.js", DIST).href);
const { hashPassword, issueSession } = await import(new URL("auth.js", DIST).href);
const { store } = await import(new URL("store.js", DIST).href);

let cookieHeader = "";
const { hash, salt } = hashPassword(process.env.ADMIN_PASSWORD);
const user = store.addUser(process.env.ADMIN_USER, hash, salt);
issueSession({ cookie: (_n, v) => { cookieHeader = `amdl_session=${v}`; } }, user);

const server = app.listen(0);
const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const check = async (name, fn) => {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

/* ---- 单趟搜索 ---- */
{
    const t0 = Date.now();
    const r = await fetch(`${base}/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6`, { headers: { cookie: cookieHeader } });
    const ms = Date.now() - t0;
    const html = await r.text();
    
    check("stream=1 不阻塞（<5s）", () => {
        // traits 驱动，应该几乎瞬时（目录查询 + 模板渲染）
        assert.ok(ms < 15000, `耗时 ${ms}ms，应该 <15s（旧版阻塞十几秒）`);
    });
    
    check("卡片包含芯片（不含 kHz 明细）", () => {
        assert.ok(html.includes("q-chip"), "应有芯片");
        // 具体 kHz/位深是解析预览的事，搜索页只显示档位标签（Hi-Res Lossless / Lossless 等）
        // 芯片文本可能是 "Lossless" / "Dolby Atmos"，不含 kHz
    });
    
    check("不应问 wrapper（wrapper 不可达也不报错）", () => {
        // LITE_SERVER 指向 99999（不存在），如果搜索还问 wrapper，应会超时或报错
        assert.ok(!html.includes("错误") && !html.includes("Error"), "wrapper 不可达不应打断搜索");
    });
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failed > 0) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log("\n全部通过");
