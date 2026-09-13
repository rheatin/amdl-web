/**
 * 引擎配置层 —— 读写 <ENGINE_DIR>/config.yaml。
 *
 * 为什么要按键覆盖而不是解析整个 YAML：
 *   * 引擎的 config.yaml 是**扁平**的 `key: value` 结构，注释很多（上游自带说明）；
 *   * 重写整份文件会丢掉注释与未知键（本服务只认识其中一部分键）；
 *   * 逐行替换 + 缺失则追加，能保证「用户的文件不被我们改写」，也不引入 YAML 依赖。
 *
 * 事实来源（部署实测）：
 *   * 引擎从**进程工作目录**读 config.yaml（os.ReadFile("config.yaml")），
 *     因此每个任务可以有一份私有配置（见 ripper.ts）；
 *   * config.yaml 是本栈里**下载语义**的唯一出处（质量、歌词、命名、转码、地区、代理），
 *     网页不再持有一份可写的副本，只做只读展示。
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** 引擎从 cwd 读的文件名；example 是兜底（config.yaml 缺失时 bind mount 会变成目录）。 */
const CANDIDATES = ["config.yaml", "config.example.yaml"];

/** 引擎配置里属于凭据的键 —— 展示时必须打码。 */
export const SECRET_KEYS = ["media-user-token", "authorization-token"];

export type EngineConfig = {
    /** 实际读到的文件路径 */
    file: string;
    /** 原文 */
    text: string;
    /** 解析出的键值（键名保持原文，值已去引号） */
    values: Record<string, string>;
    /** 出现过在这个文件里的键顺序 */
    keys: string[];
};

/** 读取基础配置：优先 config.yaml，其次 config.example.yaml。 */
export function loadEngineConfig(engineDir: string = config.engineDir): EngineConfig {
    for (const name of CANDIDATES) {
        const file = path.join(engineDir, name);
        try {
            if (!fs.statSync(file).isFile()) continue;
            const text = fs.readFileSync(file, "utf8");
            return { file, text, ...parseFlatYaml(text) };
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
 * 解析扁平的 `key: value`。
 *
 * 只认顶层标量行：`key:` 后面可以有值、也可以为空（表示嵌套块，一律忽略）。
 * 注释只在**引号之外**才截断 —— 否则 `song-file-format: "{SongName} #1"` 会被截坏。
 */
export function parseFlatYaml(text: string): { values: Record<string, string>; keys: string[] } {
    const values: Record<string, string> = {};
    const keys: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        if (/^\s/.test(raw)) continue; // 缩进行 → 属于某个嵌套块
        const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
        if (!m) continue;
        const key = m[1] ?? "";
        const value = stripInlineComment(m[2] ?? "").trim();
        if (value === "") continue; // `key:` 后换行 = 块级结构，不做标量处理
        if (!(key in values)) keys.push(key);
        values[key] = unquote(value);
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

/* --------------------------------------------------------------- 任务选项 */

/** 与 store.JobOptions 同构（此处独立声明，避免模块循环依赖）。 */
export type EngineJobOptions = {
    embedLrc: boolean;
    saveLrcFile: boolean;
    lrcType: "lyrics" | "syllable-lyrics";
    lrcExtra: "" | "translation" | "pronunciation";
    lrcFormat: "lrc" | "ttml";
};

function asBool(v: string | undefined, def: boolean): boolean {
    if (v === undefined) return def;
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return def;
}

/**
 * 从 config.yaml 读出「歌词」一族键的**有效值**，用默认值补缺口。
 *
 * 用途：界面上的歌词控件按 config.yaml 预填，用户看到的默认值就是真正会生效的值
 * （而不是前端另有一套默认值，两边说的不一样）。
 */
export function lyricOptionsFromConfig(engineDir: string = config.engineDir): EngineJobOptions {
    const v = tryLoadEngineConfig(engineDir)?.values ?? {};
    const lrcType = v["lrc-type"] === "syllable-lyrics" ? "syllable-lyrics" : "lyrics";
    const raw = v["lrc-extra"];
    const lrcExtra = raw === "translation" || raw === "pronunciation" ? raw : "";
    return {
        embedLrc: asBool(v["embed-lrc"], true),
        saveLrcFile: asBool(v["save-lrc-file"], true),
        lrcType,
        lrcExtra,
        lrcFormat: v["lrc-format"] === "ttml" ? "ttml" : "lrc"
    };
}

/** 读出引擎配置里的某几个字符串键（缺失返回 undefined）。 */
export function configStrings(keys: string[], engineDir: string = config.engineDir): Record<string, string | undefined> {
    const v = tryLoadEngineConfig(engineDir)?.values ?? {};
    const out: Record<string, string | undefined> = {};
    for (const k of keys) out[k] = v[k];
    return out;
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
 * 正常情况下用户看到的差异只是「引号少了一些」，与上游 config.yaml 的写法一致。
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

/**
 * 按键覆盖：命中同名行则整行替换（保留其它行与原顺序），未命中则追加到末尾。
 * 键缺失时不写 —— 引擎会用它自己的内置默认值。
 */
export function applyOverrides(text: string, overrides: Array<[string, OverrideValue]>): string {
    let out = text;
    for (const [key, value] of overrides) {
        const line = `${key}: ${yamlScalar(value)}`;
        const re = new RegExp(`^${escapeRegExp(key)}:(.*)$`, "m");
        if (re.test(out)) out = out.replace(re, line);
        else out += `${out.endsWith("\n") ? "" : "\n"}${line}\n`;
    }
    return out;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 展示用：把凭据类键的值替换成掩码，只保留"是否已配置"。 */
export function maskConfigText(text: string): string {
    let out = text;
    for (const key of SECRET_KEYS) {
        const re = new RegExp(`^(${escapeRegExp(key)}\\s*:\\s*)(.+)$`, "gm");
        out = out.replace(re, (_m, head: string, value: string) => `${head}${maskValue(unquote(value.trim()))}`);
    }
    return out;
}

function maskValue(v: string): string {
    if (v === "") return '""';
    if (v.length <= 8) return '"***"';
    return `"${v.slice(0, 4)}***${v.slice(-2)}"`;
}
