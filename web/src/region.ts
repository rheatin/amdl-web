/**
 * 任务级「元数据地区」覆盖 —— 计划解析（纯逻辑，依赖全部注入，便于离线单测）。
 *
 * 为什么地区只能靠改写 URL：
 *   引擎（apple-music-dl）的地区**只从 URL 取** ——
 *     storefront, id := checkUrl(urlRaw, "song"|"album"|"playlist"|…)
 *   config.yaml 里的 `storefront` 键只影响引擎自己的搜索命令，与 URL 任务取数无关。
 *   所以「本次任务用日区元数据」= 把链接里的 /cn/ 换成 /jp/。
 *
 * 判定「目标区有没有」的三个状态（见 amp-api/catalogGet 的既有约定）：
 *   有      → 200，返回记录
 *   没有    → 404（catalogGet 返回 null）
 *   查不动  → 网络/token 异常（抛错）
 * 后两者的**用户含义完全不同**（「日区没上架」vs「没查成」），必须分开提示，
 * 也绝不能因为一次网络抖动就静默给出罗马音文件名。
 *
 * 自动匹配（可选，默认关）：
 *   目标区没有这条记录时，Apple 目录里常常存在**另一条**等价记录（不同 adamId，
 *   例如 EGOIST《Departures》在日区是 2020 再版）。匹配规则刻意保守：
 *   **艺人名（去空白、忽略大小写）+ 时长（±1s）同时一致**才采用。
 *   理由：同一个搜索结果里就可能混进同名翻唱（实测撞见过 1 分 01 秒的翻唱版），
 *   标题本身又因语言不同而不可比，所以宁可回退也不猜。
 */
import { parseAppleMusicUrl, normalizeRegion, swapRegion } from "./urlinfo.js";

/** 目标区与候选记录的时长容差：不同版本常有几百毫秒的淡入淡出差异。 */
export const MATCH_TOLERANCE_MS = 1000;

export type RegionReason =
    /** 没选地区：完全跟随链接 */
    | "none"
    /** 选的地区与链接自带的一致：无需改写 */
    | "same_region"
    /** 目标区有这条记录：按目标区改写 */
    | "ok"
    /** 目标区没有，但自动匹配到了等价记录 */
    | "matched"
    /** 目标区没有 → 回退到原始链接 */
    | "not_in_target"
    /** 探测失败（网络/token）→ 回退到原始链接 */
    | "probe_failed"
    /** 该类型不做预检（播放列表/艺人），按目标区直接跑 */
    | "unprobed"
    /** 链接不是 Apple Music 链接或无法改写 */
    | "rewrite_failed";

export type RegionMatch = {
    id: string;
    name: string;
    artistName: string;
    albumName: string;
    durationMs?: number;
    /** 与源记录的时长差（ms） */
    deltaMs?: number;
};

export type RegionPlan = {
    originalUrl: string;
    /** 真正交给引擎的 URL */
    effectiveUrl: string;
    /** 用户请求的地区（"" = 跟随链接） */
    requested: string;
    /** 实际取数的目录地区（"" = 未知） */
    effective: string;
    changed: boolean;
    /** 是否发生了回退（目标区没有 / 探测失败） */
    fallback: boolean;
    reason: RegionReason;
    /** 给用户看的一句话 */
    note: string;
    match?: RegionMatch;
};

/** 探测依赖：真实实现在 index.ts（用 amp-api），测试里注入假实现。 */
export type RegionDeps = {
    /** 目标区目录里的这条记录；null = 404 没有；抛错 = 查不动 */
    track(kind: string, id: string, region: string): Promise<RegionTrack | null>;
    /** 在目标区按关键词搜单曲（自动匹配用） */
    search(term: string, region: string): Promise<RegionCandidate[]>;
};

export type RegionTrack = {
    name: string;
    artistName: string;
    durationMs?: number;
};

export type RegionCandidate = RegionMatch & { url: string };

const LABELS: Record<string, string> = {
    cn: "中国大陆 cn",
    jp: "日本 jp",
    us: "美国 us",
    gb: "英国 gb",
    hk: "香港 hk",
    tw: "台湾 tw",
    kr: "韩国 kr",
    de: "德国 de",
    fr: "法国 fr",
    ca: "加拿大 ca",
    au: "澳大利亚 au",
    sg: "新加坡 sg"
};

export function regionLabel(cc: string | undefined): string {
    if (!cc) return "链接地区";
    return LABELS[cc.toLowerCase()] ?? cc.toLowerCase();
}

/** 去空白 + 大小写折叠 —— 「タイナカ サチ」与「タイナカサチ」必须视为同一艺人。 */
export function normalizeArtistName(v: string): string {
    return v.replace(/[\s\u3000]+/g, "").toLowerCase();
}

/**
 * 自动匹配的选人规则：艺人一致 + 时长在容差内，取时长最接近的那个。
 * 时长任一方缺失一律不匹配（宁可不换，也不要下错曲目）。
 */
export function pickEquivalent(
    src: RegionTrack,
    candidates: RegionCandidate[],
    tolerance: number = MATCH_TOLERANCE_MS
): RegionCandidate | null {
    if (typeof src.durationMs !== "number" || src.durationMs <= 0) return null;
    const want = normalizeArtistName(src.artistName);
    if (!want) return null;

    let best: RegionCandidate | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        if (typeof c.durationMs !== "number" || c.durationMs <= 0) continue;
        if (normalizeArtistName(c.artistName) !== want) continue;
        const delta = Math.abs(c.durationMs - src.durationMs);
        if (delta > tolerance) continue;
        if (delta < bestDelta) {
            // 把差额一起带上：界面上要显示「时长差 xx ms」，让用户能自己复核这个匹配
            best = { ...c, deltaMs: delta };
            bestDelta = delta;
        }
    }
    return best;
}

/** 自动匹配只对单曲生效：整张专辑/播放列表换记录会改变任务规模，不做。 */
export function autoMatchSupported(kind: string): boolean {
    return kind === "song";
}

/**
 * 自动匹配的搜索词，**按精确度从高到低**依次尝试：
 *
 *   1. `艺人 完整曲名`  —— 最精确
 *   2. `艺人 曲名首词`  —— Apple 的搜索对罗马音↔假名的互转并不总是生效，
 *      实测用完整罗马音标题（"EGOIST Departures - Anata Ni Okuru Ai No Uta"）
 *      在日区**一条都搜不到**，而缩成 "EGOIST Departures" 就能搜到日文标题那条记录
 *   3. `艺人`          —— 最后兜底：候选靠「艺人 + 时长」筛，范围大但不危险
 *
 * 之所以敢放宽搜索：真正的把关在 pickEquivalent（艺人一致 + 时长 ±1s），
 * 搜索只负责「把候选捞回来」。去重与提前命中在调用方处理。
 */
export function buildMatchQueries(src: RegionTrack): string[] {
    const artist = src.artistName.trim();
    const name = src.name.trim();
    const out: string[] = [];
    if (artist && name) out.push(`${artist} ${name}`);

    const firstToken = name.split(/[\s\u3000]+/).find((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length >= 2);
    if (artist && firstToken) out.push(`${artist} ${firstToken.replace(/[^\p{L}\p{N}]+$/u, "")}`);
    if (artist) out.push(artist);

    return [...new Set(out.filter((q) => q.length >= 2))];
}

export type ResolveOptions = {
    /** 勾选「目标区没有时自动找等价记录」 */
    autoMatch?: boolean;
    /** 链接没有地区段时，用来查源记录的地区（通常是 config.yaml 的 storefront） */
    defaultRegion?: string;
};

/**
 * 解析出「这次到底用哪个 URL、哪个地区」，并把回退/匹配的原因整理成一句话。
 * 不做任何写操作 —— 预览接口和建任务接口都调用它，保证两边结论一致。
 */
export async function resolveRegionPlan(
    rawUrl: string,
    requestedRegion: unknown,
    opts: ResolveOptions,
    deps: RegionDeps
): Promise<RegionPlan> {
    const originalUrl = rawUrl.trim();
    const link = parseAppleMusicUrl(originalUrl);
    const want = normalizeRegion(requestedRegion);
    const linkRegion = link.storefront ?? "";

    const base = {
        originalUrl,
        requested: want ?? "",
        changed: false,
        fallback: false
    };

    if (!want) {
        return {
            ...base,
            effectiveUrl: originalUrl,
            effective: linkRegion,
            reason: "none",
            note: `元数据地区跟随链接（${regionLabel(linkRegion)}）。`
        };
    }

    if (linkRegion && linkRegion === want) {
        return {
            ...base,
            effectiveUrl: originalUrl,
            effective: want,
            reason: "same_region",
            note: `所选地区与链接一致（${regionLabel(want)}），不做改写。`
        };
    }

    const swapped = swapRegion(originalUrl, want);
    if (!swapped) {
        return {
            ...base,
            effectiveUrl: originalUrl,
            effective: linkRegion,
            reason: "rewrite_failed",
            note: `无法改写链接的地区（${originalUrl} 不是可识别的 Apple Music 链接），已按原链接执行。`
        };
    }

    // 播放列表 / 艺人：拿不到「整条记录」的概念，不做预检，按目标区直接跑。
    if (!autoMatchSupported(link.kind) && link.kind !== "album") {
        return {
            ...base,
            effectiveUrl: swapped,
            effective: want,
            changed: true,
            reason: "unprobed",
            note: `已按 ${regionLabel(want)} 改写链接；${link.kind === "unknown" ? "该类型" : "播放列表/艺人"}不做预检，`
                + `若该区没有这条记录，任务会失败并给出引擎的报错。`
        };
    }

    let probe: RegionTrack | null;
    try {
        probe = await deps.track(link.kind, link.id, want);
    } catch (err) {
        return {
            ...base,
            effectiveUrl: originalUrl,
            effective: linkRegion,
            fallback: true,
            reason: "probe_failed",
            note: `无法确认${regionLabel(want)}是否有这条记录（查询失败：${errText(err)}），`
                + `已按原链接（${regionLabel(linkRegion)}）执行。`
        };
    }

    if (probe) {
        return {
            ...base,
            effectiveUrl: swapped,
            effective: want,
            changed: true,
            reason: "ok",
            note: `${regionLabel(want)}目录里有这条记录：${probe.name || "(未命名)"}`
                + `${probe.artistName ? ` — ${probe.artistName}` : ""}，元数据按该区取。`
        };
    }

    /* 目标区没有 —— 先看要不要自动匹配（仅单曲） */
    if (opts.autoMatch && autoMatchSupported(link.kind)) {
        const srcRegion = linkRegion || normalizeRegion(opts.defaultRegion) || "";
        const matched = await tryAutoMatch(link.id, want, srcRegion, deps);
        if (matched.kind === "match") {
            return {
                ...base,
                effectiveUrl: matched.url,
                effective: want,
                changed: true,
                reason: "matched",
                note: `${regionLabel(want)}没有这条链接对应的记录，但按「艺人 + 时长一致」匹配到另一条：`
                    + `${matched.match.name} — ${matched.match.artistName}`
                    + `${matched.match.albumName ? `（${matched.match.albumName}）` : ""}`
                    + ` · 时长差 ${matched.match.deltaMs ?? 0}ms。`,
                match: matched.match
            };
        }
        return {
            ...base,
            effectiveUrl: originalUrl,
            effective: linkRegion,
            fallback: true,
            reason: "not_in_target",
            note: `${regionLabel(want)}没有这条记录，且没有找到「艺人 + 时长都一致」的替代记录`
                + `（${matched.why}），已回退到链接原本的 ${regionLabel(linkRegion)}。`
        };
    }

    const extra = opts.autoMatch && link.kind === "album" ? "（自动匹配只对单曲生效）" : "";
    return {
        ...base,
        effectiveUrl: originalUrl,
        effective: linkRegion,
        fallback: true,
        reason: "not_in_target",
        note: `${regionLabel(want)}目录里没有这条记录${extra}，已回退到链接原本的 ${regionLabel(linkRegion)}——`
            + `元数据会是该区的写法（常见为英文/罗马音）。`
    };
}

type MatchOutcome =
    | { kind: "match"; url: string; match: RegionMatch }
    | { kind: "none"; why: string };

async function tryAutoMatch(
    id: string,
    want: string,
    srcRegion: string,
    deps: RegionDeps
): Promise<MatchOutcome> {
    let src: RegionTrack | null = null;
    try {
        src = await deps.track("song", id, srcRegion);
    } catch (err) {
        return { kind: "none", why: `无法取得原记录的艺人/时长：${errText(err)}` };
    }
    if (!src) return { kind: "none", why: "无法在链接地区取到原记录" };
    if (typeof src.durationMs !== "number" || src.durationMs <= 0) {
        return { kind: "none", why: "原记录没有时长信息" };
    }

    // 依次尝试由精确到宽泛的搜索词，边搜边判：命中即停（最多 3 次请求）
    const queries = buildMatchQueries(src);
    if (queries.length === 0) {
        return { kind: "none", why: "原记录的艺人/曲名信息不足，无法在目标区搜索" };
    }
    const merged: RegionCandidate[] = [];
    const seen = new Set<string>();
    let searched = 0;
    let searchError = "";
    for (const q of queries) {
        let found: RegionCandidate[];
        try {
            found = await deps.search(q, want);
            searched++;
        } catch (err) {
            searchError = errText(err);
            continue;
        }
        for (const c of found) {
            if (!c.id || seen.has(c.id)) continue;
            seen.add(c.id);
            merged.push(c);
        }
        const hit = pickEquivalent(src, merged);
        if (hit) return finishMatch(hit);
    }

    if (searched === 0) {
        return { kind: "none", why: `在目标区搜索失败：${searchError || "未知错误"}` };
    }
    if (merged.length === 0) {
        return { kind: "none", why: `在目标区用 ${searched} 种搜索词都没搜到任何结果` };
    }
    return { kind: "none", why: explainMiss(src, merged, searched) };
}

function finishMatch(best: RegionCandidate): MatchOutcome {
    // 匹配到的记录用它自己的 URL（Apple 返回的就是该区的链接，带 ?i= 指向单曲）。
    // 无法确认是 Apple Music 链接时宁可不换。
    const url = best.url?.trim() ?? "";
    if (!/^https?:\/\/(music|classical)\.apple\.com\//i.test(url)) {
        return { kind: "none", why: "匹配到的记录没有可用的链接" };
    }
    return { kind: "match", url, match: best };
}

/** 没匹配上时，把「差在哪」说清楚 —— 用户据此判断是放弃还是手动找链接。 */
function explainMiss(src: RegionTrack, candidates: RegionCandidate[], searched: number): string {
    const want = normalizeArtistName(src.artistName);
    const sameArtist = candidates.filter((c) => normalizeArtistName(c.artistName) === want);
    if (sameArtist.length === 0) {
        return `${searched} 种搜索词共 ${candidates.length} 条结果里没有同名艺人（可能是翻唱/他人翻录）`;
    }
    const durations = sameArtist
        .filter((c) => typeof c.durationMs === "number")
        .slice(0, 3)
        .map((c) => `${Math.round((c.durationMs ?? 0) / 1000)}s`)
        .join(" / ");
    return `艺人一致但时长对不上（${durations || "候选没有时长"} vs ${Math.round((src.durationMs ?? 0) / 1000)}s）`;
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
