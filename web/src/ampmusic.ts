/**
 * Minimal Apple Music catalog client.
 *
 * Ported from the ripper's own Go implementation (internal/amp-api/token.go and
 * search.go) so that this frontend can search the catalog without needing the
 * engine binary, an Apple ID, or any credentials:
 *
 *   1. GET https://music.apple.com                       -> find /assets/index~*.js
 *   2. GET that bundle                                   -> regex out the JWT
 *   3. call amp-api.music.apple.com/v1/catalog/<storefront>/... with it as Bearer
 *
 * The JWT is the public web-player developer token, not a user credential.
 */
import { config, language, storefront } from "./config.js";
import { mapLimit } from "./concurrency.js";
import { mergeFormats, parseMasterPlaylist, type AudioFormat } from "./format.js";
import { SECRET_KEYS, tryLoadEngineConfig } from "./engineconf.js";
import { artworkAt } from "./artwork.js";

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let cached: { token: string; at: number } | undefined;
let cachedCandidates: { list: string[]; at: number } | undefined;

/**
 * Scrape the web player bundle for developer-token candidates.
 *
 * Measured on 2026-09-12: the bundle ships three JWTs and only some of them are accepted
 * by amp-api — `kid=97DQU9QUD6` answered 401 while `kid=LT2ZDZSXNQ` answered 200 for
 * /v1/catalog/us/search. So candidates are never trusted individually: the caller walks
 * the list until one is accepted, which also survives Apple rotating these tokens.
 */
async function tokenCandidates(): Promise<string[]> {
    if (cachedCandidates && Date.now() - cachedCandidates.at < 6 * 3600_000) {
        return cachedCandidates.list;
    }

    const index = await fetch("https://music.apple.com", {
        headers: { "user-agent": UA, accept: "text/html" }
    });
    if (!index.ok) throw new Error(`music.apple.com responded ${index.status}`);
    const html = await index.text();

    const asset = /\/assets\/index~[^/]+\.js/.exec(html);
    if (!asset) throw new Error("could not locate the music.apple.com index bundle");

    const bundle = await fetch(`https://music.apple.com${asset[0]}`, {
        headers: { "user-agent": UA, accept: "application/javascript" }
    });
    if (!bundle.ok) throw new Error(`index bundle responded ${bundle.status}`);
    const js = await bundle.text();

    const list = [...new Set(js.match(/eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+/g) ?? [])];
    if (list.length === 0) throw new Error("no JWT candidates found in the bundle");

    // The purpose-built web-player token first, then the rest in bundle order.
    list.sort((a, b) => Number(isWebPlayToken(b)) - Number(isWebPlayToken(a)));

    cachedCandidates = { list, at: Date.now() };
    return list;
}

function isWebPlayToken(jwt: string): boolean {
    try {
        const header = JSON.parse(
            Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8")
        ) as { kid?: string };
        return header.kid === "WebPlayKid";
    } catch {
        return false;
    }
}

/** GET a catalog path, walking token candidates on 401/403. Returns null on 404. */
async function catalogGet(pathname: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`https://amp-api.music.apple.com${pathname}`);
    url.searchParams.set("l", language());
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const list = await tokenCandidates();
    const ordered = cached ? [cached.token, ...list.filter((t) => t !== cached!.token)] : list;

    let lastStatus = 0;
    for (const token of ordered) {
        const res = await fetch(url, {
            headers: {
                authorization: `Bearer ${token}`,
                origin: "https://music.apple.com",
                "user-agent": UA,
                accept: "application/json"
            }
        });

        if (res.status === 401 || res.status === 403) {
            lastStatus = res.status;
            if (cached?.token === token) cached = undefined;
            continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`catalog request failed: ${res.status} ${res.statusText}`);

        cached = { token, at: Date.now() };
        return (await res.json()) as unknown;
    }
    throw new Error(`catalog request failed: all developer-token candidates were rejected (last ${lastStatus})`);
}

/* ------------------------------------------------------------------ search */

/**
 * 搜索页请求的目录类型。
 *
 * `music-videos` 必须显式写上：目录把音乐视频当**独立类型**（结果落在
 * `results["music-videos"]`），不带它 MV 就永远搜不出来 —— 而 MV 下载正是
 * 这个站点要支持的一类内容（引擎按 URL 里的 `/music-video/` 自行分派）。
 */
export const SEARCH_TYPES = "songs,albums,artists,music-videos";

export type SearchItem = {
    id: string;
    type: "song" | "album" | "artist" | string;
    name: string;
    artistName: string;
    albumName: string;
    /** 封面的**原始模板**，含 `{w}x{h}{f}` 占位；渲染时用 artworkAt() 指定尺寸。 */
    artwork: string;
    url: string;
    trackCount?: number;
    releaseDate?: string;
    durationMs?: number;
    /** 目录给的增强 HLS 清单地址（音质明细的首选取数来源，见 formatsFromCatalog）。 */
    enhancedHls?: string;
};

type RawAttrs = {
    name?: string;
    artistName?: string;
    albumName?: string;
    url?: string;
    trackCount?: number;
    releaseDate?: string;
    durationInMillis?: number;
    artwork?: { url?: string };
    audioTraits?: string[];
    /** 目录给的增强 HLS 清单地址 —— 音质明细的首选取数来源（见 formatsFromCatalog）。 */
    extendedAssetUrls?: { enhancedHls?: string };
    /** 歌单/电台的「策划方」（Apple Music、Apple Music 国语流行…）。歌曲没有这个字段。 */
    curatorName?: string;
    /* --- 详情页要用的字段（目录会在 tracks 与记录上给，但类型里之前没声明） --- */
    discNumber?: number;
    trackNumber?: number;
    hasLyrics?: boolean;
    hasTimeSyncedLyrics?: boolean;
    genreNames?: string[];
    /** 编辑文案。目录给的是 { standard, short } 结构，这里只取 standard。 */
    description?: { standard?: string; short?: string };
};

type RawItem = { id?: string; type?: string; attributes?: RawAttrs };

/** 从目录条目里取增强 HLS 地址（缺失或非 http 一律视为没有）。 */
function enhancedHlsOf(item: { attributes?: RawAttrs } | undefined): string | undefined {
    const url = item?.attributes?.extendedAssetUrls?.enhancedHls ?? "";
    return /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * 把封面的尺寸模板展开成指定像素的可用 URL。
 *
 * **模板的形状不是固定的**，这是踩过的坑。实测见过五种：
 *
 *   `…/xxx.rgb.jpg/{w}x{h}{f}`          → `300x300bb.jpg`
 *   `…/JAY.jpg/{w}x{h}bb.jpg`            → `300x300bb.jpg`
 *   `…/xxx.jpg/{w}x{h}.jpg`              → `300x300bb.jpg`
 *   `…/xxx.png/{w}x{h}SC.DN01.jpg?l=..`  → `300x300bb.jpg`   （播放列表）
 *   `…/xxx.sca1.jpg/{w}x{h}mv.jpg`        → `300x300bb.jpg`   （音乐视频）
 *
 * 只认第一种会拼出 `…/{w}x{h}bb.jpg/300x300bb.jpg` 这种垃圾串；
 * 而后两种的尾巴是 `SC.DN01.jpg` / `mv.jpg`，不是 `bb` —— 只吃掉
 * `bb|dd|cc` 会把 `<尺寸>bb.jpg` 拼在残余尾巴前面，
 * 得到 `…/200x200bb.jpgSC.DN01.jpg`，mzstatic 直接 400。
 *
 * 而且这类失败**完全静默**：<img> 加载不到只是空图，控制台没有任何报错。
 *
 * 所以做法是：从 `{w}` 开始**吃掉到查询串之前的整段尾巴**，再换上我们自己的规格。
 * 保留 `?l=` 这类查询参数（它是本地化参数，与尺寸无关）。
 */
export { artworkAt } from "./artwork.js";

export async function searchCatalog(
    term: string,
    types = "songs,albums,artists",
    limit = 12,
    /** 指定目录地区（默认 config.yaml 的 storefront）—— 地区覆盖与自动匹配要用它查目标区 */
    storefrontOverride?: string
): Promise<SearchItem[]> {
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(pickStorefront(storefrontOverride))}/search`,
        // extend 是必须的：搜索结果本身就带 enhancedHls，音质明细因此不必再问 wrapper
        // （实测 wrapper 每次约 780ms，而直接抓清单约 100ms）。
        { term, types, limit: String(limit), offset: "0", extend: "extendedAssetUrls" }
    );
    const body = raw as { results?: Record<string, { data?: RawItem[] } | undefined> };
    const out: SearchItem[] = [];
    for (const [kind, group] of Object.entries(body.results ?? {})) {
        for (const item of group?.data ?? []) {
            const a = item.attributes ?? {};
            // 搜索响应里每个条目的 type 是**复数**（"songs"/"albums"/"artists"），
            // 要先去掉复数再归类：否则下面的 order[] 一个都命中不了、排序形同虚设，
            // 界面上也会显示成 "songs"。调用方（如自动匹配）按单数比较时更会全部落空。
            const type = (item.type ?? kind).replace(/s$/, "");
            out.push({
                id: item.id ?? "",
                type,
                name: a.name ?? "(untitled)",
                artistName: a.artistName ?? "",
                albumName: a.albumName ?? "",
                artwork: a.artwork?.url ?? "",
                url: a.url ?? "",
                trackCount: a.trackCount,
                releaseDate: a.releaseDate,
                durationMs: a.durationInMillis,
                enhancedHls: enhancedHlsOf(item)
            });
        }
    }
    // 排序：歌 → 专辑 → 艺人 → 音乐视频（MV 是**视频**，放在音频结果之后，
    // 免得用户搜歌名时被一堆 Lyric Video 顶下去）。
    const order: Record<string, number> = { song: 0, album: 1, artist: 2, "music-video": 3 };
    out.sort((x, y) => (order[x.type] ?? 9) - (order[y.type] ?? 9));
    return out;
}

/* ------------------------------------------------------------------ charts */

/**
 * 榜单（Top Charts）。
 *
 * 用**公开开发者 token** 就能取，不需要 Apple 账号 —— 实测
 * `/v1/catalog/{sf}/charts?types=albums,songs,playlists,music-videos` 返回 200。
 * （对照：`/v1/editorial/...` 那条「New Music」路径需要 media-user-token，
 *   当前实测 400，所以只做榜单，不做 New。）
 *
 * 返回结构与搜索不同：每个类型下面是一个**榜单数组**，每个榜单再带 data：
 *   results.songs[0].name = "热门歌曲排行"
 *   results.songs[0].data = [ …条目… ]
 * 这里取每个类型的**第一个榜单**（Apple 当前只给一个），并把榜单名一起带回去，
 * 界面可以显示「热门歌曲排行」而不是干巴巴一个标题。
 */
export type ChartSection = {
    /** 单数类型：song / album / playlist / music-video */
    type: string;
    /** 榜单名，例如「热门歌曲排行」 */
    chartName: string;
    items: SearchItem[];
};

export async function fetchCharts(
    limit = 12,
    storefrontOverride?: string
): Promise<ChartSection[]> {
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(pickStorefront(storefrontOverride))}/charts`,
        {
            types: "songs,albums,playlists,music-videos",
            limit: String(limit),
            // 与搜索一致：带上 enhancedHls，音质明细不必再问 wrapper
            extend: "extendedAssetUrls"
        }
    );
    const body = raw as Record<string, unknown> | null;
    if (!body) return [];
    const results = (body["results"] ?? {}) as Record<string, Array<{ name?: string; data?: RawItem[] }>>;

    const out: ChartSection[] = [];
    for (const [key, charts] of Object.entries(results)) {
        const chart = charts?.[0];
        if (!chart) continue;
        const items: SearchItem[] = (chart.data ?? []).map((item) => {
            const a = item.attributes ?? {};
            return {
                id: item.id ?? "",
                // 榜单里 type 也是复数（songs/albums/playlists/music-videos），
                // 与搜索保持一致的归一化，否则下游按单数比较全部落空
                type: (item.type ?? key).replace(/s$/, ""),
                name: a.name ?? "(untitled)",
                artistName: a.artistName ?? "",
                albumName: a.albumName ?? "",
                artwork: a.artwork?.url ?? "",
                url: a.url ?? "",
                trackCount: a.trackCount,
                releaseDate: a.releaseDate,
                durationMs: a.durationInMillis,
                enhancedHls: enhancedHlsOf(item)
            };
        });
        if (items.length > 0) out.push({ type: key.replace(/s$/, ""), chartName: chart.name ?? "", items });
    }
    // 固定顺序：歌 → 专辑 → 播放列表 → MV（与搜索的排序理由相同）
    const order: Record<string, number> = { song: 0, album: 1, playlist: 2, "music-video": 3 };
    out.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
    return out;
}

/* ------------------------------------------------- real per-track capabilities */

/** Codecs this frontend can request, in display order. */
export const ALL_CODECS = ["alac", "atmos", "aac"] as const;
export type Codec = (typeof ALL_CODECS)[number];

export type TrackCapability = {
    id: string;
    name: string;
    artistName: string;
    albumName: string;
    /** 封面模板（同 SearchItem.artwork）—— 解析预览也要能出封面，不能只有搜索页有。 */
    artwork: string;
    /** Raw Apple `audioTraits` values, e.g. ["lossless","hi-res-lossless","atmos"]. */
    traits: string[];
    /** Which of ALL_CODECS this track actually supports. */
    codecs: Codec[];
    /** 时长（ms）—— 自动匹配「艺人 + 时长一致」要用（可能缺失） */
    durationMs?: number;
    /** Human-readable summary for the UI. */
    summary: string;
    /** 能力信息的来源：单曲 / 专辑曲目合集 / 播放列表曲目合集 */
    source: string;
    /**
     * 该链接实际覆盖的曲目 id（专辑/播放列表是全部曲目，单曲只有一个）。
     * 音质明细要逐曲去 master playlist 取位深/采样率，靠这个列表。
     */
    trackIds: string[];
    /**
     * 与 trackIds 一一对应的目录增强 HLS 清单地址（可能缺失）。
     * 有它就不必问 wrapper-lite —— 这是音质明细的首选取数路径。
     */
    trackHls: Array<string | undefined>;
    /**
     * 每个可用变体的音质明细（含位深、采样率、Hi-Res / Dolby Atmos 判定）。
     * 取不到时是空数组 —— 界面据此显示"未知"，绝不用 traits 猜一个数字出来。
     */
    formats: AudioFormat[];
};

/** traits -> 可请求的编码，顺序固定为 alac, atmos, aac。 */
export function mapTraits(traits: string[]): Codec[] {
    const has = (needle: string): boolean => traits.some((t) => t.includes(needle));
    const out: Codec[] = [];
    if (has("lossless")) out.push("alac");
    if (has("atmos") || has("spatial")) out.push("atmos");
    out.push("aac"); // Apple 始终提供有损兜底
    return out;
}

export function summarizeTraits(traits: string[]): string {
    const has = (needle: string): boolean => traits.some((t) => t.includes(needle));
    const labels: string[] = [];
    if (has("hi-res-lossless")) labels.push("高解析度无损");
    else if (has("lossless")) labels.push("无损");
    if (has("atmos")) labels.push("Dolby Atmos");
    else if (has("spatial")) labels.push("空间音频");
    labels.push("AAC 有损");
    return labels.join(" · ");
}

function pickStorefront(sf: string | undefined): string {
    return (sf && /^[a-z]{2}$/i.test(sf) ? sf : storefront()).toLowerCase();
}

type RawResource = {
    id?: string;
    attributes?: RawAttrs;
    relationships?: { tracks?: { data?: RawItem[] } };
};

/** 单曲的真实能力（Apple 的 audioTraits）。 */
export async function trackCapability(adamId: string, storefront?: string): Promise<TrackCapability | null> {
    const sf = pickStorefront(storefront);
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(sf)}/songs/${encodeURIComponent(adamId)}`,
        { extend: "extendedAssetUrls" }
    );
    if (!raw) return null;

    const item = ((raw as { data?: RawResource[] }).data ?? [])[0];
    if (!item) return null;
    const a = item.attributes ?? {};
    const traits = (a.audioTraits ?? []).map(String);

    return {
        id: item.id ?? adamId,
        name: a.name ?? "",
        artistName: a.artistName ?? "",
        albumName: a.albumName ?? "",
        artwork: a.artwork?.url ?? "",
        traits,
        codecs: mapTraits(traits),
        durationMs: typeof a.durationInMillis === "number" ? a.durationInMillis : undefined,
        summary: summarizeTraits(traits),
        source: "单曲",
        trackIds: [item.id ?? adamId],
        trackHls: [enhancedHlsOf(item)],
        formats: []
    };
}

/**
 * 专辑 / 播放列表：取全部曲目 audioTraits 的**合集**。
 * 这样贴专辑链接时也能给出真实可选的编码，而不是一律回落成三项。
 */
async function collectionCapability(
    kind: "albums" | "playlists",
    id: string,
    storefront?: string
): Promise<TrackCapability | null> {
    const sf = pickStorefront(storefront);
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(sf)}/${kind}/${encodeURIComponent(id)}`,
        { include: "tracks", extend: "extendedAssetUrls" }
    );
    if (!raw) return null;

    const item = ((raw as { data?: RawResource[] }).data ?? [])[0];
    if (!item) return null;

    const tracks = item.relationships?.tracks?.data ?? [];
    const union = new Set<string>();
    for (const t of tracks) for (const tr of t.attributes?.audioTraits ?? []) union.add(String(tr));

    const traits = [...union];
    const a = item.attributes ?? {};
    const label = kind === "albums" ? "专辑" : "播放列表";
    const trackItems = tracks.filter((t) => /^\d+$/.test(t.id ?? ""));
    const trackIds = trackItems.map((t) => t.id as string);
    // 曲目列表里就带着增强 HLS 地址（实测专辑 tracks 关系带 extend 后会有），
    // 于是解析预览对整张专辑也**不必逐曲问 wrapper**。
    const trackHls = trackItems.map((t) => enhancedHlsOf(t));

    return {
        id: item.id ?? id,
        name: a.name ?? "",
        artistName: a.artistName ?? "",
        albumName: kind === "albums" ? (a.name ?? "") : "",
        artwork: a.artwork?.url ?? "",
        traits,
        codecs: tracks.length > 0 ? mapTraits(traits) : [...ALL_CODECS],
        summary: tracks.length > 0 ? summarizeTraits(traits) : "未知",
        source: tracks.length > 0 ? `${label}（${tracks.length} 首曲目的能力合集）` : label,
        trackIds,
        trackHls,
        formats: []
    };
}

/* ------------------------------------------------------------- 详情页数据 */

/** 详情页里的单条曲目。 */
export type ItemTrack = {
    id: string;
    name: string;
    artistName: string;
    albumName: string;
    /** 时长（ms） */
    durationMs?: number;
    /** 曲序（discNumber/trackNumber 组合成 "1-02" 这种） */
    trackNo?: string;
    diskNumber?: number;
    trackNumber?: number;
    /** 该曲自己的目录 URL（用于逐曲建任务） */
    url: string;
    /** 是否有歌词（目录会给 hasLyrics / hasTimeSyncedLyrics） */
    hasLyrics?: boolean;
    hasTimeSyncedLyrics?: boolean;
};

export type ItemDetail = {
    kind: "song" | "album" | "playlist" | "artist" | "music-video" | string;
    id: string;
    name: string;
    artistName: string;
    /** 封面模板（含 {w}x{h}） */
    artwork: string;
    /** 这条记录的目录 URL —— 也是"整张下载"用的那个链接 */
    url: string;
    releaseDate?: string;
    trackCount?: number;
    genreNames?: string[];
    /** 专辑/播放列表的曲目；单曲与艺人时为空 */
    tracks: ItemTrack[];
    /** 描述（编辑文案，可能没有） */
    description?: string;
};

/**
 * 详情页数据：一条记录 + 它的曲目列表。
 *
 * 与 `capabilityFor` 的区别：那个只关心"能下什么编码"（traits/格式），
 * 这个关心"里面有哪些曲目、每首多长、有没有歌词" —— 详情页要展示的是后者。
 * 两者查的是**同一个目录接口**，但取不同字段，合并反而会让两边都变复杂。
 */
export async function itemDetail(
    kind: string,
    id: string,
    storefrontOverride?: string
): Promise<ItemDetail | null> {
    const sf = pickStorefront(storefrontOverride);
    if (!/^\d+$/.test(id) && !/^pl\./.test(id)) return null;

    /* 单曲与 MV 没有 tracks 关系（它们本身就是曲目）。 */
    const isCollection = kind === "album" || kind === "playlist";
    const pathKind = kind === "album" ? "albums" : kind === "playlist" ? "playlists" : kind === "music-video" ? "music-videos" : "songs";
    const params: Record<string, string> = { extend: "extendedAssetUrls" };
    if (isCollection) params["include"] = "tracks";

    const raw = await catalogGet(`/v1/catalog/${encodeURIComponent(sf)}/${pathKind}/${encodeURIComponent(id)}`, params);
    if (!raw) return null;
    const item = ((raw as { data?: RawResource[] }).data ?? [])[0];
    if (!item) return null;
    const a = item.attributes ?? {};

    const tracks: ItemTrack[] = (item.relationships?.tracks?.data ?? [])
        /* 只保留数字 id：目录偶尔会在 tracks 里塞 "more-by" 之类的伪条目 */
        .filter((t) => /^\d+$/.test(t.id ?? ""))
        .map((t) => {
            const ta = t.attributes ?? {};
            /* 曲序：优先 disc-track 组合，播放列表通常没有 disc */
            const disc = typeof ta.discNumber === "number" ? ta.discNumber : undefined;
            const no = typeof ta.trackNumber === "number" ? ta.trackNumber : undefined;
            const trackNo = no === undefined ? undefined : disc && disc > 1 ? `${disc}-${String(no).padStart(2, "0")}` : String(no).padStart(2, "0");
            return {
                id: t.id ?? "",
                name: ta.name ?? "",
                artistName: ta.artistName ?? "",
                albumName: ta.albumName ?? "",
                durationMs: typeof ta.durationInMillis === "number" ? ta.durationInMillis : undefined,
                trackNo,
                diskNumber: disc,
                trackNumber: no,
                url: ta.url ?? "",
                hasLyrics: ta.hasLyrics,
                hasTimeSyncedLyrics: ta.hasTimeSyncedLyrics
            };
        });

    return {
        kind,
        id: item.id ?? id,
        name: a.name ?? "",
        artistName: a.artistName ?? "",
        artwork: a.artwork?.url ?? "",
        url: a.url ?? "",
        releaseDate: a.releaseDate,
        trackCount: typeof a.trackCount === "number" ? a.trackCount : tracks.length || undefined,
        genreNames: Array.isArray(a.genreNames) ? a.genreNames.map(String) : undefined,
        tracks,
        description: a.description?.standard
    };
}

/**
 * 专辑/播放列表里的曲目（id + 目录给的增强 HLS 清单地址）。
 *
 * 单独导出是给搜索结果页用的：那里要的只是"这张专辑有什么规格"，
 * 不值得为它拉整张专辑的曲目（见 SEARCH_TRACK_PROBE_LIMIT）。
 */
export async function collectionTracks(
    kind: "albums" | "playlists",
    id: string,
    storefrontOverride?: string
): Promise<Array<{ id: string; enhancedHls?: string }>> {
    const sf = pickStorefront(storefrontOverride);
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(sf)}/${kind}/${encodeURIComponent(id)}`,
        { include: "tracks", extend: "extendedAssetUrls" }
    );
    const item = ((raw as { data?: RawResource[] } | null)?.data ?? [])[0];
    const tracks = item?.relationships?.tracks?.data ?? [];
    return tracks
        .filter((t) => /^\d+$/.test(t.id ?? ""))
        .map((t) => ({ id: t.id as string, enhancedHls: enhancedHlsOf(t) }));
}

/**
 * 给一份能力补上**每个变体的音质明细**。
 *
 * 失败一律降级为「没有明细」而不是抛错：音质是附加信息，
 * 不该因为它拿不到就让整个解析预览失败（原有三项回退语义必须保住）。
 */
export async function withFormats(
    cap: TrackCapability,
    storefrontOverride?: string
): Promise<TrackCapability> {
    try {
        if (cap.trackIds.length <= 1) {
            const id = cap.trackIds[0] ?? cap.id;
            return {
                ...cap,
                formats: await formatsFromCatalog(id, cap.trackHls[0], storefrontOverride)
            };
        }
        // 专辑/播放列表：逐曲取（并发受限、去重合并）—— 不限首数，用户要的就是这张专辑全貌
        const tracks = cap.trackIds.map((id, i) => ({ id, enhancedHls: cap.trackHls[i] }));
        return { ...cap, formats: await collectionFormats(tracks, undefined, storefrontOverride) };
    } catch {
        return cap;
    }
}

/** 按链接类型取真实能力；artist/unknown 返回 null 交由调用方回落。 */
export async function capabilityFor(
    kind: string,
    id: string,
    storefront?: string
): Promise<TrackCapability | null> {
    if (kind === "song") return trackCapability(id, storefront);
    if (kind === "album") return collectionCapability("albums", id, storefront);
    if (kind === "playlist") return collectionCapability("playlists", id, storefront);
    return null;
}

/* ------------------------------------------------- 每个变体的音质明细（位深/采样率） */

/**
 * 音质明细的取数路径 —— 为什么走 wrapper-lite 而不是目录 API：
 *
 *   `audioTraits` 只说得出「有没有 hi-res-lossless」，**说不出位深与采样率**
 *   （这是用户真正要看的两项）。权威值在 master playlist 的
 *   `SAMPLE-RATE=` / `BIT-DEPTH=` 上，而要拿到它必须先有一个 HLS 播放清单 URL。
 *
 *   wrapper-lite 的 `/m3u8?adamId=<id>` 正是干这个的：本地 HTTP、自动带账号令牌，
 *   实测返回 `{"code":0,...,"data":{"m3u8":"https://aod.itunes.apple.com/.../x_lossless.m3u8"}}`。
 *   目录的 `extendedAssetUrls.enhancedHls` 也能给，但它依赖公开开发者 token，
 *   而这个 token 在本项目里是会过期、要轮换的（见 tokenCandidates），
 *   音质这种"顺手一看"的信息不该压在它身上 —— 所以它只作为兜底。
 */

type CacheEntry = { formats: AudioFormat[]; at: number };
const formatCache = new Map<string, CacheEntry>();
const FORMAT_TTL_MS = 10 * 60_000;
const FORMAT_CACHE_MAX = 500;

/** 向 wrapper-lite 要某首歌的 master playlist URL（这是唯一的"额外"依赖）。 */
async function masterPlaylistUrl(adamId: string): Promise<string | null> {
    const base = config.liteServer.trim().replace(/\/+$/, "");
    if (!base) return null;
    const url = `${base}/m3u8?adamId=${encodeURIComponent(adamId)}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const body = (await res.json()) as { code?: number; data?: { m3u8?: string } };
        if (body.code !== 0) return null;
        const m3u8 = body.data?.m3u8 ?? "";
        return /^https?:\/\//i.test(m3u8) ? m3u8 : null;
    } catch {
        return null;
    }
}

/**
 * 抓一份 master playlist 并解析出全部可用变体。
 * wrapper 不认批量（`?ids=` 会报 missing adamId），所以调用方要自己控并发。
 */
export async function songFormats(adamId: string): Promise<AudioFormat[]> {
    const key = String(adamId);
    const hit = formatCache.get(key);
    if (hit && Date.now() - hit.at < FORMAT_TTL_MS) return hit.formats;

    const playlist = await masterPlaylistUrl(key);
    // m3u8 拿不到时**不缓存空结果**：wrapper 刚起来/网络抖一下是暂时的，
    // 缓存住会让整首歌在这次会话里永远显示"未知"。
    if (!playlist) return [];

    return remember(key, await fetchFormats(playlist));
}

/**
 * 音质明细的取数路径 —— 为什么**以 wrapper-lite 为准**。
 *
 * 这里踩过一个真实的坑，记下来免得再犯：
 *   目录 `extendedAssetUrls.enhancedHls` 给的清单**可能比实际能下的低一档**。
 *   实测 Ado《好きでいて》(adamId 6806106478)：
 *     * wrapper `/m3u8` → `…/P1488201312_default.m3u8`，ALAC 有 **96000-24 与 48000-24 两档**；
 *     * 目录 enhancedHls → `…/P1488201222_default.m3u8`，ALAC **只有 48000-24**。
 *   两者是**不同的清单文件**。引擎下载用的是 wrapper 那个，所以界面若显示目录那个，
 *   就会出现「Apple Music 明明是 Hi-Res，预览却只有 48 kHz」——用户实际就是这么发现的。
 *
 *   曾经在另一首歌（S.H.E《安静了》）上抽查过两条路径一致，就外推成"目录清单够用"，
 *   那个假设是错的：目录给的是降级子集。所以**先用 wrapper**，
 *   目录 enhancedHls 只当 wrapper 不可用时的兜底（聊胜于无，但要清楚它可能偏低）。
 *
 * 代价是速度：wrapper 每次约 780ms（实测与并发无关，是它去 Apple 取清单的固定成本），
 * 而直接抓目录清单只要约 100ms。正确性优先，速度靠缓存与限量来补。
 */
export async function formatsFromCatalog(
    adamId: string,
    enhancedHls: string | undefined,
    storefrontOverride?: string
): Promise<AudioFormat[]> {
    const key = String(adamId);
    const hit = formatCache.get(key);
    if (hit && Date.now() - hit.at < FORMAT_TTL_MS) return hit.formats;

    // 首选：wrapper-lite（与引擎下载同源，权威）
    const viaWrapper = await songFormats(key);
    if (viaWrapper.length > 0) return viaWrapper;

    // 兜底：目录给的清单（可能偏低一档，但在 wrapper 不可用时总比"未知"强）
    const direct = /^https?:\/\//i.test(enhancedHls ?? "") ? (enhancedHls as string) : null;
    if (!direct) return [];
    return remember(key, await fetchFormats(direct));
}

async function fetchFormats(playlist: string): Promise<AudioFormat[]> {
    try {
        const res = await fetch(playlist, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return [];
        return parseMasterPlaylist(await res.text());
    } catch {
        return [];
    }
}

function remember(key: string, formats: AudioFormat[]): AudioFormat[] {
    if (formats.length > 0) {
        if (formatCache.size >= FORMAT_CACHE_MAX) formatCache.clear();
        formatCache.set(key, { formats, at: Date.now() });
    }
    return formats;
}

/**
 * 清空音质缓存。
 *
 * 生产代码不用它 —— 缓存本来就是 TTL 自愈的。存在的理由只有一个：测试要在同一个进程里
 * 分别验证「wrapper 掉线走目录兜底」和「wrapper 正常优先用它」两条路径，而兜底结果也会进缓存
 * （见 remember），不清就会把后一条路径喂成前一条的结果。
 */
export function clearFormatCache(): void {
    formatCache.clear();
}

/** 有上限的并发映射 —— 见 concurrency.ts 的说明（这一条是保护 NAS 上的 wrapper）。 */

const COLLECTION_LIMIT = 4;
/**
 * 首页/搜索页里给「专辑」结果用的探测上限。
 *
 * 一张专辑可能有十几首，逐曲探测在**解析预览**里是合理的（用户就是要看这张专辑有什么），
 * 但搜索结果里一次要处理 12 条结果，探测整张专辑会把页面拖到十几秒。
 * 取前几首已经足以代表这张专辑的规格（同一张专辑的曲目通常同一档），
 * 所以搜索路径传这个小值；解析预览路径则不限。
 */
export const SEARCH_TRACK_PROBE_LIMIT = 2;

/** 专辑/播放列表：逐曲取音质再去重合并（合并后才能说"这张有哪些规格"）。 */
export async function collectionFormats(
    tracks: Array<{ id: string; enhancedHls?: string }>,
    limit?: number,
    storefrontOverride?: string
): Promise<AudioFormat[]> {
    const seen = new Set<string>();
    const uniq: Array<{ id: string; enhancedHls?: string }> = [];
    for (const t of tracks) {
        if (!/^\d+$/.test(t.id) || seen.has(t.id)) continue;
        seen.add(t.id);
        uniq.push(t);
    }
    if (uniq.length === 0) return [];
    const picked = limit !== undefined && limit > 0 ? uniq.slice(0, limit) : uniq;
    const each = await mapLimit(picked, COLLECTION_LIMIT, (t) =>
        formatsFromCatalog(t.id, t.enhancedHls, storefrontOverride)
    );
    return mergeFormats(each.flat());
}

/*
 * 说明：这里**没有**"按 id 现查目录"的兜底。实测 `/v1/catalog/<sf>/songs/<id>`
 * 即使带 `extend=extendedAssetUrls` 也**不返回** enhancedHls（只有 search 与
 * albums/playlists 的 tracks 关系会返回）。写一条永远不会命中的兜底只会让人误以为有保障。
 */

/* --------------------------------------------------------------- 音乐视频 */

/**
 * 音乐视频的基本信息（MV 没有"位深/采样率"可言，所以这里只取用来展示的最小集合）。
 *
 * 目录里音乐视频是**独立类型**（`music-videos`），有单独的端点与搜索类型，
 * 与歌曲/专辑并列 —— 实测 `/v1/catalog/<sf>/search?types=music-videos` 返回
 * `results["music-videos"]`。
 */
export type MusicVideoInfo = {
    id: string;
    name: string;
    artistName: string;
    albumName: string;
    durationMs?: number;
    releaseDate?: string;
    /** 封面模板（含 `{w}x{h}{f}`），渲染时用 artworkAt() 展开。 */
    artwork: string;
    url: string;
};

export async function musicVideoInfo(adamId: string, storefront?: string): Promise<MusicVideoInfo | null> {
    const sf = pickStorefront(storefront);
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(sf)}/music-videos/${encodeURIComponent(adamId)}`,
        {}
    );
    const item = ((raw as { data?: RawResource[] } | null)?.data ?? [])[0];
    if (!item) return null;
    const a = item.attributes ?? {};
    return {
        id: item.id ?? adamId,
        name: a.name ?? "",
        artistName: a.artistName ?? "",
        albumName: a.albumName ?? "",
        durationMs: typeof a.durationInMillis === "number" ? a.durationInMillis : undefined,
        releaseDate: a.releaseDate,
        artwork: a.artwork?.url ?? "",
        url: a.url ?? ""
    };
}

/* ------------------------------------------------------- 个性化（发现页） */

/**
 * 「发现」的货架。
 *
 * ## 与榜单的区别
 *
 * 榜单（`/v1/catalog/{sf}/charts`）用公开开发者 token 就能取，但它是**编辑维护的**，
 * 好几天才动一次 —— 页面上看起来就是"永远不变"。
 *
 * 这里走 `/v1/me/recommendations`：**按账号个性化**，返回 12 个货架
 * （专属推荐歌单 / 最近播放 / 专属电台推荐 / 最新发行 / 按风格分组的推荐…），
 * 每个货架都带 `nextUpdateDate`，Apple 每天刷新。
 *
 * ## 认证：两个 token 缺一不可
 *
 *   authorization: Bearer <网页抓的开发者 token>
 *   Music-User-Token: <config.yaml 的 media-user-token>
 *
 * 实测（2026-10-28）：只带 media-user-token 而用 config.yaml 里的
 * `authorization-token` 会 401；必须用从 music.apple.com bundle 现抓的那个。
 * 反过来，没有 media-user-token 时 `/v1/me/*` 一律 401 —— 所以它是硬门槛。
 */
export type Shelf = {
    /** 货架标题，如「专属推荐歌单」「最近播放」 */
    title: string;
    /** Apple 的展示形态（MusicNotesHeroShelf / MusicCoverShelf），决定卡片大小 */
    kind: string;
    /** 下次刷新时间（ISO）。没有就为空 */
    nextUpdate?: string;
    items: SearchItem[];
};

/** 从引擎配置里读 media-user-token（新旧两套键都认）。 */
function musicUserToken(): string {
    const v = tryLoadEngineConfig()?.values ?? {};
    for (const key of SECRET_KEYS) {
        const t = (v[key] ?? "").trim();
        if (t) return t;
    }
    return "";
}

/** 当前账号是否可用于个性化内容（界面据此决定是否显示「为你推荐」）。 */
export function hasUserToken(): boolean {
    return musicUserToken() !== "";
}

/**
 * 取个性化货架。
 *
 * 返回空数组表示"拿不到"（没有 token / token 失效 / Apple 抽风），
 * 而不是抛错 —— 首页不该因为个性化取不到就整块报错，
 * 榜单仍然可以照常显示。
 */
export async function personalShelves(limit = 12): Promise<Shelf[]> {
    const mut = musicUserToken();
    if (!mut) return [];

    const url = new URL("https://amp-api.music.apple.com/v1/me/recommendations");
    url.searchParams.set("l", language());
    url.searchParams.set("limit", String(limit));

    const list = await tokenCandidates();
    const ordered = cached ? [cached.token, ...list.filter((t) => t !== cached!.token)] : list;

    for (const token of ordered) {
        const res = await fetch(url, {
            headers: {
                authorization: `Bearer ${token}`,
                "music-user-token": mut,
                origin: "https://music.apple.com",
                "user-agent": UA,
                accept: "application/json"
            }
        });
        if (res.status === 401 || res.status === 403) continue;
        if (!res.ok) return [];

        const body = (await res.json()) as {
            data?: Array<{
                type?: string;
                attributes?: { title?: { stringForDisplay?: string }; display?: { kind?: string }; nextUpdateDate?: string };
                relationships?: { contents?: { data?: RawItem[] } };
            }>;
        };

        const out: Shelf[] = [];
        for (const rec of body.data ?? []) {
            const a = rec.attributes ?? {};
            const contents = rec.relationships?.contents?.data ?? [];
            const items: SearchItem[] = contents
                .map((item) => {
                    const ia = item.attributes ?? {};
                    return {
                        id: item.id ?? "",
                        /* 与搜索/榜单一致：目录给复数，这里归一到单数 */
                        type: (item.type ?? "").replace(/s$/, ""),
                        name: ia.name ?? "(untitled)",
                        /* 歌单没有 artistName，用 curatorName（Apple Music / 某风格） */
                        artistName: ia.artistName ?? ia.curatorName ?? "",
                        albumName: ia.albumName ?? "",
                        artwork: ia.artwork?.url ?? "",
                        url: ia.url ?? "",
                        trackCount: ia.trackCount,
                        releaseDate: ia.releaseDate,
                        durationMs: ia.durationInMillis
                    };
                })
                /* 空 id 的条目点了也没用，直接丢掉 */
                .filter((i) => i.id !== "");

            if (items.length === 0) continue;
            out.push({
                title: a.title?.stringForDisplay ?? "推荐",
                kind: a.display?.kind ?? "",
                nextUpdate: a.nextUpdateDate,
                items
            });
        }
        return out;
    }
    return [];
}
