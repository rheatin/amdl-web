import assert from "node:assert/strict";
import fs from "node:fs";

import { createProgressTracker, progressFromLog, withPct } from "../dist/progress.js";

/*
 * 进度解析的 fixture 全部取自**真实任务日志**（NAS 上一个 12 首专辑、
 * 最终 11/12 的 partial 任务）。这是刻意的：引擎的输出格式是外部契约，
 * 用手编的字符串测就等于在测"我以为的格式"，而这个解析器的全部价值
 * 就在于它认得真实格式 —— 包括那些用 \r 原地刷新的行。
 *
 * 若上游改了输出格式，这里会红；那时该改的是 parser，不是 fixture。
 */
const REAL_LOG = fs.readFileSync(new URL("../test/fixtures/job-14.log", import.meta.url), "utf8").split("\n");

let failures = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
};

check("真实多曲日志：认出 12 首总量", () => {
    const p = progressFromLog(REAL_LOG);
    assert.equal(p.total, 12, `total 应为 12，实际 ${p.total}`);
});

check("真实 partial 日志（11/12，1 首失败）：不谎报 100%", () => {
    /* 这份日志结尾是 `Error detected, exiting...` —— 任务在第 12 首**真的中断了**。
       所以 92% 是诚实读数；早先的测试期望 100%，那等于让界面在任务失败时显示满条，
       而用户检查时会发现少了一首。 */
    const p = progressFromLog(REAL_LOG);
    assert.equal(p.done, 11);
    assert.equal(p.total, 12);
    assert.equal(p.pct, 92);
    assert.equal(p.finished, true, "应已读到收尾汇总");
    assert.equal(p.errors, 1);
});

check("真实成功日志（12/12）：靠汇总行到达 100%", () => {
    /* 关键：这份成功日志里一条 `Decrypted` 都没有（引擎只在部分路径上打它），
       所以只数 Decrypted 会永远停在 91% —— 必须认收尾汇总行。 */
    const p = progressFromLog(fs.readFileSync(new URL("../test/fixtures/job-15.log", import.meta.url), "utf8").split("\n"));
    assert.equal(p.done, 12);
    assert.equal(p.total, 12);
    assert.equal(p.pct, 100);
    assert.equal(p.errors, 0);
});

check("真实多曲日志：抓到最后正在下的曲目标题", () => {
    const p = progressFromLog(REAL_LOG);
    assert.ok(p.title.length > 0, "标题不应为空");
    assert.ok(!/^\d+\.\s*Track/.test(p.title), `标题不该是 Track 行：${p.title}`);
});

check("单曲日志：总量为 1 且 Decrypting 直接就是整体进度", () => {
    /* 单曲任务没有 Track N of M 行（引擎只打 Queue 1 of 1），
       所以必须退回 total=1 并用 Decrypting 的百分比当整体进度。 */
    const { feed } = createProgressTracker();
    const p0 = feed("");
    assert.equal(p0.total, 1);
    const p = feed("\rDecrypting...  43%  (5.1/34 MB, 414 kB/s)");
    assert.equal(p.currentPct, 43);
    assert.equal(withPct(p).pct, 43, "单曲时整体 == 当前曲");
});

check("单曲日志：跑满后 Decrypted 把它推到 100%", () => {
    const { feed } = createProgressTracker();
    let p = feed("Decrypting... 100%  (34/34 MB, 2.9 MB/s) [10s]");
    assert.equal(p.elapsed, "10s", `elapsed 应为 10s，实际 "${p.elapsed}"`);
    p = feed("Decrypted");
    assert.equal(p.done, 1);
    assert.equal(withPct(p).pct, 100);
});

check("整体百分比按曲目数摊分，不是简单相加", () => {
    /* 12 首里完成 6 首、第 7 首下到 50% → (6 + 0.5)/12 = 54% */
    const { feed } = createProgressTracker();
    feed("Track 1 of 12: songs");
    for (let i = 0; i < 6; i++) {
        feed("Decrypting... 100%  (12/12 MB)");
        feed("Decrypted");
    }
    feed("Track 7 of 12: songs");
    const p = feed("Decrypting...  50%  (6/12 MB)");
    assert.equal(withPct(p).pct, 54);
});

check("\\r 原地刷新：取同一行里最靠后的那个百分比", () => {
    /* 引擎会在一行里塞多次刷新，取第一个会永远显示 0%。 */
    const p = progressFromLog(["\rDecrypting...   0%  (1 kB/12 MB)\r\rDecrypting...  92%  (11/12 MB)"]);
    assert.equal(p.currentPct, 92, `应取最后一个 92%，实际 ${p.currentPct}`);
});

check("曲目标题不会被空行吃掉", () => {
    const { feed } = createProgressTracker();
    feed("Track 2 of 12: songs");
    feed(""); // 引擎的回车残留会产生空行
    feed("   ");
    const p = feed("02. The Everlasting Guilty Crown");
    assert.equal(p.title, "02. The Everlasting Guilty Crown");
});

check("规格行被识别，但不会被误当成标题", () => {
    const { feed } = createProgressTracker();
    feed("Track 1 of 3: songs");
    feed("01. 原罪の灯");
    const p = feed("16-bit / 44100 Hz");
    assert.equal(p.title, "01. 原罪の灯", "规格行不该覆盖标题");
    assert.equal(p.spec, "16-bit / 44100 Hz");
});

check("Done 计数不会超过 total", () => {
    const { feed } = createProgressTracker();
    feed("Track 1 of 1: songs");
    for (let i = 0; i < 5; i++) feed("Decrypted");
    const p = feed("");
    assert.equal(p.done, 1, "单曲只应记 1 首完成");
});

check("空日志不炸", () => {
    const p = progressFromLog([]);
    assert.equal(p.done, 0);
    assert.equal(p.total, 1);
    assert.equal(p.pct, 0);
});

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
