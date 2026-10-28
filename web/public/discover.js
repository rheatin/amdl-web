/*
 * 发现页：渲染「为你推荐」的个性化货架。
 *
 * ## 与 charts.js 的分工
 *
 *   /api/discover → 按账号个性化，Apple **每天**刷新（每个货架带 nextUpdateDate）
 *   /api/charts   → 编辑维护，所有人一样，好几天才动一次
 *
 * 所以顺序是：个性化在前，榜单在后。没有 media-user-token 时个性化整块不出现，
 * 页面只剩榜单 —— 而不是空着或报错。
 *
 * ## 转义
 *
 * 曲名/歌单名来自 Apple 目录，是外部输入。所有插值都过 catalog-ui.js 的
 * escHtml/escAttr（与 charts.js 共用同一份实现，见该文件的注释）。
 */

(function () {
    const wrap = document.getElementById("shelves");
    const body = document.getElementById("shelves-body");
    const state = document.getElementById("shelves-state");
    const note = document.getElementById("shelves-note");
    if (!wrap || !body) return;

    /*
     * 电台（stations）没有可下载/可打开的站内页面，卡片直接外链到 Apple Music。
     * 其余类型（专辑/播放列表/单曲）走站内详情页。
     */
    const ITEM_KIND = { album: "album", playlist: "playlist", song: "song", "music-video": "music-video", station: "" };

    function card(it, region) {
        const art = WbArt(it.artwork, 200);
        const kind = ITEM_KIND[it.type] ?? "";
        const external = it.type === "station" || !kind;
        const href = external
            ? (it.url || "")
            : `/item?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(it.id)}${region ? `&region=${encodeURIComponent(region)}` : ""}`;

        const attrs = external
            ? `href="${escAttr(href)}" target="_blank" rel="noreferrer"`
            : `href="${escAttr(href)}" data-item-kind="${escAttr(kind)}" data-item-id="${escAttr(it.id)}" data-region="${escAttr(region)}"`;

        return `<a class="chart-card" ${attrs}>
            <div class="chart-art${art ? "" : " no-art"}">
                ${art ? `<img src="${escAttr(art)}" alt="" loading="lazy" width="200" height="200">` : ""}
            </div>
            <div class="chart-meta">
                <div class="chart-title ellipsis" title="${escAttr(it.name)}">${escHtml(it.name)}</div>
                <div class="chart-sub ellipsis">${escHtml(it.artistName)}</div>
            </div>
        </a>`;
    }

    (async () => {
        let data;
        try {
            const res = await fetch("/api/discover");
            data = await res.json();
        } catch {
            if (state) state.hidden = true;
            return;
        }

        const shelves = data.shelves ?? [];
        if (shelves.length === 0) {
            /*
             * 没有个性化内容时**整块隐藏**：首页只剩榜单也很好。
             * 但如果是"没配 token"这种可修复的情况，给一行说明 ——
             * 否则用户会以为这个功能不存在。
             */
            if (state) state.hidden = true;
            if (note && data.reason) {
                note.textContent = data.reason;
                note.hidden = false;
            }
            return;
        }

        const region = wrap.getAttribute("data-region") || "";
        body.innerHTML = shelves
            .map((s) => {
                const cards = s.items.map((it) => card(it, region)).join("");
                return `<div class="chart-row">
                    <h3 class="chart-row-title">${escHtml(s.title)}</h3>
                    <div class="chart-strip">${cards}</div>
                </div>`;
            })
            .join("");

        /* 刷新时间：让"每天会变"这件事对用户可见 */
        if (state) {
            const at = data.nextUpdate ? new Date(data.nextUpdate) : null;
            state.textContent = at && !Number.isNaN(at.getTime())
                ? `每日更新 · 下次 ${at.toLocaleString()}`
                : "每日更新";
        }
        wrap.hidden = false;
    })();
})();
