/**
 * 网页播放用的音频缓存。
 *
 * ## 为什么需要缓存，而不是直接把库里的文件发给浏览器
 *
 * 引擎落盘的是 **ALAC**（`.m4a`，MP4 封装）。实测浏览器能力：
 *
 *   MediaSource.isTypeSupported('audio/mp4; codecs="alac"')  → false
 *   MediaSource.isTypeSupported('audio/mp4; codecs="flac"')  → true
 *   audio.canPlayType('audio/flac')                          → "probably"
 *
 * 也就是说 ALAC 只有 Safari 系能放，Chrome / Firefox 完全不行。
 * FLAC 三家全支持，而且 **ALAC → FLAC 是无损且等价的**（都是无损编码，
 * 只是熵编码不同），所以这里做的是"换封装"，不是转码降质。
 *
 * 实测（NAS，5 分钟曲目）：ALAC→FLAC 1.1 s，ALAC→AAC 256k 10.3 s。
 * 无损比有损还快，因为 FLAC 只是重新熵编码，不用重采样也不用心理声学模型。
 *
 * ## 为什么不做"边转边播"（stream）
 *
 * 播放器要能拖进度条，这要求服务端支持 Range。流式转码的字节长度事先未知，
 * 没法给出 Content-Length，也支持不了任意位置 seek。落成文件后交给
 * express 的静态响应，Range / ETag / 206 全部免费。
 *
 * 1.1 秒的首次延迟可以接受（且可以预取下一首），换来的是完整的 seek 能力。
 *
 * ## 磁盘
 *
 * 无损文件不小（实测一首 5 分钟约 23 MB）。所以：
 *   · 只在真正播放时才生成，不预先转整库；
 *   · 超过上限按**最近最少使用**淘汰（见 evict）；
 *   · 源文件（ALAC）永远不动 —— 缓存删掉可以随时重建。
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** 缓存目录：`<DATA_DIR>/playcache`。 */
export function cacheDir(): string {
    return path.join(config.dataDir, "playcache");
}

/** 某个曲目的缓存文件路径。用 trackId 命名，避免路径里有中文/斜杠。 */
export function cachePath(trackId: string): string {
    return path.join(cacheDir(), `${trackId}.flac`);
}

/**
 * 缓存上限（字节）。
 *
 * 默认 8 GiB —— 大致对应 350 首无损。不需要精确：这是个软上限，
 * 淘汰在写入后触发，超出一点无所谓。
 */
function cacheLimitBytes(): number {
    const n = Number(process.env["PLAYCACHE_GB"] ?? "8");
    return (Number.isFinite(n) && n > 0 ? n : 8) * 1024 ** 3;
}

/** 缓存是否已就绪（文件存在且非空）。空文件说明上次转换中途挂了。 */
export function isCached(trackId: string): boolean {
    try {
        return fs.statSync(cachePath(trackId)).size > 0;
    } catch {
        return false;
    }
}

/**
 * 把源音频转成 FLAC 并写入缓存。
 *
 * 用 `-vn` 丢掉封面（m4a 里带 mjpeg 视频流，不丢的话 ffmpeg 会报
 * "video stream not supported in flac"）。封面由界面另外取。
 *
 * 先写 `.part` 再 rename：并发请求同一首或中途失败时，
 * 不会留下一个"看起来已缓存"的半截文件。
 *
 * @returns 缓存文件路径
 */
export async function transcodeToCache(sourceFile: string, trackId: string): Promise<string> {
    const out = cachePath(trackId);
    if (isCached(trackId)) return out;

    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${out}.part`;

    await new Promise<void>((resolve, reject) => {
        const ff = spawn(
            "ffmpeg",
            [
                "-y",
                "-v", "error",
                "-i", sourceFile,
                "-vn",                    // 丢掉内嵌封面（mjpeg）
                "-c:a", "flac",
                "-compression_level", "5",
                "-map_metadata", "0",     // 保留标签，播放器能显示标题/艺人
                "-f", "flac",
                tmp
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
        );

        let stderr = "";
        ff.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
        });
        ff.on("error", (e) => reject(new Error(`无法启动 ffmpeg：${e.message}`)));
        ff.on("close", (code) => {
            if (code === 0) return resolve();
            /* 保留 stderr 末尾 —— ffmpeg 的关键信息都在最后几行 */
            reject(new Error(`ffmpeg 转换失败（退出码 ${code}）：${stderr.slice(-400)}`));
        });
    });

    fs.renameSync(tmp, out);
    evict();
    return out;
}

/**
 * 按最近访问时间淘汰，直到总量低于上限。
 *
 * 用 atime 而不是 mtime：mtime 是生成时间，atime 是最后被读的时间 ——
 * 后者才是"最近听过"的正确信号。挂载时如果 atime 被禁用（relatime/noatime），
 * 退化成近似 LRU，对缓存来说够用。
 */
export function evict(): number {
    const dir = cacheDir();
    let entries: Array<{ file: string; size: number; at: number }>;
    try {
        entries = fs
            .readdirSync(dir)
            .filter((n) => n.endsWith(".flac"))
            .map((n) => {
                const f = path.join(dir, n);
                const st = fs.statSync(f);
                return { file: f, size: st.size, at: st.atimeMs };
            });
    } catch {
        return 0;
    }

    const limit = cacheLimitBytes();
    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= limit) return 0;

    entries.sort((a, b) => a.at - b.at); // 最久未读的先删
    let removed = 0;
    for (const e of entries) {
        if (total <= limit) break;
        try {
            fs.rmSync(e.file, { force: true });
            total -= e.size;
            removed++;
        } catch {
            /* 删不掉就跳过，别让一个坏文件阻断淘汰 */
        }
    }
    return removed;
}

/** 缓存用量统计（给设置页显示）。 */
export function cacheStats(): { files: number; bytes: number; limit: number } {
    const dir = cacheDir();
    let files = 0;
    let bytes = 0;
    try {
        for (const n of fs.readdirSync(dir)) {
            if (!n.endsWith(".flac")) continue;
            try {
                bytes += fs.statSync(path.join(dir, n)).size;
                files++;
            } catch {
                /* 并发删除时 stat 可能失败 */
            }
        }
    } catch {
        /* 目录还不存在 */
    }
    return { files, bytes, limit: cacheLimitBytes() };
}

/**
 * 缓存键：源文件路径的 sha1。
 *
 * 不直接用路径当文件名，原因有两个：
 *   · 中文/空格/斜杠在文件名里要么需要转义要么直接非法；
 *   · 客户端能传路径的话，就成了任意文件读写 —— 用哈希后服务端只认自己算出来的键。
 */
export function keyForPath(absPath: string): string {
    return crypto.createHash("sha1").update(absPath).digest("hex");
}

/**
 * 边转边发：ffmpeg 的输出同时写进缓存文件和调用方的回调。
 *
 * ## 为什么要这个
 *
 * `transcodeToCache` 要等整首转完才返回 —— 实测 4 分钟曲目 1.8 s，
 * 而且随曲长线性增长（10 分钟约 4 s）。用户点播放后要干等这么久。
 *
 * 但 FLAC 是**可流式**的（不需要 seektable），ffmpeg 写到 stdout 的第一个
 * 64 KB 只要 292 ms。所以首播走这条路：立刻出声，同时后台把整首落进缓存，
 * 下次就是 7 ms 的命中。
 *
 * ## 客户端中途断开怎么办
 *
 * 继续把 ffmpeg 读完并写完缓存 —— 断开的是浏览器，不是转码。
 * 这样用户拖回去再听、或者另一台设备来播，缓存都已经在。
 */
export async function transcodeStream(
    sourceFile: string,
    trackId: string,
    onChunk: (chunk: Buffer) => void,
    /**
     * 源时长（毫秒），来自建单时探到的目录信息。
     *
     * 有它就完全不碰 ffprobe：采样率从 FLAC 头里读，两者相乘即得总样本数。
     * 没有（老任务/元数据缺失）才回落到 ffprobe。
     */
    durationMs?: number
): Promise<string> {
    const out = cachePath(trackId);
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${out}.part`;

    /*
     * 管道输出的 FLAC 头里 total_samples 是 0，不补的话浏览器拿不到时长、
     * 进度条就废了（见 patchTotalSamples）。
     *
     * 有 durationMs 时不预先算：等第一个数据块到了，从它自己的头里读采样率，
     * 再乘时长。省掉一次 ffprobe（28 ms，占首播延迟的四分之一）。
     */
    let totalSamples = 0;
    if (durationMs === undefined || !(durationMs > 0)) {
        try {
            const { durationSec, sampleRate } = await probeAudio(sourceFile);
            totalSamples = Math.round(durationSec * sampleRate);
        } catch {
            /* 探不到就不补 —— 能播，只是没有时长，不该因此拒绝播放 */
        }
    }
    let patched = false;

    return new Promise<string>((resolve, reject) => {
        const ff = spawn(
            "ffmpeg",
            [
                "-y", "-v", "error",
                "-i", sourceFile,
                "-vn",
                "-c:a", "flac",
                "-compression_level", "5",
                "-map_metadata", "0",
                "-f", "flac",
                "-"
            ],
            { stdio: ["ignore", "pipe", "pipe"] }
        );

        const sink = fs.createWriteStream(tmp);
        let stderr = "";
        let settled = false;

        const fail = (e: Error) => {
            if (settled) return;
            settled = true;
            sink.destroy();
            fs.rmSync(tmp, { force: true });
            reject(e);
        };

        ff.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
        });

        ff.stdout.on("data", (chunk: Buffer) => {
            /* 只在第一个数据块上补头，且补一次就够 */
            if (!patched) {
                const total = totalSamples > 0
                    ? totalSamples
                    : Math.round(((durationMs ?? 0) / 1000) * flacSampleRate(chunk));
                if (total > 0) patched = patchTotalSamples(chunk, total);
            }
            sink.write(chunk);
            /*
             * 回调抛错（通常是响应已关闭）不该中断转码 —— 缓存还要写。
             * 所以这里吞掉异常，只记一次。
             */
            try {
                onChunk(chunk);
            } catch {
                /* 忽略：调用方会自己判断 */
            }
        });

        ff.on("error", (e) => fail(new Error(`无法启动 ffmpeg：${e.message}`)));
        ff.on("close", (code) => {
            if (settled) return;
            if (code !== 0) {
                fail(new Error(`ffmpeg 转换失败（退出码 ${code}）：${stderr.slice(-400)}`));
                return;
            }
            sink.end(() => {
                try {
                    fs.renameSync(tmp, out);
                } catch (e) {
                    fail(e as Error);
                    return;
                }
                settled = true;
                evict();
                resolve(out);
            });
        });
    });
}

/**
 * 读源文件的时长与采样率（不解码，几十毫秒）。
 *
 * 用途只有一个：补 FLAC 头里的 total_samples（见 patchTotalSamples）。
 */
export async function probeAudio(file: string): Promise<{ durationSec: number; sampleRate: number }> {
    return new Promise((resolve, reject) => {
        const ff = spawn("ffprobe", [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate,duration",
            "-of", "default=nw=1",
            file
        ], { stdio: ["ignore", "pipe", "pipe"] });

        let out = "";
        ff.stdout.on("data", (d: Buffer) => (out += d.toString()));
        ff.on("error", (e) => reject(new Error(`无法启动 ffprobe：${e.message}`)));
        ff.on("close", () => {
            const rate = Number(/sample_rate=(\d+)/.exec(out)?.[1] ?? 0);
            const dur = Number(/duration=([\d.]+)/.exec(out)?.[1] ?? 0);
            if (!rate || !dur) reject(new Error(`读不到音频参数：${out.trim()}`));
            else resolve({ durationSec: dur, sampleRate: rate });
        });
    });
}

/**
 * 从 FLAC 头读采样率（20 位，位于 byte 18..20 的高位）。
 *
 * 有了它就不必为"补总样本数"去起一个 ffprobe 子进程 —— 采样率本来就在
 * 我们要改的那几个字节旁边。实测 ffprobe 要 28 ms，而首播总延迟才 ~100 ms。
 */
export function flacSampleRate(buf: Buffer): number {
    if (buf.length < 21 || buf.subarray(0, 4).toString("latin1") !== "fLaC") return 0;
    return ((buf[18] ?? 0) << 12) | ((buf[19] ?? 0) << 4) | ((buf[20] ?? 0) >> 4);
}

/**
 * 把 FLAC 的 STREAMINFO.total_samples 补上。
 *
 * ## 为什么必须补
 *
 * ffmpeg 往**管道**写 FLAC 时写不出总样本数（管道不可 seek，它算不出最终长度），
 * 于是 STREAMINFO 里这一项是 0。后果很具体：浏览器拿不到 duration，
 * 进度条显示 0:00、也判定不了能不能 seek。
 *
 * 实测对比（同一首歌）：
 *   管道输出  … 12 00 12 00 00 00 00 00 6e 5a 0b b8 03 70 | 00 00 00 00 00 …
 *   文件输出  … 12 00 12 00 00 02 36 00 5e a8 0b b8 03 70 | 00 b0 25 c0 f6 …
 *                                                          ^^ total_samples
 *
 * ## 字段位置
 *
 * `fLaC`(4) + 块头(4) + STREAMINFO 前 10 字节之后是：
 *   byte 18..20  采样率(20 位) + 声道(3) + 位深(5) 的前半
 *   byte 21      位深低 4 位 + total_samples 的高 4 位
 *   byte 22..25  total_samples 的低 32 位
 * 所以 36 位的 total_samples = (b21 & 0x0F) << 32 | b22..b25。
 *
 * 只改这 5 个字节里的低位，其余（采样率、声道、位深）原样不动。
 */
export function patchTotalSamples(buf: Buffer, totalSamples: number): boolean {
    if (buf.length < 26) return false;
    if (buf.subarray(0, 4).toString("latin1") !== "fLaC") return false;

    const hi = (totalSamples / 0x100000000) & 0x0f;
    buf[21] = ((buf[21] ?? 0) & 0xf0) | hi;
    buf.writeUInt32BE(totalSamples >>> 0, 22);
    return true;
}
