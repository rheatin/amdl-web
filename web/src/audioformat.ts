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
