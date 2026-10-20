import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { coverBeside, saveDirs } from "./landed.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    capabilityFor,
    fetchCharts,
    itemDetail,
    type ItemDetail,
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
import { clearLocaleCache, config, language, storefront } from "./config.js";
import { explicitJobOptions } from "./jobopts.js";
import { cancelJob, enqueue, isActive, queueDepth, reconcileOnBoot, subscribe } from "./queue.js";
import { resolveRegionPlan, regionLabel, type RegionDeps, type RegionPlan } from "./region.js";
import { progressFromLog } from "./progress.js";
import { engineConfigPath, jobConfigDir, removeJobConfigDir } from "./ripper.js";
import {
    editableFields,
    lyricOptionsFromConfig,
    maskConfigText,
    qualityCeilingsFromConfig,
    SECRET_KEYS,
    tryLoadEngineConfig,
    writeEngineConfig
} from "./engineconf.js";
import { sanitizeJobMeta, store } from "./store.js";
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

/*
 * 封面：只服务**音频文件所在目录下的 cover.jpg**。
 *
 * 为什么不直接 express.static(MUSIC_DIR)：那等于把整个音乐目录（含所有音频）
 * 变成 HTTP 可读，而这个站点大概率挂在公网/反代后面 —— 音频文件通常几十上百 MB，
 * 不该被随手拖走。所以这里只认「一个曲目的 path」这一种输入，
 * 且必须先确认它落在引擎的落盘目录里（saveDirs()，见 landed.ts）。
 *
 * 三重限制，缺一不可：
 *   1. 路径必须解析到某个已知落盘目录之下（含目录判定，防 ../ 穿越）
 *   2. 文件名固定为 cover.jpg，不接受用户指定的文件名
 *   3. 必须登录
 * 即便如此仍然只暴露封面本身，不暴露同名目录里的其它文件。
 */
app.get("/api/cover", requireAuth, (req: Request, res: Response) => {
    const raw = String(req.query["path"] ?? "");
    if (!raw) {
        res.status(400).json({ error: "missing path" });
        return;
    }
    const resolved = path.resolve(raw);
    const roots = saveDirs().map((d) => path.resolve(d));
    // 包含性判定：必须是某个落盘目录的真子路径（目录本身不算）
    const inside = roots.some((r) => resolved.startsWith(r + path.sep));
    if (!inside) {
        res.status(404).json({ error: "not found" });
        return;
    }
    const file = coverBeside(resolved);
    if (!file) {
        res.status(404).json({ error: "no cover" });
        return;
    }
    res.sendFile(file, { maxAge: "1h" }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "not found" });
    });
});

// 供视图高亮当前导航项
app.use((req: Request, res: Response, next) => {
    res.locals.current = req.path;
    next();
});

// 顶栏的遥测胶囊（队列 / wrapper 后端 / 商店）要在**每个页面**都拿得到，
// 所以挂在全局而不是逐个 render 里传 —— 漏一个页面顶栏就少一块。
// 顺带把 engineDir 这类部署信息也放进来：顶栏是"这台机器现在什么状态"的最短路径。
app.use((_req: Request, res: Response, next) => {
    const q = queueDepth();
    res.locals.telemetry = {
        running: q.running,
        pending: q.pending,
        storefront: storefront(),
        liteServer: config.liteServer
    };
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

/* ------------------------------------------------------------ 视图辅助函数 */

/**
 * 封面模板展开（视图里叫 `art`）。
 *
 * 为什么由服务端注入、而不是做成一个 EJS partial 让各视图 include：
 * EJS 把每个模板编译成**独立函数**，`const` 声明不会带回调用方
 * （实测连往 locals 上赋值也带不回来，include 只单向向下可见），
 * 所以"抽一个 partial 出来共享"在 EJS 里根本做不到。
 * 而这个项目刻意不引入构建步骤把视图与 TS 拼在一起。
 * 于是规则**只存在这一处**，视图通过局部量拿到它 —— 没有第二份，也就没有漂移。
 *
 * 模板形状实测**五种**（见 ampmusic.ts 的 artworkAt）：除了 `{f}` / `bb.jpg` / `.jpg`，
 * 播放列表是 `SC.DN01.jpg`、MV 是 `mv.jpg`。只认 bb/dd/cc 会拼出
 * `…/200x200bb.jpgSC.DN01.jpg`（mzstatic 返回 400），
 * 而 <img> 加载失败**不报任何错**，界面上只是少了张图。
 * 这条正则**必须与 ampmusic.artworkAt 完全一致** —— 有单测逐字比对两者输出。
 */
const ART_TEMPLATE_RE = /\{w\}.*?(?=\?|$)/;
const art = (tpl: string, size: number): string =>
    tpl && tpl.includes("{w}") ? tpl.replace(ART_TEMPLATE_RE, `${size}x${size}bb.jpg`) : tpl || "";

/*
 * 挂到 app 级 locals，让**所有视图**都能拿到。
 * 逐个 render 传是不可靠的：漏一处，那张封面就是 404，
 * 而 <img> 加载失败不会在控制台报错，只是图不见了。
 */
app.locals.art = art;

/*
 * 把 Apple 链接变成一句人能读的标签：`周杰伦-muliebritty · 677907037`。
 *
 * 为什么需要：JobMeta 是后加的字段，历史任务记录里没有标题/艺人。
 * 它们的 URL 带百分号编码（`%E5%91%A8%E6%9D%B0%E4%BC%A6`），直接当标题会让
 * 整页变成一堆乱码 —— 这正是重构前的老毛病。
 *
 * 只用于**展示**：引擎只认 URL，返回值不参与任何行为判断。
 * 放在这里（由 app.locals 注入）而不是各视图各写一份，是因为检视器与队列行都要用；
 * 与 art 一样，避免两处副本漂移。
 */
app.locals.linkLabel = (u: string): string => {
    try {
        const parts = new URL(u).pathname.split("/").filter(Boolean);
        // /cn/album/名字/1465693512?i=… → 第 2 段是中文名，第 3 段是 id
        const name = parts[2] ? decodeURIComponent(parts[2]) : "";
        const id = parts[3] || parts[parts.length - 1] || "";
        if (name && id) return `${name} · ${id}`;
        return name || id || u;
    } catch {
        return u;
    }
};


/* ------------------------------------------------------------ 流式搜索结果 */

/**
 * 渲染一个 EJS 片段（partial）为字符串。
 *
 * 为什么要 `res.render` 的路径而不是另一套模板引擎：流式接口必须产出与搜索页**同一种**
 * 标记（见 views/partials/result-item.ejs 的注释）。用别的渲染方式就等于把「一行结果长什么样」
 * 抄第二遍，改一处漏一处。
 */
function renderPartial(res: Response, name: string, locals: Record<string, unknown>): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    // art 必须显式传：视图里的 <img src> 直接调 art(...)，而 EJS 拿不到模块作用域里的函数
    res.render(name, { ...locals, config, art }, (err: Error | null, html?: string) => {
        if (err) reject(err);
        else resolve(html ?? "");
    });
    return promise;
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

        // ceilings 要一起传：卡片要用它判断"Apple 有 Hi-Res 但引擎封顶更低"，
        // 流式回填的卡片与首屏渲染的卡片必须给出同一个结论。
        const ceilings = qualityCeilingsFromConfig();
        const fillHtml = async (r: (typeof items)[number], formats: AudioFormatView[]): Promise<string> =>
            renderPartial(res, "partials/result-item", {
                r: { ...r, formats },
                region,
                formatsFill: false,
                ceilings
            });

        // 阶段一：目录结果先全部落地（骨架），顺序与目录返回一致
        for (const r of items) {
            if (!alive) return;
            let html = "";
            try {
                html = await renderPartial(res, "partials/result-item", { r, region, formatsFill: true, ceilings });
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

/*
 * 工作台（默认首页）—— 单屏完成「输入 → 排队 → 看进度 → 看详情」。
 *
 * 每条任务都带上 progress：运行中的会由 SSE 实时推进，
 * 已结束的用 job.log 回填（见 progressFromLog），所以首次加载也有进度条。
 *
 * 队列默认**全部展开且不限条数**：这是一台自托管的下载机，
 * 任务总数在两位数量级；真正的筛选交给前端的页签（客户端过滤，见 app.js），
 * 服务端不截断 —— 否则"我明明有 102 个任务，列表里只有 8 个"会很困惑。
 */
app.get("/", requireAuth, (req: Request, res: Response) => {
    const jobs = store.jobs().slice().reverse().map((j) => ({ ...j, progress: progressFromLog(j.log) }));
    const activeCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    const finishedCount = jobs.length - activeCount;
    const selId = Number(req.query["job"]);
    const selected = (Number.isFinite(selId) ? store.job(selId) : undefined) ?? jobs[0] ?? null;
    res.render("workbench", {
        jobs,
        selected,
        activeCount,
        finishedCount,
        defaultRegionName: regionLabel(storefront()),
        statusText: { queued: "等待", running: "进行中", done: "完成", partial: "部分完成", failed: "失败", cancelled: "已取消" },
        ceilings: qualityCeilingsFromConfig(),
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
        ceilings: qualityCeilingsFromConfig(),
        config
    });
});

/*
 * /jobs → 工作台。
 *
 * 这一页原本是"任务列表 + 右栏详情"的双栏页，但它与工作台**讲的是同一件事**，
 * 只是老版布局。既然界面已经合成单屏，留着两个入口只会让人以为它们是两种视图。
 * 所以这里做 302 而不是删路由：书签、旧消息、深链都还能用，
 * 带 ?job=<id> 的链接会正确落到那条任务的检视器上。
 */
app.get("/jobs", requireAuth, (req: Request, res: Response) => {
    const id = Number(req.query["job"]);
    if (Number.isFinite(id)) {
        const job = store.job(id);
        res.redirect(job ? `/?job=${job.id}` : "/");
        return;
    }
    res.redirect("/");
});

/**
 * 详情页：一条记录 + 它的曲目列表。
 *
 * 用查询参数而不是路径段（`/item?kind=album&id=…`）：kind 与 id 都是
 * 外部输入，路径段要做更细的转义与冲突处理（id 可能含 `pl.` 前缀），
 * 而这条路由不承担 SEO 职责 —— 这是个需要登录的自托管工具。
 *
 * region 只影响**元数据取数**的商店（封面、曲名写法），与下载权限无关。
 */
app.get("/item", requireAuth, async (req: Request, res: Response) => {
    const kind = String(req.query["kind"] ?? "album").trim();
    const id = String(req.query["id"] ?? "").trim();
    const region = normalizeRegion(req.query["region"]) ?? "";

    if (!id) {
        res.redirect("/");
        return;
    }
    let detail: ItemDetail | null = null;
    let error: string | null = null;
    try {
        detail = await itemDetail(kind, id, region || undefined);
    } catch (err) {
        error = err instanceof Error ? err.message : String(err);
    }

    res.render("item", {
        detail,
        error,
        kind,
        id,
        region,
        regionName: regionLabel(region || storefront()),
        ceilings: qualityCeilingsFromConfig(),
        statusText: { queued: "等待", running: "进行中", done: "完成", partial: "部分完成", failed: "失败", cancelled: "已取消" },
        config
    });
});

app.get("/library", requireAuth, (_req: Request, res: Response) => {
    res.render("library", { tracks: store.allTracks(), musicDir: config.musicDir, config });
});

/**
 * 「设置」页：可编辑的引擎配置 + 只读的运行信息。
 *
 * ## 改过的设计决定（2026-10-20）
 *
 * 此前这里**刻意只读**，理由是"避免两份真相"。那个担心是对的，但结论下错了：
 *
 *   · 真正的风险不是"网页能写"，而是**同时有两处能写同一件事**。这里写的就是
 *     `config.yaml` 本身 —— 文件的 bind mount 让容器内外是同一个文件，不存在第二份。
 *     写回也是原地改（保 inode），所以改完**立即生效**，不需要重启。
 *   · 只读的代价更实际：手机上看完某个设置想改，得开 SSH 上 NAS 改文件。
 *
 * 保留的护栏：
 *   · 白名单（engineconf.EDITABLE_KEYS）：凭据、落盘路径、代理一律不可写；
 *   · 每项取值校验，换行直接拒绝（否则会破坏 YAML 单行结构）；
 *   · 写前自动备份 `config.yaml.bak`；
 *   · 页面底部仍然显示打码后的全文，用户随时能核对文件真实内容。
 *
 * 部署类参数（端口、并发、路径）仍然只在 `.env` —— 那些改了必须重建容器，
 * 网页上给个假开关只会误导。
 */
app.get("/settings", requireAuth, (_req: Request, res: Response) => {
    const engine = tryLoadEngineConfig();
    res.render("settings", {
        config,
        queue: queueDepth(),
        storefront: storefront(),
        ceilings: qualityCeilingsFromConfig(),
        language: language(),
        fields: editableFields(),
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

/*
 * 榜单。用公开开发者 token 即可，**不需要 Apple 账号**。
 *
 * 为什么不和 /api/search 合并：榜单是"无关键词的浏览入口"，搜索是"有关键词的行为" ——
 * 两者的缓存策略与界面落点都不同（榜单常驻工作台首页，搜索结果只在搜索后出现）。
 *
 * 失败时返回空数组而不是 5xx：榜单只是首页的顺带内容，
 * Apple 那边偶发抽风是常态，不该让它把工作台整页打成错误。
 */
app.get("/api/charts", requireAuth, async (_req: Request, res: Response) => {
    try {
        res.json({ sections: await fetchCharts(12) });
    } catch (err) {
        res.json({
            sections: [],
            note: `榜单暂时取不到（${err instanceof Error ? err.message : String(err)}）`
        });
    }
});

/*
 * 任务列表 —— 工作台的队列区直接吃这份数据。
 *
 * 每条都带上 `progress`：运行中的任务由 SSE 实时推进，
 * 而**已结束**的任务没有任何实时事件，所以这里用 job.log 回填一次
 * （见 progressFromLog）—— 于是「刚刷新页面进度条就空了」这个老问题不存在了。
 *
 * 代价是每个任务都要重扫一遍日志。日志上限是 config.logLines（默认 2000 行），
 * 任务数量通常在两位数，扫描量很小；真要担心就在这里加个按任务缓存，
 * 但那会引入"缓存何时失效"的另一套问题，收益不抵复杂度。
 */
app.get("/api/jobs", requireAuth, (_req: Request, res: Response) => {
    const jobs = store.jobs().map((j) => ({ ...j, progress: progressFromLog(j.log) }));
    res.json({ jobs, queue: queueDepth() });
});

/* --------------------------------------------------------------- 配置接口 */

/**
 * 只读地取回当前生效的配置，便于脚本/自检核对（凭据已打码）。
 * 写入走 POST /api/config（见下），部署类参数仍只在 .env。
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
        // 有效音质/画质上限：界面要能说清「Apple 有 Hi-Res」与「引擎只下到 48 kHz」的区别。
        ceilings: qualityCeilingsFromConfig(),
        engineConfig: {
            file: engine?.file ?? engineConfigPath(),
            present: engine !== null,
            values: engine?.values ?? {}
        }
    });
});

/**
 * 写入引擎配置。
 *
 * 只有 `fields` 一项：`{ alacMax: "96000", lyricsEmbed: "false", ... }`。
 * 只写**传上来的**键（不做"整表单覆盖"）—— 页面可能只渲染了一部分字段，
 * 整表覆盖会把没渲染的键悄悄清空。
 *
 * 返回 `written`（实际改到的点分路径）与 `changed`（值与原来不同的那些），
 * 界面据此提示「没有变化」而不是假装成功。
 */
app.post("/api/config", requireAuth, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { fields?: Record<string, unknown> };
    const fields = body.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        res.status(400).json({ error: "需要 { fields: { ... } }" });
        return;
    }
    const updates = Object.entries(fields).map(([name, value]) => ({ name, value }));
    if (updates.length === 0) {
        res.status(400).json({ error: "没有要写入的项" });
        return;
    }

    /* 写入前先记下旧值，用来算 changed */
    const before = editableFields();
    const oldValue = (name: string): string | undefined => before.find((f) => f.name === name)?.value;
    try {
        const result = writeEngineConfig(updates);
        /*
         * 地区/语言是「首次访问即缓存」的（config.ts），必须显式清掉，
         * 否则文件改了、搜索结果还是旧区。其它键每次读文件，无需处理。
         */
        clearLocaleCache();
        const changed = updates
            .filter((u) => oldValue(u.name) !== String(u.value ?? "").trim())
            .map((u) => u.name);
        res.json({
            ok: true,
            file: result.file,
            backup: result.backup,
            written: result.written,
            changed,
            fields: editableFields()
        });
    } catch (e) {
        res.status(400).json({ error: (e as Error).message });
    }
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
                artwork: mv?.artwork ?? "",
                // MV 的画质/音轨上限也要给：引擎按 mv-max / mv-audio-type 下，
                // 界面只印「MV · 视频 + 音轨」等于没告诉用户会拿到什么。
                ceilings: qualityCeilingsFromConfig(),
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
                artwork: "",
                ceilings: qualityCeilingsFromConfig(),
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
                artwork: "",
                ceilings: qualityCeilingsFromConfig(),
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
            artwork: withQuality.artwork,
            ceilings: qualityCeilingsFromConfig(),
            formats: withQuality.formats.map(presentFormat),
            resolved: link,
            plan
        });
    } catch (err) {
        res.json({
            codecs: [...ALL_CODECS],
            note: `查询能力失败：${err instanceof Error ? err.message : String(err)}`,
            artwork: "",
            ceilings: qualityCeilingsFromConfig(),
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
    const meta = sanitizeJobMeta(req.body?.meta);
    const job = store.addJob(user.id, plan.effectiveUrl, codec, options, plan, meta);
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
    // 元数据也一起克隆：重试出来的任务不该退回成「只有一条裸 URL」。
    const job = store.addJob(user.id, src.url, src.codec, src.options ?? {}, src.region, src.meta);
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
 * 查看某个任务**实际使用的**引擎配置（只读页面）。
 *
 * 为什么值得单独开一条路由：这个文件是「基础 config.yaml + 本任务的显式覆盖」
 * 叠加出来的产物（见 ripper.writeJobConfig），也就是"这次下载到底按什么跑"的唯一准确答案。
 * 它随任务记录长期存在，但之前除了删除任务时顺手清掉以外从不出现在界面上 ——
 * 于是「我明明改了 config.yaml，为什么这次不是 Hi-Res」只能靠猜。
 *
 * 只读，且只读这一个固定文件名：路径由 jobConfigDir 拼出，不接受任何用户输入。
 * 凭据照常打码（引擎配置里有 Apple 媒体 token）。
 */
app.get("/jobs/:id/config", requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const job = store.job(id);
    if (!job) {
        res.status(404).send("没有这个任务");
        return;
    }
    const file = path.join(jobConfigDir(id), "config.yaml");
    let text = "";
    try {
        text = maskConfigText(fs.readFileSync(file, "utf8"));
    } catch {
        // 任务刚建完还没起进程、或记录已被清理：明确说"还没有"，不要假装配置是空的。
        text = "# 这份配置还没有生成（任务尚未启动，或任务记录已被清理）。";
    }
    res.render("job-config", { job, file, text, ceilings: qualityCeilingsFromConfig(), config });
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
