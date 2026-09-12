/**
 * Ripper adapter: runs the apple-music-dl engine as a child process.
 *
 * Verified behaviour of the engine (from its source) that this adapter depends on:
 *   * `--json` makes it print the added tracks as a JSON array on stdout when it finishes;
 *     each element is { path, artist, artist_id, album, song }.
 *   * `--lite-server <url>` overrides the wrapper-lite endpoint for a single run.
 *   * codec flags: default = ALAC, `--atmos`, or `--aac`.
 *   * config.yaml must have `exit-on-error: true`, otherwise an error makes the engine
 *     print "press Enter to try again..." and block forever waiting on stdin.
 *   * config.yaml is read from the *process working directory* (os.ReadFile("config.yaml")),
 *     which is what makes per-job options possible: we materialise a private config.yaml
 *     for each job and run the engine with that directory as its cwd.
 *
 * Keeping this behind one module is deliberate: replacing the engine with a
 * hand-written ripper later means reimplementing only this file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { DEFAULT_JOB_OPTIONS, type Job, type JobOptions, type Track } from "./store.js";

export type RipResult = {
    ok: boolean;
    tracks: Track[];
    error?: string;
};

export function engineArgs(url: string, codec: string): string[] {
    const args = [url, "--json", "--lite-server", config.liteServer];
    if (codec === "atmos") args.push("--atmos");
    else if (codec === "aac") args.push("--aac");
    return args;
}

/** 单个任务的私有配置目录（引擎的 cwd，里面放它要读的 config.yaml）。 */
export function jobConfigDir(jobId: number): string {
    return path.join(config.dataDir, "jobcfg", String(jobId));
}

/**
 * 读取基础配置：优先 config.yaml，其次 config.example.yaml。
 *
 * 后者是必需的兜底 —— 若用户没有创建 config.yaml，bind mount 的目标会被 Docker
 * 建成**目录**，此时读 config.yaml 必然失败；有 example 兜底整套仍然可用。
 */
function readBaseConfig(): string {
    for (const name of ["config.yaml", "config.example.yaml"]) {
        const p = path.join(config.engineDir, name);
        try {
            if (fs.statSync(p).isFile()) return fs.readFileSync(p, "utf8");
        } catch {
            /* 试下一个 */
        }
    }
    throw new Error(`在 ${config.engineDir} 下找不到 config.yaml 或 config.example.yaml`);
}

/**
 * 复制基础 config.yaml 并按任务选项覆盖若干键，返回该目录。
 *
 * 覆盖方式刻意保持“朴素”：按 `^key:` 逐行替换字符串，不做 YAML 解析 —— 引擎的配置是
 * 扁平的 key: value 结构，这样既能保证未知键不丢失，也不引入额外依赖。
 */
export function writeJobConfig(job: Job): string {
    const opts: JobOptions = { ...DEFAULT_JOB_OPTIONS, ...(job.options ?? {}) };
    const base = readBaseConfig();

    const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;
    const overrides: Array<[string, string]> = [
        ["lite-server", q(config.liteServer)],
        ["embed-lrc", String(opts.embedLrc)],
        ["save-lrc-file", String(opts.saveLrcFile)],
        ["lrc-type", q(opts.lrcType)],
        ["lrc-extra", q(opts.lrcExtra)],
        ["lrc-format", q(opts.lrcFormat)]
    ];

    let out = base;
    for (const [key, value] of overrides) {
        const re = new RegExp(`^${key}:.*$`, "m");
        if (re.test(out)) out = out.replace(re, `${key}: ${value}`);
        else out += `${out.endsWith("\n") ? "" : "\n"}${key}: ${value}\n`;
    }

    const dir = jobConfigDir(job.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), out);
    return dir;
}

/**
 * Runs one rip to completion.
 * @param onLine  called for every stdout/stderr line (for the live console + SSE)
 */
export function rip(job: Job, onLine: (line: string) => void): Promise<RipResult> {
    const args = engineArgs(job.url, job.codec);

    let cwd = config.engineDir;
    try {
        cwd = writeJobConfig(job);
        onLine(`[amdl-web] 本次任务配置：歌词嵌入=${job.options?.embedLrc ?? true} · ` +
            `另存 lrc=${job.options?.saveLrcFile ?? false} · ` +
            `类型=${job.options?.lrcType ?? "lyrics"} · ` +
            `附加=${job.options?.lrcExtra || "无"} · 格式=${job.options?.lrcFormat ?? "lrc"}`);
    } catch (err) {
        onLine(`[amdl-web] 生成任务配置失败，回退到全局 config.yaml：${String(err)}`);
    }

    return new Promise<RipResult>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(config.engineBin, args, {
                cwd,
                env: { ...process.env, NO_COLOR: "1" },
                stdio: ["ignore", "pipe", "pipe"]
            });
        } catch (err) {
            resolve({ ok: false, tracks: [], error: `failed to spawn engine: ${String(err)}` });
            return;
        }

        const stdoutLines: string[] = [];
        let stderrTail = "";
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const finish = (result: RipResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };

        if (config.jobTimeoutSec > 0) {
            timer = setTimeout(() => {
                onLine(`[amdl-web] job exceeded ${config.jobTimeoutSec}s, killing engine`);
                child.kill("SIGKILL");
                finish({ ok: false, tracks: [], error: "timeout" });
            }, config.jobTimeoutSec * 1000);
        }

        const handle = (buf: Buffer, isErr: boolean): void => {
            const text = buf.toString("utf8");
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
                if (!line) continue;
                onLine(line);
                if (isErr) {
                    stderrTail = `${stderrTail}${line}\n`.slice(-4000);
                } else {
                    stdoutLines.push(line);
                    if (stdoutLines.length > 5000) stdoutLines.shift();
                }
            }
        };

        child.stdout?.on("data", (b: Buffer) => handle(b, false));
        child.stderr?.on("data", (b: Buffer) => handle(b, true));

        child.on("error", (err) => {
            finish({ ok: false, tracks: [], error: `engine error: ${err.message}` });
        });

        child.on("close", (code) => {
            const tracks = parseTracks(stdoutLines);
            if (code === 0) {
                finish({ ok: true, tracks });
                return;
            }
            const hint = stderrTail.trim().split("\n").slice(-6).join("\n");
            finish({
                ok: false,
                tracks,
                error: `engine exited with code ${code}${hint ? `\n${hint}` : ""}`
            });
        });
    });
}

/** The engine prints the JSON summary last; scan backwards for the first parsable array. */
export function parseTracks(lines: string[]): Track[] {
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 60; i--) {
        const line = (lines[i] ?? "").trim();
        if (!line.startsWith("[")) continue;
        try {
            const parsed = JSON.parse(line) as unknown;
            if (!Array.isArray(parsed)) continue;
            return parsed
                .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
                .map((t) => ({
                    path: typeof t["path"] === "string" ? t["path"] : "",
                    artist: typeof t["artist"] === "string" ? t["artist"] : "",
                    album: typeof t["album"] === "string" ? t["album"] : "",
                    song: typeof t["song"] === "string" ? t["song"] : ""
                }))
                .filter((t) => t.path !== "" || t.song !== "");
        } catch {
            /* not the summary line */
        }
    }
    return [];
}

export function engineConfigPath(): string {
    return path.join(config.engineDir, "config.yaml");
}
