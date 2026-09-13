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

export type SearchItem = {
    id: string;
    type: "song" | "album" | "artist" | string;
    name: string;
    artistName: string;
    albumName: string;
    artwork: string;
    url: string;
    trackCount?: number;
    releaseDate?: string;
    durationMs?: number;
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
};

type RawItem = { id?: string; type?: string; attributes?: RawAttrs };

export async function searchCatalog(
    term: string,
    types = "songs,albums,artists",
    limit = 12
): Promise<SearchItem[]> {
    const raw = await catalogGet(
        `/v1/catalog/${encodeURIComponent(storefront())}/search`,
        { term, types, limit: String(limit), offset: "0" }
    );
    const body = raw as { results?: Record<string, { data?: RawItem[] } | undefined> };
    const out: SearchItem[] = [];
    for (const [kind, group] of Object.entries(body.results ?? {})) {
        for (const item of group?.data ?? []) {
            const a = item.attributes ?? {};
            const type = item.type ?? kind.replace(/s$/, "");
            out.push({
                id: item.id ?? "",
                type,
                name: a.name ?? "(untitled)",
                artistName: a.artistName ?? "",
                albumName: a.albumName ?? "",
                artwork: (a.artwork?.url ?? "").replace("{w}", "160").replace("{h}", "160"),
                url: a.url ?? "",
                trackCount: a.trackCount,
                releaseDate: a.releaseDate,
                durationMs: a.durationInMillis
            });
        }
    }
    const order: Record<string, number> = { song: 0, album: 1, artist: 2 };
    out.sort((x, y) => (order[x.type] ?? 9) - (order[y.type] ?? 9));
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
    /** Raw Apple `audioTraits` values, e.g. ["lossless","hi-res-lossless","atmos"]. */
    traits: string[];
    /** Which of ALL_CODECS this track actually supports. */
    codecs: Codec[];
    /** Human-readable summary for the UI. */
    summary: string;
    /** 能力信息的来源：单曲 / 专辑曲目合集 / 播放列表曲目合集 */
    source: string;
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
        traits,
        codecs: mapTraits(traits),
        summary: summarizeTraits(traits),
        source: "单曲"
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

    return {
        id: item.id ?? id,
        name: a.name ?? "",
        artistName: a.artistName ?? "",
        albumName: kind === "albums" ? (a.name ?? "") : "",
        traits,
        codecs: tracks.length > 0 ? mapTraits(traits) : [...ALL_CODECS],
        summary: tracks.length > 0 ? summarizeTraits(traits) : "未知",
        source: tracks.length > 0 ? `${label}（${tracks.length} 首曲目的能力合集）` : label
    };
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
