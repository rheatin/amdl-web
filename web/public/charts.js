/*
 * 榜单（Top Charts）—— 只在发现页（首页）加载。
 *
 * 从 workbench.js 拆出来的原因：首页现在是榜单，任务页是队列，
 * 两者不再同屏。把队列的页签/选中/SSE 逻辑也塞进首页，只会让
 * 首页为了不存在的元素跑一堆空绑定。
 *
 * 失败时整块隐藏 —— 榜单挂了不该在首屏挂一个红框，
 * 那会让用户以为站点坏了，而实际只是 Apple 的接口抽风。
 */

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
        /* 榜单是按这个商店取的（见 /api/charts 的 storefront），跳详情页要带上 */
        const chartRegion = wrap.getAttribute("data-region") || "";
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
                        return `<article class="chart-card" data-item-kind="${escAttr(it.type)}" data-item-id="${escAttr(it.id)}" data-region="${escAttr(chartRegion)}">
                            <div class="chart-art${art ? "" : " no-art"}">
                                ${art ? `<img src="${escAttr(art)}" alt="" loading="lazy" width="200" height="200">` : ""}
                                ${canDownload ? `<div class="art-panel"><div class="art-panel-in">
                                    <button class="dl" data-url="${escAttr(it.url)}" data-codec="${isMV ? "mv" : "alac"}" data-meta='${meta}'>
                                        <span class="dl-name">${isMV ? "下载 MV" : "ALAC 无损"}</span>
                                        <span class="dl-spec">${it.trackCount ? it.trackCount + " 首" : ""}</span>
                                    </button>
                                </div></div>` : ""}
                            ${previewBtn(it)}</div>
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
        /*
         * 用 hidden 而不是把文字清空：.label 有一个 ::before 圆点，
         * 文字为空时那个圆点还在 —— 页面上就多出一个没来由的孤立小点。
         */
        if (state) state.hidden = true;
        wrap.hidden = false;
    } catch {
        /* 取不到就不显示 */
    }
})();

