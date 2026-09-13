import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityFor, searchCatalog, ALL_CODECS } from "./ampmusic.js";
import {
    attachUser,
    clearSession,
    hashPassword,
    issueSession,
    requireAuth,
    seedAdmin,
    verifyPassword
} from "./auth.js";
import { config, language, storefront } from "./config.js";
import { explicitJobOptions } from "./jobopts.js";
import { enqueue, queueDepth, reconcileOnBoot, subscribe } from "./queue.js";
import { engineConfigPath } from "./ripper.js";
import { lyricOptionsFromConfig, maskConfigText, SECRET_KEYS, tryLoadEngineConfig } from "./engineconf.js";
import { store } from "./store.js";
import { parseAppleMusicUrl } from "./urlinfo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(here, "..", "views"));
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "64kb" }));
app.use("/static", express.static(path.join(here, "..", "public")));
app.use(attachUser);

// 供视图高亮当前导航项
app.use((req: Request, res: Response, next) => {
    res.locals.current = req.path;
    next();
});

// 静态资源版本号：内容一变就变 —— 否则浏览器会继续用缓存里的旧 app.js
// （曾导致「新功能已部署但界面上看不到」）。模板里以 ?v= 引用。
app.locals.assetVersion = ((): string => {
    try {
        const h = crypto.createHash("sha1");
        for (const f of ["app.js", "app.css"]) {
            h.update(fs.readFileSync(path.join(here, "..", "public", f)));
        }
        return h.digest("hex").slice(0, 8);
    } catch {
        return "dev";
    }
})();

/* ------------------------------------------------------------------ pages */

app.get("/login", (req: Request, res: Response) => {
    if (res.locals.user) {
        res.redirect("/");
        return;
    }
    res.render("login", {
        firstRun: store.users().length === 0,
        error: typeof req.query["error"] === "string" ? req.query["error"] : null
    });
});

app.post("/login", (req: Request, res: Response) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const user = store.userByName(username);
    if (!user || !verifyPassword(user, password)) {
        res.redirect("/login?error=invalid+credentials");
        return;
    }
    issueSession(res, user);
    res.redirect("/");
});

app.post("/logout", (req: Request, res: Response) => {
    clearSession(res);
    res.redirect("/login");
});

app.get("/", requireAuth, (_req: Request, res: Response) => {
    res.render("index", {
        jobs: store.jobs().slice(-8).reverse(),
        tracks: store.allTracks().slice(0, 8),
        queue: queueDepth(),
        // 表单里的歌词控件按 config.yaml 预填 —— 用户看到的就是真正生效的值
        opts: lyricOptionsFromConfig(),
        config
    });
});

app.get("/search", requireAuth, async (req: Request, res: Response) => {
    const q = String(req.query["q"] ?? "").trim();
    let results: Awaited<ReturnType<typeof searchCatalog>> = [];
    let error: string | null = null;
    if (q) {
        try {
            results = await searchCatalog(q);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
    }
    res.render("search", { q, results, error, config });
});

app.get("/jobs", requireAuth, (_req: Request, res: Response) => {
    const jobs = store.jobs().slice().reverse();
    const id = Number(_req.query["job"]);
    const selected = Number.isFinite(id) ? store.job(id) : jobs[0];
    res.render("jobs", { jobs, selected: selected ?? null, queue: queueDepth(), config });
});

app.get("/library", requireAuth, (_req: Request, res: Response) => {
    res.render("library", { tracks: store.allTracks(), musicDir: config.musicDir, config });
});

/**
 * 「设置」页 = 只读的配置视图。
 *
 * 这里刻意**不可编辑**：下载语义以引擎 config.yaml 为唯一出处（用户直接编辑文件），
 * 部署相关的参数在 .env 里。网页只告诉你「现在实际生效的是什么、在哪里改」，
 * 避免出现第二份真相（两份配置互相覆盖是之前踩过的坑）。
 */
app.get("/settings", requireAuth, (_req: Request, res: Response) => {
    const engine = tryLoadEngineConfig();
    res.render("settings", {
        config,
        queue: queueDepth(),
        storefront: storefront(),
        language: language(),
        engineFile: engine?.file ?? engineConfigPath(),
        engineText: engine ? maskConfigText(engine.text) : null,
        engineKeys: engine?.keys ?? [],
        secrets: SECRET_KEYS.map((k) => ({
            key: k,
            set: Boolean((engine?.values[k] ?? "").trim())
        }))
    });
});

/* -------------------------------------------------------------------- api */

app.get("/healthz", (_req: Request, res: Response) => {
    res.json({
        ok: true,
        queue: queueDepth(),
        jobs: store.jobs().length,
        liteServer: config.liteServer,
        engineBin: config.engineBin,
        musicDir: config.musicDir,
        storefront: storefront(),
        engineConfig: tryLoadEngineConfig()?.file ?? null
    });
});

app.post("/api/setup", (req: Request, res: Response) => {
    if (store.users().length > 0) {
        res.status(409).json({ error: "already initialised" });
        return;
    }
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (username.length < 2 || password.length < 8) {
        res.status(400).json({ error: "username >= 2 chars and password >= 8 chars required" });
        return;
    }
    const { hash, salt } = hashPassword(password);
    const user = store.addUser(username, hash, salt);
    issueSession(res, user);
    res.json({ ok: true, username: user.username });
});

app.post("/api/login", (req: Request, res: Response) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const user = store.userByName(username);
    if (!user || !verifyPassword(user, password)) {
        res.status(401).json({ error: "invalid credentials" });
        return;
    }
    issueSession(res, user);
    res.json({ ok: true, username: user.username });
});

app.post("/api/logout", (_req: Request, res: Response) => {
    clearSession(res);
    res.json({ ok: true });
});

app.get("/api/search", requireAuth, async (req: Request, res: Response) => {
    const q = String(req.query["q"] ?? "").trim();
    if (!q) {
        res.status(400).json({ error: "missing q" });
        return;
    }
    try {
        res.json({ results: await searchCatalog(q) });
    } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

app.get("/api/jobs", requireAuth, (_req: Request, res: Response) => {
    res.json({ jobs: store.jobs(), queue: queueDepth() });
});

/* --------------------------------------------------------- 配置（只读接口） */

/**
 * 只读地取回当前生效的配置，便于脚本/自检核对（凭据已打码）。
 * 没有写接口：改配置请编辑 config.yaml（下载语义）或 .env（部署），改完重启容器。
 */
app.get("/api/config", requireAuth, (_req: Request, res: Response) => {
    const engine = tryLoadEngineConfig();
    res.json({
        runtime: {
            port: config.port,
            dataDir: config.dataDir,
            musicDir: config.musicDir,
            engineDir: config.engineDir,
            engineBin: config.engineBin,
            liteServer: config.liteServer,
            wrapperDataDir: config.wrapperDataDir,
            concurrency: config.concurrency,
            jobTimeoutSec: config.jobTimeoutSec,
            logLines: config.logLines,
            fileMode: config.fileMode === null ? "keep" : config.fileMode.toString(8),
            sessionDays: config.sessionDays,
            trustProxy: config.trustProxy,
            proxy: config.httpsProxy || config.httpProxy || "",
            storefront: storefront(),
            language: language(),
            tz: process.env["TZ"] ?? ""
        },
        engineConfig: {
            file: engine?.file ?? engineConfigPath(),
            present: engine !== null,
            values: engine?.values ?? {}
        }
    });
});

/* --------------------------------------------------------------- 任务接口 */

/**
 * 单曲真实能力查询 —— 让界面里的编码选项来自 Apple 自己的 audioTraits，
 * 而不是三个硬编码选项。拿不到（播放列表/查询失败）时返回全部并附说明。
 */
app.get("/api/codecs", requireAuth, async (req: Request, res: Response) => {
    const raw = String(req.query["url"] ?? "").trim();
    const link = parseAppleMusicUrl(raw);

    if (!link.id) {
        res.json({ codecs: [...ALL_CODECS], note: link.note ?? "无法识别链接", resolved: link });
        return;
    }
    try {
        // 先用链接自带的地区查（/cn/ 的曲目查 /us/ 会 404），失败再试默认地区
        let cap = await capabilityFor(link.kind, link.id, link.storefront);
        if (!cap && link.storefront && link.storefront !== storefront()) {
            cap = await capabilityFor(link.kind, link.id);
        }
        if (!cap) {
            res.json({
                codecs: [...ALL_CODECS],
                note: link.note ?? `Apple 未返回该${link.kind}的能力信息`,
                resolved: link
            });
            return;
        }
        res.json({
            codecs: cap.codecs,
            traits: cap.traits,
            summary: cap.summary,
            source: cap.source,
            title: cap.name,
            artist: cap.artistName,
            album: cap.albumName,
            resolved: link
        });
    } catch (err) {
        res.json({
            codecs: [...ALL_CODECS],
            note: `查询能力失败：${err instanceof Error ? err.message : String(err)}`,
            resolved: link
        });
    }
});

/**
 * Apple 2FA relay.
 *
 * wrapper-lite reads the one-time code from `<base-dir>/2fa.txt` (lite/auth.cpp) and polls
 * that path while a login is pending, so the web UI can drop the code instead of the user
 * having to touch the NAS filesystem. Only that single fixed filename is ever written.
 */
app.post("/api/apple/2fa", requireAuth, (req: Request, res: Response) => {
    const code = String(req.body?.code ?? "").replace(/\D/g, "");
    if (code.length < 4 || code.length > 8) {
        res.status(400).json({ error: "验证码应为 4-8 位数字" });
        return;
    }
    const file = path.join(config.wrapperDataDir, "2fa.txt");
    try {
        fs.writeFileSync(file, code, { mode: 0o666 });
        // entrypoint.sh 会把该目录 chown 成 root，必须显式保住可写位，
        // 否则之后以 uid 1000 运行的进程（以及宿主机上的普通用户）都写不进去。
        fs.chmodSync(file, 0o666);
        res.json({ ok: true, file, hint: "wrapper-lite 会轮询该文件读取验证码" });
    } catch (err) {
        res.status(500).json({
            error: `无法写入 ${file}：${err instanceof Error ? err.message : String(err)}`
        });
    }
});

/**
 * 任务选项的**显式**覆盖 —— 只影响这一个任务，不落盘到任何配置文件（见 jobopts.ts）。
 */
app.post("/api/jobs", requireAuth, (req: Request, res: Response) => {
    const url = String(req.body?.url ?? "").trim();
    const codec = String(req.body?.codec ?? "alac").trim();
    if (!/^https?:\/\/(music|classical)\.apple\.com\//i.test(url)) {
        res.status(400).json({ error: "expected an https://music.apple.com/... link" });
        return;
    }
    if (!["alac", "atmos", "aac"].includes(codec)) {
        res.status(400).json({ error: "codec must be alac, atmos or aac" });
        return;
    }
    const user = res.locals.user as { id: number };
    // 未给出的键一律不写进任务配置 → 引擎用 config.yaml 的值
    const options = explicitJobOptions(req.body?.options);
    const job = store.addJob(user.id, url, codec, options);
    enqueue(job);
    res.status(201).json({ job });
});

/**
 * 重试：把原任务（同一个链接 / 编码 / 临时覆盖）克隆成一个新任务。
 *
 * 之所以「重试」够用而不需要「强制重下」：引擎遇到已存在的文件会先跳过
 * （`Track already exists locally.`），所以重跑一个专辑链接只会补上失败的那几首。
 * 而实测的失败原因是 Apple CDN 偶发掐断 HTTP/2 流，重跑一次通常就好了。
 */
app.post("/api/jobs/:id/retry", requireAuth, (req: Request, res: Response) => {
    const src = store.job(Number(req.params.id));
    if (!src) {
        res.status(404).json({ error: "no such job" });
        return;
    }
    if (src.status === "running" || src.status === "queued") {
        res.status(409).json({ error: "job is still active" });
        return;
    }
    const user = res.locals.user as { id: number };
    const job = store.addJob(user.id, src.url, src.codec, src.options ?? {});
    enqueue(job);
    res.status(201).json({ job });
});

app.delete("/api/jobs/:id", requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const job = store.job(id);
    if (!job) {
        res.status(404).json({ error: "no such job" });
        return;
    }
    if (job.status === "running" || job.status === "queued") {
        res.status(409).json({ error: "job is still active" });
        return;
    }
    job.status = "failed";
    store.flush();
    res.json({ ok: true });
});

/** Server-sent events: live engine output for one job. */
app.get("/api/jobs/:id/events", requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const job = store.job(id);
    if (!job) {
        res.status(404).end();
        return;
    }
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
    });

    const send = (data: unknown): void => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    /**
     * 顺序很讲究：**先订阅、再发 hello**。
     * hello 里带着完整的 job.log，客户端收到后是「覆盖式」渲染；
     * 若在 hello 之后再重放一遍 job.log（早先的实现就是这样），开头几行会在控制台上
     * 重复出现（用户实际看到过两遍「基线 = config.yaml…」）。
     * 但直接在订阅前发 hello 又会漏掉这两步之间产生的日志，所以先订阅、暂存、再补发。
     */
    let live = false;
    const staged: unknown[] = [];
    const unsubscribe = subscribe(id, (ev) => {
        if (live) send(ev);
        else staged.push(ev);
    });

    send({ type: "hello", job: store.job(id) ?? job, queue: queueDepth() });
    live = true;
    for (const ev of staged) send(ev);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

    req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
    });
});

/* ---------------------------------------------------------------- startup */

seedAdmin();
reconcileOnBoot();

app.listen(config.port, () => {
    console.log(`[amdl-web] listening on http://0.0.0.0:${config.port}`);
    console.log(`[amdl-web] engine=${config.engineBin} cwd=${config.engineDir} lite=${config.liteServer}`);
    console.log(`[amdl-web] music=${config.musicDir} data=${config.dataDir}`);
    if (store.users().length === 0) {
        console.log("[amdl-web] no users yet — open /login to create the first admin account");
    }
});
