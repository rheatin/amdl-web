import assert from "node:assert/strict";
import fs from "node:fs";

/*
 * 榜单与分类页签的静态守卫。
 *
 * 守两类东西：
 *   1. 榜单渲染**必须转义**来自 Apple 的文本。曲名/艺人是外部输入，
 *      直接拼 innerHTML 等于把 XSS 面交给目录内容。
 *   2. 分类页签的类别键必须与目录返回的**单数** type 一致，
 *      否则页签永远筛不出东西 —— 而且失败是静默的（卡片不显示，没有任何报错）。
 *
 * 用静态断言而不是跑无头浏览器：这些是"字符串契约"，读源码就能验，
 * 跑浏览器成本高得多、还依赖网络。
 */
const ui = fs.readFileSync(new URL("../public/workbench.js", import.meta.url), "utf8");
const searchJs = fs.readFileSync(new URL("../public/search.js", import.meta.url), "utf8");
const resultsTpl = fs.readFileSync(new URL("../views/partials/results-section.ejs", import.meta.url), "utf8");
const rowTpl = fs.readFileSync(new URL("../views/partials/result-item.ejs", import.meta.url), "utf8");

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
    }
};

/* ---- 1. 转义 ---- */
check("榜单定义了 escHtml / escAttr", /const escHtml =/.test(ui) && /const escAttr =/.test(ui));

/*
 * 只检查**真正插进 HTML 模板**的字段：`${...}` 里的表达式。
 * 不能扫所有字段引用 —— 大量用法并不产出 HTML（正则 .test()、
 * JSON.stringify 的对象字面量、LABEL[] 查表），算进来只会是一串假阳性。
 */
const HTML_SLOT = /\$\{([^}]*)\}/g;
const bad = [];
for (const m of ui.matchAll(HTML_SLOT)) {
    const expr = m[1].trim();
    if (!/\bit\.(name|artistName|albumName|url|artwork)\b|\bsec\.(chartName|type)\b/.test(expr)) continue;
    // 允许：转义函数包裹、LABEL 查表
    if (/^(escHtml|escAttr|WbArt)\(/.test(expr)) continue;
    if (/^LABEL\[/.test(expr)) continue;
    bad.push(expr.slice(0, 60));
}
/* 先收集，再用下面过滤掉嵌套模板后的结果断言 */

/* ---- 2. 分类页签 ---- */
const tplCats = [...resultsTpl.matchAll(/data-cat="([a-z-]+)"/g)].map((m) => m[1]);
check(
    "页签覆盖全部五个类别 + all",
    JSON.stringify(tplCats) === JSON.stringify(["all", "song", "album", "artist", "playlist", "music-video"]),
    `实际 ${JSON.stringify(tplCats)}`
);
/*
 * 嵌套模板（`${cond ? `...` : ""}`）会让上面那轮扫描把一整段标记当成单个表达式，
 * 于是漏掉内层。这里换一种查法：**遍历所有单层 `${}`**（不跨花括号），
 * 内层的插值同样会被扫到 —— 这才是真正覆盖到嵌套的检查。
 */
const LEAF_SLOT = /\$\{([^{}]*)\}/g;
const badLeaf = [];
for (const m of ui.matchAll(LEAF_SLOT)) {
    const expr = m[1].trim();
    if (!/\bit\.(name|artistName|albumName|url|artwork)\b|\bsec\.(chartName|type)\b/.test(expr)) continue;
    if (/^(escHtml|escAttr|WbArt)\(/.test(expr)) continue;
    if (/^LABEL\[/.test(expr)) continue;
    badLeaf.push(expr.slice(0, 60));
}
check("（含嵌套模板）所有插值字段都经过转义", badLeaf.length === 0, `未转义：${JSON.stringify(badLeaf)}`);

/* data-meta 是 JSON 里嵌在单引号属性中，必须由 escAttr 处理，不能直接 JSON.stringify */
check(
    "data-meta 经 escAttr 处理",
    /const meta = escAttr\(JSON\.stringify/.test(ui),
    "JSON 直接进单引号属性会被引号截断"
);

check("卡片带 data-type 供筛选", /data-type="<%= r\.type %>"/.test(rowTpl));
check("筛选逻辑按 data-type 比较", /getAttribute\("data-type"\)\s*===\s*srCat/.test(searchJs));
check("流式插卡后也会应用当前页签", /li\.hidden = !matchesCat\(li\)/.test(searchJs));

/*
 * 页签键必须是单数。搜索响应里 type 是复数（songs/albums/…），
 * searchCatalog 已去掉尾部 s；页签若写复数就永远筛不出东西。
 */
check(
    "页签键是单数形式（与 searchCatalog 归一化后的 type 一致）",
    tplCats.every((c) => c === "all" || !c.endsWith("s")),
    `实际 ${JSON.stringify(tplCats)}`
);

/* ---- 3. 服务端直出时也初始化计数 ---- */
check(
    "首屏静态渲染也会初始化页签计数",
    /^\s*syncCatCats\(\);\s*$/m.test(searchJs),
    "否则服务端直出时页签上没有任何数字"
);

/* ---- 4. 榜单是次要内容，失败不能拖垮页面 ---- */
check(
    "榜单失败时整块隐藏而不是报错",
    /catch\s*\{[\s\S]{0,120}\/\* 取不到就不显示 \*\//.test(ui),
    "榜单挂在首屏红框会让用户以为站点坏了，而实际只是 Apple 抽风"
);


/* ---- 5. 三份 artwork 实现必须给出相同结果 ---- */
/*
 * 同一条规则被抄了三遍（后端 artworkAt / 视图 app.locals.art / 前端 WbArt），
 * 因为三者跑在互相隔离的环境里。漂移的表现是「某处封面变空图 + 零报错」——
 * 已经在播放列表/MV 上真实发生过：后端改了、前端没改。
 * 所以这里拿同一批模板跑三份实现，逐字比对。
 */
const { artworkAt } = await import("../dist/ampmusic.js");

const wbReSrc = (ui.match(/const WbArt = \(function \(\) \{[\s\S]*?const RE = (\/.*?\/);/) || [])[1];
const wbRe = wbReSrc ? (0, eval)(wbReSrc) : null;
const wbArt = (tpl, size) => (tpl && tpl.includes("{w}") ? tpl.replace(wbRe, `${size}x${size}bb.jpg`) : tpl || "");

const idxSrc = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const viewReSrc = (idxSrc.match(/const ART_TEMPLATE_RE = (\/.*?\/);/) || [])[1];
const viewRe = viewReSrc ? (0, eval)(viewReSrc) : null;
const viewArt = (tpl, size) => (tpl && tpl.includes("{w}") ? tpl.replace(viewRe, `${size}x${size}bb.jpg`) : tpl || "");

const PARITY_SHAPES = [
    "https://x/a.rgb.jpg/{w}x{h}{f}",
    "https://x/b.jpg/{w}x{h}bb.jpg",
    "https://x/c.jpg/{w}x{h}.jpg",
    "https://x/d.png/{w}x{h}SC.DN01.jpg?l=zh-Hans",
    "https://x/e.sca1.jpg/{w}x{h}mv.jpg",
    "https://x/f.jpg/{w}x{h}"
];
check("三份 artwork 实现的正则都存在", Boolean(wbRe && viewRe));
for (const tpl of PARITY_SHAPES) {
    const a = artworkAt(tpl, 200);
    const b = viewArt(tpl, 200);
    const c = wbArt(tpl, 200);
    check(`三份实现一致（${tpl.slice(-16)}）`, a === b && b === c, `后端 ${a} / 视图 ${b} / 前端 ${c}`);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
