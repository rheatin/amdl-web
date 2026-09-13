import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { applyFileModes } from "./filemode.js";
import { discoverLandedTracks } from "./landed.js";
import { rip } from "./ripper.js";
import { store, type Job, type JobStatus } from "./store.js";

export type JobEvent =
    | { type: "log"; line: string; at: number }
    | { type: "status"; status: JobStatus; error?: string; tracks?: number; at: number };

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function subscribe(jobId: number, listener: (ev: JobEvent) => void): () => void {
    const channel = `job:${jobId}`;
    bus.on(channel, listener);
    return () => bus.off(channel, listener);
}

function emit(jobId: number, ev: JobEvent): void {
    bus.emit(`job:${jobId}`, ev);
}

const pending: number[] = [];
let running = 0;

export function enqueue(job: Job): void {
    pending.push(job.id);
    pump();
}

function pump(): void {
    while (running < config.concurrency && pending.length > 0) {
        const id = pending.shift();
        if (id === undefined) return;
        running += 1;
        void execute(id).finally(() => {
            running -= 1;
            pump();
        });
    }
}

async function execute(jobId: number): Promise<void> {
    const job = store.job(jobId);
    if (!job) return;

    const startedAt = Date.now();
    store.updateJob(jobId, { status: "running", startedAt, error: undefined, tracks: [], log: [] });
    emit(jobId, { type: "status", status: "running", at: Date.now() });

    const say = (line: string): void => {
        store.appendLog(jobId, line);
        emit(jobId, { type: "log", line, at: Date.now() });
    };

    const result = await rip(job, say);

    if (result.summary) {
        const s = result.summary;
        say(`[amdl-web] 引擎汇总：完成 ${s.completed}/${s.total} · 警告 ${s.warnings} · 错误 ${s.errors}`);
    }

    /**
     * 有曲目失败时引擎不打印 `--json` 汇总，落盘清单得自己找回来（见 landed.ts）。
     * 这一步同时决定了任务状态：确实写出了文件 = 「部分完成」，而不是「失败」。
     */
    const tracks = result.tracks.length > 0 ? result.tracks : discoverLandedTracks(startedAt);
    if (!result.ok && result.tracks.length === 0 && tracks.length > 0) {
        say(`[amdl-web] 引擎未给出落盘清单，按 mtime 找回 ${tracks.length} 个文件`);
    }

    // 引擎产出的是 0600；按 FILE_MODE 统一权限，否则媒体服务器（别的 uid）读不到。
    // 成功与部分成功都要修：只补下载失败曲目的场景，权限尤其容易被漏掉。
    const fixed = applyFileModes(tracks);
    if (fixed > 0 && config.fileMode !== null) {
        say(`[amdl-web] 已把 ${fixed} 个文件权限设为 ${config.fileMode.toString(8)}`);
    }

    // 有文件落盘就算「部分完成」，哪怕引擎是崩溃退出、连汇总行都没有
    const status: JobStatus = result.ok ? "done" : tracks.length > 0 ? "partial" : "failed";
    const error = result.ok
        ? undefined
        : tracks.length > 0
            ? `部分完成：${tracks.length} 首已落盘${result.summary ? `（${result.summary.completed}/${result.summary.total}）` : ""}`
            : (result.error ?? "unknown error");

    store.updateJob(jobId, {
        status,
        finishedAt: Date.now(),
        error,
        tracks
    });
    store.flush();
    emit(jobId, { type: "status", status, error, tracks: tracks.length, at: Date.now() });
}

/** Jobs left "running"/"queued" by a restart are marked failed at boot. */
export function reconcileOnBoot(): void {
    for (const job of store.jobs()) {
        if (job.status === "running" || job.status === "queued") {
            store.updateJob(job.id, {
                status: "failed",
                finishedAt: Date.now(),
                error: "interrupted by restart"
            });
        }
    }
    store.flush();
}

export function queueDepth(): { pending: number; running: number } {
    return { pending: pending.length, running };
}
