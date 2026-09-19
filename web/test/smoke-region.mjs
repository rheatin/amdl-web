/**
 * 端到端冒烟：地区覆盖的接口行为 + 模板渲染（不依赖引擎真跑）。
 *
 * ⚠️ 这不是离线单测：探测走**真实网络**（amp-api），所以手动跑，也不放进离线套件
 *    （文件名刻意不带 `.test.`，免得被 `test/*.test.mjs` 之类的 glob 顺手带进去）。
 *
 * 它会自己起一个服务进程，用**临时 DATA_DIR**（于是可以先 /api/setup 建管理员、再带 cookie 访问），
 * 引擎路径指向一个不存在的文件（只验证到建任务为止，不会真的下载）。默认不碰任何线上数据。
 *
 * 用法：
 *   cd web && node test/smoke-region.mjs                      # 本地：验证当前 dist + views
 *   SMOKE_APP_DIR=/app SMOKE_ROOT=/tmp/amdl-smoke node test/smoke-region.mjs   # 容器内：验证部署后的镜像
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGE = process.env.SMOKE_APP_DIR
    ? path.resolve(process.env.SMOKE_APP_DIR)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.SMOKE_ROOT
    ? path.resolve(process.env.SMOKE_ROOT)
    // 默认落系统临时目录：绝不落在仓库里（否则每次冒烟都会留下未跟踪文件）
    : path.join(os.tmpdir(), "amdl-smoke-region");
const PORT = Number(process.env.SMOKE_PORT || 34567);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "music"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "engine"), { recursive: true });
// 引擎配置只用来给「地区/语言」兜底值：storefront=cn
fs.writeFileSync(path.join(ROOT, "engine", "config.yaml"), 'storefront: "cn"\nlanguage: ""\n');

const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: STAGE,
    env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: path.join(ROOT, "data"),
        MUSIC_DIR: path.join(ROOT, "music"),
        ENGINE_DIR: path.join(ROOT, "engine"),
        ENGINE_BIN: path.join(ROOT, "no-such-engine"),   // 不让它真去下载
        LITE_SERVER: "http://127.0.0.1:1",
        SESSION_SECRET: "smoke-test-secret-0123456789abcdef",
        // 与生产一致：目录查询的语言。注意 jp 店 + l=en-US 会返回英文/罗马音标题，
        // 所以这里必须设成生产里的值（.env LANGUAGE=zh-Hans-CN），否则测的不是真实行为。
        LANGUAGE: "zh-Hans-CN",
        WRAPPER_DATA_DIR: path.join(ROOT, "wrapper")
    },
    stdio: ["ignore", "ignore", "inherit"]
});

async function waitUp() {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`${BASE}/healthz`);
            if (r.ok) return await r.json();
        } catch {
            /* not yet */
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("server did not come up");
}

let cookie = "";
async function api(method, url, body) {
    const res = await fetch(`${BASE}${url}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const setC = res.headers.get("set-cookie");
    if (setC) cookie = setC.split(";")[0];
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* html */
    }
    return { status: res.status, json, text };
}

const CN_JP_OK = "https://music.apple.com/cn/song/hanabira/1451567917";          // 日区有（はなびら）
const CN_ONLY_ALBUM = "https://music.apple.com/cn/album/departures-anata-ni-okuru-ai-no-uta/1463200943"; // 日区 404
const CN_ONLY_SONG = "https://music.apple.com/cn/song/departures/1463201068";   // 日区 404，但日区有等价记录

try {
    const health = await waitUp();
    console.log(`server up: storefront=${health.storefront}`);

    const setup = await api("POST", "/api/setup", { username: "smoketest", password: "smoke-test-password" });
    check("首次运行可创建管理员", () => assert.equal(setup.status, 200));

    /* ---------------------------------------------------- /api/codecs 计划 */

    const ok = await api("GET", `/api/codecs?url=${encodeURIComponent(CN_JP_OK)}&region=jp`);
    check("codecs：日区有 → 采用日区（reason=ok）", () => {
        assert.equal(ok.status, 200);
        assert.equal(ok.json.plan.reason, "ok");
        assert.equal(ok.json.plan.changed, true);
        assert.equal(ok.json.plan.fallback, false);
        assert.match(ok.json.plan.effectiveUrl, /music\.apple\.com\/jp\//);
        assert.match(ok.json.title ?? "", /はなびら/);   // 预览里的标题也来自日区（且是日文原名）
    });
    console.log(`      note: ${ok.json.plan.note}`);

    const follow = await api("GET", `/api/codecs?url=${encodeURIComponent(CN_JP_OK)}`);
    check("codecs：不选地区 → 跟随链接、不改写", () => {
        assert.equal(follow.json.plan.reason, "none");
        assert.equal(follow.json.plan.effectiveUrl, CN_JP_OK);
    });

    const same = await api("GET", `/api/codecs?url=${encodeURIComponent(CN_JP_OK)}&region=cn`);
    check("codecs：选的地区与链接一致 → 不改写", () => assert.equal(same.json.plan.reason, "same_region"));

    const fb = await api("GET", `/api/codecs?url=${encodeURIComponent(CN_ONLY_ALBUM)}&region=jp`);
    check("codecs：日区没有 → 回退（fallback=true）", () => {
        assert.equal(fb.json.plan.reason, "not_in_target");
        assert.equal(fb.json.plan.fallback, true);
        assert.equal(fb.json.plan.effectiveUrl, CN_ONLY_ALBUM);
    });
    console.log(`      note: ${fb.json.plan.note}`);

    const am = await api("GET", `/api/codecs?url=${encodeURIComponent(CN_ONLY_SONG)}&region=jp&autoMatch=1`);
    check("codecs：自动匹配 → 换用日区的等价记录", () => {
        assert.equal(am.json.plan.reason, "matched", `实际 reason=${am.json.plan.reason} / ${am.json.plan.note}`);
        assert.ok(am.json.plan.match, "缺少 match 信息");
        assert.match(am.json.plan.effectiveUrl, /music\.apple\.com\/jp\//);
    });
    if (am.json.plan.match) {
        const m = am.json.plan.match;
        console.log(`      匹配到 ${m.id} "${m.name}" — ${m.artistName}（${m.albumName}）Δ${m.deltaMs}ms`);
    }
    console.log(`      note: ${am.json.plan.note}`);

    /* ------------------------------------------------------ POST /api/jobs */

    const bad = await api("POST", "/api/jobs", { url: CN_JP_OK, codec: "alac", region: "jpy" });
    check("建任务：非法地区码 → 400", () => assert.equal(bad.status, 400));

    const j1 = await api("POST", "/api/jobs", { url: CN_JP_OK, codec: "alac", region: "jp" });
    check("建任务：URL 被改写成日区，并记录计划", () => {
        assert.equal(j1.status, 201);
        assert.match(j1.json.job.url, /music\.apple\.com\/jp\//);
        assert.equal(j1.json.job.region.requested, "jp");
        assert.equal(j1.json.job.region.reason, "ok");
        assert.equal(j1.json.job.region.originalUrl, CN_JP_OK);
    });

    const j2 = await api("POST", "/api/jobs", { url: CN_ONLY_ALBUM, codec: "alac", region: "jp" });
    check("建任务：目标区没有 → 回退并如实记录（不改 URL）", () => {
        assert.equal(j2.status, 201);
        assert.equal(j2.json.job.url, CN_ONLY_ALBUM);
        assert.equal(j2.json.job.region.fallback, true);
        assert.equal(j2.json.job.region.effective, "cn");
    });

    const retry = await api("POST", `/api/jobs/${j1.json.job.id}/retry`);
    check("重试：沿用原任务记录的地区与实际 URL（不重新探测）", () => {
        assert.equal(retry.status, 201);
        assert.equal(retry.json.job.url, j1.json.job.url);
        assert.equal(retry.json.job.region.reason, "ok");
        assert.equal(retry.json.job.region.note, j1.json.job.region.note);
    });

    /* ----------------------------------------------------------- 模板渲染 */

    const home = await api("GET", "/");
    check("首页渲染成功（含回退提示与地区选择器）", () => {
        assert.equal(home.status, 200);
        assert.match(home.text, /元数据地区/);
        assert.match(home.text, /地区已回退/);
        assert.match(home.text, /id="job-region"/);
        assert.match(home.text, /<option value="jp">日本 jp<\/option>/);
    });

    const jobs = await api("GET", `/jobs?job=${j1.json.job.id}`);
    check("任务页渲染成功：显示请求/实际地区与说明", () => {
        assert.equal(jobs.status, 200);
        assert.match(jobs.text, /元数据地区/);
        assert.match(jobs.text, /请求 <code>jp<\/code>/);
        assert.match(jobs.text, /目标区生效/);
    });

    const jobs2 = await api("GET", `/jobs?job=${j2.json.job.id}`);
    check("任务页渲染成功：回退任务显示「已回退」", () => {
        assert.equal(jobs2.status, 200);
        assert.match(jobs2.text, /目标区没有 → 已回退/);
        assert.match(jobs2.text, /元数据地区/);
        assert.match(jobs2.text, /请求 <code>jp<\/code>/);
    });

    /* 控制台首行的措辞（用户看得到的那句）—— 直接看任务记录里的 log，避免读流 */
    const allJobs = await api("GET", "/api/jobs");
    check("任务控制台首行措辞正确（不是「基线 =」）", () => {
        assert.equal(allJobs.status, 200);
        const saved = (allJobs.json.jobs || []).find((j) => j.id === j1.json.job.id);
        assert.ok(saved && Array.isArray(saved.log), "任务记录里没有 log");
        assert.ok(
            saved.log.some((l) => /引擎配置以 .*config\.yaml 为准 · 本次无临时覆盖/.test(l)),
            `log 首行不符合预期：${JSON.stringify(saved.log.slice(0, 3))}`
        );
        assert.ok(!saved.log.some((l) => l.includes("基线")), "仍在输出「基线」");
    });

    /* ------------------------------------------------------ 搜索页：选商店 */

    const searchJp = await api("GET", `/search?q=${encodeURIComponent("Hanabira")}&region=jp`);
    const searchCn = await api("GET", `/search?q=${encodeURIComponent("Hanabira")}&region=cn`);
    check("搜索页：能选商店，且选项与概览页一致", () => {
        assert.equal(searchJp.status, 200);
        assert.match(searchJp.text, /id="search-region"/);
        assert.match(searchJp.text, /<option value="jp" selected>日本 jp<\/option>/);
        assert.match(searchJp.text, /搜索范围：<b>日本 jp<\/b>/);
    });
    check("搜索页：日区搜到的是日文原名，大陆区是罗马音（证明真的按商店查）", () => {
        assert.match(searchJp.text, /はなびら/, "日区结果里没有 はなびら");
        assert.match(searchCn.text, /Hanabira/, "大陆区结果里没有 Hanabira");
    });
    check("搜索页：结果里的下载按钮带着当前商店", () => {
        assert.match(searchJp.text, /data-region="jp"/);
    });

    const searchDefault = await api("GET", `/search?q=${encodeURIComponent("Hanabira")}`);
    check("搜索页：不选商店时用配置里的商店（cn），并提示可切换", () => {
        assert.equal(searchDefault.status, 200);
        assert.match(searchDefault.text, /搜索范围：<b>中国大陆 cn<\/b>/);
        assert.match(searchDefault.text, /换商店可以搜到该区的元数据写法/);
    });

    const searchBad = await api("GET", `/search?q=x&region=jpy`);
    check("搜索页：非法地区码按「未指定」处理，不报错", () => {
        assert.equal(searchBad.status, 200);
        assert.match(searchBad.text, /搜索范围：<b>中国大陆 cn<\/b>/);
    });
} catch (err) {
    failed++;
    console.log(`FAIL  冒烟脚本异常：${err.stack || err}`);
} finally {
    child.kill("SIGKILL");
}

console.log(failed === 0 ? "\nSMOKE PASSED" : `\n${failed} SMOKE CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
