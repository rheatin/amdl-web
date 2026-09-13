import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Track } from "./store.js";

/**
 * 下载完成后统一文件权限。
 *
 * 引擎写出的音频是 0600（仅属主可读），而用户的媒体库惯例是 0666 ——
 * navidrome / jellyfin 常以别的 uid 运行，600 会让它们读不到新文件。
 * 除了本任务写出的音频，同目录下的**其它音频**与封面/歌词等旁挂文件也一并调整：
 * 重试只补一两首时，同专辑里先前下好的文件仍是 600，媒体服务器会「只读到半张专辑」。
 *
 * 由 FILE_MODE 控制（八进制字符串，默认 "666"；设为 "keep" 可关闭）。
 */
const SIDECAR = /\.(jpg|jpeg|png|webp|lrc|ttml|m3u8)$/i;
const AUDIO = /\.(m4a|mp4|m4v|mov|mp3|flac|wav|aac)$/i;

export function applyFileModes(tracks: Track[]): number {
    const mode = config.fileMode;
    if (mode === null) return 0;

    let changed = 0;
    const dirs = new Set<string>();

    for (const t of tracks) {
        if (!t.path) continue;
        if (chmod(t.path, mode)) changed++;
        dirs.add(path.dirname(t.path));
    }

    for (const dir of dirs) {
        let names: string[] = [];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if ((SIDECAR.test(name) || AUDIO.test(name)) && chmod(path.join(dir, name), mode)) changed++;
        }
    }

    return changed;
}

function chmod(p: string, mode: number): boolean {
    try {
        if ((fs.statSync(p).mode & 0o777) === mode) return false;
        fs.chmodSync(p, mode);
        return true;
    } catch {
        return false;
    }
}
