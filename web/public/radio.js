/*
 * 电台的取歌与准备。
 *
 * 这一段从 player.js 里拆出来，是因为它有两处状态（待准备的曲目缓冲、在飞标记）
 * 和一段容易写错的控制流：**只准备一首就返回**。
 *
 * 曾经写错过的样子：把 station 给的两首都 await 准备完才 return ——
 * 于是按下播放要等约 50 秒（两首各 ~25 秒）才出声，而其中第二首的等待
 * 完全没必要（那时候第一首还没开始播）。正确的做法是每次只备一首，
 * 剩下的等接近队尾时再由续杯逻辑触发。
 */

/** 从电台取到、但还没准备的曲目缓冲。 */
let pending = [];
/** 当前电台 id；换成别的电台时缓冲要作废。 */
let pendingFor = null;

/** 队列里已有哪些 trackId（含缓冲里的），用来去重。 */
function knownIds(queue) {
    const s = new Set();
    for (const q of queue) if (q && q.trackId) s.add(q.trackId);
    for (const p of pending) s.add(p.id);
    return s;
}

/** 向电台再要一批曲目进缓冲（Apple 每次只给 2 首，调用即前移）。 */
async function pullStation(stationId, queueRef) {
    const r = await fetch("/api/station/next/" + encodeURIComponent(stationId));
    if (!r.ok) return;
    const d = await r.json();
    const seen = knownIds(queueRef ?? []);
    for (const t of d.tracks ?? []) {
        if (!t.id || seen.has(t.id)) continue;
        if (pending.some((x) => x.id === t.id)) continue;
        pending.push(t);
    }
}

/**
 * 把一首曲目变成可播的队列项：整首优先，失败退回 30 秒试听。
 *
 * 退回而非报错的理由：准备失败的原因（wrapper 掉线、该曲版权限制、NAS 磁盘满）
 * 用户一个都解决不了，而"完全没声音"比"只有 30 秒"更糟。
 */
async function toPlayable(t) {
    try {
        const res = await fetch("/api/radio/prepare", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ trackId: t.id, url: t.url })
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.path) {
            return { path: j.path, song: t.name, artist: t.artistName, trackId: t.id };
        }
    } catch {
        /* 走到下面退回试听 */
    }
    if (t.previewUrl) {
        return { preview: true, url: t.previewUrl, song: t.name, artist: t.artistName, trackId: t.id };
    }
    return null;
}

/**
 * 备出**一首**可播曲目并追加到队列。
 *
 * @returns 是否成功追加（false 表示电台取空了或全部失败）
 */
export async function radioPrepareOne(stationId, queue) {
    if (pendingFor !== stationId) {
        pending = [];
        pendingFor = stationId;
    }
    /* 缓冲空了就再要一批；还是空就说明这个电台取不到东西 */
    if (pending.length === 0) await pullStation(stationId, queue);
    const t = pending.shift();
    if (!t) return false;

    const item = await toPlayable(t);
    if (!item) return false;
    queue.push(item);
    return true;
}

/** 换台/停止时清掉缓冲，否则旧电台的歌会串进新电台。 */
export function radioReset() {
    pending = [];
    pendingFor = null;
}
