/*
 * 搜索页的流式取结果（配合 src/index.ts 的 /search/results/stream）。
 *
 * 为什么不是 app.js 里加一段：搜索页独有的逻辑（约 130 行）塞进本来就有 500 行的公共脚本里，
 * 每次评审都得在一堆无关代码里找它。这个文件只在搜索页加载（search.ejs 里 defer 引入）。
 *
 * 为什么用 fetch + ReadableStream 而不是 EventSource：
 *   * EventSource 只会自动重连、不能带自定义头，也**不能中止** —— 用户改了关键词后
 *     旧的那条流还会继续把旧结果插进来（两次搜索的结果会混在一起）。
 *     这里用 AbortController，新搜索一开始就把上一条掐掉。
 *   * 我们不需要自动重连：断流就重来一次比"悄悄接上一条半截的流"更好懂。
 *
 * 协议（NDJSON，一行一个 JSON）：
 *   {t:"meta", q, region, regionName}   {type:"total", total}   {t:"card", id, html}
 *   {t:"fill", id, html}                {t:"done"}             {type:"error", message}
 * 以 ":"("/") 开头的行是心跳，忽略。
 */

/*
 * 变量一律带 sr = search 前缀：本文件与 app.js 是**两个独立的经典脚本**，共享全局作用域，
 * 像 `input`/`list` 这种名字很容易和那边撞车（撞了就是其中一边莫名其妙不认识自己的变量）。
 */
const srForm = document.querySelector("[data-search-form]");
const srInput = srForm ? srForm.querySelector('input[name="q"]') : null;
const srRegion = document.getElementById("search-region");
const srSubmit = document.querySelector("[data-search-submit]");
const srResults = document.querySelector("[data-results]");
const srList = document.querySelector("[data-results-list]");
const srCount = document.querySelector("[data-result-count]");
const srState = document.getElementById("search-state");
const srEmpty = document.getElementById("search-empty");

/* 当前这一轮搜索的"身份"：同关键词 + 同商店才算重复，不必重跑 */
let srQ = "";
let srRegionText = "";

if (srForm && srInput && srResults && srList) {
    /*
     * 每张卡片/每次回填渲染后，还有没有没回填的骨架？用来判断"完成"该说什么。
     * 选择器跟着封面卡的类名走（.cover-chips / [data-fill-state]）——
     * 卡片从「一行结果」改成「封面卡」时这里必须同步改，否则永远数到 0 个 pending，
     * 「完成」会立刻报出来，用户看到的还是骨架。
     */
    const pendingFills = () => document.querySelectorAll('.cover-chips [data-fill-state="pending"]').length;

    /* 已经到达、但对应的卡片还没插进 DOM 的回填（同一条 TCP 分片里的 fill 先于 card） */
    const earlyFills = new Map();

    function insertCard(id, html) {
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const li = tpl.content.firstElementChild;
        if (!li) return;
        srList.appendChild(li);
        /*
         * 新卡片要先按**当前页签**决定是否显示：用户在「专辑」页签下搜出新歌，
         * 歌卡不该突然冒出来。然后刷新计数与页签可用状态。
         */
        li.hidden = !matchesCat(li);
        syncCatCats();
        /*
         * 回填可能比卡片先到（同一条 TCP 分片里的 fill 先于 card），
         * 那种情况暂存在 earlyFills 里，卡片一插进 DOM 就立刻补上。
         */
        const early = earlyFills.get(id);
        if (early !== undefined) {
            earlyFills.delete(id);
            applyFill(id, early);
        }
    }

    /* ---- 分类页签（纯客户端过滤）------------------------------------ */
    /*
     * 卡片全部已在 DOM 里，所以切换页签只是 hidden 开关 —— 不再发请求。
     * 这也是它必须和流式协作的原因：新卡片到达时要先按当前页签决定是否显示，
     * 否则用户在"专辑"页签下搜出新歌，歌卡会突然冒出来。
     */
    const srCatTabs = document.querySelector("[data-cat-tabs]");
    let srCat = "all";

    const matchesCat = (li) => srCat === "all" || li.getAttribute("data-type") === srCat;

    function syncCatCats() {
        if (!srCatTabs || !srList) return;
        const cards = [...srList.querySelectorAll(".cover-card")];
        const counts = { all: cards.length };
        for (const li of cards) {
            const t = li.getAttribute("data-type") || "unknown";
            counts[t] = (counts[t] || 0) + 1;
        }
        for (const [k, v] of Object.entries(counts)) {
            const el = srCatTabs.querySelector(`[data-cat-count="${k}"]`);
            // 计数为 0 的类别不显示数字（留个 0 反而像坏了）
            if (el) el.textContent = v > 0 ? String(v) : "";
        }
        // 没结果的页签置灰，避免点了之后一片空白还以为是没加载出来
        for (const btn of srCatTabs.querySelectorAll(".tab")) {
            const k = btn.getAttribute("data-cat");
            const n = counts[k] ?? (k === "all" ? cards.length : 0);
            btn.disabled = k !== "all" && n === 0;
        }
        applyCatFilter();
    }

    function applyCatFilter() {
        if (!srList) return;
        for (const li of srList.querySelectorAll(".cover-card")) {
            li.hidden = !matchesCat(li);
        }
        if (srEmpty) {
            const anyVisible = [...srList.querySelectorAll(".cover-card")].some((li) => !li.hidden);
            // 只在"当前页签下确实没有卡片"时显示空态；全站无结果由服务端文案负责
            srEmpty.hidden = anyVisible || srList.children.length === 0;
        }
    }

    if (srCatTabs) {
        srCatTabs.addEventListener("click", (ev) => {
            const btn = ev.target instanceof Element ? ev.target.closest(".tab") : null;
            if (!btn || btn.disabled) return;
            srCat = btn.getAttribute("data-cat") || "all";
            for (const b of srCatTabs.querySelectorAll(".tab")) {
                b.setAttribute("aria-selected", b === btn ? "true" : "false");
            }
            applyCatFilter();
        });
    }

    function applyFill(id, html) {
        const box = document.querySelector(`.cover-chips[data-fill-id="${id}"]`);
        if (!box) {
            earlyFills.set(id, html);
            return;
        }
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const fresh = tpl.content.querySelector(".cover-chips");
        if (fresh) {
            box.innerHTML = fresh.innerHTML;
            /* 骨架标记要撤掉：不留 data-fill-state 与 aria-busy，免得样式继续压暗 */
            if (fresh.hasAttribute("title")) box.setAttribute("title", fresh.getAttribute("title"));
            else box.removeAttribute("title");
        } else {
            box.innerHTML = html;
        }
        box.removeAttribute("data-fill-state");
        box.removeAttribute("aria-busy");
    }

    function setState(text, state) {
        if (!srState) return;
        srState.textContent = text || "";
        if (state) srState.setAttribute("data-state", state);
        else srState.removeAttribute("data-state");
    }

    function setCount(text) {
        if (srCount) srCount.textContent = text;
    }

    function setBusy(busy) {
        if (srSubmit) {
            srSubmit.disabled = busy;
            if (busy) srSubmit.setAttribute("data-busy", "1");
            else srSubmit.removeAttribute("data-busy");
        }
        if (srInput) srInput.readOnly = busy;
    }

    /*
     * 一次搜索 = 一条流，用"代次"(gen) 认领：新一轮开始时 gen 加一，
     * 旧的那一轮每次收到消息都会发现自己已过期，从而停手（不能靠 AbortController 一个手段：
     * 中止是异步的，分片可能已经在路上，过期消息插进新列表就是两轮结果混在一起）。
     */
    let srGen = 0;
    let srAbort = null;
    let srRunning = false;

    function startSearch(q, regionText) {
        const gen = ++srGen;
        if (srAbort) srAbort.abort();
        const ac = new AbortController();
        srAbort = ac;
        srRunning = true;
        void runStream(gen, q, regionText, ac);
    }

    async function runStream(gen, q, regionText, ac) {
        srList.innerHTML = "";
        earlyFills.clear();
        if (srEmpty) srEmpty.hidden = true;
        setCount("结果");
        setState("正在搜索…", "loading");
        setBusy(true);

        const params = new URLSearchParams({ q, stream: "1" });
        if (regionText) params.set("region", regionText);

        let total = null;
        let cards = 0;
        let done = false;

        try {
            const res = await fetch(`/search/results/stream?${params.toString()}`, {
                signal: ac.signal,
                headers: { accept: "application/x-ndjson" }
            });
            if (!res.ok) {
                let msg = `HTTP ${res.status}`;
                try {
                    const data = await res.json();
                    if (data && data.error) msg = data.error;
                } catch {
                    /* 不是 JSON 就用状态码 */
                }
                throw new Error(msg);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            for (;;) {
                const chunk = await reader.read();
                if (gen !== srGen) {
                    void reader.cancel();
                    return;
                }
                if (chunk.done) break;
                buf += decoder.decode(chunk.value, { stream: true });
                for (;;) {
                    const nl = buf.indexOf("\n");
                    if (nl < 0) break;
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line || line.startsWith(":")) continue;
                    let msg = null;
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue;
                    }

                    if (msg.t === "meta") {
                        setState("正在搜索…", "loading");
                    } else if (msg.type === "total") {
                        total = msg.total;
                        setCount(`结果（${total}）`);
                        if (total === 0) {
                            if (srEmpty) srEmpty.hidden = false;
                            setState("没有结果", "idle");
                        } else {
                            setState(`已找到 ${total} 条 · 正在逐条补音质…`, "loading");
                        }
                    } else if (msg.t === "card") {
                        insertCard(String(msg.id), msg.html || "");
                        cards += 1;
                    } else if (msg.t === "fill") {
                        applyFill(String(msg.id), msg.html || "");
                        if (total !== null) {
                            setState(`已显示 ${cards}/${total} 条 · 音质还差 ${pendingFills()} 条`, "loading");
                        }
                    } else if (msg.t === "done") {
                        done = true;
                        if (total === null || total === 0) setState("", "idle");
                        else {
                            const left = pendingFills();
                            setState(
                                left === 0
                                    ? `共 ${total} 条 · 音质已全部取到`
                                    : `共 ${total} 条 · 还有 ${left} 条没取到音质（wrapper 可能没返回清单）`,
                                left === 0 ? "done" : "idle"
                            );
                        }
                    } else if (msg.type === "error") {
                        throw new Error(msg.message || "搜索失败");
                    }
                }
            }
            if (!done) setState("结果流提前结束（网络中断？）", "idle");
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            if (gen !== srGen) return;
            const text = err instanceof Error ? err.message : String(err);
            setState(`搜索失败：${text}`, "error");
        } finally {
            /* 被新一轮顶掉的旧流不许动界面状态（否则新流刚显示"正在搜索"就被旧流清掉忙态） */
            if (gen === srGen) {
                srRunning = false;
                setBusy(false);
            }
        }
    }

    function runCurrent() {
        const q = srInput.value.trim();
        if (!q) {
            srInput.focus();
            return;
        }
        const regionText = srRegion ? srRegion.value : "";
        if (srRunning && q === srQ && regionText === srRegionText) return;
        srQ = q;
        srRegionText = regionText;
        const url = new URL(window.location.href);
        url.searchParams.set("q", q);
        if (regionText) url.searchParams.set("region", regionText);
        else url.searchParams.delete("region");
        window.history.replaceState(null, "", url.toString());
        startSearch(q, regionText);
    }

    srForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        runCurrent();
    });
    if (srRegion) srRegion.addEventListener("change", () => runCurrent());

    /*
     * 首屏：服务端已经渲染好了（stream=1 时是空列表 + 骨架位），这里把它换成流。
     * 用 replaceState 而不是 location.href 的原因见文件头的说明：只有一条流在跑。
     */
    if (srInput.value.trim()) {
        runCurrent();
    } else {
        setState("", "idle");
    }

    /*
     * 服务端直出时卡片已在 DOM 里，但 syncCatCats 只在流式插卡时被调用，
     * 页签上的计数会是空的。这里补一次，覆盖"首屏静态渲染"这条路径。
     */
    syncCatCats();
}
