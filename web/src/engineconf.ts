/**
 * 引擎配置层 —— 读写 <ENGINE_DIR>/config.yaml。
 *
 * ## 为什么是「按键覆盖」而不是解析整个 YAML
 *
 * 引擎的 config.yaml 注释很多（上游自带说明），而本服务只认识其中一部分键。
 * 重写整份文件会丢掉注释与未知键，所以这里是**逐行替换 + 缺失则追加**，
 * 不引入 YAML 依赖，也保证「用户的文件不被我们改写」。
 *
 * ## 为什么全部用「点分路径」
 *
 * 上游在 2025 年把配置从**扁平**结构改成了**嵌套**结构：
 *
 *     旧（本机上原来那份）        新（上游 main）
 *     ------------------------    --------------------------------------
 *     lite-server: ...            general.lite-server: ...
 *     alac-save-folder: ...       paths.alac: ...
 *     embed-lrc: true             metadata.lyrics.embed: true
 *     mv-max: 2160                media.mv.max: 2160
 *
 * 如果本文件里写死 `v["alac-save-folder"]`，那次上游更新就会让 UI 静默失效
 * （配置读不到 → 落盘目录扫描扫空 → 音乐库变空）。所以：
 *
 *   * 解析时把**每个标量都记成完整点分路径**（`paths.alac`），无论它嵌多深；
 *   * 读取一律走 `pickString()` / `pickBool()`，传**候选路径列表**（新路径在前、旧路径在后）。
 *     上游再改键名时，只需往候选表里补一项，而不用改调用点。
 *
 * 事实来源（部署实测）：
 *   * 引擎从**进程工作目录**读 config.yaml（os.ReadFile("config.yaml")），
 *     因此每个任务可以有一份私有配置（见 ripper.ts）；
 *   * config.yaml 是本栈里**下载语义**的唯一出处（质量、歌词、命名、转码、地区、代理）。
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** 引擎从 cwd 读的文件名；example 是兜底（config.yaml 缺失时 bind mount 会变成目录）。 */
const CANDIDATES = ["config.yaml", "config.example.yaml"];

/**
 * 引擎配置里属于凭据的键 —— 展示时必须打码。
 * 用点分路径，且**新旧两套都列上**：这是纯安全网，宁可多打一次码。
 */
export const SECRET_KEYS = [
    "general.media-user-token",
    "general.authorization-token",
    "media-user-token",
    "authorization-token"
];

/**
 * 一组「同一个语义」的候选路径（新 → 旧）。
 * 读取时按顺序找第一个存在的；这就是与上游键名解耦的地方。
 */
export const KEYS = {
    liteServer: ["general.lite-server", "lite-server"],
    exitOnError: ["general.exit-on-error", "exit-on-error"],
    storefront: ["general.storefront", "storefront"],
    language: ["general.language", "language"],
    /** 落盘根目录 —— landed.ts 扫描用（少一个就会导致「音乐库变空」） */
    saveFolders: ["paths.alac", "paths.atmos", "paths.aac", "paths.mv"],
    /** 歌词一族（界面控件预填 + 任务级临时覆盖） */
    lyricsEmbed: ["metadata.lyrics.embed", "embed-lrc"],
    lyricsSaveFile: ["metadata.lyrics.save-file", "save-lrc-file"],
    lyricsType: ["metadata.lyrics.type", "lrc-type"],
    lyricsExtra: ["metadata.lyrics.extra", "lrc-extra"],
    lyricsFormat: ["metadata.lyrics.format", "lrc-format"],
    /** MV 画质与音轨（上游把这组从 `mv-max` / `mv-audio-type` 挪进了 `media.mv.*`） */
    mvMax: ["media.mv.max", "mv-max"],
    mvAudioType: ["media.mv.audio-type", "mv-audio-type"],
    /** 音频质量上限 */
    alacMax: ["media.alac-max", "alac-max"],
    atmosMax: ["media.atmos-max", "atmos-max"],
    aacType: ["media.aac-type", "aac-type"]
} as const;

export type EngineConfig = {
    /** 实际读到的文件路径 */
    file: string;
    /** 原文 */
    text: string;
    /**
     * 解析出的键值。键是**完整点分路径**（`paths.alac`、`metadata.lyrics.embed`）。
     * 同时保留顶层键名（不含点）以便兼容旧配置。
     */
    values: Record<string, string>;
    /** 出现过在这个文件里的键顺序（点分路径形式） */
    keys: string[];
};

/** 读取基础配置：优先 config.yaml，其次 config.example.yaml。 */
export function loadEngineConfig(engineDir: string = config.engineDir): EngineConfig {
    for (const name of CANDIDATES) {
        const file = path.join(engineDir, name);
        try {
            if (!fs.statSync(file).isFile()) continue;
            const text = fs.readFileSync(file, "utf8");
            return { file, text, ...parseYamlScalars(text) };
        } catch {
            /* 试下一个 */
        }
    }
    throw new Error(`在 ${engineDir} 下找不到 config.yaml 或 config.example.yaml`);
}

/** 只读展示用：找不到配置时返回 null，而不是让整页 500。 */
export function tryLoadEngineConfig(engineDir: string = config.engineDir): EngineConfig | null {
    try {
        return loadEngineConfig(engineDir);
    } catch {
        return null;
    }
}

/**
 * 解析配置里**所有层级的标量**，键为点分路径。
 *
 * 这是一个刻意做小的 YAML 子集解析：只认 `indent + key: value` 与空值块头
 * (`key:` 后换行表示嵌套开始)。够用且可预测 —— 我们需要的是「读回自己关心的几个值」，
 * 不是通用 YAML。序列、锚点、多行标量一律忽略（配置里没有）。
 *
 * 注释只在**引号之外**才截断 —— 否则 `song-file: "{SongName} #1"` 会被截坏。
 */
export function parseYamlScalars(text: string): { values: Record<string, string>; keys: string[] } {
    const values: Record<string, string> = {};
    const keys: string[] = [];
    /** 缩进层级栈：每层是 [缩进宽度, 键名] */
    const stack: Array<{ indent: number; key: string }> = [];

    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim() || raw.trim().startsWith("#")) continue;
        const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
        if (!m) continue;

        const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
        const key = m[2] ?? "";
        const value = stripInlineComment(m[3] ?? "").trim();

        // 弹掉同级或更深的层级，找到自己的父级
        while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();
        const prefix = stack.map((s) => s.key).join(".");
        const full = prefix ? `${prefix}.${key}` : key;

        if (value === "") {
            // 块头：进入下一层（也可能是空值键，但引擎配置里空标量都带引号 ""）
            stack.push({ indent, key });
            continue;
        }
        if (!(full in values)) keys.push(full);
        values[full] = unquote(value);
    }
    return { values, keys };
}

function stripInlineComment(v: string): string {
    const t = v.trim();
    // 值本身以引号开头：配对的收尾引号之后才是注释区（引号内的 # 属于值）
    const q = t[0];
    if (q === '"' || q === "'") {
        for (let i = 1; i < t.length; i++) {
            if (t[i] !== q) continue;
            if (q === '"' && t[i - 1] === "\\") continue; // 被转义的引号不算收尾
            return t.slice(0, i + 1);
        }
        return t; // 引号没配对：整段当值，不去猜
    }
    // 裸标量：` #` 之后是注释
    const at = v.search(/(^|\s)#/);
    return at === -1 ? v : v.slice(0, at);
}

function unquote(v: string): string {
    if (v.length >= 2) {
        const a = v[0];
        const b = v[v.length - 1];
        if (a === '"' && b === '"') return unescapeDouble(v.slice(1, -1));
        // 单引号标量在 YAML 里不做转义（'' 表示一个单引号）
        if (a === "'" && b === "'") return v.slice(1, -1).replace(/''/g, "'");
    }
    return v;
}

/** 与 yamlScalar() 的转义互逆 —— 保证「写进去再读出来」是同一个字符串。 */
function unescapeDouble(v: string): string {
    return v.replace(/\\(["\\])/g, "$1");
}

/* --------------------------------------------------------------- 读取工具 */

function asBool(v: string | undefined, def: boolean): boolean {
    if (v === undefined) return def;
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return def;
}

/** 按候选路径列表找第一个有值的字符串。 */
export function pickString(
    values: Record<string, string>,
    candidates: readonly string[]
): string | undefined {
    for (const k of candidates) {
        const v = values[k];
        if (v !== undefined && v !== "") return v;
    }
    return undefined;
}

/** 同上，但把空值也当成"存在"（用于「用户显式写空」也算一种表态的键）。 */
export function pickRaw(
    values: Record<string, string>,
    candidates: readonly string[]
): string | undefined {
    for (const k of candidates) {
        if (k in values) return values[k];
    }
    return undefined;
}

export function pickBool(
    values: Record<string, string>,
    candidates: readonly string[],
    def: boolean
): boolean {
    return asBool(pickRaw(values, candidates), def);
}

/** 兼容旧调用点：按（点分）键读若干字符串。 */
export function configStrings(keys: string[], engineDir: string = config.engineDir): Record<string, string | undefined> {
    const v = tryLoadEngineConfig(engineDir)?.values ?? {};
    const out: Record<string, string | undefined> = {};
    for (const k of keys) out[k] = v[k];
    return out;
}

/* --------------------------------------------------------------- 任务选项 */

/** 与 store.JobOptions 同构（此处独立声明，避免模块循环依赖）。 */
export type EngineJobOptions = {
    embedLrc: boolean;
    saveLrcFile: boolean;
    lrcType: "lyrics" | "syllable-lyrics";
    lrcExtra: "" | "translation" | "pronunciation";
    lrcFormat: "lrc" | "ttml";
};

/**
 * 从 config.yaml 读出「歌词」一族键的**有效值**，用默认值补缺口。
 *
 * 用途：界面上的歌词控件按 config.yaml 预填，用户看到的默认值就是真正会生效的值
 * （而不是前端另有一套默认值，两边说的不一样）。
 */
export function lyricOptionsFromConfig(engineDir: string = config.engineDir): EngineJobOptions {
    const v = tryLoadEngineConfig(engineDir)?.values ?? {};
    const lrcType = pickRaw(v, KEYS.lyricsType) === "syllable-lyrics" ? "syllable-lyrics" : "lyrics";
    const raw = pickRaw(v, KEYS.lyricsExtra);
    const lrcExtra = raw === "translation" || raw === "pronunciation" ? raw : "";
    return {
        embedLrc: pickBool(v, KEYS.lyricsEmbed, true),
        saveLrcFile: pickBool(v, KEYS.lyricsSaveFile, true),
        lrcType,
        lrcExtra,
        lrcFormat: pickRaw(v, KEYS.lyricsFormat) === "ttml" ? "ttml" : "lrc"
    };
}

/**
 * 引擎的**有效音质/画质上限**，从 config.yaml 读出。
 *
 * 为什么必须读：界面会按 master playlist 判定 Hi-Res（位深 ≥24 且采样率 >48 kHz），
 * 而引擎实际下到的是 `media.alac-max` 允许的那一档。两者不是一回事 ——
 * `alac-max: 96000` 而清单里只有 96 kHz 时结果碰巧一致，
 * 但 `alac-max: 48000` 时界面照样会标「Hi-Res 24-bit/96 kHz」，
 * 落盘却只有 48 kHz。**界面报的是 Apple 的能力，落到硬盘上的是引擎的上限**，
 * 两者必须同时呈现，否则就是在骗人。
 *
 * 注意三个键的单位各不相同，不能混：
 *   * `alac-max`  = 采样率上限（Hz），取值 192000 / 96000 / 48000 / 44100
 *   * `atmos-max` = 码率上限（kbps），取值 2768 / 2448
 *   * `mv-max`    = 视频分辨率上限（纵向像素），如 2160 / 1080 / 720
 *
 * 读不到就是 `undefined`（= 未在 config.yaml 里写，引擎用自己的默认值），
 * **不要**替它猜一个默认值 —— 猜错的后果是界面显示一个假的封顶值。
 */
export type QualityCeilings = {
    /** ALAC 采样率上限（Hz） */
    alacMaxHz?: number;
    /** Dolby Atmos 码率上限（kbps） */
    atmosMaxKbps?: number;
    /** MV 纵向分辨率上限 */
    mvMax?: number;
    /** MV 音轨编码（"atmos" | "ac3" | "aac"） */
    mvAudioType?: string;
    /** AAC 流配置（"aac-lc" | "aac" | "aac-binaural" | "aac-downmix"） */
    aacType?: string;
};

function pickNum(values: Record<string, string>, candidates: readonly string[]): number | undefined {
    const raw = pickString(values, candidates);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function qualityCeilingsFromConfig(engineDir: string = config.engineDir): QualityCeilings {
    const v = tryLoadEngineConfig(engineDir)?.values ?? {};
    const out: QualityCeilings = {};
    const alac = pickNum(v, KEYS.alacMax);
    if (alac !== undefined) out.alacMaxHz = alac;
    const atmos = pickNum(v, KEYS.atmosMax);
    if (atmos !== undefined) out.atmosMaxKbps = atmos;
    const mv = pickNum(v, KEYS.mvMax);
    if (mv !== undefined) out.mvMax = mv;
    const mvAudio = pickString(v, KEYS.mvAudioType);
    if (mvAudio) out.mvAudioType = mvAudio;
    const aac = pickString(v, KEYS.aacType);
    if (aac) out.aacType = aac;
    return out;
}

/**
 * 某个无损变体是否**超出**引擎的 ALAC 采样率上限 —— 即「界面说 Hi-Res 但拿不到」。
 *
 * 只在两边都有数时才有话说：上限缺失（用户没配）不代表不限，
 * 而变体缺采样率也无法判定，所以任一缺失都返回 false（不虚报风险）。
 */
export function exceedsAlacCeiling(f: { sampleRate?: number }, ceilings: QualityCeilings): boolean {
    return f.sampleRate !== undefined && ceilings.alacMaxHz !== undefined && f.sampleRate > ceilings.alacMaxHz;
}

/* ------------------------------------------------------------- 覆盖与打码 */

/** 覆盖值允许的类型。布尔/数字必须以**裸标量**写出，否则引擎解析成字符串会失败。 */
export type OverrideValue = string | number | boolean;

/**
 * 标量格式化 —— 关键细节：**该裸写就裸写**。
 *
 * 踩过的坑：早期实现给所有值都套双引号，于是 `exit-on-error: "true"` 变成字符串，
 * 引擎（Go，强类型结构体）解析 bool 字段会直接失败；同理 `alac-max: "96000"`。
 * 因此布尔与数字一律裸写；字符串只在**必须**时才加引号（空值、可能与 bool/数字混淆、
 * 以特殊字符开头、含 `: ` 或 ` #`、首尾有空格、含引号或反斜杠）。
 */
function yamlScalar(value: OverrideValue): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);

    const s = value;
    if (s === "") return '""';
    const needsQuote =
        /^[\s]|[\s]$/.test(s) || // 首尾空白
        /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || // YAML 指示符开头
        /:\s/.test(s) || // 冒号+空格（会被当成嵌套映射）
        /\s#/.test(s) || // 空格+井号（会被当成注释）
        /[\\"]/.test(s) || // 引号/反斜杠：需要转义
        /\n/.test(s) ||
        /^(true|false|yes|no|on|off|null|~)$/i.test(s) || // 会被解析成 bool/null
        /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s); // 会被解析成数字
    return needsQuote ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按键覆盖，键是**点分路径**（`metadata.lyrics.embed`）。
 *
 * 行为：
 *   * 找到该路径的行 → 整行替换（保留缩进、保留其它行与原顺序）；
 *   * 找不到 → 尝试**在其父块下插入**（例如 `metadata:` 存在但没有 `lyrics:` 子块）；
 *   * 父块也不存在 → 在文件末尾补出完整结构。
 *
 * 键缺失时不写 —— 引擎会用它自己的内置默认值。
 */
export function applyOverrides(text: string, overrides: Array<[string, OverrideValue]>): string {
    let out = text;
    for (const [key, value] of overrides) {
        const parts = key.split(".");
        const leaf = parts.pop() ?? "";
        if (parts.length === 0) {
            out = writeTopLevel(out, leaf, value);
            continue;
        }
        // 分两步：先保证块存在（可能会**改写文本**），再在新文本里**重新定位**。
        // 曾经把这两件事合成一步：创建块时顺带返回一个偏移，结果那个偏移是基于
        // 「追加后的文本」算的，却被拿去操作「追加前的文本」，于是键被写到错位置
        // （实测把 embed 插进了 metadata.artwork 而且插了两遍）。
        const ensured = ensureBlock(out, parts);
        const block = requireBlock(ensured, parts);
        out = insertKey(ensured, block.start, block.indent, block.childIndent, leaf, value);
    }
    return out;
}

/**
 * 取出行尾注释（含它前面的空白）。
 *
 * 为什么要保留：这份配置几乎每行都带说明性注释（`alac-max: 192000  # ...`），
 * 用户靠它判断该填什么。整行替换会把注释吃掉 —— 改个音质就把文档抹了。
 *
 * 只认**引号之外**、前面是空白的 `#`，否则 `storefront: "a#b"` 会被截断。
 */
function trailingComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === "#" && i > 0 && /[ \t]/.test(line[i - 1] ?? "")) {
            let j = i;
            while (j > 0 && /[ \t]/.test(line[j - 1] ?? "")) j--;
            return line.slice(j);
        }
    }
    return "";
}

/** 顶层键：命中则整行替换（保留行尾注释），否则追加到文件末尾。 */
function writeTopLevel(text: string, key: string, value: OverrideValue): string {
    const line = `${key}: ${yamlScalar(value)}`;
    const re = new RegExp(`^(${escapeRegExp(key)}:[^\n]*)$`, "m");
    const hit = re.exec(text);
    if (hit) {
        const old = hit[1] ?? "";
        return text.slice(0, hit.index) + line + trailingComment(old) + text.slice(hit.index + old.length);
    }
    return `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/** 一个块头（`key:` 且无值）：它在文本中的位置、**自身缩进**、以及子级缩进。 */
type Block = { start: number; indent: number; childIndent: number };

/**
 * 保证某个点分路径的**块**存在，返回**改写后的文本**（不改写就原样返回）。
 *
 * 幂等。不存在时递归保证父块存在，再写入子块头
 * —— `metadata` 在、但 `lyrics` 不在，就补出 `lyrics:`，而不是把整条路径当叶子写
 * （那会写出 `metadata.lyrics.save-file:` 这种非法键）。
 *
 * 注意它**不返回位置**：位置必须由调用方在新文本上重新查（见 applyOverrides）。
 */
function ensureBlock(text: string, parts: string[]): string {
    if (findBlock(text, parts)) return text;

    const leaf = parts[parts.length - 1] ?? "";
    const parentParts = parts.slice(0, -1);

    if (parentParts.length === 0) {
        return `${text}${text.endsWith("\n") ? "" : "\n"}${leaf}:\n`;
    }
    const withParent = ensureBlock(text, parentParts);
    const parent = requireBlock(withParent, parentParts);
    return insertKey(withParent, parent.start, parent.indent, parent.childIndent, leaf, null);
}

/** 定位一个**必然存在**的块；不存在就抛错（宁可炸也不要静默写错位置）。 */
function requireBlock(text: string, parts: string[]): Block {
    const b = findBlock(text, parts);
    if (!b) throw new Error(`无法在配置中定位块：${parts.join(".")}`);
    return b;
}

/**
 * 在 `level`（**子级缩进**）这一层写入一个键，块的扫描范围是
 * [`blockStart`, 下一个缩进 ≤ `blockIndent` 的行)。
 * `value === null` 表示写入的是**子块头**（`key:` 无值）。
 *
 * 两个约束都是踩出来的：
 *
 *  1. **扫描必须止于块尾**（下一个缩进 ≤ 块自身缩进的行），而不是"下一个缩进 < 子级缩进的行"。
 *     否则块后面属于父块兄弟的行会被当成块内内容 —— 实测就这样把 `embed` 插进了
 *     `metadata.artwork`，还插了两遍。
 *  2. **只认当前这一层的直接子键**（缩进恰好等于 level）。早先只看「缩进 ≥ level」，
 *     于是 `metadata.lyrics.embed` 会一路钻进兄弟块 `metadata.artwork.embed` 里。
 */
function insertKey(
    text: string,
    blockStart: number,
    blockIndent: number,
    level: number,
    key: string,
    value: OverrideValue | null
): string {
    const pad = " ".repeat(level);
    const newLine = value === null ? `${pad}${key}:` : `${pad}${key}: ${yamlScalar(value)}`;

    const startAfterHeader = text.indexOf("\n", blockStart);
    let offset = startAfterHeader === -1 ? text.length : startAfterHeader + 1;
    let insertAt = text.length;

    while (offset < text.length) {
        const nl = text.indexOf("\n", offset);
        const lineEnd = nl === -1 ? text.length : nl;
        const line = text.slice(offset, lineEnd);
        const indent = line.length - line.trimStart().length;

        if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
            if (indent <= blockIndent) {
                insertAt = offset; // 块尾
                break;
            }
            if (indent === level && new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line.trimStart())) {
                /* 保留行尾注释（见 trailingComment 的注释） */
                const keep = value === null ? "" : trailingComment(line);
                return text.slice(0, offset) + newLine + keep + text.slice(lineEnd);
            }
        }
        if (nl === -1) break;
        offset = nl + 1;
    }

    const needsNl = insertAt > 0 && text[insertAt - 1] !== "\n";
    return text.slice(0, insertAt) + (needsNl ? "\n" : "") + newLine + "\n" + text.slice(insertAt);
}


/**
 * 找到某个点分路径的**每一级**块。
 *
 * 实现要点（都是踩出来的）：
 *   * 每级只在**父块的范围内**找，并要求缩进**恰好比父级深 2 空格**
 *     —— 引擎配置固定 2 空格缩进。早先按「缩进 > 父级」来找，会匹配到更深的同名块；
 *     搜索窗口不设上界时更糟：键会匹配到自己那一行**之后**的重复内容。
 *   * 所以每级都要算出**结束偏移**（下一个缩进 ≤ 块自身的行），作为下一级的搜索上界。
 *
 * 返回每一级的 `Block`（`blocks[blocks.length - 1]` 就是目标块）。
 */
function findBlockPath(text: string, parts: string[]): Block[] {
    const INDENT_STEP = 2;
    const blocks: Block[] = [];
    let from = 0;
    let to = text.length;

    for (let i = 0; i < parts.length; i++) {
        const wantIndent = i * INDENT_STEP;
        const hit = findKeyLine(text, parts[i] ?? "", wantIndent, from, to);
        if (!hit) return [];
        blocks.push(hit);
        to = blockEnd(text, hit.start, wantIndent);
        // 下一级从**块头的下一行**开始找。
        // 踩过的坑：写 `from = hit.start + 1` 只前进一个字符，于是下一级会从
        // `metadata:` 的第 2 个字符开始扫（读成 "etadata:"），立刻判定"离开本层"，
        // 结果 `metadata.lyrics` 永远找不到。
        const headerEnd = text.indexOf("\n", hit.start);
        if (headerEnd === -1) return blocks;
        from = headerEnd + 1;
    }
    return blocks;
}

/** 只要最后一级（目标块）。 */
function findBlock(text: string, parts: string[]): Block | null {
    const path = findBlockPath(text, parts);
    return path.length === parts.length && path.length > 0 ? (path[path.length - 1] ?? null) : null;
}

/** 在 [from, to) 内找缩进恰好为 `indent` 的 `key:`（无值的块头）。 */
function findKeyLine(text: string, key: string, indent: number, from: number, to: number): Block | null {
    let offset = from;
    while (offset < to) {
        const nl = text.indexOf("\n", offset);
        const lineEnd = Math.min(nl === -1 ? text.length : nl, to);
        const line = text.slice(offset, lineEnd);
        const trimmed = line.trimStart();
        if (trimmed !== "" && !trimmed.startsWith("#")) {
            const lineIndent = line.length - trimmed.length;
            if (lineIndent === indent && new RegExp(`^${escapeRegExp(key)}\\s*:\\s*$`).test(trimmed)) {
                return { start: offset, indent, childIndent: indent + 2 };
            }
            if (lineIndent < indent) return null; // 已离开本层
        }
        if (nl === -1 || nl + 1 >= to) break;
        offset = nl + 1;
    }
    return null;
}

/** 块内容的结束偏移：从块头下一行起，遇到缩进 ≤ `indent` 的非空行即结束。 */
function blockEnd(text: string, blockStart: number, indent: number): number {
    const startAfterHeader = text.indexOf("\n", blockStart);
    let offset = startAfterHeader === -1 ? text.length : startAfterHeader + 1;
    while (offset < text.length) {
        const nl = text.indexOf("\n", offset);
        const lineEnd = nl === -1 ? text.length : nl;
        const line = text.slice(offset, lineEnd);
        const trimmed = line.trimStart();
        if (trimmed !== "" && !trimmed.startsWith("#")) {
            const lineIndent = line.length - trimmed.length;
            if (lineIndent <= indent) return offset;
        }
        if (nl === -1) break;
        offset = nl + 1;
    }
    return text.length;
}

/** 展示用：把凭据类键的值替换成掩码，只保留"是否已配置"。任意层级都会打码。 */
export function maskConfigText(text: string): string {
    let out = text;
    for (const key of SECRET_KEYS) {
        const leaf = key.split(".").pop() ?? key;
        const re = new RegExp(`^(\\s*${escapeRegExp(leaf)}\\s*:\\s*)(.+)$`, "gm");
        out = out.replace(re, (_m, head: string, value: string) => `${head}${maskValue(unquote(value.trim()))}`);
    }
    return out;
}

function maskValue(v: string): string {
    if (v === "") return '""';
    if (v.length <= 8) return '"***"';
    return `"${v.slice(0, 4)}***${v.slice(-2)}"`;
}

/* ------------------------------------------------------------- 写回配置 */

/**
 * 可写的键（白名单）。值是**候选路径列表**，与 `KEYS` 同一套语义：
 * 写的时候只在**文件里已经存在的那条路径**上改，绝不新增并行键。
 *
 * 为什么强调这一点：上游把扁平键改成了嵌套结构，用户文件里可能还是
 * `embed-lrc: true`。如果一律按新路径 `metadata.lyrics.embed` 写，
 * 结果是**同一个语义出现两行**，引擎读哪条取决于它的解析顺序 ——
 * 用户改了界面、行为却可能没变。所以这里复用 KEYS 的候选表。
 */
const EDITABLE_KEYS: Record<string, readonly string[]> = {
    alacMax: KEYS.alacMax,
    atmosMax: KEYS.atmosMax,
    aacType: KEYS.aacType,
    mvMax: KEYS.mvMax,
    mvAudioType: KEYS.mvAudioType,
    storefront: KEYS.storefront,
    language: KEYS.language,
    lyricsEmbed: KEYS.lyricsEmbed,
    lyricsSaveFile: KEYS.lyricsSaveFile,
    lyricsType: KEYS.lyricsType,
    lyricsExtra: KEYS.lyricsExtra,
    lyricsFormat: KEYS.lyricsFormat
};

/** 每个可写项的取值约束。空数组 = 任意合法标量（但仍要过类型检查）。 */
const EDITABLE_VALUES: Record<string, readonly string[]> = {
    aacType: ["aac-lc", "aac", "aac-binaural", "aac-downmix"],
    mvAudioType: ["atmos", "ac3", "aac"],
    lyricsEmbed: ["true", "false"],
    lyricsSaveFile: ["true", "false"],
    lyricsType: ["lyrics", "syllable-lyrics"],
    lyricsExtra: ["", "translation", "pronunciation"],
    lyricsFormat: ["lrc", "ttml"]
};

/**
 * 每项写入 YAML 时的**标量类型**。
 *
 * 不能一律按字符串写：`yamlScalar("false")` 会加引号（正确 —— 裸 false 会被读成布尔），
 * 于是布尔键变成 `embed-lrc: "false"`，Go 的强类型结构体解析失败。
 * 数值同理：`alac-max: "96000"` 也解析不了。
 */
type FieldType = "string" | "bool" | "int";

const FIELD_TYPES: Record<string, FieldType> = {
    alacMax: "int",
    atmosMax: "int",
    mvMax: "int",
    aacType: "string",
    mvAudioType: "string",
    storefront: "string",
    language: "string",
    lyricsEmbed: "bool",
    lyricsSaveFile: "bool",
    lyricsType: "string",
    lyricsExtra: "string",
    lyricsFormat: "string"
};

export type EditableField = {
    /** 语义名（与 KEYS 的键一致） */
    name: string;
    /** 当前生效值（原始字符串，未打码 —— 这些都不是凭据） */
    value: string;
    /** 实际写在文件里的那条路径（旧扁平键或新嵌套键） */
    path: string;
    /** 允许的取值；空表示自由输入 */
    allowed: string[];
    /** 是否是数值输入（界面用 number 控件） */
    numeric: boolean;
    /** 布尔开关 */
    bool: boolean;
};

/** 列出界面上可编辑的字段及其当前值。 */
export function editableFields(engineDir: string = config.engineDir): EditableField[] {
    const cfg = tryLoadEngineConfig(engineDir);
    const values = cfg?.values ?? {};
    const out: EditableField[] = [];
    for (const [name, candidates] of Object.entries(EDITABLE_KEYS)) {
        /* 找到文件里**实际存在**的那条路径；都不存在就用首选路径（会新增） */
        const path_ = candidates.find((c) => values[c] !== undefined) ?? candidates[0] ?? "";
        out.push({
            name,
            value: values[path_] ?? "",
            path: path_,
            allowed: [...(EDITABLE_VALUES[name] ?? [])],
            numeric: FIELD_TYPES[name] === "int",
            bool: FIELD_TYPES[name] === "bool"
        });
    }
    return out;
}

/** 校验一个待写入项。返回错误信息，或 null 表示通过。 */
export function validateEditable(name: string, raw: unknown): string | null {
    if (!(name in EDITABLE_KEYS)) return `不可修改的项：${name}`;
    const v = String(raw ?? "").trim();
    if (v.length > 200) return `${name} 太长`;
    /* 换行会破坏「一行一个键」的结构，是这里唯一真正危险的输入 */
    if (/[\r\n]/.test(v)) return `${name} 不能包含换行`;
    if (FIELD_TYPES[name] === "int") {
        if (!/^\d+$/.test(v)) return `${name} 必须是整数`;
        const n = Number(v);
        if (n <= 0 || n > 384000) return `${name} 超出合理范围（1–384000）`;
    }
    const allowed = EDITABLE_VALUES[name];
    if (allowed && allowed.length > 0 && !allowed.includes(v)) {
        return `${name} 只能是：${allowed.map((x) => x || "(空)").join(" / ")}`;
    }
    if (name === "storefront" && !/^[a-z]{2}$/.test(v)) return "地区必须是两位小写字母，如 cn / jp";
    if (name === "language" && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(v)) return "语言格式如 en-US / zh-Hans-CN";
    return null;
}

/**
 * 把若干项写回引擎的 `config.yaml`，并返回**实际写入的键**。
 *
 * ## 为什么必须原地写（不能用 rename）
 *
 * compose 里 `config.yaml` 是**单文件 bind mount**，绑定的是启动那一刻的
 * **inode**。`rename`（以及 `sed -i`）会新建文件再改名，inode 变了 ——
 * 容器里看到的仍是旧内容。这正是 README 里「改完要重启容器」那条坑的成因。
 *
 * `fs.writeFileSync` 直接写同一路径：Docker 的 bind mount 对「同一 inode 上的
 * 内容变化」是实时可见的，所以**不需要重启**。
 *
 * ## 为什么先备份
 *
 * 这份文件是用户手写的（注释、顺序、未知键）。写坏它等于毁掉唯一的配置源，
 * 所以每次写前留一份 `.bak`。
 */
export function writeEngineConfig(
    updates: Array<{ name: string; value: unknown }>,
    engineDir: string = config.engineDir
): { file: string; backup: string; written: string[] } {
    return writeEngineConfigTo(updates, engineDir, config.dataDir);
}

/**
 * 同上，但显式指定备份目录。
 *
 * 为什么备份不能放在配置文件旁边：`/engine` 是 root 拥有的只读目录
 * （compose 里只把 config.yaml 这一个**文件**挂进去），容器用户 1000
 * 对目录没有写权限，`copyFile` 到 `/engine/config.yaml.bak` 会 EACCES。
 * `/data` 是挂进来的可写卷，放那里。
 */
export function writeEngineConfigTo(
    updates: Array<{ name: string; value: unknown }>,
    engineDir: string,
    backupDir: string
): { file: string; backup: string; written: string[] } {
    const cfg = loadEngineConfig(engineDir);

    const overrides: Array<[string, OverrideValue]> = [];
    const errors: string[] = [];
    for (const u of updates) {
        const err = validateEditable(u.name, u.value);
        if (err) {
            errors.push(err);
            continue;
        }
        const candidates = EDITABLE_KEYS[u.name];
        const path_ = candidates.find((c) => cfg.values[c] !== undefined) ?? candidates[0] ?? "";
        if (!path_) continue;
        const v = String(u.value ?? "").trim();
        /* 按声明类型转成真正的标量：布尔/数值不能以字符串形式写（见 FIELD_TYPES） */
        const type = FIELD_TYPES[u.name];
        const scalar: OverrideValue =
            type === "int" ? Number(v) : type === "bool" ? v === "true" : v;
        overrides.push([path_, scalar]);
    }
    if (errors.length > 0) throw new Error(errors.join("；"));

    const next = applyOverrides(cfg.text, overrides);
    const backup = path.join(backupDir, "config.yaml.bak");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(cfg.file, backup);
    try {
        fs.writeFileSync(cfg.file, next, "utf8");
    } catch (e) {
        /*
         * 只读挂载是最可能的失败原因，而报错原文（EROFS）对用户毫无指向性。
         * 这里换成能直接行动的说明。
         */
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
            throw new Error(
                `${cfg.file} 不可写（${code}）。检查 docker-compose.yml 里该文件的挂载是否仍带 :ro —— ` +
                    `本功能要求去掉 :ro，改完需 docker compose up -d 重建容器。`
            );
        }
        throw e;
    }
    return { file: cfg.file, backup, written: overrides.map(([k]) => k) };
}

