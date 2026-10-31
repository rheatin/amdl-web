/**
 * 音质明细的**服务端呈现层**。
 *
 * 为什么要单独一个模块：`presentFormat` 原先只写在 index.ts 的 /api/codecs 里，
 * 结果搜索页那条路径直接把 `AudioFormat` 塞给 EJS，而视图取的是 `f.detail` / `f.label` ——
 * 这两个字段只由本函数产出。于是搜索页的芯片渲染成一片空白（上线后实测到）。
 * 现在两条路径共用同一个函数，字段名不再有第二种可能。
 *
 * 呈现层放在服务端而非视图/前端，是因为「24-bit/96 kHz 该怎么写」只应该有一处实现：
 * 这个项目已经因为重复实现踩过同类坑（见 urlinfo.ts 的注释）。
 */
import { codecLabel, describeFormat, formatLabel, type AudioFormat } from "./format.js";

export type AudioFormatView = {
    codec: string;
    /** 编码族的中文名，例如「ALAC 无损」 */
    kind: string;
    bitDepth: number | null;
    sampleRate: number | null;
    channels: number | null;
    bitrateKbps: number | null;
    lossless: boolean;
    hiRes: boolean;
    atmos: boolean;
    /** 明细串，例如 `24-bit/96 kHz · 2ch` —— 搜索结果芯片与解析面板都用它 */
    detail: string;
    /** 完整标签，例如 `ALAC 无损 · 24-bit/96 kHz · Hi-Res` —— 按钮 tooltip 用 */
    label: string;
};

export function presentFormat(f: AudioFormat): AudioFormatView {
    return {
        codec: f.codec,
        kind: codecLabel(f.codec),
        bitDepth: f.bitDepth ?? null,
        sampleRate: f.sampleRate ?? null,
        channels: f.channels ?? null,
        bitrateKbps: f.bitrateKbps ?? null,
        lossless: f.lossless,
        hiRes: f.hiRes,
        atmos: f.atmos,
        detail: describeFormat(f),
        label: formatLabel(f)
    };
}

/**
 * 只凭目录的 `audioTraits` 造出音质视图 —— **不打 wrapper-lite**。
 *
 * ## 为什么搜索页用它
 *
 * 精确的位深/采样率只写在 master playlist 的变体行里，而 wrapper 那份和目录
 * `extendedAssetUrls.enhancedHls` 那份**是两个不同的清单文件**：实测 Ado
 * 《好きでいて》(6806106478) wrapper 给到 `alac 96000-24`，目录只给 `48000-24`。
 * 所以"具体多少 kHz"这件事必须以 wrapper 为准 —— 解析预览和下载前就用它。
 *
 * 但"有没有 Hi-Res / 有没有 Atmos"这一层，目录的 `audioTraits` 判得**准**
 * （同一首歌的 traits 里就有 `hi-res-lossless`，与 wrapper 的 96k 一致）。
 *
 * 代价对比很悬殊：traits 是搜索结果**自带**的字段，零请求；
 * 而逐条问 wrapper 实测 26 条结果要 **23.9 秒**（每次约 920ms，与并发无关）。
 * 列表页要的是"这张卡是什么档"，不是"这张卡第 3 轨的采样率" ——
 * 所以列表用 traits，明细留给解析预览。
 *
 * ## 为什么这里造的是 AudioFormat 而不是直接造视图
 *
 * 标签与描述串的实现只能有一处（`formatLabel` / `describeFormat`）。
 * 从 AudioFormat 走一遍 presentFormat，芯片文字就和 wrapper 路径**同一套措辞**，
 * 不会出现"同一个意思两种写法"。
 */
export function formatsFromTraits(traits: string[] | undefined): AudioFormat[] {
    const list = (traits ?? []).map(String);
    const has = (needle: string) => list.some((t) => t.includes(needle));
    const out: AudioFormat[] = [];

    if (has("lossless")) {
        /* traits 说不出具体档位，所以 sampleRate/bitDepth 留空 ——
           describeFormat 会把明细渲染成空串，芯片只显示「Hi-Res Lossless / Lossless」，
           这是诚实的：我们确实只知道"有这一档"。 */
        out.push({ codec: "alac", lossless: true, hiRes: has("hi-res-lossless"), atmos: false });
    }
    if (has("atmos") || has("spatial")) {
        out.push({ codec: "atmos", lossless: false, hiRes: false, atmos: true });
    }
    /* Apple 始终提供有损兜底 */
    out.push({ codec: "aac", lossless: false, hiRes: false, atmos: false });

    return out;
}
