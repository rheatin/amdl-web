/**
 * amdl-web — ripper 适配器的解析逻辑单元测试（无需 Apple 凭据、无需容器）
 *
 * 验证的是最容易被引擎输出格式变化搞坏的一段：`--json` 汇总行的提取。
 * 运行：node test/parser.test.mjs   （需先 npm run build）
 */
import assert from "node:assert/strict";
import { engineArgs, parseSummary, parseTracks } from "../dist/ripper.js";

const summary = JSON.stringify([
    { path: "/downloads/ALAC/A/01 - S.m4a", artist: "A", artist_id: "1", album: "Alb", song: "S" }
]);

const cases = [
    { name: "array as last line", lines: ["Downloading 1/3", "[1/3] ok", summary], want: 1 },
    { name: "array followed by text", lines: ["Downloading", summary, "Done."], want: 1 },
    { name: "array mid-tail", lines: [summary, "x", "y"], want: 1 },
    { name: "bracket log lines only", lines: ["[1/3] downloading", "[2/3] downloading"], want: 0 },
    { name: "empty array", lines: ["[]"], want: 0 },
    { name: "malformed line then summary", lines: ["[1/3] not json", summary], want: 1 },
    { name: "truncated json", lines: ['[{"path": "/x"'], want: 0 },
    { name: "two arrays: last wins", lines: ["[]", summary], want: 1 }
];

let failed = 0;
for (const c of cases) {
    const got = parseTracks(c.lines);
    const ok = got.length === c.want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(28)} -> ${got.length} track(s), want ${c.want}`);
    if (ok && got.length > 0) {
        assert.equal(got[0].artist, "A");
        assert.equal(got[0].album, "Alb");
        assert.equal(got[0].song, "S");
        assert.match(got[0].path, /\.m4a$/);
    }
}

const a = engineArgs("https://music.apple.com/us/album/x/1", "atmos");
assert.ok(a.includes("--atmos") && a.includes("--json") && a.includes("--lite-server"));
assert.ok(!engineArgs("https://music.apple.com/us/album/x/1", "alac").includes("--atmos"));
assert.ok(engineArgs("https://music.apple.com/us/album/x/1", "aac").includes("--aac"));
console.log("PASS  engineArgs flags (alac/atmos/aac + --json + --lite-server)");

// 有曲目失败时引擎**不会**打印 --json 汇总，这行统计是唯一的成败依据（真实输出见下）
const REAL_SUMMARY = "=======  [✔ ] Completed: 6/7  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======";
assert.deepEqual(
    parseSummary(["[amdl-web] 基线 = config.yaml（/engine/config.yaml）", REAL_SUMMARY, "Error detected, exiting..."]),
    { completed: 6, total: 7, warnings: 0, errors: 1 }
);
assert.equal(parseSummary(["Decrypted", "Track #1: 2752 packets"]), undefined);
assert.equal(parseSummary([]), undefined);
assert.deepEqual(
    parseSummary([REAL_SUMMARY.replace("Errors: 1", "Errors: 12").replace("Completed: 6/7", "Completed: 0/7")]),
    { completed: 0, total: 7, warnings: 0, errors: 12 }
);
console.log("PASS  parseSummary（含真实日志行 / 缺失 / 全失败）");

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
