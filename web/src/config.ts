import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tryLoadEngineConfig } from "./engineconf.js";

function env(name: string, def: string): string {
    const v = process.env[name];
    return v === undefined || v === "" ? def : v;
}
function envInt(name: string, def: number, lo = Number.NEGATIVE_INFINITY, hi = Number.POSITIVE_INFINITY): number {
    const n = Number(env(name, String(def)));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : def;
}
function envBool(name: string, def: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v.trim() === "") return def;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * 运行时配置只有两处来源，原则如下（这是本项目的配置分层约定）：
 *
 *   1. `.env`（本文件）—— **与宿主机/部署相关**：端口、路径、权限、时区、并发、代理…
 *      以及本服务自己的私密信息（站点管理员口令、会话密钥）。
 *   2. 引擎的 `config.yaml`（engineconf.ts）—— **与下载相关**：音质、歌词、命名、
 *      转码、地区、Apple 凭据。用户直接编辑文件，网页只读展示。
 *
 * 网页 UI 里只剩「本次任务的临时覆盖项」，不落盘、可随时改（见 ripper.ts）。
 */
export const config = {
    port: envInt("PORT", 2000, 1, 65535),

    /** Directory for our own state (users/jobs JSON + session secret). */
    dataDir: path.resolve(env("DATA_DIR", "./data")),
    /** Where the ripper writes audio (mounted into the container). */
    musicDir: path.resolve(env("MUSIC_DIR", "./music")),
    /** Directory that holds the engine's config.yaml — also the engine's cwd. */
    engineDir: path.resolve(env("ENGINE_DIR", ".")),

    /**
     * wrapper-lite's data directory (`--base-dir`), mounted into this container so the
     * web UI can drop the 2FA code the wrapper polls for. The code is read from
     * `<base-dir>/2fa.txt` (wrapper-lite source: lite/auth.cpp).
     */
    wrapperDataDir: path.resolve(env("WRAPPER_DATA_DIR", "/wrapper-data")),

    /** Ripper binary. It is the only component that talks to wrapper-lite + Temari. */
    engineBin: env("ENGINE_BIN", "apple-music-dl"),

    /** wrapper-lite HTTP endpoint (the only backend service in this stack). */
    liteServer: env("LITE_SERVER", "http://wrapper-lite:12340"),

    /**
     * 出网代理（引擎的下载请求会走 Go 的 http.ProxyFromEnvironment；本服务自身的
     * 目录查询也尊重这两个变量）。留空则直连。与 config.yaml 的 `proxy` 是两回事：
     * 这个作用于「引擎 → Apple 媒体 CDN」，那个作用于「引擎 → amp-api」。
     */
    httpProxy: env("HTTP_PROXY", env("http_proxy", "")),
    httpsProxy: env("HTTPS_PROXY", env("https_proxy", "")),
    noProxy: env("NO_PROXY", env("no_proxy", "")),

    /** 站点管理员账号 bootstrap（仅首次可用，之后由网页创建/改密）。 */
    adminUser: env("ADMIN_USER", ""),
    adminPassword: env("ADMIN_PASSWORD", ""),

    /** Session lifetime (days). */
    sessionDays: envInt("SESSION_DAYS", 30, 1, 3650),
    /** 反向代理后置 true，才会信任 X-Forwarded-* 头（用于 secure cookie / 真实 IP）。 */
    trustProxy: envBool("TRUST_PROXY", false),

    /** Ripping is heavy: keep it serial by default. */
    concurrency: envInt("JOB_CONCURRENCY", 1, 1, 16),
    /** How many engine stdout lines to retain per job. */
    logLines: envInt("JOB_LOG_LINES", 2000, 200, 200000),
    /** Hard timeout for one job (seconds). 0 disables. */
    jobTimeoutSec: envInt("JOB_TIMEOUT_SEC", 7200, 0),

    /**
     * 容器内进程的属主（compose 的 user: 已经写死 1000:100）。
     * 这里只是**暴露出来用于自检与提示**：宿主 MUSIC_DIR 的属主必须与之匹配，
     * 否则下载会以 EACCES 失败。改这里不会改变容器进程身份，要改 compose。
     */
    puid: envInt("PUID", 1000, 0),
    pgid: envInt("PGID", 100, 0),

    /**
     * 下载完成后给音频文件（及同目录的封面/歌词）设置的权限位，八进制字符串。
     * 默认 "666" 以匹配用户的媒体库惯例（媒体服务器常以别的 uid 运行）。
     * 设为 "keep" 表示不改动。
     */
    fileMode: parseFileMode(env("FILE_MODE", "666"))
};

function parseFileMode(raw: string): number | null {
    const v = raw.trim().toLowerCase();
    if (v === "" || v === "keep" || v === "none" || v === "off") return null;
    const n = Number.parseInt(v, 8);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export type AppConfig = typeof config;

fs.mkdirSync(config.dataDir, { recursive: true });

/* --------------------------------------------------- 地区 / 语言（跟随 config.yaml） */

/**
 * 目录查询用的 storefront / language **以引擎 config.yaml 为准**，.env 只作兜底。
 * 这样「一个地方配地区」：config.yaml 里写 cn，网页搜索、编码探测、下载元数据全都跟着变。
 * 只在首次访问时读一次；改完 config.yaml 需要重启容器（bind mount 的 inode 问题，见 README）。
 */
let storefrontCache: string | null = null;
let languageCache: string | null = null;

export function storefront(): string {
    if (storefrontCache) return storefrontCache;
    const fromYaml = readEngineScalar("storefront");
    const v = (fromYaml ?? env("STOREFRONT", "us")).trim().toLowerCase();
    storefrontCache = /^[a-z]{2}$/.test(v) ? v : "us";
    return storefrontCache;
}

export function language(): string {
    if (languageCache) return languageCache;
    const v = (readEngineScalar("language") ?? env("LANGUAGE", "en-US")).trim();
    languageCache = v === "" ? "en-US" : v;
    return languageCache;
}

/**
 * 读引擎 config.yaml 里的一个标量键（engineconf 不依赖本模块，因此可以静态导入）。
 */
function readEngineScalar(key: string): string | undefined {
    try {
        const v = tryLoadEngineConfig(config.engineDir)?.values[key];
        return v === undefined || v.trim() === "" ? undefined : v.trim();
    } catch {
        return undefined;
    }
}


/** Session signing secret: SESSION_SECRET, else generated once and persisted. */
export function sessionSecret(): string {
    const fromEnv = process.env["SESSION_SECRET"];
    if (fromEnv && fromEnv.length >= 16) return fromEnv;

    const file = path.join(config.dataDir, "session.secret");
    try {
        const existing = fs.readFileSync(file, "utf8").trim();
        if (existing.length >= 32) return existing;
    } catch {
        /* not created yet */
    }
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
}
