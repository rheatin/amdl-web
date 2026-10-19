import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { coverBeside } from "./landed.js";
import type { RegionPlan } from "./region.js";

export type Track = {
    path: string;
    artist: string;
    album: string;
    song: string;
    /** 落盘文件大小（字节）。引擎的 --json 清单不带，只有 mtime 找回那条路才有。 */
    size?: number;
    /** 该曲目的目录时长（ms）—— 由建单时的能力探测带上，用于算真实码率与总时长。 */
    durationMs?: number;
    /**
     * 该曲目的封面模板（含 `{w}x{h}`）。
     * 引擎的 `--json` 清单不带封面，目录封面是建单时探到的、挂在 job.meta 上 ——
     * 所以这一项由 allTracks 从任务继承（同一张专辑的所有曲目共用一张封面）。
     */
    artwork?: string;
};

/**
 * queued → running → 终态。
 * 终态四选一：done（全部成功）、partial（有曲目失败但确实落盘了文件）、failed（什么都没出来）、
 * cancelled（用户主动取消；已经落盘的文件保留，跟 partial 的区别是「没下完是用户的意思」）。
 */
export type JobStatus = "queued" | "running" | "done" | "partial" | "failed" | "cancelled";

/** 终态（不会再到别的状态去）——取消/清空/重试都以它为准，别再各处手写状态列表。 */
export const FINISHED_STATUSES: JobStatus[] = ["done", "partial", "failed", "cancelled"];

export function isFinished(status: JobStatus): boolean {
    return FINISHED_STATUSES.includes(status);
}

/**
 * 每个任务的下载选项 —— 会以「按任务覆盖 config.yaml」的方式传给引擎
 * （引擎从进程 cwd 读 config.yaml，见 ripper.ts）。
 */
export type JobOptions = {
    /** 嵌入歌词到文件标签（引擎 embed-lrc），默认开 */
    embedLrc: boolean;
    /** 额外另存 .lrc 文件（引擎 save-lrc-file） */
    saveLrcFile: boolean;
    /** 逐行 / 逐字（引擎 lrc-type） */
    lrcType: "lyrics" | "syllable-lyrics";
    /** 翻译 / 罗马音（引擎 lrc-extra） */
    lrcExtra: "" | "translation" | "pronunciation";
    /** 歌词格式（引擎 lrc-format） */
    lrcFormat: "lrc" | "ttml";
};

export const DEFAULT_JOB_OPTIONS: JobOptions = {
    embedLrc: true,
    saveLrcFile: true,
    lrcType: "lyrics",
    lrcExtra: "",
    lrcFormat: "lrc"
};

/** 白名单校验：只接受已知取值；缺失的键以 base 为准（默认取内置默认值）。 */
export function sanitizeJobOptions(input: unknown, base: JobOptions = DEFAULT_JOB_OPTIONS): JobOptions {
    const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    return {
        embedLrc: o["embedLrc"] === undefined ? base.embedLrc : Boolean(o["embedLrc"]),
        saveLrcFile: o["saveLrcFile"] === undefined ? base.saveLrcFile : Boolean(o["saveLrcFile"]),
        lrcType: o["lrcType"] === "syllable-lyrics" ? "syllable-lyrics" : o["lrcType"] === "lyrics" ? "lyrics" : base.lrcType,
        lrcExtra:
            o["lrcExtra"] === "translation" || o["lrcExtra"] === "pronunciation" || o["lrcExtra"] === ""
                ? (o["lrcExtra"] as JobOptions["lrcExtra"])
                : base.lrcExtra,
        lrcFormat: o["lrcFormat"] === "ttml" ? "ttml" : o["lrcFormat"] === "lrc" ? "lrc" : base.lrcFormat
    };
}

/**
 * 校验并裁剪建单时客户端传来的展示信息（JobMeta）。
 *
 * 只做**形状**校验，不核对内容的真伪 —— 这些值只是界面上的标题/封面，
 * 引擎完全不看它们，伪造它们最多让某条任务记录显示错误的标题，
 * 不会影响下载结果。因此这里刻意不去目录复核（那是一次网络往返，且值会变）。
 *
 * `artwork` 只放行 mzstatic 的图片地址：它会直接进 `src=`，
 * 放行任意字符串等于让客户端往 `<img src>` 里塞 `javascript:` 之类的东西。
 */
export function sanitizeJobMeta(input: unknown): JobMeta | undefined {
    const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const title = String(o["title"] ?? "").slice(0, 300);
    const artistName = String(o["artistName"] ?? "").slice(0, 300);
    const albumName = String(o["albumName"] ?? "").slice(0, 300);
    const artworkRaw = String(o["artwork"] ?? "");
    const artwork = /^https:\/\/[\w-]*\.?mzstatic\.com\//i.test(artworkRaw) ? artworkRaw.slice(0, 1000) : "";
    const durationRaw = Number(o["durationMs"]);
    const expectedRaw = Number(o["expectedTracks"]);
    if (!title && !artistName && !albumName && !artwork) return undefined;
    return {
        title,
        artistName,
        albumName,
        artwork,
        ...(Number.isFinite(durationRaw) && durationRaw > 0 ? { durationMs: durationRaw } : {}),
        ...(Number.isFinite(expectedRaw) && expectedRaw > 0 ? { expectedTracks: Math.floor(expectedRaw) } : {})
    };
}

export type Job = {
    id: number;
    userId: number;
    /** Apple Music URL (or search-derived URL) to rip. */
    url: string;
    /** "alac" | "atmos" | "aac" */
    codec: string;
    /**
     * 本任务**显式**给出的下载选项（歌词一族）。
     * 空对象 = 完全按引擎 config.yaml 执行；这里永远不写内置默认值，
     * 否则会把用户的 config.yaml 覆盖掉（见 ripper.writeJobConfig）。
     */
    options: Partial<JobOptions>;
    /**
     * 元数据地区覆盖的完整记录（含实际执行用的 URL、回退/匹配原因）。
     *
     * 两点约定：
     *   * `url` 字段存的是**实际执行**的 URL（已改写或已回退），所以重试直接克隆本记录即可，
     *     **不再重新探测** —— 目录会变，不能让同一次重试漂到别的地区/别的记录；
     *   * 引擎不认识这个字段，它只影响建任务前的 URL 改写与界面展示。
     */
    region?: RegionPlan;
    /**
     * 建单时从目录探到的展示信息（标题/艺人/封面/时长/预期曲目数）。
     * 纯贴链接建单时为空 —— 那时本来就没有这些信息。
     */
    meta?: JobMeta;
    /** 引擎收尾的汇总；引擎没打印这一行时为 undefined。 */
    summary?: EngineSummary;
    status: JobStatus;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    tracks: Track[];
    /** Tail of the engine's output, for the live console. */
    log: string[];
};

/**
 * 引擎收尾打印的汇总（`Completed: 6/7 | Warnings: 0 | Errors: 1`）。
 * 之前只打进日志行，于是「6/7、1 个错误」只能靠用户翻控制台才看得见。
 */
export type EngineSummary = {
    completed: number;
    total: number;
    warnings: number;
    errors: number;
};

/**
 * 建单时从目录探到、之后不再变化的展示信息。
 *
 * 单独一个类型而不是散落的顶层字段：这些值只在建单那刻有意义，
 * 且总是「要么一起有、要么一起空」（纯贴链接建单就没有）。
 * `artwork` 是含 `{w}x{h}{f}` 的模板，渲染时再按尺寸展开。
 */
export type JobMeta = {
    title: string;
    artistName: string;
    albumName: string;
    artwork: string;
    /** 目录给的时长（ms）；专辑/播放列表是全部曲目的合集。 */
    durationMs?: number;
    /** 这一单预期会下多少首（专辑曲目数）。有它才能做「11/12，缺 #7」。 */
    expectedTracks?: number;
};

export type User = {
    id: number;
    username: string;
    /** scrypt hash, hex */
    hash: string;
    /** scrypt salt, hex */
    salt: string;
    createdAt: number;
};

type Db = {
    version: number;
    users: User[];
    jobs: Job[];
};

const DB_FILE = path.join(config.dataDir, "amdl-web.json");
const EMPTY: Db = { version: 1, users: [], jobs: [] };

function load(): Db {
    try {
        const raw = fs.readFileSync(DB_FILE, "utf8");
        const parsed = JSON.parse(raw) as Partial<Db>;
        return {
            version: 1,
            users: Array.isArray(parsed.users) ? parsed.users : [],
            jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
        };
    } catch {
        return structuredClone(EMPTY);
    }
}

let db: Db = load();

/** Atomic write: tmp file + rename, so a crash cannot truncate the store. */
function persist(): void {
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
}

export const store = {
    users(): User[] {
        return db.users;
    },
    userByName(name: string): User | undefined {
        return db.users.find((u) => u.username.toLowerCase() === name.toLowerCase());
    },
    userById(id: number): User | undefined {
        return db.users.find((u) => u.id === id);
    },
    addUser(username: string, hash: string, salt: string): User {
        const user: User = {
            id: nextId(db.users),
            username,
            hash,
            salt,
            createdAt: Date.now()
        };
        db.users.push(user);
        persist();
        return user;
    },
    setPassword(userId: number, hash: string, salt: string): void {
        const u = this.userById(userId);
        if (!u) return;
        u.hash = hash;
        u.salt = salt;
        persist();
    },

    /* ------------------------------------------------------------ 设置 */
    /* 说明：本服务不再持有可写的「站点设置」——下载语义全部以引擎 config.yaml 为准，
     * 网页只做只读展示，任务级选项随任务提交（见 ripper.ts / engineconf.ts）。 */

    jobs(): Job[] {
        return db.jobs;
    },
    job(id: number): Job | undefined {
        return db.jobs.find((j) => j.id === id);
    },
    addJob(
        userId: number,
        url: string,
        codec: string,
        options: Partial<JobOptions> = {},
        region?: RegionPlan,
        meta?: JobMeta
    ): Job {
        const job: Job = {
            id: nextId(db.jobs),
            userId,
            url,
            codec,
            options,
            ...(region ? { region } : {}),
            ...(meta ? { meta } : {}),
            status: "queued",
            createdAt: Date.now(),
            tracks: [],
            log: []
        };
        db.jobs.push(job);
        persist();
        return job;
    },
    updateJob(id: number, patch: Partial<Job>): Job | undefined {
        const job = this.job(id);
        if (!job) return undefined;
        Object.assign(job, patch);
        persist();
        return job;
    },
    appendLog(id: number, line: string): void {
        const job = this.job(id);
        if (!job) return;
        job.log.push(line);
        if (job.log.length > config.logLines) {
            job.log.splice(0, job.log.length - config.logLines);
        }
        // Log lines are high-frequency; persistence happens on status changes.
    },
    /**
     * 真的把任务记录删掉（不是改状态）。
     *
     * 调用方负责先确认它不在跑：`queue.cancelJob` 之后 `execute()` 仍会对同一个 id
     * 调 updateJob/appendLog，那些都是 no-op（job 已经查不到），不会把记录写回来。
     */
    deleteJob(id: number): Job | undefined {
        const i = db.jobs.findIndex((j) => j.id === id);
        if (i < 0) return undefined;
        const [job] = db.jobs.splice(i, 1);
        persist();
        return job;
    },
    /** 批量删除已结束（done/partial/failed/cancelled）的任务记录，返回删掉的数量。 */
    deleteFinished(): number {
        const before = db.jobs.length;
        db.jobs = db.jobs.filter((j) => !isFinished(j.status));
        const removed = before - db.jobs.length;
        if (removed > 0) persist();
        return removed;
    },
    flush(): void {
        persist();
    },
    /**
     * 音乐库的曲目列表。
     *
     * 封面有两条来源，按优先级取：
     *   1. **磁盘上音频同目录的 cover.jpg** —— 引擎下载时顺手写的，所以**历史任务也有封面**；
     *      不需要网络请求，也不需要回填任何任务元数据。
     *   2. 任务元数据里的模板（job.meta.artwork）—— 新任务建单时从目录探到的，
     *      指向 mzstatic 原图，分辨率更高，磁盘上没有时兜底。
     * 曲目自带的 artwork 若已存在则优先于两者。
     */
    allTracks(): Array<Track & { jobId: number; at: number }> {
        return db.jobs
            .flatMap((j) =>
                j.tracks.map((t) => ({
                    ...t,
                    /*
                     * 磁盘上有封面时给的是**文件系统路径**，由调用方（音乐库视图）
                     * 拼成 /api/cover?path=… —— 那条路由只暴露封面文件本身，
                     * 且做了落盘目录包含性校验，不把整个音乐目录变成可下载。
                     */
                    artwork: t.artwork ?? (coverBeside(t.path) || j.meta?.artwork || ""),
                    jobId: j.id,
                    at: j.finishedAt ?? j.createdAt
                }))
            )
            .sort((a, b) => b.at - a.at);
    }
};

function nextId(items: Array<{ id: number }>): number {
    return items.reduce((max, i) => Math.max(max, i.id), 0) + 1;
}
