import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    capabilityFor,
    searchCatalog,
    ALL_CODECS,
    songFormats,
    withFormats,
    collectionTracks,
    collectionFormats,
    formatsFromCatalog,
    musicVideoInfo,
    SEARCH_TYPES,
    SEARCH_TRACK_PROBE_LIMIT,
    type TrackCapability
} from "./ampmusic.js";
import { presentFormat, type AudioFormatView } from "./audioformat.js";
import { mapLimit } from "./concurrency.js";
import type { AudioFormat } from "./format.js";

/**
 * 音乐视频的「编码」标识。
 *
 * 它**不是**编码 —— MV 由链接决定，引擎不需要任何标志。之所以仍然放进 codec 字段：
 * 任务记录、重试、界面都需要一个单一的字段来表达"这个任务下的是什么"，
 * 为 MV 新开一套字段只会让每个消费点都要判断两种形状。
 */
const MV_CODEC = "mv";
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
import { cancelJob, enqueue, isActive, queueDepth, reconcileOnBoot, subscribe } from "./queue.js";
import { resolveRegionPlan, regionLabel, type RegionDeps, type RegionPlan } from "./region.js";
import { engineConfigPath, removeJobConfigDir } from "./ripper.js";
import { lyricOptionsFromConfig, maskConfigText, SECRET_KEYS, tryLoadEngineConfig } from "./engineconf.js";
import { store } from "./store.js";
import { normalizeRegion, parseAppleMusicUrl } from "./urlinfo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
/** 导出给测试用（test/search-stream.test.mjs 自己 listen 到一个随机端口）。 */
export { app };

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
//
// 把 public/ 下**所有**文件都算进去，而不是写死 ["app.js","app.css"]：
// 漏掉一个文件名就等于「改了它但版本号不变」——search.js 就正好踩过这个坑。
// 文件名也参与哈希，这样增删文件同样会推动版本号。
app.locals.assetVersion = ((): string => {
    try {
        const dir = path.join(here, "..", "public");
        const h = crypto.createHash("sha1");
        for (const f of fs.readdirSync(dir).sort()) {
            const abs = path.join(dir, f);
            if (!fs.statSync(abs).isFile()) continue;
            h.update(f);
            h.update(fs.readFileSync(abs));
        }
        return h.digest("hex").slice(0, 8);
    } catch {
        return "dev";
    }
})();

/* ------------------------------------------------- 页面用的音质明细小工具 */

/**
 * 给搜索结果补上音质明细，供视图直接渲染。
 *
 * 设计约束：
 *   * **不用 traits 猜数字**。位深/采样率只有 master playlist 说得准，所以这里真的去取；
 *     取不到就是空数组，视图显示"未取到"，而不是硬写一个 16/44.1。
 *   * 探测失败**不能让搜索页报错** —— 音质是附加信息，目录搜索结果本身才是主功能。
 *   * 只对 `song`/`album` 探测：artist 没有音质可言，music-video 走的是视频轨道
 *     （MV 没有位深/采样率，界面上给一个"下载 MV"按钮即可）。
 *   * 交给视图的必须是 presentFormat 的**呈现形态**（含 detail/label），
 *     不是原始 AudioFormat —— 否则 EJS 里取 f.detail 全是空字符串（上线时实测到过）。
 *   * 曲目**优先用目录直接给的 enhancedHls**（搜索响应里就有，约 100ms），
 *     不去问 wrapper-lite（每次约 780ms）。这是搜索从 19 秒降到几秒的关键。
 *   * 仍要限并发并给专辑设首数上限：12 条结果各拉整张专辑的清单，不加约束同样会拖垮页面。
 */
const SEARCH_PROBE_LIMIT = 3;

async function decorateFormats(
    items: Array<{ id: string; type: string; enhancedHls?: string }>,
    storefrontOverride?: string
): Promise<Array<{ formats: AudioFormatView[] }>> {
    const empty = { formats: [] as AudioFormatView[] };
    return mapLimit(items, SEARCH_PROBE_LIMIT, async (item) => {
        if (!/^\d+$/.test(item.id)) return empty;
        try {
            if (item.type === "song") {
                const formats = await formatsFromCatalog(item.id, item.enhancedHls, storefrontOverride);
                return { formats: formats.map(presentFormat) };
            }
            if (item.type === "album") {
                const tracks = await collectionTracks("albums", item.id, storefrontOverride);
                const formats = await collectionFormats(tracks, SEARCH_TRACK_PROBE_LIMIT, storefrontOverride);
                return { formats: formats.map(presentFormat) };
            }
            return empty;
        } catch {
            return empty;
        }
    });
}

async function decorateSearchResults<T extends { id: string; type: string; enhancedHls?: string }>(
    results: T[],
    storefrontOverride?: string
): Promise<Array<T & { formats: AudioFormatView[] }>> {
    const quality = await decorateFormats(results, storefrontOverride);
    return results.map((r, i) => ({ ...r, ...(quality[i] ?? { formats: [] }) }));
}

/**
 * 单曲的音质明细（解析链接预览用）。非法 id 直接返回空 —— 不拿一个空 id 去打 wrapper。
 * 专辑/播放列表走 ampmusic.withFormats（逐曲探测再合并）。
 */
async function formatsFor(id: string): Promise<AudioFormat[]> {
    if (!/^\d+$/.test(id)) return [];
    try {
        return await songFormats(id);
    } catch {
        return [];
    }
}

/**
 * 探测音质的总时限：宁可界面先出来显示"未知"，也不要卡住整个解析预览。
 * 专辑/播放列表是逐曲探测的，长列表下这个兜底保证预览不会无限期挂着。
 */
const FORMAT_PROBE_BUDGET_MS = 20_000;

async function attachFormats(cap: TrackCapability, storefrontOverride?: string): Promise<TrackCapability> {
    const budget = new Promise<TrackCapability>((resolve) =>
        setTimeout(() => resolve(cap), FORMAT_PROBE_BUDGET_MS)
    );
    try {
        return await Promise.race([withFormats(cap, storefrontOverride), budget]);
    } catch {
        return cap;
    }
}

/* ------------------------------------------------------------ 流式搜索结果 */

/**
 * 渲染一个 EJS 片段（partial）为字符串。
 *
 * 为什么要 `res.render` 的路径而不是另一套模板引擎：流式接口必须产出与搜索页**同一种**
 * 标记（见 views/partials/result-item.ejs 的注释）。用别的渲染方式就等于把「一行结果长什么样」
 * 抄第二遍，改一处漏一处。
 */
function renderPartial(res: Response, name: string, locals: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
        res.render(name, { ...locals, config }, (err: Error | null, html?: string) => {
            if (err) reject(err);
            else resolve(html ?? "");
        });
    });
}

/**
 * 把搜索结果**流式**推给浏览器（NDJSON，一行一个事件）。
 *
 * 用户的原始抱怨是「没有任何状态显示，按钮也没有灰，一定是请求完才显示结果」——
 * 根因是搜索页把目录搜索（约 3 秒）与 12 条结果的音质探测（每条 0.78 秒、并发上限 3，
 * 实测十几秒）串在一次服务端渲染里，期间浏览器只能盯着上一页。
 *
 * 于是拆成两个阶段，阶段之间**不再有整体等待**：
 *   * 阶段一 `meta` → `total` → 逐条 `card`（目录搜索一回来就发，界面立刻有东西）
 *   * 阶段二 逐条 `fill`（探测完一条回填一条：用 3 个 worker 抢队列，谁先回来谁先发）
 *
 * 记号：`card` 里 song/album 的音质区渲染成骨架（`data-fill-id`），`fill` 事件把骨架换掉。
 * 之所以要 `pendingFill` 兜底：`card` 与它的 `fill` 可能落在同一个 TCP 分片里，
 * 浏览器若先读到 fill，`[data-fill-id="…"]` 还不存在 —— 丢掉就等于这一条永远是骨架。
 *
 * 客户端断开（用户按了 Esc、关了标签）时写会抛错，这里一律当成"提前收工"，
 * 不再继续探测后面的条目 —— 没人在等的 wrapper 请求不该继续占用 NAS。
 */
async function streamSearchResults(req: Request, res: Response, q: string, region: string): Promise<void> {
    res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
        // 反向代理/隧道不要缓冲：x-accel-buffering 给 nginx，no-transform 给中间层
        "x-accel-buffering": "no",
        connection: "keep-alive"
    });
    let alive = true;
    const write = (obj: unknown): boolean => {
        if (!alive) return false;
        try {
            res.write(`${JSON.stringify(obj)}\n`);
            return true;
        } catch {
            alive = false;
            return false;
        }
    };
    const end = (): void => {
        if (!alive) return;
        alive = false;
        try {
            res.end();
        } catch {
            /* 连接已经没了 */
        }
    };
    const onClose = (): void => {
        alive = false;
    };
    req.on("close", onClose);

    // 心跳：目录搜索阶段可能几秒没有任何字节，代理与浏览器都更容易把这种连接当死连接。
    // 注释行不是合法 JSON，客户端会直接忽略 —— 与 jobs 的 SSE 用同一套约定。
    const beat = setInterval(() => {
        if (!alive || res.writableEnded) {
            alive = false;
            return;
        }
        try {
            res.write(": ping\n\n");
        } catch {
            alive = false;
        }
    }, 15_000);

    // 客户端还没走到对应 card 的 fill（见上面的分片说明）
    const pendingFill = new Map<string, string>();

    try {
        write({ t: "meta", q, region: region || "", regionName: regionLabel(region || storefront()) });

        let items: Awaited<ReturnType<typeof searchCatalog>> = [];
        try {
            items = await searchCatalog(q, SEARCH_TYPES, 12, region || undefined);
        } catch (err) {
            write({ type: "error", message: err instanceof Error ? err.message : String(err) });
            return;
        }
        if (!alive) return;
        write({ type: "total", total: items.length });

        const fillHtml = async (r: (typeof items)[number], formats: AudioFormatView[]): Promise<string> =>
            renderPartial(res, "partials/result-item", {
                r: { ...r, formats },
                region,
                formatsFill: false
            });

        // 阶段一：目录结果先全部落地（骨架），顺序与目录返回一致
        for (const r of items) {
            if (!alive) return;
            let html = "";
            try {
                html = await renderPartial(res, "partials/result-item", { r, region, formatsFill: true });
            } catch {
                html = "";
            }
            if (!alive) return;
            if (html) write({ t: "card", id: String(r.id), html });
            const ready = pendingFill.get(String(r.id));
            if (ready) {
                pendingFill.delete(String(r.id));
                write({ t: "fill", id: String(r.id), html: ready });
            }
        }

        // 阶段二：只对 song/album 探测（artist 没有音质，MV 走视频轨道）。
        // 用 3 个消费者抢同一条队列，而不是 mapLimit —— 后者要等整批跑完才返回，
        // 又会变回"最后一条决定一切"。并发上限的用意见 concurrency.ts（保护同一台 NAS 上的 wrapper）。
        const queue = items
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => r.type === "song" || r.type === "album");
        let cursor = 0;
        const workers = Array.from({ length: Math.min(SEARCH_PROBE_LIMIT, queue.length) }, async () => {
            for (;;) {
                if (!alive) return;
                const idx = cursor++;
                if (idx >= queue.length) return;
                const { r } = queue[idx]!;
                if (!/^\d+$/.test(r.id)) continue;
                let formats: AudioFormatView[] = [];
                try {
                    const one = await decorateFormats([{ id: r.id, type: r.type, enhancedHls: r.enhancedHls }], region || undefined);
                    formats = one[0]?.formats ?? [];
                } catch {
                    formats = [];
                }
                if (!alive) return;
                let html: string;
                try {
                    html = await fillHtml(r, formats);
                } catch {
                    continue;
                }
                if (!alive) return;
                if (!write({ t: "fill", id: String(r.id), html })) pendingFill.set(String(r.id), html);
            }
        });
        await Promise.all(workers);
        if (!alive) return;
        write({ t: "done" });
    } finally {
        clearInterval(beat);
        req.off("close", onClose);
        end();
    }
}

/** 搜索结果的流式接口：搜索页在有 JS 时走这条；没有 JS 仍是 /search 的服务端渲染。 */
app.get("/search/results/stream", requireAuth, async (req: Request, res: Response) => {
    const q = String(req.query["q"] ?? "").trim();
    const region = normalizeRegion(req.query["region"]) ?? "";
    if (!q) {
        res.status(400).json({ error: "missing q" });
        return;
    }
    await streamSearchResults(req, res, q, region);
});

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

/**
 * 搜索页：**按商店搜索**（与概览页共用同一个地区选择器）。
 *
 * 为什么搜索也需要选商店：Apple 的目录分商店，同一首歌在不同商店的元数据写法不同
 * （`Hanabira` / `はなびら`）。只搜默认商店，就永远搜不到日文原名那一条记录 ——
 * 而这正是「想要日文名」时最该先做的事。搜索结果里的链接自带该商店的地区段，
 * 所以点下载时服务端只会判定「与链接一致」，不会多一次改写或探测。
 */
app.get("/search", requireAuth, async (req: Request, res: Response) => {
    const q = String(req.query["q"] ?? "").trim();
    const region = normalizeRegion(req.query["region"]) ?? "";
    let results: Awaited<ReturnType<typeof searchCatalog>> = [];
    let error: string | null = null;
    if (q) {
        try {
            // music-videos 一起搜：目录把它当独立类型，不显式请求就不会出现在结果里。
            // 排序仍由 searchCatalog 保证（song → album → artist → music-video）。
            results = await searchCatalog(q, SEARCH_TYPES, 12, region || undefined);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
    }

    // 每条结果挂上音质明细（位深/采样率/Hi-Res/Atmos）。
    // 这是本页唯一会"变慢"的地方：并发限 3、专辑只探前 2 首、songFormats 自带 10 分钟缓存。
    // 首次搜索大约多等几秒，之后同一曲目基本不再打 wrapper。
    //
    // `stream=1` 表示"客户端会自己去 /search/results/stream 取"（见 public/search.js），
    // 这条路径必须立刻返回：否则用户还是要等这十几秒才看得到页面，等于白做流式。
    // 代价是这一次渲染没有结果 —— 客户端在首帧之后马上把流接上，观感上就是"先出页面，再出结果"。
    // 没有 JS 的客户端不带这个参数，走的仍是原来那套完整服务端渲染。
    const streaming = req.query["stream"] === "1";
    const withQuality = streaming ? results : await decorateSearchResults(results, region || undefined);

    res.render("search", {
        q,
        results: withQuality,
        error,
        region,
        // 两个都是**字符串**（视图直接显示，不要再当函数调）：
        // regionName = 本次实际搜索的商店，defaultRegionName = 配置里的默认商店
        regionName: regionLabel(region || storefront()),
        defaultRegionName: regionLabel(storefront()),
        config
    });
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
 * 元数据地区探测的真实依赖（计划逻辑在 region.ts，依赖注入以便离线单测）。
 *
 * 三态来自 amp-api 的既有约定（见 ampmusic.catalogGet）：
 *   200 → 有记录；404 → 返回 null（该区没有）；其它异常 → 抛错（查不动）。
 */
const regionDeps: RegionDeps = {
    async track(kind, id, region) {
        const cap = await capabilityFor(kind, id, region);
        return cap
            ? { name: cap.name, artistName: cap.artistName, durationMs: cap.durationMs }
            : null;
    },
    async search(term, region) {
        const items = await searchCatalog(term, "songs", 25, region);
        return items
            .filter((i) => i.type === "song" || i.type === "songs")
            .map((i) => ({
                id: i.id,
                name: i.name,
                artistName: i.artistName,
                albumName: i.albumName,
                url: i.url,
                durationMs: i.durationMs
            }));
    }
};

/** 解析「这次用哪个地区/哪个 URL」，失败也不抛给路由 —— 一律退化成「跟随链接」。 */
async function planRegion(
    url: string,
    requested: unknown,
    autoMatch: boolean
): Promise<RegionPlan> {
    try {
        return await resolveRegionPlan(
            url,
            requested,
            { autoMatch, defaultRegion: storefront() },
            regionDeps
        );
    } catch (err) {
        // resolveRegionPlan 已自行兜住探测异常；走到这里说明出了意料之外的问题，
        // 那就当作用户没选地区（绝不因为一个附加功能让建任务失败）。
        return {
            originalUrl: url,
            effectiveUrl: url,
            requested: normalizeRegion(requested) ?? "",
            effective: parseAppleMusicUrl(url).storefront ?? "",
            changed: false,
            fallback: true,
            reason: "probe_failed",
            note: `地区处理失败（${err instanceof Error ? err.message : String(err)}），已按原链接执行。`
        };
    }
}

/**
 * 单曲真实能力查询 —— 让界面里的编码选项来自 Apple 自己的 audioTraits，
 * 而不是三个硬编码选项。拿不到（播放列表/查询失败）时返回全部并附说明。
 *
 * 这里同时返回**地区计划**（requested/effective/fallback/note），
 * 于是「选了日区但日区没有 → 会回退」这件事在**点下载之前**就能看到。
 *
 * 另外返回 `formats` —— 每个可用变体的**位深与采样率**（以及 Hi-Res / Dolby Atmos 判定）。
 * 它来自 master playlist 的 SAMPLE-RATE/BIT-DEPTH，是 audioTraits 给不出的信息。
 *
 * 音乐视频（`/music-video/...`）单独走一支：MV 是视频，没有位深/采样率可言，
 * 也不需要选编码（引擎按 URL 自行分派到 MV 下载）。返回 `musicVideo: true` +
 * `codecs: ["mv"]`，界面据此换掉编码选择器。
 */
app.get("/api/codecs", requireAuth, async (req: Request, res: Response) => {
    const raw = String(req.query["url"] ?? "").trim();
    const link = parseAppleMusicUrl(raw);
    const plan = await planRegion(raw, req.query["region"], req.query["autoMatch"] === "1");

    if (!link.id) {
        res.json({ codecs: [...ALL_CODECS], note: link.note ?? "无法识别链接", resolved: link, plan });
        return;
    }
    // 自动匹配换的是**另一条记录**，能力/标题要按匹配到的那条查，否则界面会自相矛盾
    const probeKind = plan.reason === "matched" && plan.match ? "song" : link.kind;
    const probeId = plan.reason === "matched" && plan.match ? plan.match.id : link.id;

    // ---- 音乐视频：不查 audioTraits（那不是音频），只取标题/艺人用于确认 ----
    if (link.kind === "music-video") {
        try {
            const mv = await musicVideoInfo(probeId, plan.effective || link.storefront);
            res.json({
                codecs: [MV_CODEC],
                musicVideo: true,
                title: mv?.name ?? "",
                artist: mv?.artistName ?? "",
                album: mv?.albumName ?? "",
                summary: "音乐视频（MV）",
                source: "音乐视频",
                resolved: link,
                plan
            });
        } catch (err) {
            // 取不到元数据不影响建任务 —— 引擎只按 URL 工作
            res.json({
                codecs: [MV_CODEC],
                musicVideo: true,
                summary: "音乐视频（MV）",
                note: `未能取到视频信息（${err instanceof Error ? err.message : String(err)}），仍可直接下载`,
                resolved: link,
                plan
            });
        }
        return;
    }

    try {
        // 先按实际会取数的地区查（链接自带的地区 / 用户选的地区），失败再试配置里的地区
        let cap = await capabilityFor(probeKind, probeId, plan.effective || link.storefront);
        if (!cap && plan.effective && plan.effective !== storefront()) {
            cap = await capabilityFor(probeKind, probeId, storefront());
        }
        if (!cap) {
            res.json({
                codecs: [...ALL_CODECS],
                formats: await formatsFor(probeId),
                note: link.note ?? `Apple 未返回该${link.kind}的能力信息`,
                resolved: link,
                plan
            });
            return;
        }
        const withQuality = await attachFormats(cap, plan.effective || link.storefront);
        res.json({
            codecs: withQuality.codecs,
            traits: withQuality.traits,
            summary: withQuality.summary,
            source: withQuality.source,
            title: withQuality.name,
            artist: withQuality.artistName,
            album: withQuality.albumName,
            formats: withQuality.formats.map(presentFormat),
            resolved: link,
            plan
        });
    } catch (err) {
        res.json({
            codecs: [...ALL_CODECS],
            note: `查询能力失败：${err instanceof Error ? err.message : String(err)}`,
            resolved: link,
            plan
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
 *
 * 另外接受两个「地区」字段（不是引擎配置键，引擎按 URL 取地区，见 region.ts）：
 *   region    —— 目标目录地区（两位小写字母；空 = 跟随链接）
 *   autoMatch —— 目标区没有时，是否允许换用「艺人 + 时长一致」的另一条记录
 * 服务端把 URL 改写好之后再入队，并且**把实际执行的 URL 存进任务**，
 * 因此重试不会重新探测（目录会变，重试不该漂到别的地区）。
 */
app.post("/api/jobs", requireAuth, async (req: Request, res: Response) => {
    const url = String(req.body?.url ?? "").trim();
    let codec = String(req.body?.codec ?? "alac").trim();
    if (!/^https?:\/\/(music|classical)\.apple\.com\//i.test(url)) {
        res.status(400).json({ error: "expected an https://music.apple.com/... link" });
        return;
    }
    // MV 由**链接**决定，不由 codec 决定：引擎按 URL 里的 /music-video/ 自行分派。
    // 所以贴 MV 链接时即使前端传了 alac 也强制成 mv，避免任务记录写着"alac"、
    // 实际却下了个视频（那会让任务页与重试按钮都在说谎）。
    if (parseAppleMusicUrl(url).kind === "music-video") codec = MV_CODEC;

    if (![...ALL_CODECS, MV_CODEC].includes(codec as never)) {
        res.status(400).json({ error: `codec must be one of ${[...ALL_CODECS, MV_CODEC].join(", ")}` });
        return;
    }
    const rawRegion = req.body?.region;
    const regionGiven = rawRegion === undefined || rawRegion === null ? "" : String(rawRegion).trim();
    if (regionGiven !== "" && !normalizeRegion(regionGiven)) {
        res.status(400).json({ error: "region must be a 2-letter code such as jp" });
        return;
    }

    const user = res.locals.user as { id: number };
    // 未给出的键一律不写进任务配置 → 引擎用 config.yaml 的值
    const options = explicitJobOptions(req.body?.options);
    const plan = await planRegion(url, regionGiven, req.body?.autoMatch === true);
    const job = store.addJob(user.id, plan.effectiveUrl, codec, options, plan);
    enqueue(job);
    res.status(201).json({ job });
});

/**
 * 重试：把原任务（同一个链接 / 编码 / 临时覆盖 / 元数据地区）克隆成一个新任务。
 *
 * 之所以「重试」够用而不需要「强制重下」：引擎遇到已存在的文件会先跳过
 * （`Track already exists locally.`），所以重跑一个专辑链接只会补上失败的那几首。
 * 而实测的失败原因是 Apple CDN 偶发掐断 HTTP/2 流，重跑一次通常就好了。
 *
 * 地区：直接复用原任务记录里的 `region`（其 effectiveUrl 就是当初实际执行的 URL），
 * **不重新探测** —— 目标区目录会随时间变化，让重试漂到另一个地区/另一条记录是不对的。
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
    const job = store.addJob(user.id, src.url, src.codec, src.options ?? {}, src.region);
    enqueue(job);
    res.status(201).json({ job });
});

/**
 * 取消任务：排队中的直接摘掉，运行中的 SIGKILL 掉引擎（见 queue.cancelJob）。
 * 已经结束的任务返回 409 —— 前端只在 queued/running 时显示这个按钮。
 */
app.post("/api/jobs/:id/cancel", requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const job = store.job(id);
    if (!job) {
        res.status(404).json({ error: "no such job" });
        return;
    }
    if (!cancelJob(id)) {
        res.status(409).json({ error: `job is already ${job.status}` });
        return;
    }
    res.json({ ok: true, job: store.job(id) });
});

app.delete("/api/jobs/:id", requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const job = store.job(id);
    if (!job) {
        res.status(404).json({ error: "no such job" });
        return;
    }
    /**
     * 运行中/排队中的**不能直接删**：execute() 收尾时还会对同一个 id 落库，
     * 记录会「删了又回来」一半；而且用户真正想干的多半是先停下。
     * 前端在这两个状态下给的是「取消」按钮，所以这条 409 正常用不到。
     */
    if (isActive(id)) {
        res.status(409).json({ error: "job is still active — cancel it first" });
        return;
    }
    store.deleteJob(id);
    removeJobConfigDir(id);
    res.json({ ok: true });
});

/**
 * 批量清空已结束的任务（done/partial/failed/cancelled）。
 * 只动任务记录：音乐库里的文件一个都不碰。
 */
app.post("/api/jobs/clear-finished", requireAuth, (_req: Request, res: Response) => {
    const removed = store.deleteFinished();
    res.json({ ok: true, removed });
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
     * 重复出现（用户实际看到过两遍开头的「引擎配置以 … 为准」）。
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

/**
 * 监听交给「被 import 的模块」自己做。
 *
 * 测试（test/search-stream.test.mjs）需要**真实**的 Express 应用：路由、中间件、
 * res.render 的 views 查找都一样，只有端口不同。早期版本的条件是
 * `if (!config.dataDir.startsWith(os.tmpdir()))` —— 依赖临时目录名这种脆弱前提，
 * 现在换成显式开关，谁想接管监听谁自己声明。
 */
if (!process.env.AMDL_NO_LISTEN) {
    app.listen(config.port, () => {
        console.log(`[amdl-web] listening on http://0.0.0.0:${config.port}`);
        console.log(`[amdl-web] engine=${config.engineBin} cwd=${config.engineDir} lite=${config.liteServer}`);
        console.log(`[amdl-web] music=${config.musicDir} data=${config.dataDir}`);
        if (store.users().length === 0) {
            console.log("[amdl-web] no users yet — open /login to create the first admin account");
        }
    });
}
