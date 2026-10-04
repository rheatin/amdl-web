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

/**
 * 正在跑的引擎进程，按任务 id 索引 —— 取消要能真的把它杀掉（见 cancelJob / ripper.rip）。
 */
const controllers = new Map<number, AbortController>();

export function enqueue(job: Job): void {
    pending.push(job.id);
    pump();
}

/**
 * 取消一个任务。两种情形都算「取消成功」：
 *   * 还在排队 —— 从队列里摘掉，引擎根本不会启动；
 *   * 正在运行 —— abort 掉 kill 信号，ripper 会 SIGKILL 引擎，execute() 收尾时按 cancelled 落库。
 *
 * 返回 false 表示这个任务已经结束了（终态），没什么可取消的。
 */
export function cancelJob(id: number): boolean {
    const job = store.job(id);
    if (!job) return false;
    if (job.status !== "queued" && job.status !== "running") return false;

    const i = pending.indexOf(id);
    if (i >= 0) pending.splice(i, 1);

    // 先落库再 abort：这样页面立刻能看到「已取消」，而不用等引擎进程真的死掉
    store.updateJob(id, {
        status: "cancelled",
        finishedAt: Date.now(),
        error: job.status === "running" ? "已取消（引擎已终止，已下载的文件保留）" : "已取消（还没开始跑）"
    });
    store.flush();
    emit(id, { type: "status", status: "cancelled", error: "已取消", at: Date.now() });

    controllers.get(id)?.abort();
    return true;
}

/** 队列里还有没有这个 id（排队中或运行中）。 */
export function isActive(id: number): boolean {
    const job = store.job(id);
    return Boolean(job && (job.status === "running" || job.status === "queued")) || pending.includes(id);
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

    const controller = new AbortController();
    controllers.set(jobId, controller);

    const startedAt = Date.now();
    store.updateJob(jobId, { status: "running", startedAt, error: undefined, tracks: [], log: [] });
    emit(jobId, { type: "status", status: "running", at: Date.now() });

    const say = (line: string): void => {
        store.appendLog(jobId, line);
        emit(jobId, { type: "log", line, at: Date.now() });
    };

    const result = await rip(job, say, controller.signal);
    controllers.delete(jobId);

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

    /**
     * 取消过就别再按引擎的退出码判状态了：SIGKILL 出来的是非 0 码，
     * 直接走下面的分支会把用户主动取消写成「失败」，任务页与重试按钮都会说谎。
     * 已经落盘的曲目照样记上（取消不等于回滚）。
     */
    if (controller.signal.aborted) {
        store.updateJob(jobId, {
            status: "cancelled",
            finishedAt: Date.now(),
            error: `已取消 · ${tracks.length} 首已落盘（文件保留）`,
            tracks
        });
        store.flush();
        emit(jobId, { type: "status", status: "cancelled", error: "已取消", tracks: tracks.length, at: Date.now() });
        return;
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
