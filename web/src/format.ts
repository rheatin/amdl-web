/**
 * 音质明细：从 HLS master playlist 解出「这首歌到底有什么音质」。
 *
 * 为什么需要这个模块 —— 之前前端只把 Apple 的 `audioTraits` 压成三个标签
 * （ALAC 无损 / Dolby Atmos / AAC 有损，见 ampmusic.mapTraits），
 * **sample rate 与 bit depth 从头到尾被丢掉了**。而这两项恰好是「这首是不是 Hi-Res」
 * 的唯一判据，猜不出来。
 *
 * 权威来源是 master playlist：Apple 对 ALAC 变体**显式声明**位深与采样率（实测）：
 *
 *   #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-48000-24",CHANNELS="2",
 *                 SAMPLE-RATE=48000,BIT-DEPTH=24
 *   #EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1863779,CODECS="alac",
 *                     AUDIO="audio-alac-stereo-48000-24"
 *   #EXT-X-MEDIA:...GROUP-ID="audio-alac-stereo-44100-16",CHANNELS="2",
 *                 SAMPLE-RATE=44100,BIT-DEPTH=16
 *
 * AAC 变体没有这两个属性，但它的 GROUP-ID 自带码率、且用 `HE` 标出 HE-AAC：
 *   audio-stereo-256 / audio-stereo-128 / audio-HE-stereo-64
 *
 * 两条使用纪律（真被坑过或差点被坑过）：
 *   1. **不要拿 ffmpeg 报的位深当真相**。QNAP 自带的是 ffmpeg 0.8.10，对 ALAC 一律
 *      报容器字长 `s32` —— 实测那首 96 kHz 的曲目其实是 24-bit。位深只能信 playlist。
 *   2. SAMPLE-RATE/BIT-DEPTH 缺失时才退回解析 GROUP-ID 尾部的 `-<rate>-<depth>`，
 *      而不是自己编一个默认值。
 *
 * 本模块**不碰网络**：抓取在 ampmusic.ts（wrapper-lite / 目录 extendedAssetUrls），
 * 这样解析逻辑可以纯函数测试（见 test/format.test.mjs）。
 */

/** 音频编码族 —— 界面按它分量级展示，而不是只给一个"有损/无损"。 */
export type AudioCodec = "alac" | "atmos" | "dolby-audio" | "aac" | "he-aac" | "unknown";

/** 一个可用变体的音质明细。 */
export type AudioFormat = {
    codec: AudioCodec;
    /** 采样率（Hz）。AAC/E-AC-3 这类 Apple 不声明时可能缺失。 */
    sampleRate?: number;
    /** 位深（bit）。有损编码没有这个概念，故仅 ALAC 会有。 */
    bitDepth?: number;
    /** 声道数 */
    channels?: number;
    /** 码率（kbps） */
    bitrateKbps?: number;
    /** 无损（bit-perfect） */
    lossless: boolean;
    /** Apple 的 Hi-Res 判据：位深 ≥ 24 且采样率 > 48 kHz */
    hiRes: boolean;
    /** Dolby Atmos（空间音频） */
    atmos: boolean;
};

const CODEC_LABEL: Record<AudioCodec, string> = {
    alac: "ALAC 无损",
    atmos: "Dolby Atmos",
    "dolby-audio": "Dolby Audio",
    aac: "AAC 有损",
    "he-aac": "HE-AAC 有损",
    unknown: "未知编码"
};

/** 展示优先级：无损在前，有损在后；同族按码率/采样率降序排在后面处理。 */
const CODEC_ORDER: Record<AudioCodec, number> = {
    alac: 0,
    atmos: 1,
    "dolby-audio": 2,
    aac: 3,
    "he-aac": 4,
    unknown: 5
};

export function codecLabel(codec: AudioCodec): string {
    return CODEC_LABEL[codec];
}

/**
 * 一行的完整描述，例如 `24-bit/96 kHz · 2ch`、`768 kbps`。
 *
 * 两条刻意的取舍：
 *   * **无损不显示码率**。ALAC 那串数字来自 HLS 的 AVERAGE-BANDWIDTH，是清单的**估算带宽**，
 *     不是解码后的 PCM 码率（实测 24-bit/48 kHz 标成 1864 kbps，而真实 PCM 约 2304 kbps）。
 *     对无损来说位深+采样率已经说全了，标一个估算值只会误导。
 *   * `channels: false` 时省掉声道（紧凑标签用，见 formatLabel）。
 */
export function describeFormat(f: AudioFormat, opts: { channels?: boolean } = {}): string {
    const withChannels = opts.channels !== false;
    const parts: string[] = [];
    if (f.bitDepth !== undefined && f.sampleRate !== undefined) {
        parts.push(`${f.bitDepth}-bit/${kHz(f.sampleRate)}`);
    } else if (f.bitDepth !== undefined) {
        parts.push(`${f.bitDepth}-bit`);
    } else if (f.sampleRate !== undefined) {
        parts.push(kHz(f.sampleRate));
    }
    if (withChannels && f.channels !== undefined) parts.push(`${f.channels}ch`);
    // 有损才给码率：那是它的有效音质指标
    if (!f.lossless && f.bitrateKbps !== undefined) parts.push(`${f.bitrateKbps} kbps`);
    return parts.length > 0 ? parts.join(" · ") : "未标注";
}

/** 采样率显示：48000 → `48 kHz`，44100 → `44.1 kHz`。 */
export function kHz(sampleRate: number): string {
    const k = sampleRate / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

/**
 * 单个变体的标签，例如 `ALAC 无损 · 24-bit/96 kHz · Hi-Res`。
 *
 * 这里**故意不带声道数**：用户问的是采样率/位深/Hi-Res/Atmos，而 `2ch` 是每一条都有的
 * 噪音，挤在徽章里反而淹掉真正的信息。声道要看得细的时候用 `describeFormat`（明细行）。
 * 也不为「无损」再加一个徽章 —— `ALAC 无损` 已经说过了，重复只会稀释 Hi-Res 这种关键标记。
 *
 * 非 Hi-Res 的无损标 `≤48 kHz/16-bit`（「低于 Hi-Res 门槛」）：
 * 早先写的是「CD 音质」，**这是错的** —— 24-bit/48 kHz 并不是 CD（CD 是 16-bit/44.1 kHz），
 * 而实测 Apple 的 `lossless` 档里 24/48 很常见。用一个错误的类比不如直接说门槛。
 * `dolby-audio` 走独立标签，不冒充 Atmos（两者是不同的编码与体验）。
 */
export function formatLabel(f: AudioFormat): string {
    const badges = [codecLabel(f.codec), describeFormat(f, { channels: false })];
    if (f.hiRes) badges.push("Hi-Res");
    else if (f.lossless && f.bitDepth !== undefined && f.sampleRate !== undefined) badges.push("≤48 kHz/16-bit");
    return badges.join(" · ");
}

/**
 * 解析 master playlist 的 `#EXT-X-MEDIA` / `#EXT-X-STREAM-INF`，返回去重后的可用变体。
 *
 * 判定完全基于**实测过的字段组合**，不做"看起来像就当成"的猜测：
 *   * `CODECS="alac"`                  → ALAC 无损（位深/采样率取自同名 GROUP-ID）
 *   * `CODECS="ec-3"` + AUDIO 含 atmos → Dolby Atmos
 *   * `CODECS="ac-3"`                  → Dolby Audio
 *   * `CODECS="mp4a.40.5"`             → HE-AAC
 *   * `CODECS="mp4a.40.2"`             → AAC
 */
export function parseMasterPlaylist(text: string): AudioFormat[] {
    const media = parseMediaTags(text);
    const out: AudioFormat[] = [];

    for (const attrs of parseStreamInfTags(text)) {
        const codecs = (attrs["CODECS"] ?? "").trim().toLowerCase();
        const groupId = (attrs["AUDIO"] ?? "").trim();
        const group = media.get(groupId);
        const bandwidth = num(attrs["AVERAGE-BANDWIDTH"]) ?? num(attrs["BANDWIDTH"]);
        const bitrateKbps = bandwidth !== undefined ? Math.round(bandwidth / 1000) : undefined;
        const channels = group?.channels;

        if (codecs.includes("alac")) {
            // ALAC：位深/采样率优先取 EXT-X-MEDIA 的显式属性，缺失才解析 GROUP-ID 尾部
            const fromGroup = alacFromGroupId(groupId);
            const bitDepth = group?.bitDepth ?? fromGroup?.bitDepth;
            const sampleRate = group?.sampleRate ?? fromGroup?.sampleRate;
            out.push({
                codec: "alac",
                sampleRate,
                bitDepth,
                channels,
                bitrateKbps,
                lossless: true,
                hiRes: isHiRes(bitDepth, sampleRate),
                atmos: false
            });
            continue;
        }

        if (codecs.includes("ec-3") || codecs.includes("eac3")) {
            const atmos = /atmos/i.test(groupId) || /atmos/i.test(attrs["NAME"] ?? "") || /atmos/i.test(codecs);
            out.push({
                codec: atmos ? "atmos" : "dolby-audio",
                sampleRate: group?.sampleRate,
                channels,
                bitrateKbps,
                lossless: false,
                hiRes: false,
                atmos
            });
            continue;
        }

        if (codecs.includes("ac-3")) {
            out.push({
                codec: "dolby-audio",
                sampleRate: group?.sampleRate,
                channels,
                bitrateKbps,
                lossless: false,
                hiRes: false,
                atmos: false
            });
            continue;
        }

        if (codecs.includes("mp4a.40.5")) {
            out.push({
                codec: "he-aac",
                sampleRate: group?.sampleRate,
                channels,
                bitrateKbps,
                lossless: false,
                hiRes: false,
                atmos: false
            });
            continue;
        }

        if (codecs.includes("mp4a")) {
            out.push({
                codec: "aac",
                sampleRate: group?.sampleRate,
                channels,
                bitrateKbps,
                lossless: false,
                hiRes: false,
                atmos: false
            });
            continue;
        }

        out.push({
            codec: "unknown",
            sampleRate: group?.sampleRate,
            channels,
            bitrateKbps,
            lossless: false,
            hiRes: false,
            atmos: false
        });
    }

    // 有些 master playlist 只有 #EXT-X-MEDIA 而没有 STREAM-INF（或反之），
    // 此时至少把 ALAC 组播出来 —— 用户问的位深/采样率就在这条里。
    if (out.length === 0) {
        for (const [groupId, g] of media) {
            if (!/alac/i.test(groupId)) continue;
            out.push({
                codec: "alac",
                sampleRate: g.sampleRate,
                bitDepth: g.bitDepth,
                channels: g.channels,
                lossless: true,
                hiRes: isHiRes(g.bitDepth, g.sampleRate),
                atmos: false
            });
        }
    }

    return sortFormats(dedupeFormats(out));
}

/**
 * Apple 的 Hi-Res 判据：位深 ≥ 24 **且** 采样率 > 48 kHz。
 * 两项都缺时不算 Hi-Res —— 宁可不说，也不要把 16/44.1 说成 Hi-Res
 * （Apple 目录里 `hi-res-lossless` 这个 trait 的口径与此一致）。
 */
export function isHiRes(bitDepth: number | undefined, sampleRate: number | undefined): boolean {
    if (bitDepth === undefined || sampleRate === undefined) return false;
    return bitDepth >= 24 && sampleRate > 48000;
}

/**
 * 从 `audio-alac-stereo-48000-24` 这样的 GROUP-ID 尾部取 `-<采样率>-<位深>`。
 * 实测 GROUP-ID 的形状是 `<前缀>-<采样率>-<位深>`，但前缀长度不固定
 * （`audio-alac-stereo` / 未来可能带别的段），所以**从后往前**认两个数字，
 * 比正则死抠前缀更耐改。
 */
export function alacFromGroupId(groupId: string): { sampleRate?: number; bitDepth?: number } | undefined {
    const parts = groupId.trim().toLowerCase().split("-").filter(Boolean);
    if (parts.length < 2) return undefined;
    const bitDepth = num(parts[parts.length - 1]);
    const sampleRate = num(parts[parts.length - 2]);
    if (bitDepth === undefined || sampleRate === undefined) return undefined;
    // 合理性检查：位深 8-32、采样率 8k-768k；不满足就当没解析出来
    if (bitDepth < 8 || bitDepth > 32) return undefined;
    if (sampleRate < 8000 || sampleRate > 768000) return undefined;
    return { sampleRate, bitDepth };
}

/**
 * 跨曲目合并同一音质（专辑/播放列表用）。
 * 同 codec+位深+采样率+码率视为同一规格，`channels` 取最大值，
 * 这样「这张专辑有 24/96 和 16/44.1 两种」会如实呈现成两行。
 */
export function mergeFormats(formats: AudioFormat[]): AudioFormat[] {
    return sortFormats(dedupeFormats(formats));
}

/** 一行摘要，用于搜索结果那种窄位置，例如 `24-bit/96 kHz Hi-Res · Atmos · AAC 256`。 */
export function summarizeFormats(formats: AudioFormat[], max = 3): string {
    if (formats.length === 0) return "未知";
    const parts = formats.slice(0, max).map((f) => formatLabel(f));
    if (formats.length > max) parts.push(`+${formats.length - max}`);
    return parts.join(" · ");
}

/* ------------------------------------------------------------------ internals */

function dedupeFormats(list: AudioFormat[]): AudioFormat[] {
    const seen = new Map<string, AudioFormat>();
    for (const f of list) {
        const key = [f.codec, f.bitDepth ?? "", f.sampleRate ?? "", f.bitrateKbps ?? ""].join("|");
        const prev = seen.get(key);
        if (!prev) {
            seen.set(key, { ...f });
            continue;
        }
        if (f.channels !== undefined && (prev.channels === undefined || f.channels > prev.channels)) {
            prev.channels = f.channels;
        }
    }
    return [...seen.values()];
}

/** 展示排序：先按编码族（无损在前），再按位深、采样率、码率降序。 */
function sortFormats(list: AudioFormat[]): AudioFormat[] {
    return list.sort((a, b) => {
        const byCodec = (CODEC_ORDER[a.codec] ?? 9) - (CODEC_ORDER[b.codec] ?? 9);
        if (byCodec !== 0) return byCodec;
        const byDepth = (b.bitDepth ?? 0) - (a.bitDepth ?? 0);
        if (byDepth !== 0) return byDepth;
        const byRate = (b.sampleRate ?? 0) - (a.sampleRate ?? 0);
        if (byRate !== 0) return byRate;
        return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
    });
}

type MediaTag = { channels?: number; sampleRate?: number; bitDepth?: number };

/** 收集 `#EXT-X-MEDIA`，按 GROUP-ID 索引本模块用得到的三个属性。 */
function parseMediaTags(text: string): Map<string, MediaTag> {
    const map = new Map<string, MediaTag>();
    for (const attrs of attributeLines(text, "#EXT-X-MEDIA:")) {
        const groupId = (attrs["GROUP-ID"] ?? "").trim();
        if (!groupId) continue;
        const tag: MediaTag = {
            channels: num(attrs["CHANNELS"]),
            sampleRate: num(attrs["SAMPLE-RATE"]),
            bitDepth: num(attrs["BIT-DEPTH"])
        };
        // 同一 GROUP-ID 可能出现多次（不同语言/角色），保留属性更全的那条
        const prev = map.get(groupId);
        if (!prev || scoreOf(tag) > scoreOf(prev)) map.set(groupId, tag);
    }
    return map;
}

function scoreOf(t: MediaTag): number {
    return (t.channels !== undefined ? 1 : 0) + (t.sampleRate !== undefined ? 1 : 0) + (t.bitDepth !== undefined ? 1 : 0);
}

function parseStreamInfTags(text: string): Array<Record<string, string>> {
    return attributeLines(text, "#EXT-X-STREAM-INF:");
}

/**
 * 取出以 `prefix` 开头的行，把行内 `KEY=VALUE` 拆成一个 map。
 * 每行一个属性组 —— HLS 的标签就是「一行一个标签」，不存在一行多组。
 */
function attributeLines(text: string, prefix: string): Array<Record<string, string>> {
    const out: Array<Record<string, string>> = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith(prefix)) continue;
        const attrs = splitAttributes(line.slice(prefix.length));
        if (attrs) out.push(attrs);
    }
    return out;
}

/**
 * 按逗号切分属性，但**引号内的逗号不算分隔符**。
 * 实测 `CODECS="mp4a.40.2"` 很简单，但 `CODECS="ec-3,ac-3"` 这种多值是合法 HLS，
 * 一刀切会把它拆坏成两个假属性。
 */
function splitAttributes(s: string): Record<string, string> | null {
    const map: Record<string, string> = {};
    let key = "";
    let value = "";
    let inQuotes = false;
    let hasValue = false;

    const flush = (): void => {
        if (key.trim()) {
            const k = key.trim();
            map[k.toUpperCase()] = value.trim().replace(/^"|"$/g, "");
        }
        key = "";
        value = "";
        hasValue = false;
    };

    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === '"') {
            inQuotes = !inQuotes;
            value += ch;
            continue;
        }
        if (ch === "=" && !inQuotes && !hasValue) {
            hasValue = true;
            continue;
        }
        if (ch === "," && !inQuotes) {
            flush();
            continue;
        }
        if (hasValue) value += ch;
        else key += ch;
    }
    flush();
    return Object.keys(map).length > 0 ? map : null;
}

function num(v: string | undefined): number | undefined {
    if (v === undefined) return undefined;
    const n = Number(v.replace(/"/g, "").trim());
    return Number.isFinite(n) ? n : undefined;
}
