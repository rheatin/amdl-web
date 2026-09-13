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
 * 配置分层的落实点（见 config.ts 顶部说明）：
 *   基础 = 用户的 config.yaml **原样**（下载语义的唯一出处，注释与未知键都保留）；
 *   覆盖 = 只有两类：本服务必须掌握的键（lite-server / exit-on-error），
 *          以及本次任务**显式**给出的临时选项（歌词一族）。
 *   没被显式给出的键一律不动 —— 引擎会用 config.yaml 的值，绝不用本服务的内置默认值
 *   去覆盖用户的文件。
 *
 * Keeping this behind one module is deliberate: replacing the engine with a
 * hand-written ripper later means reimplementing only this file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { applyOverrides, loadEngineConfig, type OverrideValue } from "./engineconf.js";
import { store, type Job, type JobOptions, type Track } from "./store.js";

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

/** 本服务必须掌握的键（无论用户的 config.yaml 怎么写）。 */
const FORCED: Array<[string, OverrideValue]> = [
    ["lite-server", config.liteServer],
    ["exit-on-error", true] // 裸 bool：引擎的字段是 bool，写成字符串会解析失败
];

/** 任务选项 → 引擎键。只包含**本次任务显式给出**的键。 */
function jobOverrides(opts: Partial<JobOptions>): Array<[string, OverrideValue]> {
    const out: Array<[string, OverrideValue]> = [];
    if (opts.embedLrc !== undefined) out.push(["embed-lrc", opts.embedLrc]);
    if (opts.saveLrcFile !== undefined) out.push(["save-lrc-file", opts.saveLrcFile]);
    if (opts.lrcType !== undefined) out.push(["lrc-type", opts.lrcType]);
    if (opts.lrcExtra !== undefined) out.push(["lrc-extra", opts.lrcExtra]);
    if (opts.lrcFormat !== undefined) out.push(["lrc-format", opts.lrcFormat]);
    return out;
}

/**
 * 复制基础 config.yaml 并套用覆盖项，写入任务私有目录后返回该目录。
 * 覆盖方式见 engineconf.applyOverrides（逐行替换，未命中则追加，不解析整份 YAML）。
 */
export function writeJobConfig(job: Job): string {
    const base = loadEngineConfig(config.engineDir).text;
    const overrides = [...FORCED, ...jobOverrides(job.options ?? {})];

    const dir = jobConfigDir(job.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), applyOverrides(base, overrides));
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
        const shown = jobOverrides(job.options ?? {}).map(([k, v]) => `${k}=${v}`).join(" · ");
        onLine(`[amdl-web] 基线 = config.yaml（${engineConfigPath()}）` +
            (shown ? ` · 本任务覆盖：${shown}` : " · 本任务无覆盖项"));
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
