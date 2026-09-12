import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { applyFileModes } from "./filemode.js";
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

    store.updateJob(jobId, { status: "running", startedAt: Date.now(), error: undefined, tracks: [], log: [] });
    emit(jobId, { type: "status", status: "running", at: Date.now() });

    const result = await rip(job, (line) => {
        store.appendLog(jobId, line);
        emit(jobId, { type: "log", line, at: Date.now() });
    });

    if (result.ok) {
        // 引擎产出的是 0600；按 FILE_MODE 统一权限，否则媒体服务器（别的 uid）读不到
        const fixed = applyFileModes(result.tracks);
        if (fixed > 0 && config.fileMode !== null) {
            const line = `[amdl-web] 已把 ${fixed} 个文件权限设为 ${config.fileMode.toString(8)}`;
            store.appendLog(jobId, line);
            emit(jobId, { type: "log", line, at: Date.now() });
        }
        store.updateJob(jobId, {
            status: "done",
            finishedAt: Date.now(),
            tracks: result.tracks
        });
        store.flush();
        emit(jobId, { type: "status", status: "done", tracks: result.tracks.length, at: Date.now() });
    } else {
        store.updateJob(jobId, {
            status: "failed",
            finishedAt: Date.now(),
            error: result.error ?? "unknown error",
            tracks: result.tracks
        });
        store.flush();
        emit(jobId, {
            type: "status",
            status: "failed",
            error: result.error,
            tracks: result.tracks.length,
            at: Date.now()
        });
    }
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
