/**
 * 找回「本次真正落盘」的曲目。
 *
 * 为什么需要它：引擎只有在**全部成功**时才在末尾打印 `--json` 汇总。只要有一首失败
 * （实测常见：Apple CDN 在最长的那首上把 HTTP/2 流掐了），它就打印
 * `Completed: 6/7 | Errors: 1` 后直接 `Error detected, exiting...` 退出 ——
 * 于是我们既不知道落盘清单，任务页也会显示 0 首，而**文件权限还会停在引擎默认的 0600**，
 * 以别的 uid 运行的媒体服务器（navidrome / jellyfin）读不到。
 *
 * 所以按 config.yaml 里的保存目录 + 本任务开始时间，把新写出来的文件找回来。
 * 判据是 mtime，而不是「猜文件名」——引擎的命名模板（artist/album/song 三段格式）可配置，
 * 猜路径迟早会错。
 */
import fs from "node:fs";
import path from "node:path";
import { configStrings } from "./engineconf.js";
import type { Track } from "./store.js";

const SAVE_KEYS = ["alac-save-folder", "atmos-save-folder", "aac-save-folder", "mv-save-folder"];
const AUDIO = /\.(m4a|mp4|m4v|mov|mp3|flac|wav|aac)$/i;
const MAX_DEPTH = 6;
const MAX_FILES = 5000;

/** 引擎配置里的落盘根目录（容器内路径；前端与引擎同容器，所以直接可读）。 */
export function saveDirs(): string[] {
    const v = configStrings(SAVE_KEYS);
    const out: string[] = [];
    for (const key of SAVE_KEYS) {
        const dir = (v[key] ?? "").trim();
        if (dir && !out.includes(dir)) out.push(dir);
    }
    return out;
}

/**
 * 由文件路径还原成展示用的曲目信息。
 *
 * 落盘布局是 `<save-folder>/<artist>/<album>/<song>.<ext>`（命名模板默认如此），
 * 单曲则是 `<save-folder>/<artist>/<album>/…`，播放列表/MV 会更浅或更深，
 * 因此层级不足时宁可留空，也不硬造一个错的艺术家名。
 */
export function trackFromPath(saveDir: string, file: string): Track {
    const rel = path.relative(saveDir, file);
    const parts = rel.split(path.sep);
    const stem = path.basename(file, path.extname(file));
    return {
        path: file,
        artist: parts.length >= 3 ? (parts[0] ?? "") : "",
        album: parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "",
        // 去掉文件名前缀的曲序（"01. " / "1-02 " / "03 - "）
        song: stem.replace(/^\d+\s*(?:[.\-‐–—]\s*|\s+)/, "").trim()
    };
}

/** 扫描落盘目录，返回 mtime 不早于 `sinceMs` 的音频文件。 */
export function discoverLandedTracks(sinceMs: number, dirs: string[] = saveDirs()): Track[] {
    const cutoff = sinceMs - 2000; // 给时钟误差留一点余地
    const found: Track[] = [];
    const seen = new Set<string>();

    // root 必须一直是最外层保存目录：trackFromPath 靠它算相对层级，
    // 传错成「当前递归到的目录」会把艺术家/专辑解析成空（被单测抓到过）。
    const walk = (dir: string, depth: number, root: string): void => {
        if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // 目录不存在/不可读（例如目录被换掉）时静默跳过
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(p, depth + 1, root);
                continue;
            }
            if (!entry.isFile() || !AUDIO.test(entry.name)) continue;
            if (seen.has(p)) continue;
            let mtime = 0;
            try {
                mtime = fs.statSync(p).mtimeMs;
            } catch {
                continue;
            }
            if (mtime < cutoff) continue;
            seen.add(p);
            found.push(trackFromPath(root, p));
            if (found.length >= MAX_FILES) return;
        }
    };

    for (const dir of dirs) walk(dir, 0, dir);
    return found;
}
