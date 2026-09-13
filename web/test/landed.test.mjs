/**
 * amdl-web — 「落盘找回」单元测试（无需 Apple 凭据、无需容器）
 *
 * 场景来自真实故障：一张专辑 7 首里失败了 1 首，引擎于是不打印 --json 汇总，
 * 结果任务显示 0 首、文件权限也停在 0600。这里验证我们能把这次真正写出的文件找回来，
 * 而且不会把同目录里的旧文件、封面、无关文件也算进去。
 *
 * 运行：node test/landed.test.mjs   （需先 npm run build）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLandedTracks, trackFromPath } from "../dist/landed.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-landed-"));
const album = path.join(root, "EGOIST", "Departures - Anata Ni Okuru Ai No Uta");
fs.mkdirSync(album, { recursive: true });

const fresh = path.join(album, "04. Departures - Anata Ni Okuru Ai No Uta (BOOM BOOM SATELLITES Remix).m4a");
fs.writeFileSync(fresh, "new");
const oldTrack = path.join(album, "01. Departures - Anata Ni Okuru Ai No Uta.m4a");
fs.writeFileSync(oldTrack, "old");
const past = new Date(Date.now() - 3_600_000);
fs.utimesSync(oldTrack, past, past);
fs.writeFileSync(path.join(album, "cover.jpg"), "jpg");
fs.writeFileSync(path.join(album, "notes.txt"), "txt");
const nested = path.join(root, "Atmos", "Taylor Swift", "Lover");
fs.mkdirSync(nested, { recursive: true });
fs.writeFileSync(path.join(nested, "02. Cruel Summer.m4a"), "new");

const startedAt = Date.now() - 60_000;

check("只找回本次新写的音频（旧文件、封面、非音频都不算）", () => {
    const found = discoverLandedTracks(startedAt, [root]);
    const paths = found.map((t) => t.path).sort();
    assert.deepEqual(paths, [fresh, path.join(nested, "02. Cruel Summer.m4a")].sort());
});

check("从路径还原 艺术家 / 专辑 / 曲名（去掉曲序前缀）", () => {
    const found = discoverLandedTracks(startedAt, [root]);
    const t = found.find((x) => x.path === fresh);
    assert.equal(t.artist, "EGOIST");
    assert.equal(t.album, "Departures - Anata Ni Okuru Ai No Uta");
    assert.equal(t.song, "Departures - Anata Ni Okuru Ai No Uta (BOOM BOOM SATELLITES Remix)");
});

check("层级不足时宁可留空，也不硬造艺术家名", () => {
    const t = trackFromPath(root, path.join(root, "01. 幸せについて私が知っている5つの方法.m4a"));
    assert.equal(t.artist, "");
    assert.equal(t.album, "");
    assert.equal(t.song, "幸せについて私が知っている5つの方法");
});

check("目录不存在 / 空目录不抛异常", () => {
    assert.deepEqual(discoverLandedTracks(startedAt, [path.join(root, "nope")]), []);
    assert.deepEqual(discoverLandedTracks(startedAt, []), []);
});

check("时间点之后的才算（回溯 1 小时的旧文件不算）", () => {
    const long = discoverLandedTracks(Date.now() - 7_200_000, [root]);
    assert.ok(long.some((t) => t.path === oldTrack), "把起点提前后，旧文件也应被找到");
});

fs.rmSync(root, { recursive: true, force: true });

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
