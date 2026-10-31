/*
 * 播放器 UI —— 播放库内/整首/30 秒片段与电台连续播。
 *
 * ## 三种音源，三种结束语义
 *
 *   · 库内整首（`path`）→ 走 `/api/play`：服务端把 ALAC 转成 FLAC 再发
 *   · 电台整首（`path`）→ 同上，只是文件来自 radio.ts 准备的临时缓存
 *   · 30 秒试听（`url`）→ **直连 Apple CDN**：目录给的片段不加密，
 *     `<audio>` 取跨源媒体不受 CORS 限制，所以一行流量都不过 NAS
 *
 * 结束语义：试听**放完就停**（连播片段等于永远听不完任何东西），电台与库内曲目
 * **继续下一首**。
 *
 * 电台第一首要现准备（下载 + 解密 + 转码，实测约 5–50 秒，取决于曲目大小）。
 * 这段等待必须显式显示"正在准备…"，否则按了播放没声音，用户只会以为坏了。
 */
import { radioPrepareOne, radioReset } from "./radio.js";

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

/* 元素在 views/partials/player.ejs 里；沿用同一个而不是另建一个，
   否则页面里同时存在两个 <audio>，谁在响从外部看不出来 */
const audio = document.getElementById("player-audio");
let queue = [];
let index = -1;
/** 当前电台 id；换台时队列清空。 */
let radioId = null;

let seeking = false;
/** 发起当前播放的那个按钮，用来标 .playing（同时只能有一个）。 */
let originBtn = null;

/* 播放条只在登录后的页面上有（登录页也 include 了 foot）。元素不在就直接退出，
   否则下面每一个 addEventListener 都会抛。 */
if (!bar || !audio) {
    /* no-op */
} else {
/* ---- 音量/进度条 ----------------------------------------------- */

function fmt(sec) {
    if (!Number.isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

elVolume.addEventListener("input", () => {
    audio.volume = Number(elVolume.value);
});
audio.volume = Number(elVolume.value);

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

/* ---- 控件事件 -------------------------------------------------- */

elToggle.addEventListener("click", () => {
    if (audio.paused) {
        const res = audio.play().catch((e) => {
            /* 自动播放策略被拦——这是浏览器行为，不是错误。点一下播放键就行。*/
            if (e.name === "NotAllowedError") return;
            console.warn("播放失败", e);
        });
        elToggle.textContent = "⏸";
        bar.classList.add("playing");
        markOrigin(true);
    } else {
        audio.pause();
        elToggle.textContent = "▶";
        bar.classList.remove("playing");
        markOrigin(false);
    }
});

elNext.addEventListener("click", next);
elPrev.addEventListener("click", prev);

/* ---- 播放队列控制 --------------------------------------------- */

function show() {
    if (bar) bar.hidden = false;
}

function hide() {
    if (bar) bar.hidden = true;
}

async function load(list, at) {
    queue = list;
    index = at;
    const t = queue[index];
    if (!t) return false;

    if (t.path) {
        /* 整首：路径由 radio.ts 登记或音乐库自带 */
        audio.src = new URL(`/api/play?path=${encodeURIComponent(t.path)}`, location.href).href;
    } else if (t.preview) {
        /* 30 秒片段：直连 Apple CDN */
        audio.src = t.url;
    } else {
        elSub.textContent = "曲目不可用";
        return false;
    }

    show();
    elTitle.textContent = t.song || "未知曲目";
    elSub.textContent = [t.artist, t.album].filter(Boolean).join(" · ");
    await audio.play().catch((e) => {
        /* 自动播放策略被拦——用户得主动点击播放。不会在这里报错炸页。*/
        if (e.name !== "NotAllowedError") console.warn("播放失败", e);
    });

    document.title = `${t.song} — amdl-web`;
}

/**
 * 下一首。
 *
 * 电台队在尾时先**就地备一首**再播 —— 不能只发起备歌然后指望
 * 用户再点一次：他要的就是"现在这声之后马上有下一首"。
 */
async function next() {
    if (index + 1 < queue.length) {
        await load(queue, index + 1);
        return;
    }
    if (radioId) {
        elSub.textContent = "正在准备下一首…";
        const ok = await radioPrepareOne(radioId, queue);
        if (ok) {
            await load(queue, queue.length - 1);
            return;
        }
        elSub.textContent = "这个电台暂时没有更多曲目";
    }
    elToggle.textContent = "▶";
}

/** 上一首 */
function prev() {
    const cur = queue[index];
    if (!cur) return;
    /* 如果正在播第一首歌且播了超过几秒，就当重播 */
    if (index > 0 && !(radioId && index === 0 && audio.currentTime > 4)) {
        load(queue, index - 1);
        return;
    }
    audio.currentTime = 0;
}

/** 标记当前播放的按钮，方便高亮。 */
function markOrigin(playing) {
    if (!originBtn) return;
    originBtn.classList.toggle("playing", playing);
}

/* ---- 元数据事件 ---------------------------------------------- */

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

audio.addEventListener("ended", () => {
    /*
     * 两种结束语义，故意不一样：
     *   · 普通试听 → **停下**。30 秒片段连播等于永远听不完任何东西。
     *   · 电台 → 继续往下（队尾时就地备下一首）。
     * 库内整首连播也走 next()，但那条分支不会触发备歌。
     */
    const cur = queue[index];
    const isPreview = Boolean(cur && cur.preview);
    if (!radioId && isPreview) {
        elToggle.textContent = "▶";
        return;
    }
    void next();
});

audio.addEventListener("loadedmetadata", () => {
    elDur.textContent = fmt(audio.duration);
});

audio.addEventListener("timeupdate", () => {
    if (seeking) return;
    if (!Number.isFinite(audio.duration)) return;
    elProgress.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    elCur.textContent = fmt(audio.currentTime);
});

audio.addEventListener("error", () => {
    const err = audio.error;
    if (err) {
        console.warn("audio error:", err.code, err.message);
        elSub.textContent = "这首歌无法播放";
    }
    markOrigin(false);
});

/* ---- 委托 ---------------------------------------------------- */

document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;

    /* 电台卡 ▶ */
    const radioBtn = t.closest("[data-radio-id]");
    if (radioBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        void startRadio(radioBtn.dataset.radioId, radioBtn.dataset.radioName, radioBtn);
        return;
    }

    /* 预览 ▶ */
    const btn = t.closest("[data-play-preview], [data-play-path]");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();

    if (originBtn && originBtn !== btn) originBtn.classList.remove("playing");
    originBtn = btn;

    if (btn.dataset.playPreview) {
        load([{ preview: true, url: btn.dataset.playPreview, song: btn.dataset.playName || "", artist: "" }], 0);
    } else {
        load([{ path: btn.dataset.playPath, song: btn.dataset.playName || "", artist: "" }], 0);
    }
});

window.player = { audio, load, next, prev };

/* ---- startRadio: 整首优先，失败退回 30 秒 --------------------- */

/**
 * 开始一个电台。
 *
 * @param id 电台的 id（ra.u-* 格式）
 * @param name 电台名称，用作副标题
 * @param btn 点击它的卡片按钮，标成 .playing
 */
async function startRadio(id, name, btn) {
    radioId = id;
    queue = [];
    index = -1;
    originBtn = null;
    /* 换台要作废上一台的缓冲，否则旧电台已经取到、还没播的几首会串进新台 */
    radioReset();

    /* 电台第一首要现准备（下载解密 + 转码，约 5–10 秒）。不显示这行，用户按下
     * 播放却几秒没声音，只会以为坏了。 */
    show();
    elTitle.textContent = name || "电台";
    elSub.textContent = "正在准备第一首…";

    await radioPrepareOne(id, queue);

    if (queue.length === 0) {
        /* 一首都备不出来 -> 彻底停 */
        hide();
        elTitle.textContent = "电台";
        elSub.textContent = "这个电台暂时取不到曲目";
        return;
    }

    if (btn) {
        btn.classList.add("playing");
        originBtn = btn;
    }

    load(queue, 0);
}

window.startRadio = startRadio;
}
