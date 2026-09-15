/**
 * amdl-web — 「元数据地区」计划解析测试
 * 运行：node test/region.test.mjs
 *
 * 全部离线：探测依赖是注入的假实现（真实实现用 amp-api，见 index.ts 的 regionDeps）。
 */
import assert from "node:assert/strict";
import { buildMatchQueries, pickEquivalent, resolveRegionPlan, MATCH_TOLERANCE_MS } from "../dist/region.js";

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
async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
}

/* ------------------------------------------------------- 假依赖 */

const JP = "https://music.apple.com/jp/album/x/1537785429?i=1537785429";
const CN_SONG = "https://music.apple.com/cn/song/hanabira/1451567917";

function fakeDeps(opts = {}) {
    const calls = [];
    return {
        calls,
        deps: {
            async track(kind, id, region) {
                calls.push(`track:${kind}:${id}:${region}`);
                if (region === "jp") {
                    if (opts.targetThrows) throw new Error(opts.targetThrows);
                    return opts.target ?? null;
                }
                if (opts.srcThrows) throw new Error(opts.srcThrows);
                return opts.src ?? null;
            },
            async search(term, region) {
                calls.push(`search:${term}:${region}`);
                if (opts.searchThrows) throw new Error(opts.searchThrows);
                if (typeof opts.searchBy === "function") return opts.searchBy(term) ?? [];
                return opts.candidates ?? [];
            }
        }
    };
}

/* ------------------------------------------------------- pickEquivalent */

check("匹配：艺人一致（去空白）+ 时长在容差内 → 采用", () => {
    const src = { name: "x", artistName: "タイナカ サチ", durationMs: 274412 };
    const got = pickEquivalent(src, [
        { id: "1", name: "n", artistName: "タイナカサチ", albumName: "a", url: JP, durationMs: 274100 }
    ]);
    assert.equal(got?.id, "1");
});

check("匹配：时长差 1001ms 超出容差 → 不采用", () => {
    const src = { name: "x", artistName: "A", durationMs: 100000 };
    const got = pickEquivalent(src, [
        { id: "1", name: "n", artistName: "A", albumName: "a", url: JP, durationMs: 100000 + MATCH_TOLERANCE_MS + 1 }
    ]);
    assert.equal(got, null);
});

check("匹配：艺人不一致（同名翻唱）→ 不采用", () => {
    const src = { name: "x", artistName: "EGOIST", durationMs: 255587 };
    const got = pickEquivalent(src, [
        { id: "1", name: "n", artistName: "あかの", albumName: "a", url: JP, durationMs: 255587 }
    ]);
    assert.equal(got, null);
});

check("匹配：缺时长的候选项一律不考虑", () => {
    const src = { name: "x", artistName: "A", durationMs: 1000 };
    assert.equal(pickEquivalent(src, [{ id: "1", name: "n", artistName: "A", albumName: "a", url: JP }]), null);
    assert.equal(pickEquivalent({ name: "x", artistName: "A" }, [
        { id: "1", name: "n", artistName: "A", albumName: "a", url: JP, durationMs: 1000 }
    ]), null);
});

check("匹配：多个候选取时长最接近的", () => {
    const src = { name: "x", artistName: "A", durationMs: 100000 };
    const got = pickEquivalent(src, [
        { id: "far", name: "n", artistName: "A", albumName: "a", url: JP, durationMs: 100900 },
        { id: "near", name: "n", artistName: "A", albumName: "a", url: JP, durationMs: 100050 }
    ]);
    assert.equal(got?.id, "near");
});

/* ------------------------------------------------- 搜索词（由精确到宽泛） */

check("搜索词：完整曲名 → 首词 → 只要艺人（去重、跳过过短的）", () => {
    assert.deepEqual(
        buildMatchQueries({ name: "Departures - Anata Ni Okuru Ai No Uta", artistName: "EGOIST" }),
        ["EGOIST Departures - Anata Ni Okuru Ai No Uta", "EGOIST Departures", "EGOIST"]
    );
    // 单token曲名：首词与完整曲名是同一个，去重后只剩两个
    assert.deepEqual(buildMatchQueries({ name: "はなびら", artistName: "back number" }), [
        "back number はなびら",
        "back number"
    ]);
    assert.deepEqual(buildMatchQueries({ name: "", artistName: "A" }), []);     // 单字母艺人太短，不搜
    assert.deepEqual(buildMatchQueries({ name: "x", artistName: "" }), []);
    assert.deepEqual(buildMatchQueries({ name: "x", artistName: "A" }), ["A x"]); // 组合够长就搜
});

await checkAsync("搜索词兜底：精确词搜不到时缩成「艺人 + 首词」再搜", async () => {
    const hit = {
        id: "1537443279",
        name: "Departures 〜あなたにおくるアイの歌〜",
        artistName: "EGOIST",
        albumName: "ETBE",
        url: JP,
        durationMs: 255013
    };
    const { deps, calls } = fakeDeps({
        target: null,
        src: { name: "Departures - Anata Ni Okuru Ai No Uta", artistName: "EGOIST", durationMs: 255587 },
        searchBy: (term) => (term === "EGOIST Departures" ? [hit] : [])
    });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/departures/1463201068", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "matched");
    assert.equal(p.match?.id, "1537443279");
    assert.deepEqual(calls.slice(2), [
        "search:EGOIST Departures - Anata Ni Okuru Ai No Uta:jp",
        "search:EGOIST Departures:jp"
    ]);
});

await checkAsync("搜索词全落空：如实说明搜了几种、几条", async () => {
    const { deps, calls } = fakeDeps({
        target: null,
        src: { name: "Departures - Anata Ni Okuru Ai No Uta", artistName: "EGOIST", durationMs: 255587 },
        searchBy: () => []
    });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/departures/1463201068", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "not_in_target");
    assert.match(p.note, /3 种搜索词都没搜到/);
    assert.equal(calls.filter((c) => c.startsWith("search:")).length, 3);
});

await checkAsync("艺人/曲名信息不足时不去搜（也不谎报成搜索失败）", async () => {
    const { deps, calls } = fakeDeps({ target: null, src: { name: "", artistName: "", durationMs: 1000 } });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/x/1", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "not_in_target");
    assert.match(p.note, /信息不足/);
    assert.equal(calls.filter((c) => c.startsWith("search:")).length, 0);
});

/* ------------------------------------------------- 计划的各条分支 */

await checkAsync("没选地区：不改写、不探测、跟随链接", async () => {
    const { deps, calls } = fakeDeps();
    const p = await resolveRegionPlan(CN_SONG, "", {}, deps);
    assert.equal(p.reason, "none");
    assert.equal(p.effectiveUrl, CN_SONG);
    assert.equal(p.changed, false);
    assert.equal(p.fallback, false);
    assert.deepEqual(calls, []);
    assert.match(p.note, /跟随链接/);
});

await checkAsync("选的地区与链接一致：不改写、不探测", async () => {
    const { deps, calls } = fakeDeps();
    const p = await resolveRegionPlan(CN_SONG, "cn", {}, deps);
    assert.equal(p.reason, "same_region");
    assert.equal(p.effectiveUrl, CN_SONG);
    assert.deepEqual(calls, []);
});

await checkAsync("目标区有这条记录：改写 URL 并采用目标区", async () => {
    const { deps, calls } = fakeDeps({ target: { name: "はなびら", artistName: "back number", durationMs: 300000 } });
    const p = await resolveRegionPlan(CN_SONG, "jp", {}, deps);
    assert.equal(p.reason, "ok");
    assert.equal(p.changed, true);
    assert.equal(p.fallback, false);
    assert.equal(p.effective, "jp");
    assert.match(p.effectiveUrl, /^https:\/\/music\.apple\.com\/jp\//);
    assert.match(p.effectiveUrl, /\?i=1451567917|\/1451567917$/);   // id 与 query 保留
    assert.deepEqual(calls, ["track:song:1451567917:jp"]);
    assert.match(p.note, /はなびら/);
});

await checkAsync("目标区没有（404）：回退到原链接，并给出可见提示", async () => {
    const { deps } = fakeDeps({ target: null });
    const p = await resolveRegionPlan(CN_SONG, "jp", {}, deps);
    assert.equal(p.reason, "not_in_target");
    assert.equal(p.fallback, true);
    assert.equal(p.changed, false);
    assert.equal(p.effectiveUrl, CN_SONG);
    assert.equal(p.effective, "cn");
    assert.match(p.note, /没有这条记录/);
    assert.match(p.note, /回退/);
});

await checkAsync("探测抛错（查不动）与「没有」必须区分", async () => {
    const { deps } = fakeDeps({ targetThrows: "socket hang up" });
    const p = await resolveRegionPlan(CN_SONG, "jp", {}, deps);
    assert.equal(p.reason, "probe_failed");
    assert.equal(p.fallback, true);
    assert.equal(p.effectiveUrl, CN_SONG);
    assert.match(p.note, /查询失败/);
    assert.match(p.note, /socket hang up/);
    assert.doesNotMatch(p.note, /目录里没有/);
});

await checkAsync("自动匹配：艺人+时长一致 → 换用目标区的另一条记录", async () => {
    const { deps, calls } = fakeDeps({
        target: null,
        src: { name: "Departures - Anata Ni Okuru Ai No Uta", artistName: "EGOIST", durationMs: 255587 },
        candidates: [
            { id: "1537443279", name: "Departures 〜あなたにおくるアイの歌〜", artistName: "EGOIST", albumName: "ETBE", url: JP, durationMs: 255013 }
        ]
    });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/departures/1463201068", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "matched");
    assert.equal(p.effectiveUrl, JP);
    assert.equal(p.fallback, false);
    assert.equal(p.match?.id, "1537443279");
    assert.equal(p.match?.deltaMs, 574);
    assert.deepEqual(calls, [
        "track:song:1463201068:jp",
        "track:song:1463201068:cn",
        "search:EGOIST Departures - Anata Ni Okuru Ai No Uta:jp"
    ]);
});

await checkAsync("自动匹配：同名翻唱（艺人不同）→ 不换，回退", async () => {
    const { deps } = fakeDeps({
        target: null,
        src: { name: "Homura", artistName: "LiSA", durationMs: 274412 },
        candidates: [
            { id: "999", name: "Homura", artistName: "あかの", albumName: "cover", url: JP, durationMs: 274400 }
        ]
    });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/homura/1531847485", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "not_in_target");
    assert.equal(p.fallback, true);
    assert.equal(p.effectiveUrl, "https://music.apple.com/cn/song/homura/1531847485");
    assert.match(p.note, /艺人都不一致|翻唱/);
});

await checkAsync("自动匹配：艺人一致但时长对不上 → 不换，回退", async () => {
    const { deps } = fakeDeps({
        target: null,
        src: { name: "Homura", artistName: "LiSA", durationMs: 274412 },
        candidates: [
            { id: "999", name: "Homura (TV size)", artistName: "LiSA", albumName: "x", url: JP, durationMs: 95333 }
        ]
    });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/homura/1531847485", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "not_in_target");
    assert.match(p.note, /时长对不上/);
});

await checkAsync("自动匹配：目标区搜索失败 → 回退（不猜）", async () => {
    const { deps } = fakeDeps({
        target: null,
        src: { name: "x", artistName: "A", durationMs: 1000 },
        searchThrows: "429 too many requests"
    });
    const p = await resolveRegionPlan("https://music.apple.com/cn/song/x/1", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "not_in_target");
    assert.equal(p.fallback, true);
    assert.match(p.note, /搜索失败/);
});

await checkAsync("整张专辑不做自动匹配（换记录会改变任务规模）", async () => {
    const { deps, calls } = fakeDeps({ target: null, src: { name: "x", artistName: "A", durationMs: 1000 } });
    const p = await resolveRegionPlan("https://music.apple.com/cn/album/x/111", "jp", { autoMatch: true }, deps);
    assert.equal(p.reason, "not_in_target");
    assert.equal(p.fallback, true);
    assert.equal(p.effectiveUrl, "https://music.apple.com/cn/album/x/111");
    assert.match(p.note, /只对单曲生效/);
    assert.deepEqual(calls, ["track:album:111:jp"]);
});

await checkAsync("播放列表/艺人不做预检：按目标区直接跑并说明", async () => {
    const { deps, calls } = fakeDeps();
    const p = await resolveRegionPlan("https://music.apple.com/cn/playlist/x/pl.u-Ympg5s39LRqp", "jp", {}, deps);
    assert.equal(p.reason, "unprobed");
    assert.equal(p.changed, true);
    assert.equal(p.fallback, false);
    assert.match(p.effectiveUrl, /^https:\/\/music\.apple\.com\/jp\/playlist/);
    assert.deepEqual(calls, []);
    assert.match(p.note, /不做预检/);
});

await checkAsync("非 Apple 链接：不改写，明确说明", async () => {
    const { deps } = fakeDeps();
    const p = await resolveRegionPlan("https://example.com/cn/song/x/1", "jp", {}, deps);
    assert.equal(p.reason, "rewrite_failed");
    assert.equal(p.changed, false);
});

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
