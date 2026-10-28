/**
 * Apple 封面模板展开 —— **唯一**的服务端实现。
 *
 * ## 为什么单独一个文件
 *
 * 同一条规则以前抄了两份（ampmusic.ts 与 index.ts），靠一条单测逐字比对来防漂移。
 * 漂移的代价很隐蔽：某处封面变成空图，而 `<img>` 加载失败**不产生任何报错**。
 * 现在两份合一，只剩浏览器那份还需要手抄（见 public/catalog-ui.js）。
 *
 * ## 规则
 *
 * 模板形如 `.../{w}x{h}{crop}.{ext}`，`{w}` / `{h}` 是尺寸占位。实测遇到的尾巴：
 *
 *   `{f}`           → Apple 的"格式"占位，换成 bb.jpg
 *   `bb.jpg`        → 标准裁切
 *   `.jpg`          → 只有扩展名
 *   `SC.DN01.jpg`   → 播放列表的裁切
 *   `mv.jpg`        → MV
 *   `AM.PDCXS19.jpg`→ **个性化歌单**（`/gen/` 路径下），带颜色参数与签名
 *
 * 早先的做法是「从 `{w}` 起吃掉整段尾巴，换成 `200x200bb.jpg`」。对前五种都有效，
 * 但对 `/gen/` 那种**会 404**：该路径下的 URL 带 `signature`/`vkey` 参数，
 * 服务端只认原样的裁切串（实测 `200x200bb.jpg` → 404，`200x200AM.PDCXS19.jpg` → 200）。
 *
 * 所以现在**只替换占位符本身**，尾巴原样保留。查询串也自然不受影响。
 */
export function artworkAt(template: string, size: number, format: "jpg" | "webp" = "jpg"): string {
    if (!template) return "";
    if (!template.includes("{w}")) return template;

    let url = template.replace("{w}", String(size)).replace("{h}", String(size));

    /* `{f}` 是"格式"占位，补成标准裁切 */
    url = url.replace("{f}", `bb.${format}`);

    /*
     * 模板到 `{h}` 就结束（`.../{w}x{h}`）时，展开后是 `.../200x200`，
     * 还缺裁切与扩展名 —— 补上默认值。
     * 用 lookahead 限定「紧跟 ? 或字符串末尾」，避免误伤 `200x200bb.jpg` 这类已完整的。
     */
    url = url.replace(/(\d+x\d+)(?=\?|$)/, `$1bb.${format}`);

    return url;
}
