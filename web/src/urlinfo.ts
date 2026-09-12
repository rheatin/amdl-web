/**
 * Apple Music 分享链接解析。
 *
 * 支持的形态（实测）：
 *   https://music.apple.com/us/song/example/1440833098
 *   https://music.apple.com/us/album/example/1440833098?i=1440833100   ← 曲目 id 在 i 参数里
 *   https://music.apple.com/us/album/example/1440833098
 *   https://music.apple.com/us/artist/example/160847
 *   https://music.apple.com/cn/playlist/xxx/pl.u-Ympg5s39LRqp
 *   https://classical.music.apple.com/...
 */
export type AppleLinkKind = "song" | "album" | "artist" | "playlist" | "music-video" | "unknown";

export type AppleLink = {
    kind: AppleLinkKind;
    /** 数字 id（song/album/artist）；播放列表是 pl.* */
    id: string;
    /**
     * 链接里的店铺地区（如 cn / us）。
     * Apple 的目录 API 是分店铺的：对 /cn/ 的曲目查询 /us/ 会 404，
     * 所以查能力时必须优先用链接自带的地区。
     */
    storefront?: string;
    /** 解析失败时的原因，便于 UI 提示 */
    note?: string;
};

const TYPES = new Set<AppleLinkKind>(["song", "album", "artist", "playlist", "music-video"]);

export function parseAppleMusicUrl(raw: string): AppleLink {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return { kind: "unknown", id: "", note: "不是合法 URL" };
    }
    if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) {
        return { kind: "unknown", id: "", note: `不认识的域名：${url.hostname}` };
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const sf = parts[0] && /^[a-z]{2}$/i.test(parts[0]) ? parts[0].toLowerCase() : undefined;

    // 专辑链接里的 ?i= 指向具体曲目
    const i = url.searchParams.get("i");
    if (i && /^\d+$/.test(i)) return { kind: "song", id: i, storefront: sf };

    const idx = parts.findIndex((p) => TYPES.has(p as AppleLinkKind));
    const kind = (idx >= 0 ? (parts[idx] as AppleLinkKind) : "unknown");
    const last = parts[parts.length - 1] ?? "";

    if (kind === "playlist" || /^pl\./.test(last)) {
        return { kind: "playlist", id: last, storefront: sf, note: "播放列表没有单曲能力信息" };
    }
    if (/^\d+$/.test(last)) return { kind, id: last, storefront: sf };
    if (/^pl\./.test(last)) {
        return { kind: "playlist", id: last, storefront: sf, note: "播放列表没有单曲能力信息" };
    }

    return { kind: "unknown", id: "", storefront: sf, note: "无法从链接中解析出 id" };
}
