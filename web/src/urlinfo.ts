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

/**
 * 地区码规范化：只认两位字母，统一小写；其它一律视为「没选」。
 * 服务端只做这一层白名单 —— 具体某区能不能查到，交给目录探测（见 region.ts）。
 */
export function normalizeRegion(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase();
    return /^[a-z]{2}$/.test(s) ? s : null;
}

/**
 * 改写链接里的地区段：`/cn/album/x/1` → `/jp/album/x/1`。
 *
 * 引擎按 URL 的地区取目录（元数据、也就是文件名与内层标签的来源），
 * 所以「本次任务用日区元数据」在实现上就是这一句改写。
 *
 * 细节：
 *   * 地区段**缺失**时插到最前面（`/album/x/1` → `/jp/album/x/1`）；
 *   * query（专辑链接里的 `?i=` 指向具体曲目）与百分号编码原样保留；
 *   * 非 Apple Music 链接、非法地区码一律返回 null —— 调用方据此回退到原链接，
 *     绝不要拿一个猜出来的 URL 去建任务。
 */
export function swapRegion(rawUrl: string, region: string): string | null {
    const cc = normalizeRegion(region);
    if (!cc) return null;

    let url: URL;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        return null;
    }
    if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;

    if (/^[a-z]{2}$/i.test(parts[0])) parts[0] = cc;
    else parts.unshift(cc);

    url.pathname = `/${parts.join("/")}`;
    return url.toString();
}
