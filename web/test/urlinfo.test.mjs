/**
 * amdl-web — Apple Music 分享链接解析测试
 * 运行：node test/urlinfo.test.mjs
 */
import assert from "node:assert/strict";
import { parseAppleMusicUrl, normalizeRegion, swapRegion } from "../dist/urlinfo.js";

const cases = [
    { url: "https://music.apple.com/cn/song/%E5%AE%89%E9%9D%99%E4%BA%86/648276085", kind: "song", id: "648276085", sf: "cn" },
    { url: "https://music.apple.com/cn/album/abc/1234567?i=648276085", kind: "song", id: "648276085", sf: "cn" },
    { url: "https://music.apple.com/cn/album/abc/1234567", kind: "album", id: "1234567", sf: "cn" },
    { url: "https://music.apple.com/us/artist/YOASOBI/160847", kind: "artist", id: "160847", sf: "us" },
    { url: "https://music.apple.com/cn/playlist/x/pl.u-Ympg5s39LRqp", kind: "playlist", id: "pl.u-Ympg5s39LRqp", sf: "cn" },
    { url: "https://classical.music.apple.com/cn/album/abc/1234567", kind: "album", id: "1234567", sf: "cn" },
    { url: "https://example.com/cn/song/x/1", kind: "unknown", id: "", sf: undefined },
    { url: "not a url", kind: "unknown", id: "", sf: undefined }
];

let failed = 0;
for (const c of cases) {
    const got = parseAppleMusicUrl(c.url);
    const ok = got.kind === c.kind && got.id === c.id && got.storefront === c.sf;
    if (!ok) failed++;
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${got.kind}/${got.id || "-"}/${got.storefront || "-"}  ` +
        `(want ${c.kind}/${c.id || "-"}/${c.sf || "-"})  ${c.url.slice(0, 55)}`
    );
}
/* ---------------------------------------------- 地区改写（任务级元数据地区） */

console.log("");
const regionCases = [
    // 常规：换掉地区段
    {
        url: "https://music.apple.com/cn/song/%E5%AE%89%E9%9D%99%E4%BA%86/648276085",
        region: "jp",
        want: "https://music.apple.com/jp/song/%E5%AE%89%E9%9D%99%E4%BA%86/648276085"
    },
    // 专辑链接里的 ?i= 指向具体曲目，必须原样保留（引擎靠它只下这一首）
    {
        url: "https://music.apple.com/cn/album/departures/1463200943?i=1463201068",
        region: "jp",
        want: "https://music.apple.com/jp/album/departures/1463200943?i=1463201068"
    },
    // 没有地区段：插到最前面
    {
        url: "https://music.apple.com/album/x/123",
        region: "jp",
        want: "https://music.apple.com/jp/album/x/123"
    },
    // classical 子域也要认
    {
        url: "https://classical.music.apple.com/cn/album/x/123",
        region: "jp",
        want: "https://classical.music.apple.com/jp/album/x/123"
    },
    // 播放列表 id（pl.*）不受影响
    {
        url: "https://music.apple.com/cn/playlist/x/pl.u-Ympg5s39LRqp",
        region: "jp",
        want: "https://music.apple.com/jp/playlist/x/pl.u-Ympg5s39LRqp"
    },
    // 大写地区码也能换
    {
        url: "https://music.apple.com/US/album/x/123",
        region: "JP",
        want: "https://music.apple.com/jp/album/x/123"
    },
    // 不该改写的：非 Apple 域名 / 非法地区码 / 空路径 / 非法 URL
    { url: "https://example.com/cn/song/x/1", region: "jp", want: null },
    { url: "https://music.apple.com/cn/song/x/1", region: "jpy", want: null },
    { url: "https://music.apple.com/cn/song/x/1", region: "", want: null },
    { url: "https://music.apple.com/", region: "jp", want: null },
    { url: "not a url", region: "jp", want: null }
];

for (const c of regionCases) {
    const got = swapRegion(c.url, c.region);
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  swapRegion -> ${got === null ? "null" : got.slice(0, 62)}${ok ? "" : `\n      want ${c.want}`}`);
}

for (const [input, want] of [["JP", "jp"], [" jp ", "jp"], ["jpy", null], ["", null], [undefined, null], [42, null]]) {
    const got = normalizeRegion(input);
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  normalizeRegion(${JSON.stringify(input)}) -> ${JSON.stringify(got)}`);
}

// 改写后的链接必须仍能被解析器认得（两个函数是一对）
{
    const swapped = swapRegion("https://music.apple.com/cn/album/x/1463200943?i=1463201068", "jp");
    const link = parseAppleMusicUrl(swapped);
    const ok = link.kind === "song" && link.id === "1463201068" && link.storefront === "jp";
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  改写后仍可解析：${link.kind}/${link.id}/${link.storefront}`);
}

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);