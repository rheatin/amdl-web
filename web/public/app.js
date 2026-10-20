/*
 * amdl-web 前端脚本 —— 共享层：请求封装、提示、操作委托。
 *
 * 本文件在**每个页面**都加载，所以只放真正跨页面的东西；
 * 工作台自己的逻辑（页签筛选、选中联动、进度条推进）见 workbench.js。
 */

/* ---- 请求封装 -------------------------------------------------------- */

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
    });
    let data = null;
    try {
        data = await res.json();
    } catch {
        /* 空响应体 */
    }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
}

async function delJson(url) {
    const res = await fetch(url, { method: "DELETE" });
    let data = null;
    try {
        data = await res.json();
    } catch {
        /* 空响应体 */
    }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
}

/* ---- 提示 ------------------------------------------------------------ */

/**
 * 提示条。kind 决定配色：成功与失败必须一眼能分开。
 * 落点优先级：浮层 toast → 页面内的消息区（工作台/搜索页各有一个）。
 */
function toast(msg, kind) {
    const el =
        document.getElementById("toast") ||
        document.getElementById("enqueue-msg") ||
        document.getElementById("search-msg");
    if (!el) return;
    el.textContent = msg;
    if (el.classList.contains("toast")) {
        el.classList.add("show");
        el.classList.toggle("ok", kind === "ok");
        el.classList.toggle("err", kind === "err");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => el.classList.remove("show"), 5000);
    } else {
        // 页面内的消息区：用 warn/err/ok 三个类着色，不占用浮层
        el.classList.remove("ok", "warn", "err");
        if (kind) el.classList.add(kind);
        setTimeout(() => {
            if (el.textContent === msg) {
                el.textContent = "";
                el.classList.remove("ok", "warn", "err");
            }
        }, 6000);
    }
}

/**
 * 工作台/任务页的整页刷新只做一次。
 * 「取消」的回调与 SSE 的终态事件都会想刷新页面（把服务端渲染的行换成终态行），
 * 两边各刷一次会白闪一下，甚至把提示冲掉。
 */
let pageReloading = false;
function reloadJobsPage(delay) {
    if (pageReloading) return;
    pageReloading = true;
    setTimeout(() => location.reload(), delay || 0);
}

/* ---- 队列行的操作（取消 / 重试 / 删除 / 清空）------------------------ */

/*
 * 用事件委托而不是逐行绑定：队列行会被 SSE 刷新整块替换，
 * 逐个绑定的话每次刷新后按钮就失效了。
 * 同时要在行上 stopPropagation —— 点操作按钮不应该顺便切换选中。
 */
document.addEventListener("click", async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;

    const cancel = t.closest("[data-cancel]");
    if (cancel) {
        ev.stopPropagation();
        const id = cancel.getAttribute("data-cancel");
        cancel.disabled = true;
        try {
            await postJson(`/api/jobs/${id}/cancel`, {});
            toast(`任务 #${id} 已取消`, "ok");
            reloadJobsPage(500);
        } catch (err) {
            cancel.disabled = false;
            toast(`取消失败：${err.message}`, "err");
        }
        return;
    }

    const retry = t.closest("[data-retry]");
    if (retry) {
        ev.stopPropagation();
        const id = retry.getAttribute("data-retry");
        retry.disabled = true;
        try {
            const { job } = await postJson(`/api/jobs/${id}/retry`);
            toast(`已重试为任务 #${job.id}`, "ok");
            setTimeout(() => { location.href = `/?job=${job.id}`; }, 600);
        } catch (err) {
            retry.disabled = false;
            toast(`重试失败：${err.message}`, "err");
        }
        return;
    }

    const del = t.closest("[data-del]");
    if (del) {
        ev.stopPropagation();
        const id = del.getAttribute("data-del");
        if (!confirm(`删除任务 #${id} 的记录？\n\n只删记录，已经下载的文件不会动。`)) return;
        del.disabled = true;
        try {
            await delJson(`/api/jobs/${id}`);
            toast(`任务 #${id} 的记录已删除`, "ok");
            reloadJobsPage(300);
        } catch (err) {
            del.disabled = false;
            toast(`删除失败：${err.message}`, "err");
        }
        return;
    }

    const clear = t.closest("[data-clear-finished]");
    if (clear) {
        ev.stopPropagation();
        if (!confirm("清空所有已结束的任务记录？\n\n只删记录，已经下载的文件不会动。")) return;
        try {
            const data = await postJson("/api/jobs/clear-finished", {});
            toast(`已清空 ${data && typeof data.removed === "number" ? data.removed : ""} 条记录`, "ok");
            reloadJobsPage(300);
        } catch (err) {
            toast(`清空失败：${err.message}`, "err");
        }
    }
});

/* ---- 搜索结果：一键下载（带着当前搜索的商店一起建任务）---- */

/*
 * 用**事件委托**而不是给每个按钮绑定：
 * 搜索结果是流式逐条插进 DOM 的（见 search.js），页面加载那一刻按钮还不存在，
 * 逐个绑定必然漏掉全部结果。
 *
 * 事件挂在 document 上、只处理 button.dl，所以不会和工作台队列行的
 * [data-cancel] / [data-retry] / [data-del] 冲突 —— 那些按钮不带 .dl 类。
 */
document.addEventListener("click", async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const btn = t ? t.closest("button.dl") : null;
    if (!btn || btn.disabled) return;

    const url = btn.getAttribute("data-url");
    if (!url) return;
    const codec = btn.getAttribute("data-codec") || "alac";
    const region = (btn.getAttribute("data-region") || "").trim();

    btn.disabled = true;
    const label = btn.innerHTML;
    btn.textContent = "加入中…";
    try {
        const body = { url, codec };
        /*
         * 结果链接本来就带该商店的地区段，服务端会判定「与链接一致」——
         * 带 region 只是把用户的意图一并记录下来（含自动匹配的判定依据）。
         */
        if (region) body.region = region;
        /*
         * 卡片上的标题/艺人/封面/时长/曲目数一并交给服务端存进任务记录。
         * 不带的话任务列表里只有一条裸 URL（历史任务就是这样）。
 */
        const metaRaw = btn.getAttribute("data-meta");
        if (metaRaw) {
            try {
                body.meta = JSON.parse(metaRaw);
            } catch {
                /* 元数据只是展示用，解析失败不该挡住建任务 */
            }
        }

        const { job } = await postJson("/api/jobs", body);
        toast(`已加入队列：#${job.id}`, "ok");
        // 跳到工作台并选中这条：用户能立刻看到它开始跑
        setTimeout(() => { location.href = `/?job=${job.id}`; }, 600);
    } catch (err) {
        btn.disabled = false;
        btn.innerHTML = label;
        toast(`加入失败：${err.message}`, "err");
    }
});

/* ---- 卡片 → 详情页 ---------------------------------------------------- */

/*
 * 点封面卡或榜单卡进入详情页。
 *
 * 用事件委托（卡片是流式插入的）。以下三种情况不跳转：
 *   · 点的是按钮（下载、取消……）—— 那些有自己的处理
 *   · 点的是链接（任务编号）
 *   · 点的是 .why（说明气泡）
 *
 * `data-item-kind` / `data-item-id` 由模板写在卡片上；只有"有详情页意义"的
 * 类型（专辑/播放列表/单曲/MV）才会带，艺人卡暂不带（没有艺人详情页）。
 */
document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    if (t.closest("button, a, .why")) return;
    const card = t.closest("[data-item-id]");
    if (!card) return;
    const kind = card.getAttribute("data-item-kind") || "album";
    const id = card.getAttribute("data-item-id");
    if (!id) return;
    const region = card.getAttribute("data-region") || "";
    location.href = `/item?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}${region ? `&region=${encodeURIComponent(region)}` : ""}`;
});

/* ---- 登录页首次运行：创建管理员 -------------------------------------- */

const setupForm = document.getElementById("setup-form");
if (setupForm) {
    setupForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const username = setupForm.elements.username.value.trim();
        const password = setupForm.elements.password.value;
        const btn = setupForm.querySelector("button");
        btn.disabled = true;
        try {
            await postJson("/api/setup", { username, password });
            location.href = "/";
        } catch (err) {
            toast(`创建失败：${err.message}`, "err");
            btn.disabled = false;
        }
    });
}
