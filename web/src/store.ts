import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { RegionPlan } from "./region.js";

export type Track = {
    path: string;
    artist: string;
    album: string;
    song: string;
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
    status: JobStatus;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    tracks: Track[];
    /** Tail of the engine's output, for the live console. */
    log: string[];
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
        region?: RegionPlan
    ): Job {
        const job: Job = {
            id: nextId(db.jobs),
            userId,
            url,
            codec,
            options,
            ...(region ? { region } : {}),
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
    allTracks(): Array<Track & { jobId: number; at: number }> {
        return db.jobs
            .flatMap((j) => j.tracks.map((t) => ({ ...t, jobId: j.id, at: j.finishedAt ?? j.createdAt })))
            .sort((a, b) => b.at - a.at);
    }
};

function nextId(items: Array<{ id: number }>): number {
    return items.reduce((max, i) => Math.max(max, i.id), 0) + 1;
}
