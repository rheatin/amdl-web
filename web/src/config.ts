import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function env(name: string, def: string): string {
    const v = process.env[name];
    return v === undefined || v === "" ? def : v;
}

/** All runtime configuration comes from environment variables (see .env.example). */
export const config = {
    port: Number(env("PORT", "2000")),

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

    /** Apple Music storefront/language used for catalog search. */
    storefront: env("STOREFRONT", "us"),
    language: env("LANGUAGE", "en-US"),

    /** Ripping is heavy: keep it serial by default. */
    concurrency: Math.max(1, Number(env("JOB_CONCURRENCY", "1"))),
    /** How many engine stdout lines to retain per job. */
    logLines: Math.max(200, Number(env("JOB_LOG_LINES", "2000"))),
    /** Hard timeout for one job (seconds). 0 disables. */
    jobTimeoutSec: Math.max(0, Number(env("JOB_TIMEOUT_SEC", "7200"))),

    /** Optional first-boot admin seeding. */
    adminUser: env("ADMIN_USER", ""),
    adminPassword: env("ADMIN_PASSWORD", ""),

    /** Session lifetime (days). */
    sessionDays: Math.max(1, Number(env("SESSION_DAYS", "30"))),

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
