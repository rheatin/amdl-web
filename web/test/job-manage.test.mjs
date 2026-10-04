/**
 * amdl-web — 任务管理（取消 / 删除 / 清空已结束）端到端测试
 *
 * 为什么要有这个测试：这几条路径全是**破坏性**的（删记录、杀进程），
 * 而它们最容易错的地方恰恰是「谁还能被删」——活任务必须挡住，不然
 * execute() 收尾时会把记录又写回来一半。这里就把边界逐条钉死。
 *
 * 运行：npm run build && node test/job-manage.test.mjs
 *
 * 刻意**不入队**：本文件只碰队列的簿记（pending / status），
 * 一 spawn 引擎就得依赖真实二进制，测试就没法在任意机器上跑了。
 * 因此「运行中」的任务直接由 store 造出来 —— 取消路径关心的正是
 * 「状态是 running 时该发生什么」，而不是引擎真的在不在。
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

/* --------------------------------------------------------------- 环境与依赖就位 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-web-jobs-"));
process.env.DATA_DIR = tmp;
process.env.PORT = "0";
process.env.ADMIN_USER = "";
process.env.ADMIN_PASSWORD = "";
process.env.LITE_SERVER = "http://wrapper.invalid:12340";
process.env.MUSIC_DIR = path.join(tmp, "music");
/* 由测试自己 listen：见 src/index.ts 末尾的说明 */
process.env.AMDL_NO_LISTEN = "1";
fs.mkdirSync(process.env.MUSIC_DIR, { recursive: true });

const { app } = await import(new URL("index.js", DIST).href);
const { store } = await import(new URL("store.js", DIST).href);
const { queueDepth } = await import(new URL("queue.js", DIST).href);
const { issueSession, hashPassword } = await import(new URL("auth.js", DIST).href);

let cookieHeader = "";
const { hash, salt } = hashPassword("job-manage-test");
const user = store.addUser("job-tester", hash, salt);
issueSession({ cookie: (_name, value) => (cookieHeader = `amdl_session=${value}`) }, user);

const server = app.listen(0);
const port = await new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server.address().port));
    server.once("error", reject);
});
const base = `http://127.0.0.1:${port}`;

const call = (method, p, body) =>
    fetch(base + p, {
        method,
        headers: {
            cookie: cookieHeader,
            ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

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

try {
    /* ------------------------------------------------- 造四个不同状态的任务 */
    const queued = store.addJob(user.id, "https://music.apple.com/cn/album/1", "alac");
    const running = store.addJob(user.id, "https://music.apple.com/cn/album/2", "alac");
    store.updateJob(running.id, { status: "running", startedAt: Date.now() });
    const done = store.addJob(user.id, "https://music.apple.com/cn/album/3", "alac");
    store.updateJob(done.id, { status: "done", finishedAt: Date.now() });
    const failedJob = store.addJob(user.id, "https://music.apple.com/cn/album/4", "alac");
    store.updateJob(failedJob.id, { status: "failed", finishedAt: Date.now(), error: "boom" });

    assert.equal(queueDepth().pending, 0, "测试期间不应该有任务真的排队");
    assert.equal(queueDepth().running, 0, "测试期间不应该有任务真的在跑");

    /* ------------------------------------------------------------ 1. 取消 */
    await check("取消排队中的任务 → 200 且状态变 cancelled", async () => {
        const res = await call("POST", `/api/jobs/${queued.id}/cancel`);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.job.status, "cancelled");
        assert.match(body.job.error, /还没开始跑/);
    });

    await check("取消运行中的任务 → 200 且状态变 cancelled", async () => {
        const res = await call("POST", `/api/jobs/${running.id}/cancel`);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.job.status, "cancelled");
        assert.match(body.job.error, /引擎已终止/);
    });

    await check("取消已结束的任务 → 409（没什么可取消的）", async () => {
        const res = await call("POST", `/api/jobs/${done.id}/cancel`);
        assert.equal(res.status, 409);
    });

    await check("取消不存在的任务 → 404", async () => {
        const res = await call("POST", "/api/jobs/9999/cancel");
        assert.equal(res.status, 404);
    });

    /* ------------------------------------------- 2. 页面上的按钮按状态分岔 */
    await check("列表：活任务给「取消」、已结束的给「删除」、并有「清空已结束」", async () => {
        const html = await (await call("GET", "/jobs")).text();
        assert.ok(!html.includes(`data-cancel="${running.id}"`), "已取消的任务不该再给取消按钮");
        assert.ok(html.includes(`data-del="${done.id}"`), "已结束的任务应该有删除按钮");
        assert.ok(html.includes("data-clear-finished"), "有已结束任务时应该出现「清空已结束」");
    });

    await check("列表：还在排队的任务给的是「取消」而不是「删除」", async () => {
        const fresh = store.addJob(user.id, "https://music.apple.com/cn/album/5", "alac");
        const html = await (await call("GET", "/jobs")).text();
        assert.ok(html.includes(`data-cancel="${fresh.id}"`));
        assert.ok(!html.includes(`data-del="${fresh.id}"`));
    });

    await check("详情区：已结束的任务给「重试 + 删除」，且没有「取消任务」", async () => {
        const html = await (await call("GET", `/jobs?job=${failedJob.id}`)).text();
        assert.ok(html.includes(`data-retry="${failedJob.id}"`));
        assert.ok(html.includes(`data-del="${failedJob.id}"`));
        assert.ok(!html.includes(">取消任务<"), "终态详情不该出现取消按钮");
    });

    /* -------------------------------------------------------------- 3. 删除 */
    const cfgDir = path.join(tmp, "jobcfg", String(done.id));
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "config.yaml"), "lite-server: http://x\n");

    await check("删除已结束的任务 → 200 且记录真的没了", async () => {
        const res = await call("DELETE", `/api/jobs/${done.id}`);
        assert.equal(res.status, 200);
        assert.equal(store.job(done.id), undefined, "记录应该从 store 里消失，而不是被标成 failed");
    });

    await check("删任务会顺手清掉它的私有 config 目录", () => {
        assert.equal(fs.existsSync(cfgDir), false);
    });

    await check("删掉已取消的任务 → 200", async () => {
        const res = await call("DELETE", `/api/jobs/${queued.id}`);
        assert.equal(res.status, 200);
    });

    await check("删活任务被挡住（不该出现「删了又回来」）", async () => {
        const fresh = store.addJob(user.id, "https://music.apple.com/cn/album/6", "alac");
        const res = await call("DELETE", `/api/jobs/${fresh.id}`);
        assert.equal(res.status, 409);
        assert.notEqual(store.job(fresh.id), undefined, "被拒绝的删除不能动记录");
    });

    await check("删除不存在的任务 → 404", async () => {
        const res = await call("DELETE", "/api/jobs/9999");
        assert.equal(res.status, 404);
    });

    /* -------------------------------------------------- 4. 清空已结束 */
    await check("清空已结束：终态全清、活任务留下", async () => {
        const before = store.jobs().length;
        const res = await call("POST", "/api/jobs/clear-finished", {});
        const body = await res.json();
        const left = store.jobs();
        assert.equal(res.status, 200);
        assert.equal(body.removed, before - left.length);
        assert.ok(body.removed >= 2, `至少该清掉 cancelled/failed 那几条，实际 ${body.removed}`);
        for (const j of left) {
            assert.ok(j.status === "queued" || j.status === "running", `活任务不该被清掉：#${j.id} ${j.status}`);
        }
    });

    await check("清空后页面不再显示「清空已结束」", async () => {
        const html = await (await call("GET", "/jobs")).text();
        assert.ok(!html.includes("data-clear-finished"));
    });
} finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
    process.exit(failed === 0 ? 0 : 1);
}
