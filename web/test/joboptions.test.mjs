/**
 * amdl-web — 任务级选项测试
 *
 * 回归背景（第一版）：任务的歌词选项曾经总是带内置默认值，会把「设置」页里的同名项
 * 覆盖掉（设置里开了「另存 .lrc」，任务却按默认的关闭执行）。
 *
 * 现行语义（配置分层）：下载语义的唯一出处是引擎 config.yaml；网页只提供
 * 「本次任务的临时覆盖」。因此这里要守住两条：
 *   1. 没显式给出的键**绝不出现在**任务选项里（否则会把 config.yaml 覆盖掉）；
 *   2. 显式给出的非法值被**剔除**（回落 config.yaml），而不是变成内置默认值写进任务。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// store.ts 会在导入时创建 DATA_DIR，指向临时目录避免污染工作区
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-test-"));

const { sanitizeJobOptions, DEFAULT_JOB_OPTIONS } = await import("../dist/store.js");
const { explicitJobOptions } = await import("../dist/jobopts.js");

let failed = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
};

check("未提供任何任务选项时，沿用内置默认（仅用于展示/校验）", () => {
    assert.deepEqual(sanitizeJobOptions(undefined), DEFAULT_JOB_OPTIONS);
});

check("一个键都不给 → 任务选项为空对象（引擎完全按 config.yaml 执行）", () => {
    assert.deepEqual(explicitJobOptions(undefined), {});
    assert.deepEqual(explicitJobOptions({}), {});
});

check("只采纳显式给出的键，其余键不出现", () => {
    const opts = explicitJobOptions({ saveLrcFile: true });
    assert.deepEqual(opts, { saveLrcFile: true });
    assert.ok(!("embedLrc" in opts), "未给出的键不得写进任务配置");
});

check("表单给出的完整一组键全部保留", () => {
    const opts = explicitJobOptions({
        embedLrc: false,
        saveLrcFile: true,
        lrcType: "syllable-lyrics",
        lrcExtra: "translation",
        lrcFormat: "ttml"
    });
    assert.deepEqual(opts, {
        embedLrc: false,
        saveLrcFile: true,
        lrcType: "syllable-lyrics",
        lrcExtra: "translation",
        lrcFormat: "ttml"
    });
});

check("非法值被剔除（回落 config.yaml），不会变成内置默认值", () => {
    const opts = explicitJobOptions({ lrcType: "bogus", lrcFormat: "bogus", embedLrc: "yes" });
    assert.deepEqual(opts, {}, "非法取值一律剔除，交给 config.yaml");
});

check("空字符串 lrcExtra 是合法值（表示不附加），必须保留", () => {
    assert.deepEqual(explicitJobOptions({ lrcExtra: "" }), { lrcExtra: "" });
});

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
