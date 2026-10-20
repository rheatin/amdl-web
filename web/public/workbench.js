/*
 * 工作台脚本 —— 只在首页（workbench）加载。
 *
 * 负责四件事：
 *   1. 「加入队列」：一个输入框同时接受 Apple 链接与关键词
 *      （是链接就直接建任务；是关键词就走搜索，搜索结果填进队列区）
 *   2. 页签筛选：全部 / 进行中 / 已结束（纯客户端，不重新请求）
 *   3. 选中联动：点队列行 → 检视器讲这一条；再点别的 → 跟着换
 *   4. 进度推进：SSE 的 progress 事件直接改那一行的进度条宽度
 *
 * 为什么进度不重新拉列表：SSE 已经把新读数推过来了，
 * 再 fetch 一次 /api/jobs 会把整块 DOM 换掉 —— 正在 hover 的行会闪、
 * 用户的滚动位置会跳、正在看的那行会失去高亮。只改数字，不动结构。
 */

/*
 * 封面模板展开 —— 这是**第三份**实现（另两份：ampmusic.ts 的后端版、
 * index.ts 里给 EJS 视图用的 app.locals.art）。
 *
 * 分三份是因为三者跑在互相隔离的环境里（Node 服务端 / EJS 渲染 / 浏览器），
 * 没法共享同一个模块。代价是规则必须手抄，所以 charts-tabs.test.mjs
 * 有一条断言逐字比对三份实现的输出 —— 抄漏一处，封面就是静默的空图。
 *
 * 形状实测五种：`{f}` / `bb.jpg` / `.jpg` / `SC.DN01.jpg`（播放列表）/ `mv.jpg`（MV）。
 * 只认 bb/dd/cc 会拼出 `…/200x200bb.jpgSC.DN01.jpg`，mzstatic 返回 400，
 * 而 <img> 加载失败不产生任何控制台错误。
 */
const WbArt = (function () {
    const RE = /\{w\}.*?(?=\?|$)/;
    return (tpl, size) => (tpl && tpl.includes("{w}") ? tpl.replace(RE, `${size}x${size}bb.jpg`) : tpl || "");
})();

const wbForm = document.getElementById("enqueue-form");
const wbInput = document.getElementById("q");
const wbBtn = document.getElementById("enqueue-btn");
const wbMsg = document.getElementById("enqueue-msg");
const wbRegion = document.getElementById("job-region");
const wbAutoMatch = document.getElementById("job-automatch");
const wbOverride = document.getElementById("opts-override");
const wbLyricsOpts = document.getElementById("lyrics-opts");
const wbOptsBox = document.getElementById("opts-box");
const wbList = document.getElementById("queue-list");
const wbTabs = document.getElementById("queue-tabs");

const IS_URL = /^https?:\/\/(music|classical)\.apple\.com\//i;

/*
 * 按钮文案随输入变：空 → "搜索"，粘了 Apple 链接 → "加入队列"。
 *
 * 为什么必须分两种：这个输入框同时接受链接与关键词，而两者要做的事完全不同
 * （链接直接建任务、关键词跳搜索）。文案不跟随输入，用户就只能靠猜。
 */
const syncEnqueueLabel = () => {
    if (!wbBtn || !wbInput) return;
    const raw = (wbInput.value || "").trim();
    if (!raw) {
        wbBtn.textContent = "搜索";
        wbBtn.title = "";
        return;
    }
    if (IS_URL.test(raw)) {
        wbBtn.textContent = "加入队列";
        wbBtn.title = "直接下载这条链接";
    } else {
        wbBtn.textContent = "搜索";
        wbBtn.title = "按关键词搜目录";
    }
};

/* ---- 1. 加入队列 ------------------------------------------------------ */

if (wbForm) {
    wbForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const raw = (wbInput.value || "").trim();
        if (!raw) return;

        const region = wbRegion ? wbRegion.value : "";

        /* 链接：直接建任务。关键词：先出搜索结果让用户挑。
           不做成"先解析再让用户选编码"的两步 —— 那个步骤在搜索结果里
           已经完成了（每条结果自带可用编码），直接给结果更少点击。 */
        if (!IS_URL.test(raw)) {
            location.href = `/search?q=${encodeURIComponent(raw)}${region ? `&region=${region}` : ""}`;
            return;
        }

        wbBtn.disabled = true;
        wbBtn.textContent = "解析中…";
        try {
            const body = { url: raw, codec: "alac" };
            if (region) body.region = region;
            if (wbAutoMatch && wbAutoMatch.checked) body.autoMatch = true;
            if (wbOverride && wbOverride.checked) body.options = collectLyricOptions();

            const { job } = await postJson("/api/jobs", body);
            toast(`已加入队列：#${job.id}`, "ok");
            setTimeout(() => { location.href = `/?job=${job.id}`; }, 500);
        } catch (err) {
            // 失败必须**就地报错**，不能只弹 toast 然后把输入框留着 ——
            // 用户会以为"点了没反应"然后再去点一次。
            showEnqueueError(err.message);
            wbBtn.disabled = false;
            syncEnqueueLabel();
        }
    });

    syncEnqueueLabel();
    wbInput.addEventListener("input", syncEnqueueLabel);

    /* 勾了"覆盖歌词选项"才展开那一块 —— 不勾选时控件存在但不生效，
       早先是把整块压暗，而压暗的表单仍然可点，比不显示更容易误操作。 */
    if (wbOverride && wbLyricsOpts) {
        wbOverride.addEventListener("change", () => {
            wbLyricsOpts.hidden = !wbOverride.checked;
        });
    }
}

/*
 * 在输入框**下方**就地报错。
 *
 * 早先只用 toast()，而工作台上的 toast 落点是 #enqueue-msg（页面内消息区），
 * 它在表单**下方**较远的位置、又是 muted 小字 —— 失败时用户盯着按钮等跳转，
 * 根本没看见错误，于是"点了没反应"。
 */
const showEnqueueError = (msg) => {
    const box = document.getElementById("parse-result");
    if (!box) {
        toast(msg, "err");
        return;
    }
    box.hidden = false;
    box.className = "parse-result err";
    box.textContent = msg;
};


function collectLyricOptions() {
    const box = wbOptsBox;
    if (!box) return {};
    const out = {};
    box.querySelectorAll("input[type=checkbox][name]").forEach((el) => {
        out[el.name] = el.checked;
    });
    box.querySelectorAll("select[name]").forEach((el) => {
        out[el.name] = el.value;
    });
    return out;
}

/* ---- 2. 页签筛选 ------------------------------------------------------ */

const ACTIVE_STATES = ["queued", "running"];

if (wbTabs && wbList) {
    let filter = "all";

    const matches = (row) => {
        const st = row.getAttribute("data-status");
        if (filter === "active") return ACTIVE_STATES.indexOf(st) >= 0;
        if (filter === "done") return ACTIVE_STATES.indexOf(st) < 0;
        return true;
    };

    wbTabs.addEventListener("click", (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest(".tab") : null;
        if (!btn) return;
        filter = btn.getAttribute("data-filter") || "all";
        wbTabs.querySelectorAll(".tab").forEach((b) => {
            b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });
        wbList.querySelectorAll(".qrow").forEach((r) => {
            r.hidden = !matches(r);
        });
        updateCounts();
    });

    /* 计数跟着实际可见行数走 —— SSE 随时会新增/结束任务，
       服务端渲染时的数字很快就不准了。 */
    function updateCounts() {
        const rows = [...wbList.querySelectorAll(".qrow")];
        const counts = {
            all: rows.length,
            active: rows.filter((r) => ACTIVE_STATES.indexOf(r.getAttribute("data-status")) >= 0).length,
            done: rows.filter((r) => ACTIVE_STATES.indexOf(r.getAttribute("data-status")) < 0).length
        };
        for (const [k, v] of Object.entries(counts)) {
            const el = wbTabs.querySelector(`[data-count="${k}"]`);
            if (el) el.textContent = String(v);
        }
    }
    updateCounts();
}

/* ---- 3. 选中联动 ------------------------------------------------------ */

/*
 * 选中走 URL（?job=<id>）而不是纯内存状态：
 * 这样刷新页面、复制链接给另一个标签页，收到的都是同一个任务。
 * 代价是每次切换发一次请求 —— 但这正好也拿到了检视器需要的服务端渲染内容。
 */
if (wbList) {
    wbList.addEventListener("click", (ev) => {
        const row = ev.target instanceof Element ? ev.target.closest(".qrow") : null;
        if (!row) return;
        selectRow(row.getAttribute("data-qrow"));
    });
    wbList.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const row = ev.target instanceof Element ? ev.target.closest(".qrow") : null;
        if (!row) return;
        ev.preventDefault();
        selectRow(row.getAttribute("data-qrow"));
    });
}

function selectRow(id) {
    if (!id) return;
    const cur = new URL(location.href);
    if (cur.searchParams.get("job") === id) return;
    cur.searchParams.set("job", id);
    location.href = cur.toString();
}

/* ---- 4. 进度推进（只改数字，不动 DOM 结构）--------------------------- */

const consoleEl = document.getElementById("console");
const lines = [];

if (consoleEl) {
    const jobId = consoleEl.getAttribute("data-job");

    const paint = () => {
        consoleEl.textContent = lines.join("\n");
        consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    /*
     * 优先用 SSE；连不上（比如反向代理截断了长连接）退回轮询。
     * 轮询只取 /api/jobs 里这一条的 progress —— 队列可能上百条，
     * 但每次请求的响应体仍然带着全部任务的 log，所以这里**限制轮询频率**到 3 秒，
     * 且只在有任务在跑时才轮询。
     */
    let source = null;
    let pollTimer = null;

    const applyProgress = (jobId, p) => {
        const row = wbList ? wbList.querySelector(`.qrow[data-qrow="${jobId}"]`) : null;
        if (!row) return;
        const bar = row.querySelector(".pbar > i");
        const pct = row.querySelector(".qrow-pct");
        if (bar) bar.style.width = `${Math.max(2, p.pct)}%`;
        if (pct) {
            pct.textContent = `${p.pct}%`;
            if (p.title) {
                const sub = row.querySelector(".qrow-current");
                if (sub) sub.textContent = ` · ${p.title}`;
            }
        }
    };

    const setBadge = (row, status) => {
        const badge = row.querySelector(".tag");
        if (!badge) return;
        badge.textContent = STATUS_TEXT[status] || status;
        badge.className = `tag ${TAG_CLASS[status] || ""}`;
    };

    const STATUS_TEXT = { queued: "等待", running: "进行中", done: "完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
    /* 状态标签的配色必须与服务端渲染一致（见 task-row.ejs 的 TAG_CLASS），
       否则 SSE 推一次就会把颜色改掉。 */
    const TAG_CLASS = { done: "ok", partial: "hires" };

    /*
     * 状态变化时只更新**这一行**，不整页刷新。
     *
     * 为什么要重画整行而不是只改徽章：队列行的按钮是按状态分岔的
     * （活任务给"取消"、终态给"重试 + 删除"），而这些按钮是服务端渲染的，
     * 客户端改不出来。所以状态一变就把这一行的 HTML 换掉。
     *
     * 换法是重新请求工作台页面、抽出同一 id 的那一行 —— 服务端仍是唯一
     * 渲染来源，客户端不另写一份"终态行长什么样"。
     */
    let rowSyncing = false;
    const syncRowState = async (id, job) => {
        if (!wbList || rowSyncing) return;
        const row = wbList.querySelector(`.qrow[data-qrow="${id}"]`);
        if (!row) return;
        // 状态没变就别动：终态任务在每次 SSE 重连的 hello 里都会再报一次
        if (row.getAttribute("data-status") === job.status) return;

        rowSyncing = true;
        try {
            const res = await fetch(location.pathname + location.search, { headers: { "x-fragment": "1" } });
            if (res.ok) {
                const html = await res.text();
                const tpl = document.createElement("template");
                tpl.innerHTML = html.trim();
                const fresh = tpl.content.querySelector(`.qrow[data-qrow="${id}"]`);
                if (fresh) {
                    row.replaceWith(fresh);
                    updateCounts();
                }
            } else {
                // 拿不到新行就只更新可见信息，好过什么都不做
                setBadge(row, job.status);
                row.setAttribute("data-status", job.status);
            }
        } catch {
            /* 下一次事件再试 */
        } finally {
            rowSyncing = false;
        }
    };

    const startPolling = () => {
        if (pollTimer) return;
        pollTimer = setInterval(async () => {
            try {
                const res = await fetch("/api/jobs");
                if (!res.ok) return;
                const { jobs } = await res.json();
                const me = jobs.find((j) => String(j.id) === String(jobId));
                if (!me) return;
                if (me.progress) applyProgress(jobId, me.progress);
                const row = wbList && wbList.querySelector(`.qrow[data-qrow="${jobId}"]`);
                if (row && me.status !== row.getAttribute("data-status")) {
                    await syncRowState(jobId, me);
                    if (ACTIVE_STATES.indexOf(me.status) < 0) {
                        clearInterval(pollTimer);
                        pollTimer = null;
                    }
                }
            } catch {
                /* 下一次再说 */
            }
        }, 3000);
    };

    try {
        source = new EventSource(`/api/jobs/${jobId}/events`);
        source.onopen = () => {
            /* 连上了就不轮询 */
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        };
        source.onerror = () => {
            /* EventSource 自己会重连；但如果一直连不上，退回轮询兜底 */
            if (source.readyState === 2) startPolling();
        };
        source.onmessage = (ev) => {
            let data;
            try {
                data = JSON.parse(ev.data);
            } catch {
                return;
            }
            if (data.type === "hello") {
                lines.length = 0;
                ((data.job && data.job.log) || []).forEach((l) => lines.push(l));
                paint();
                /*
                 * ⚠ 这里**绝不能**因为"已经是终态"就整页刷新。
                 * 页面每次加载都会建立一个 SSE 连接，hello 带着当前状态；
                 * 已结束的任务 → 刷新 → 又是 hello、又是终态 → 再刷新……
                 * 这是个死循环，表现为浏览器不停地自己刷新、什么都点不了。
                 * （之前版本真实存在过这个问题。）
                 *
                 * 正确做法：只改那一行，不整页刷新。状态真的变了才动，
                 * 而且要换成终态版本 —— 队列行按状态分岔渲染按钮
                 * （活任务给"取消"、终态给"重试/删除"）。
                 */
                if (data.job && data.job.status) {
                    syncRowState(jobId, data.job);
                }
                return;
            }
            if (data.type === "log") {
                lines.push(data.line);
                if (lines.length > 4000) lines.splice(0, lines.length - 4000);
                paint();
                return;
            }
            if (data.type === "progress") {
                applyProgress(jobId, data.progress);
                return;
            }
            if (data.type === "status") {
                syncRowState(jobId, { status: data.status, error: data.error, tracks: data.tracks });
            }
        };
    } catch {
        startPolling();
    }
}

/* ---- 5. 热门榜单 ------------------------------------------------------ */

/*
 * 榜单是"没有关键词时的浏览入口"：让空白的工作台有东西可看，
 * 也是用户发现新音乐的唯一途径（否则只能用搜索）。
 *
 * 失败时整块隐藏 —— 榜单挂了不该在首屏挂一个红框，
 * 那会让用户以为站点坏了，而实际只是 Apple 的接口抽风。
 */

/**
 * 转义来自 Apple 的文本再拼进 HTML。
 *
 * 这些字符串（歌名/艺人/榜单名）是**外部输入**，直接拼 innerHTML 等于把
 * XSS 面交给 Apple 的目录内容。虽然我们相信 Apple，但目录里确实存在
 * 用户可提交的曲名（例如 \"<script>\" 之类），而这条链路经手的是我们自己的页面。
 */
const escHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 属性值同样要转义 —— 单引号包裹时 & 和 ' 最关键。 */
const escAttr = (s) => escHtml(s);

(async () => {
    const wrap = document.getElementById("charts");
    const body = document.getElementById("charts-body");
    const state = document.getElementById("charts-state");
    if (!wrap || !body) return;
    try {
        const res = await fetch("/api/charts");
        if (!res.ok) return;
        const { sections } = await res.json();
        if (!Array.isArray(sections) || sections.length === 0) return;

        const LABEL = { song: "歌曲", album: "专辑", playlist: "播放列表", "music-video": "MV" };
        body.innerHTML = sections
            .map((sec) => {
                const cards = sec.items
                    .map((it) => {
                        const art = WbArt(it.artwork, 200);
                        const isMV = it.type === "music-video";
                        const canDownload = /^https?:\/\//i.test(it.url || "");
                        const meta = escAttr(JSON.stringify({
                            title: it.name, artistName: it.artistName, albumName: it.albumName,
                            artwork: it.artwork, durationMs: it.durationMs, expectedTracks: it.trackCount
                        }));
                        return `<article class="chart-card">
                            <div class="chart-art${art ? "" : " no-art"}">
                                ${art ? `<img src="${escAttr(art)}" alt="" loading="lazy" width="200" height="200">` : ""}
                                ${canDownload ? `<div class="art-panel"><div class="art-panel-in">
                                    <button class="dl" data-url="${escAttr(it.url)}" data-codec="${isMV ? "mv" : "alac"}" data-meta='${meta}'>
                                        <span class="dl-name">${isMV ? "下载 MV" : "ALAC 无损"}</span>
                                        <span class="dl-spec">${it.trackCount ? it.trackCount + " 首" : ""}</span>
                                    </button>
                                </div></div>` : ""}
                            </div>
                            <div class="chart-meta">
                                <div class="chart-title ellipsis" title="${escAttr(it.name)}">${escHtml(it.name)}</div>
                                <div class="chart-sub ellipsis">${escHtml(it.artistName)}</div>
                            </div>
                        </article>`;
                    })
                    .join("");
                return `<div class="chart-row">
                    <h3 class="chart-row-title">${LABEL[sec.type] || sec.type}<span class="muted small"> · ${escHtml(sec.chartName)}</span></h3>
                    <div class="chart-strip">${cards}</div>
                </div>`;
            })
            .join("");
        if (state) state.textContent = "";
        wrap.hidden = false;
    } catch {
        /* 取不到就不显示 */
    }
})();
