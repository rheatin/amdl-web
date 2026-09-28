/**
 * 一个极小的「有上限并发」映射。
 *
 * 为什么需要：搜索页要为每条结果去问 wrapper-lite 一次 `/m3u8` 加抓一次 playlist。
 * 12 条结果全并发会把 NAS 上的 wrapper 打满（它与 FairPlay 解密共享同一个进程），
 * 实测搜索因此慢到 15.8 秒 —— 反而比串行还糟。给一个上限后每个请求都能及时得到响应。
 *
 * 这不是性能优化，是**保护服务端**：本服务与 wrapper 跑在同一台 NAS 上。
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const size = Math.max(1, Math.min(limit, items.length));
    const out: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: size }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]!);
        }
    });
    await Promise.all(workers);
    return out;
}
