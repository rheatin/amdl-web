/**
 * 电台的整首播放。
 *
 * ## 为什么需要这个模块
 *
 * 电台卡原本只播 30 秒试听片段（目录给的、不加密）。要听整首就必须真的下载解密 ——
 * 但这些歌是"顺手听听"，不该进音乐库、不该占落盘目录、也不该出现在任务列表里。
 *
 * 所以这里走一条**独立的临时管线**：
 *   引擎下载 + 解密到 `dataDir/radio/<id>/` → 转成 FLAC 进播放缓存 → 删掉临时目录。
 *
 * ## 与下载队列的关系
 *
 * 不复用 `queue.ts`：那个队列的语义是"用户明确要下的任务"，会写记录、发 SSE、
 * 统一文件权限、进音乐库。电台要的是相反的东西 —— 不留痕。
 * 但**并发必须串行**：引擎一次只跑一个（Apple 按 IP 限流，wrapper 也不宜并发解密），
 * 而用户快进时会连续触发好几个 prepare。所以这里用一条 promise 链把它们排队，
 * 同一首歌的重复请求直接共享在飞的那一个。
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { KEYS } from "./engineconf.js";
import { rip } from "./ripper.js";
import { transcodeToCache } from "./playcache.js";
import type { Job, Track } from "./store.js";

/** trackId → 已经准备好的 FLAC 绝对路径。`/api/play` 只认这里登记过的路径。 */
const ready = new Map<string, string>();
/** 在飞的准备任务，避免同一首歌被并发下载两次。 */
const inflight = new Map<string, Promise<string>>();
/** 引擎串行链（见文件头的说明）。 */
let chain: Promise<unknown> = Promise.resolve();

/** 临时下载目录（引擎的落盘位置）。 */
function workDir(trackId: string): string {
    return path.join(config.dataDir, "radio", trackId);
}

/**
 * 这个绝对路径是否允许被 `/api/play` 播出。
 *
 * 音乐库那条判定只看 `store.allTracks()`；电台曲目不在库里，所以要有这第二个来源。
 * 关键是它仍然只接受**我们自己登记过的**路径 —— 不能因为"支持电台"就把
 * `/api/play` 退化成任意文件读取。
 */
export function isRadioPlayable(absPath: string): boolean {
    for (const p of ready.values()) if (p === absPath) return true;
    return false;
}

/** 缓存里已有的话直接给（重启后会丢登记，届时重新准备一次即可）。 */
export function radioTrackFile(trackId: string): string | undefined {
    return ready.get(trackId);
}

/**
 * 准备一首电台曲目：下载解密 → FLAC → 清理临时文件。
 *
 * @param trackId 纯数字的 Apple 曲目 id
 * @param url     该曲的目录页 URL（引擎按 URL 工作）
 * @returns 可直接交给 `/api/play` 的 FLAC 绝对路径
 */
export function prepareRadioTrack(trackId: string, url: string): Promise<string> {
    if (!/^\d+$/.test(trackId)) return Promise.reject(new Error("无效的曲目 ID"));
    if (!/^https:\/\/(music\.apple\.com|beta\.music\.apple\.com)\/|^https:\/\/amp-api/i.test(url)) {
        return Promise.reject(new Error("不是 Apple Music 的曲目地址"));
    }

    const hit = ready.get(trackId);
    if (hit && fs.existsSync(hit)) return Promise.resolve(hit);

    const running = inflight.get(trackId);
    if (running) return running;

    const job = chain.then(() => doPrepare(trackId, url));
    chain = job.catch(() => undefined);
    inflight.set(trackId, job);
    job.finally(() => inflight.delete(trackId));
    return job;
}

/** 把四个落盘目录全指向这一首歌的临时目录，这样不管引擎选哪档都跑不出去。 */
function saveFolderOverrides(dir: string): Array<[string, string]> {
    return KEYS.saveFolders.map((k) => [k, dir] as [string, string]);
}

function findLandedAudio(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    /* 引擎会写标签与封面，落盘结构可能是 dir/艺人/专辑/曲.m4a */
    const walk = (d: string, depth: number): string | undefined => {
        if (depth > 5) return undefined;
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const f = path.join(d, ent.name);
            if (ent.isDirectory()) {
                const inner = walk(f, depth + 1);
                if (inner) return inner;
            } else if (/\.(m4a|mp4|m4v|mov|flac|wav|mp3|aac)$/i.test(ent.name)) {
                return f;
            }
        }
        return undefined;
    };
    return walk(dir, 0);
}

async function doPrepare(trackId: string, url: string): Promise<string> {
    const dir = workDir(trackId);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    /*
     * rip() 要一个 Job。这里造一个**永不入库**的假任务：
     * id 用负数，保证不会和真实任务（从 1 递增）撞上，也让人一眼看出是合成的。
     * codec 固定 alac —— 引擎会按 config.yaml 的上限自己降到能给的最好档位。
     */
    const job = {
        id: -Number(trackId),
        url,
        codec: "alac",
        options: {}
    } as unknown as Job;

    let landed: Track[] = [];
    try {
        const result = await rip(job, () => undefined, undefined, {
            dir,
            extraOverrides: saveFolderOverrides(dir)
        });
        landed = result.tracks ?? [];
        if (!result.ok && landed.length === 0) {
            throw new Error(result.error || "下载失败");
        }
    } catch (e) {
        /* 失败也要清临时目录 —— 半截文件留在数据目录里最容易被忘 */
        fs.rmSync(dir, { recursive: true, force: true });
        throw e;
    }

    const source = landed[0]?.path ?? findLandedAudio(dir);
    if (!source) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error("引擎没有产出文件");
    }

    const flac = await transcodeToCache(source, `radio-${trackId}`);
    ready.set(trackId, flac);

    /*
     * 删掉解密出来的原始文件：它躺在临时目录里，既占空间又可能在下次
     * 同名下载时被误认。FLAC 缓存才是播放要用的东西，已经另存了。
     */
    fs.rmSync(dir, { recursive: true, force: true });

    return flac;
}
