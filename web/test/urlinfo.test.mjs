/**
 * amdl-web — Apple Music 分享链接解析测试
 * 运行：node test/urlinfo.test.mjs
 */
import assert from "node:assert/strict";
import { parseAppleMusicUrl } from "../dist/urlinfo.js";

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
console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
