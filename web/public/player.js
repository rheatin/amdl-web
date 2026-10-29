/*
 * 播放条 —— 队列、进度、切歌。
 *
 * ## 为什么 src 直接指向 /api/play
 *
 * 服务端在该请求里完成「转 FLAC + 发文件」，并且支持 Range。
 * 所以浏览器自己就会做分块加载和拖动 seek，前端不需要把整个文件读进内存
 * （无损一首 20 MB+，读进内存会明显拖慢手机）。
 *
 * ## 为什么首次播放会停一下
 *
 * 库里是 ALAC，浏览器放不了；服务端要转成 FLAC（实测约 1 秒）。
 * 这段延迟发生在第一个 Range 请求里。为了让它尽量无感，切歌时**预取**下一首：
 * 播第一首时顺手请求第二首，用户点下一首时通常已经转好了。
 */

const audio = document.getElementById("player-audio");
const bar = document.getElementById("player");
const elTitle = document.getElementById("player-title");
const elSub = document.getElementById("player-sub");
const elToggle = document.getElementById("player-toggle");
const elPrev = document.getElementById("player-prev");
const elNext = document.getElementById("player-next");
const elProgress = document.getElementById("player-progress");
const elCur = document.getElementById("player-cur");
const elDur = document.getElementById("player-dur");
const elVolume = document.getElementById("player-volume");

/** 队列：{ path, song, artist, album } */
let queue = [];
let index = -1;
/** 正在拖动进度条时不要被 timeupdate 抢回去 */
let seeking = false;
/** 发起当前播放的那个按钮 —— 用来标 .playing（同时只可能有一个在响） */
let originBtn = null;

function markOrigin(playing) {
    if (!originBtn) return;
    originBtn.classList.toggle("playing", playing);
}
/** 已经预取过的 path，避免重复请求 */
const prefetched = new Set();

function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

function playUrl(path) {
    return `/api/play?path=${encodeURIComponent(path)}`;
}

/**
 * 队列条目的实际音源。
 *
 * 两种：
 *   · 库内文件 → /api/play（服务端把 ALAC 转成浏览器能放的 FLAC）
 *   · 试听片段 → 目录给的 CDN 地址，**原样直连**
 *
 * 试听不需要服务端参与：Apple 的 previews 是不加密的普通 MP4，
 * 而 <audio> 取跨源媒体不受 CORS 限制，所以一点流量都不过 NAS。
 */
function srcOf(item) {
    return item.preview ? item.url : playUrl(item.path);
}

function show() {
    if (bar) bar.hidden = false;
}

function load(list, at) {
    queue = list;
    index = at;
    const t = queue[index];
    if (!t) return;
    show();
    elTitle.textContent = t.song || "未知曲目";
    /*
     * 明确标「试听」：片段只有 30 秒，不写清楚用户会以为歌坏了 / 网站卡了。
     */
    elSub.textContent = t.preview
        ? [t.artist, "试听 30 秒"].filter(Boolean).join(" · ")
        : [t.artist, t.album].filter(Boolean).join(" · ");
    audio.src = srcOf(t);
    audio.play().catch((e) => {
        /* 自动播放被拦：这是浏览器策略，不是错误。让用户点一下播放键即可。 */
        if (e.name !== "NotAllowedError") console.warn("播放失败", e);
    });
    document.title = `${t.song} — amdl-web`;
}

function next() {
    if (index + 1 < queue.length) load(queue, index + 1);
}

function prev() {
    /* 播过 3 秒再按上一首 = 重播当前曲；否则真的上一首（和主流播放器一致） */
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    if (index > 0) load(queue, index - 1);
}

/**
 * 预取下一首。
 *
 * 用 fetch 而不是 new Audio().load()：后者会占用一个解码器并可能被浏览器回收，
 * 前者只要把响应头拿到、把 body 丢掉就行 —— 但它**仍然会生成缓存文件**，
 * 因为转码发生在服务端响应第一个字节之前。
 */
function prefetchNext() {
    const t = queue[index + 1];
    /* 试听是 CDN 直连、没有转码成本，预取它只会浪费带宽 */
    if (!t || t.preview || prefetched.has(t.path)) return;
    prefetched.add(t.path);
    fetch(playUrl(t.path), { headers: { range: "bytes=0-1" } })
        .then((r) => r.arrayBuffer())
        .catch(() => {
            /* 预取失败无所谓，真正播的时候还会再请求一次 */
            prefetched.delete(t.path);
        });
}

/* ---- 事件 ------------------------------------------------------------ */

if (audio && bar) {
    elToggle.addEventListener("click", () => {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    });

    elNext.addEventListener("click", next);
    elPrev.addEventListener("click", prev);

    audio.addEventListener("play", () => {
        elToggle.textContent = "⏸";
        bar.classList.add("playing");
        markOrigin(true);
    });
    audio.addEventListener("pause", () => {
        elToggle.textContent = "▶";
        bar.classList.remove("playing");
        markOrigin(false);
    });
    audio.addEventListener("ended", () => markOrigin(false));
    audio.addEventListener("error", () => markOrigin(false));

    audio.addEventListener("loadedmetadata", () => {
        elDur.textContent = fmt(audio.duration);
    });

    audio.addEventListener("timeupdate", () => {
        if (seeking || !Number.isFinite(audio.duration) || audio.duration === 0) return;
        elProgress.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
        elCur.textContent = fmt(audio.currentTime);
    });

    audio.addEventListener("ended", () => {
        /*
         * 试听放完就停：它是一首 30 秒的**片段**，接着自动播下一首的片段
         * 会变成"永远听不完任何东西"，比手动点更烦。
         */
        const cur = queue[index];
        if (!cur || !cur.preview) {
            if (index + 1 < queue.length) {
                load(queue, index + 1);
                return;
            }
        }
        elToggle.textContent = "▶";
    });

    audio.addEventListener("playing", prefetchNext);

    audio.addEventListener("error", () => {
        const msg = audio.error;
        if (!msg) return;
        /* 转码失败或文件没了 —— 明确说出来，别让它静默停在 0:00 */
        elSub.textContent = "这首歌无法播放（文件可能已删除，或转码失败）";
        console.warn("audio error", msg.code, msg.message);
    });

    elProgress.addEventListener("input", () => {
        seeking = true;
        const ratio = Number(elProgress.value) / 1000;
        if (Number.isFinite(audio.duration)) {
            elCur.textContent = fmt(ratio * audio.duration);
        }
    });

    elProgress.addEventListener("change", () => {
        const ratio = Number(elProgress.value) / 1000;
        if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
        seeking = false;
    });

    elVolume.addEventListener("input", () => {
        audio.volume = Number(elVolume.value);
    });
    audio.volume = Number(elVolume.value);

    /* 空格播放/暂停 —— 但输入框里打字时不能抢 */
    document.addEventListener("keydown", (ev) => {
        if (ev.code !== "Space") return;
        const t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
        if (bar.hidden) return;
        ev.preventDefault();
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    });
}

/*
 * 播放委托：带 data-play-path（库内文件）或 data-play-preview（30 秒片段）的元素都能触发。
 *
 * 卡片是流式插入的（搜索结果、榜单、推荐货架），所以用委托而不是逐个绑定。
 * 若同一个容器上有 data-play-list（JSON 数组），就把它当整个队列 ——
 * 这样点专辑里的某一首，下一首会自然往下走。
 *
 * 注意委托必须排在 app.js 的"卡片→详情页"委托**之后**注册吗？不需要：
 * 这里 stopPropagation + preventDefault 会挡住冒泡，而 app.js 那条对
 * `button` 本来就 return（t.closest("button, a, .why")）。
 */
document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const btn = t.closest("[data-play-path], [data-play-preview]");
    if (!btn) return;

    const previewUrl = btn.getAttribute("data-play-preview");
    if (previewUrl) {
        ev.preventDefault();
        ev.stopPropagation();
        if (originBtn && originBtn !== btn) originBtn.classList.remove("playing");
        originBtn = btn;
        load(
            [{
                preview: true,
                url: previewUrl,
                song: btn.getAttribute("data-play-name") || "",
                artist: btn.getAttribute("data-play-artist") || ""
            }],
            0
        );
        return;
    }

    ev.preventDefault();
    ev.stopPropagation();
    if (originBtn && originBtn !== btn) originBtn.classList.remove("playing");
    originBtn = btn;

    const listEl = btn.closest("[data-play-list]");
    if (listEl) {
        const list = JSON.parse(listEl.getAttribute("data-play-list"));
        const at = Math.max(0, list.findIndex((x) => x.path === btn.getAttribute("data-play-path")));
        load(list, at);
        return;
    }
    load([{ path: btn.getAttribute("data-play-path"), song: btn.getAttribute("data-play-name") || "" }], 0);
});
