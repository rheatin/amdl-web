/*
 * 目录卡片的共享工具：封面模板展开 + 文本转义。
 *
 * 为什么单独一个文件：发现页（discover.js）和榜单（charts.js）都要拼卡片，
 * 各抄一份就会出现"某处漏了转义"这种静默问题 —— 曲名/榜单名是**外部输入**
 * （Apple 目录里确实存在用户可提交的曲名），直接拼 innerHTML 等于把 XSS 面
 * 交给目录内容。
 *
 * 注意这仍是**浏览器端的第三份**实现（另两份：ampmusic.ts 的后端版、
 * index.ts 里给 EJS 用的 app.locals.art）。三者跑在互相隔离的环境里，
 * 没法共享模块，所以 test/charts-tabs.test.mjs 有一条断言逐字比对它们的输出。
 */

/*
 * 封面模板展开 —— 浏览器端的实现。
 *
 * 必须与 src/artwork.ts 完全一致：那边是唯一服务端实现（EJS 视图与目录查询共用），
 * 这里是因为浏览器拿不到 Node 模块而必须手抄的一份。
 * 漂移的表现很隐蔽 —— 封面变空图，而 <img> 加载失败不产生任何报错。
 * test/charts-tabs.test.mjs 会拿同一批模板跑两份实现并逐字比对。
 *
 * 关键点（踩过）：**只替换 {w}/{h} 占位符，尾巴原样保留**。
 * 个性化歌单的封面在 /gen/ 路径下，形如
 *   .../gen/{w}x{h}AM.PDCXS19.jpg?c1=…&signature=…&vkey=1
 * 早先「从 {w} 起吃掉整段尾巴换成 200x200bb.jpg」对它会 404（实测）。
 */
const WbArt = (function () {
    return (tpl, size) => {
        if (!tpl) return "";
        if (!tpl.includes("{w}")) return tpl;

        let url = tpl.replace("{w}", String(size)).replace("{h}", String(size));
        /* {f} 是"格式"占位，补成标准裁切 */
        url = url.replace("{f}", "bb.jpg");
        /* 模板到 {h} 就结束 → 展开后是 200x200，还缺裁切与扩展名 */
        url = url.replace(/(\d+x\d+)(?=\?|$)/, "$1bb.jpg");
        return url;
    };
})();

const escHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 属性值同样要转义 —— 单引号包裹时 & 和 ' 最关键。 */
const escAttr = (s) => escHtml(s);


/**
 * 试听按钮 —— 榜单、推荐货架、搜索结果共用。
 *
 * ## 为什么能直接播
 *
 * Apple 目录的 `attributes.previews` 是 **30 秒、不加密** 的 AAC 片段：
 * 实测直接 GET 就返回普通 MP4（头 12 字节是 `ftyp`/`M4A `），
 * 既不需要 wrapper-lite 解密，也不需要先把整首歌下下来。
 * 而且 `<audio>` 加载跨源媒体**不受 CORS 限制**，所以浏览器直连 CDN，
 * 一点流量都不过 NAS。
 *
 * ## 没有 previewUrl 就不出按钮
 *
 * 专辑/歌单/电台条目本身没有 previewUrl（要取其内层曲目）。
 * 给一个点了没声的按钮比不给按钮更糟。
 */
const previewBtn = (it) =>
    it.previewUrl
        ? `<button class="pv" data-play-preview="${escAttr(it.previewUrl)}"
                 data-play-name="${escAttr(it.name)}" data-play-artist="${escAttr(it.artistName)}"
                 title="试听 30 秒" aria-label="试听 ${escAttr(it.name)}">▶</button>`
        : "";
