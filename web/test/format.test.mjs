/**
 * amdl-web — 音质明细解析单元测试（无需 Apple 凭据、无需容器、不联网）
 *
 * 样本是**从真实 master playlist 抄下来的原文**（2026-09 从 wrapper-lite 的
 * /m3u8?adamId=... 取回，见每条注释里的 adamId），不是照着理想格式构造的 ——
 * 这个项目的教训是"构造的样本永远比现实干净"。
 *
 * 运行：node test/format.test.mjs   （需先 npm run build）
 */
import assert from "node:assert/strict";
import {
    parseMasterPlaylist,
    alacFromGroupId,
    isHiRes,
    mergeFormats,
    describeFormat,
    formatLabel,
    summarizeFormats,
    kHz
} from "../dist/format.js";

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

/* --------------------------------------------------------------- 真实样本 */

/** adamId=648276085（S.H.E《安静了》）：ALAC 24-bit/48 kHz + 三档 AAC。 */
const HIRES_ALAC = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-SESSION-DATA:DATA-ID="com.apple.hls.audioAssetMetadata",VALUE="eyJhIjoxfQ=="

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-48000-24",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced",SAMPLE-RATE=48000,BIT-DEPTH=24
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-128",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-HE-stereo-64",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"

#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=264338,BANDWIDTH=268377,CODECS="mp4a.40.2",STABLE-VARIANT-ID="bgewq9yy9",AUDIO="audio-stereo-256"
P1480338270_A648276085_audio_en_gr256_mp4a-40-2.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1863779,BANDWIDTH=1995537,CODECS="alac",STABLE-VARIANT-ID="og4uznrqw",AUDIO="audio-alac-stereo-48000-24"
P1480338270_A648276085_audio_en_gr2304_alac.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=134011,BANDWIDTH=136584,CODECS="mp4a.40.2",STABLE-VARIANT-ID="rusuv79xv",AUDIO="audio-stereo-128"
P1480338270_A648276085_audio_en_gr128_mp4a-40-2.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=70347,BANDWIDTH=74868,CODECS="mp4a.40.5",STABLE-VARIANT-ID="yb722o2lr",AUDIO="audio-HE-stereo-64"
P1480338270_A648276085_audio_en_gr64_mp4a-40-2.m3u8

#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P000000000/s1/e1",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
`;

/** adamId=1537923439（prayer-x）：ALAC 16-bit/44.1 kHz —— 与上面同为 ALAC 但**不是** Hi-Res。 */
const CD_ALAC = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-44100-16",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced",SAMPLE-RATE=44100,BIT-DEPTH=16
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=259876,BANDWIDTH=268506,CODECS="mp4a.40.2",STABLE-VARIANT-ID="gt1d9kf91",AUDIO="audio-stereo-256"
P1481357932_A1537923439_audio_en_gr256_mp4a-40-2.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=932317,BANDWIDTH=1044287,CODECS="alac",STABLE-VARIANT-ID="61yv89592",AUDIO="audio-alac-stereo-44100-16"
P1481357932_A1537923439_audio_en_gr2304_alac.m3u8
`;

/** Atmos 形态：ec-3 + GROUP-ID 里带 atmos（Atmos 没有位深概念，只能给码率）。 */
const ATMOS = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-atmos-2768",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=768000,BANDWIDTH=779000,CODECS="ec-3",AUDIO="audio-atmos-2768"
P0000000000_A000000000_audio_en_gr768_ec-3.m3u8
`;

/** Dolby Audio（ac-3）与 ec-3 但**不是** Atmos：不能混为一谈。 */
const DOLBY_AUDIO = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-dolby-448",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=448000,BANDWIDTH=450000,CODECS="ac-3",AUDIO="audio-dolby-448"
a.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=640000,BANDWIDTH=650000,CODECS="ec-3",AUDIO="audio-dolby-448"
b.m3u8
`;

/** 老清单：只有 GROUP-ID、**没有** SAMPLE-RATE / BIT-DEPTH 属性 —— 必须能退回解析尾部。 */
const NO_EXPLICIT_ATTRS = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-96000-24",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=3712000,BANDWIDTH=3800000,CODECS="alac",AUDIO="audio-alac-stereo-96000-24"
x.m3u8
`;

/* --------------------------------------------------------------- 解析：ALAC */

check("ALAC 24-bit/48 kHz：位深与采样率都来自显式属性", () => {
    const formats = parseMasterPlaylist(HIRES_ALAC);
    const alac = formats.find((f) => f.codec === "alac");
    assert.ok(alac, "应当解析出 ALAC 变体");
    assert.equal(alac.bitDepth, 24);
    assert.equal(alac.sampleRate, 48000);
    assert.equal(alac.channels, 2);
    assert.equal(alac.lossless, true);
});

check("24-bit/48 kHz 不算 Hi-Res（采样率必须 > 48 kHz）", () => {
    const alac = parseMasterPlaylist(HIRES_ALAC).find((f) => f.codec === "alac");
    assert.equal(alac.hiRes, false, "48 kHz 是 CD 级上限，不是 Hi-Res");
});

check("ALAC 16-bit/44.1 kHz 解析正确且不是 Hi-Res", () => {
    const alac = parseMasterPlaylist(CD_ALAC).find((f) => f.codec === "alac");
    assert.equal(alac.bitDepth, 16);
    assert.equal(alac.sampleRate, 44100);
    assert.equal(alac.hiRes, false);
    assert.equal(alac.lossless, true);
});

check("ALAC 24-bit/96 kHz 是 Hi-Res（两个条件都满足）", () => {
    const formats = parseMasterPlaylist(NO_EXPLICIT_ATTRS);
    const alac = formats.find((f) => f.codec === "alac");
    assert.equal(alac.bitDepth, 24);
    assert.equal(alac.sampleRate, 96000);
    assert.equal(alac.hiRes, true, "显式属性缺失时必须能从 GROUP-ID 尾部解析出来");
});

/* --------------------------------------------------------------- 解析：有损 */

check("AAC 三档都解析出来，码率来自 AVERAGE-BANDWIDTH", () => {
    const formats = parseMasterPlaylist(HIRES_ALAC);
    const aac = formats.filter((f) => f.codec === "aac");
    assert.equal(aac.length, 2, "两档 AAC（256 / 128）");
    assert.deepEqual(
        aac.map((f) => f.bitrateKbps).sort((a, b) => b - a),
        [264, 134]
    );
    assert.ok(aac.every((f) => f.lossless === false && f.bitDepth === undefined));
});

check("mp4a.40.5 认成 HE-AAC，不冒充普通 AAC", () => {
    const he = parseMasterPlaylist(HIRES_ALAC).find((f) => f.codec === "he-aac");
    assert.ok(he, "应有 HE-AAC 变体");
    assert.equal(he.bitrateKbps, 70);
});

check("ec-3 + GROUP-ID 含 atmos → Dolby Atmos", () => {
    const atmos = parseMasterPlaylist(ATMOS).find((f) => f.atmos);
    assert.ok(atmos, "应识别出 Atmos");
    assert.equal(atmos.codec, "atmos");
    assert.equal(atmos.bitrateKbps, 768);
    assert.equal(atmos.lossless, false);
    assert.equal(atmos.hiRes, false);
});

check("ac-3 是 Dolby Audio、ec-3 无 atmos 也是 Dolby Audio —— 都不冒充 Atmos", () => {
    const formats = parseMasterPlaylist(DOLBY_AUDIO);
    assert.equal(formats.length, 2);
    assert.ok(formats.every((f) => f.atmos === false), "没有 atmos 标记就不能说 Atmos");
    assert.ok(formats.every((f) => f.codec === "dolby-audio"));
});

/* --------------------------------------------------------------- 排序与去重 */

check("排序：无损在前，有损在后（AAC 族按码率降序，HE-AAC 最后）", () => {
    const codecs = parseMasterPlaylist(HIRES_ALAC).map((f) => f.codec);
    assert.deepEqual(codecs, ["alac", "aac", "aac", "he-aac"], `实际 ${codecs}`);
    const bitrates = parseMasterPlaylist(HIRES_ALAC)
        .filter((f) => f.codec === "aac")
        .map((f) => f.bitrateKbps);
    assert.deepEqual(bitrates, [264, 134], "同族内按码率降序");
});

check("mergeFormats 把同一规格合并、保留最大声道数", () => {
    const merged = mergeFormats([
        { codec: "alac", bitDepth: 24, sampleRate: 96000, channels: 2, lossless: true, hiRes: true, atmos: false },
        { codec: "alac", bitDepth: 24, sampleRate: 96000, channels: 6, lossless: true, hiRes: true, atmos: false },
        { codec: "alac", bitDepth: 16, sampleRate: 44100, channels: 2, lossless: true, hiRes: false, atmos: false }
    ]);
    assert.equal(merged.length, 2, "24/96 与 16/44.1 应合成两行");
    assert.equal(merged[0].channels, 6, "合并后取最大声道数");
    assert.equal(merged[0].sampleRate, 96000);
});

/* --------------------------------------------------------------- 展示串 */

check("kHz：整数不留小数，44100 显示为 44.1", () => {
    assert.equal(kHz(48000), "48 kHz");
    assert.equal(kHz(44100), "44.1 kHz");
    assert.equal(kHz(96000), "96 kHz");
    assert.equal(kHz(88200), "88.2 kHz");
});

check("describeFormat：无损不标码率（那是清单估算带宽），有损才标", () => {
    assert.equal(
        describeFormat({
            codec: "alac", bitDepth: 24, sampleRate: 48000, channels: 2, bitrateKbps: 1864,
            lossless: true, hiRes: false, atmos: false
        }),
        "24-bit/48 kHz · 2ch",
        "无损的 1864 kbps 是 AVERAGE-BANDWIDTH 估算值，不能当 PCM 码率显示"
    );
    assert.equal(
        describeFormat(
            { codec: "alac", bitDepth: 24, sampleRate: 96000, channels: 2, lossless: true, hiRes: true, atmos: false },
            { channels: false }
        ),
        "24-bit/96 kHz"
    );
    assert.equal(
        describeFormat({ codec: "aac", bitrateKbps: 256, channels: 2, lossless: false, hiRes: false, atmos: false }),
        "2ch · 256 kbps"
    );
    assert.equal(
        describeFormat({ codec: "atmos", bitrateKbps: 768, channels: 2, lossless: false, hiRes: false, atmos: true }),
        "2ch · 768 kbps",
        "Atmos 是有损，码率是它的有效指标"
    );
    assert.equal(describeFormat({ codec: "unknown", lossless: false, hiRes: false, atmos: false }), "未标注");
});

check("formatLabel 标出 Hi-Res / 门槛 / Atmos，不夹带声道、不重复「无损」", () => {
    assert.equal(
        formatLabel({ codec: "alac", bitDepth: 24, sampleRate: 96000, channels: 2, lossless: true, hiRes: true, atmos: false }),
        "ALAC 无损 · 24-bit/96 kHz · Hi-Res"
    );
    assert.equal(
        formatLabel({ codec: "alac", bitDepth: 16, sampleRate: 44100, channels: 2, lossless: true, hiRes: false, atmos: false }),
        "ALAC 无损 · 16-bit/44.1 kHz · ≤48 kHz/16-bit"
    );
    // 24-bit/48 kHz 在 Apple 的 lossless 档里很常见，**不能**叫它「CD 音质」（CD 是 16/44.1）
    assert.equal(
        formatLabel({ codec: "alac", bitDepth: 24, sampleRate: 48000, channels: 2, lossless: true, hiRes: false, atmos: false }),
        "ALAC 无损 · 24-bit/48 kHz · ≤48 kHz/16-bit"
    );
    assert.equal(
        formatLabel({ codec: "atmos", bitrateKbps: 768, channels: 2, lossless: false, hiRes: false, atmos: true }),
        "Dolby Atmos · 768 kbps"
    );
});

check("summarizeFormats 截断并给出 +N", () => {
    const formats = parseMasterPlaylist(HIRES_ALAC);
    const s = summarizeFormats(formats, 2);
    assert.ok(s.startsWith("ALAC 无损 · 24-bit/48 kHz"), s);
    assert.ok(s.endsWith("+2"), `应当提示还有 2 项，实际 ${s}`);
});

/* --------------------------------------------------------------- 边界与坏输入 */

check("空文本 / 非 playlist 不抛错，返回空数组", () => {
    assert.deepEqual(parseMasterPlaylist(""), []);
    assert.deepEqual(parseMasterPlaylist("#EXTM3U\n#EXTINF:10,\nseg.ts\n"), []);
    assert.deepEqual(parseMasterPlaylist("not a playlist at all"), []);
});

check("只有 EXT-X-MEDIA 没有 STREAM-INF 时也能报出 ALAC", () => {
    const only = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-192000-24",AUTOSELECT=YES,CHANNELS="2",SAMPLE-RATE=192000,BIT-DEPTH=24
`;
    const formats = parseMasterPlaylist(only);
    assert.equal(formats.length, 1);
    assert.equal(formats[0].bitDepth, 24);
    assert.equal(formats[0].sampleRate, 192000);
    assert.equal(formats[0].hiRes, true);
});

check("引号内的逗号不当作属性分隔符", () => {
    const multi = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-atmos-2768",CHANNELS="2"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=768000,CODECS="ec-3,ac-3",AUDIO="audio-atmos-2768"
a.m3u8
`;
    const formats = parseMasterPlaylist(multi);
    assert.equal(formats.length, 1, `多值 CODECS 不该被拆成两个变体，实际 ${JSON.stringify(formats)}`);
    assert.equal(formats[0].codec, "atmos");
});

check("isHiRes：两项都缺时一律 false（不猜）", () => {
    assert.equal(isHiRes(undefined, undefined), false);
    assert.equal(isHiRes(24, undefined), false);
    assert.equal(isHiRes(undefined, 96000), false);
    assert.equal(isHiRes(16, 192000), false, "16-bit 再高的采样率也不是 Hi-Res");
    assert.equal(isHiRes(24, 48000), false, "48 kHz 不算 Hi-Res");
    assert.equal(isHiRes(24, 48001), true);
});

check("alacFromGroupId：离谱数值当解析失败，不返回垃圾", () => {
    assert.deepEqual(alacFromGroupId("audio-alac-stereo-48000-24"), { sampleRate: 48000, bitDepth: 24 });
    assert.equal(alacFromGroupId("audio-alac-stereo"), undefined);
    assert.equal(alacFromGroupId("audio-stereo-256"), undefined, "256 是码率不是采样率，不能误认");
    assert.equal(alacFromGroupId("audio-44100-99"), undefined, "99 位深不合理");
});

console.log(failed === 0 ? "\nALL PASS  format" : `\n${failed} FAILED  format`);
process.exit(failed === 0 ? 0 : 1);
