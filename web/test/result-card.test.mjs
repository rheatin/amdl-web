import ejs from "ejs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (name, cond) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) failures++;
};

/*
 * 两条守卫：
 *
 * 1) CSS 注释里若出现注释结束符（斜杠紧跟星号），注释会提前闭合，其后的内容
 *    （包括整个 :root 令牌块）会被浏览器当成非法 CSS 丢弃 —— 页面上没有任何报错，
 *    只是所有颜色/圆角/间距全部失效，退化成无样式的裸 HTML。
 *    这里曾因为在注释里写"动效令牌前缀"的通配写法而踩过，从截图上很难立刻归因，
 *    所以直接在测试里挡住。
 *
 * 2) 封面卡的三处渲染契约（都在客户端被 JS 依赖，坏了都是静默失败）：
 *    a. 流式骨架：data-fill-id / data-fill-state 必须是**字面量**属性
 *       （EJS 会把拼出来的引号转义成实体，search.js 就定位不到了）
 *    b. 下载按钮的 data-meta：必须是能被 JSON.parse 的合法 JSON
 *    c. 封面 URL：模板必须被展开成真实尺寸，不能残留字面量 {w}
 */
const css = fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
check("app.css 注释能正常闭合（正文里没有提前终止符）", !/\*\//.test(css.replace(/\/\*[\s\S]*?\*\//g, "")));

const rootBlock = (css.match(/:root\s*\{[\s\S]*?\n\}/) || [""])[0];
check("app.css 仍有 :root 令牌块", rootBlock.length > 0);
for (const t of ["--radius-lg", "--space-5", "--space-6", "--text-base", "--accent"]) {
    check(`令牌 ${t} 已定义`, rootBlock.includes(`${t}:`));
}

// 带上 filename / root，否则模板里的相对 include 找不到文件。
// 注意必须用 fileURLToPath：URL.pathname 在 Windows 上是 `/C:/...`，
// EJS 拿它拼路径就会多出一个前导斜杠，然后报"找不到文件"。
const { fileURLToPath } = await import("node:url");
const viewsDir = fileURLToPath(new URL("../views/", import.meta.url));
const tplPath = fileURLToPath(new URL("partials/result-item.ejs", new URL("../views/", import.meta.url)));
const tpl = fs.readFileSync(tplPath, "utf8");

/*
 * art() 由服务端通过 app.locals 注入（见 src/index.ts 里 ART_TEMPLATE_RE 的注释：
 * EJS 的 include 不会把 helper 带出去，所以"抽成 partial 共享"根本行不通）。
 * 这里从已构建的服务里取同一个函数传进去 —— 测的是线上那份实现，
 * 而不是测试里另抄一份（另抄一份就等于允许它悄悄漂移）。
 */

// 导入 dist/index.js 会真的初始化服务：先把它需要的环境摆好，
// 否则它会去读真实的 DATA_DIR。
process.env.AMDL_NO_LISTEN = "1";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-web-card-"));
process.env.ADMIN_USER = "";
process.env.ADMIN_PASSWORD = "";
const { app } = await import("../dist/index.js");
const render = (r, formatsFill = false, ceilings = {}) =>
    ejs.render(tpl, { r, region: "jp", formatsFill, ceilings, art: app.locals.art },
        { filename: tplPath, root: viewsDir });


/* 1. 骨架属性 */
const album = {
    id: "1440833098", type: "album", name: "我的电台 FM S.H.E", artistName: "S.H.E", albumName: "",
    artwork: "https://art.invalid/{w}x{h}.jpg", url: "https://music.apple.com/cn/album/x/1440833098", trackCount: 11
};
const skel = await render(album, true);
check("骨架卡带字面量 data-fill-id", skel.includes('data-fill-id="1440833098"'));
check("骨架卡带 data-fill-state", skel.includes('data-fill-state="pending"'));
check("骨架卡有 sk-chip 占位", skel.includes("sk-chip"));
check("骨架卡没有 &#34; 之类的转义残留", !skel.includes("&#34;"));

/* 艺人/MV 不该有音质骨架 */
const artist = { id: "160847", type: "artist", name: "S.H.E", artistName: "S.H.E", artwork: "https://a/{w}x{h}{f}", url: "" };
check("艺人卡没有音质骨架", !(await render(artist, true)).includes("data-fill-id"));
const mv = { id: "1553273901", type: "music-video", name: "安静了", artistName: "S.H.E", artwork: "https://a/{w}x{h}{f}", url: "u", durationMs: 260000 };
check("MV 卡没有音质骨架", !(await render(mv, true)).includes("data-fill-id"));

/* 2. data-meta 必须是合法 JSON —— 标题里带引号/反斜杠/撇号最容易破 */
const nasty = {
    id: "1", type: "song", name: 'He said "hi" \\ ok', artistName: "O'Hara", albumName: "a'b",
    artwork: "https://a/{w}x{h}{f}", url: "https://music.apple.com/cn/song/x/1", durationMs: 213000
};
const nastyHtml = await render(nasty);

/*
 * 封面模板的**三种实测形状**都要能展开。
 *
 * 这是真实踩到的：cn 店给 `{w}x{h}{f}`，而另一个记录给的是 `{w}x{h}bb.jpg`。
 * 只认前一种时，后者会被拼成 `…/{w}x{h}bb.jpg/160x160bb.jpg` —— 浏览器 404，
 * 而 <img> 加载失败不产生任何控制台报错，界面上只是"封面偶尔不显示"，极难归因。
 * 因此这里逐个形状断言，且断言**展开后不含任何占位符**。
 */
const TEMPLATE_SHAPES = [
    "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/xx.rgb.jpg/{w}x{h}{f}",
    "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/cc/dd/JAY.jpg/{w}x{h}bb.jpg",
    "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/ee/ff/yy.jpg/{w}x{h}.jpg"
];
for (const tpl of TEMPLATE_SHAPES) {
    const out = (await render({ ...nasty, artwork: tpl })).match(/<img src="([^"]+)"/)[1];
    check(`模板可展开且无残留占位符（${tpl.slice(-14)}）`, /200x200bb\.jpg$/.test(out) && !out.includes("{"));
}

/*
 * 三份实现必须逐字一致：视图（art.ejs）、后端 artworkAt，以及它们在本卡片里的产物。
 * 之所以要比对：result-item.ejs 只能自己 include art.ejs（EJS 的 include 只单向可见），
 * 后端流式接口又必须给出同样大小的图 —— 规则漂移的表现是"某处封面变空白"，无任何报错。
 */
const serverArt = (await import("../dist/ampmusic.js")).artworkAt;
for (const tpl of TEMPLATE_SHAPES) {
    const fromItem = (await render({ ...nasty, artwork: tpl })).match(/<img src="([^"]+)"/)[1];
    check(
        `视图渲染与服务端 artworkAt 一致（${tpl.slice(-14)}）`,
        fromItem === serverArt(tpl, 200)
    );
}
const m = nastyHtml.match(/data-meta='([^']*)'/);
check("下载按钮带 data-meta", Boolean(m));
if (m) {
    try {
        /* 浏览器读属性时已经把 HTML 实体解码回原字符，测试里要手动做同一步，
           否则会把正确的实体编码误判成 bug。 */
        const parsed = JSON.parse(
            m[1].replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        );
        check("data-meta 是合法 JSON", parsed.title === nasty.name && parsed.artistName === "O'Hara");
        check("data-meta 保留了时长", parsed.durationMs === 213000);
    } catch (e) {
        check(`data-meta 可解析（${e.message}）`, false);
    }
}

/*
 * 老任务（没有 meta）的显示降级。
 *
 * JobMeta 是后加的字段，历史任务记录里没有标题/艺人/封面。
 * 早先的降级是把整条 URL 当标题，于是整页变成一堆 %E5%BB%BA 编码的链接。
 * 这里断言降级结果不含百分号编码、也不把裸 URL 铺在标题位上。
 */
const LEGACY_URL = "https://music.apple.com/cn/album/%E5%91%A8%E6%9D%B0%E4%BC%A6-muliebritty/677907037";
const rowTplPath = fileURLToPath(new URL("partials/task-row.ejs", new URL("../views/", import.meta.url)));
const legacyRow = await ejs.render(
    fs.readFileSync(rowTplPath, "utf8"),
    {
        j: {
            id: 101, status: "done", codec: "alac", url: LEGACY_URL,
            createdAt: Date.now() - 86400000, error: null, tracks: [], options: {}, region: null,
            progress: { done: 1, total: 1, currentPct: 0, pct: 100, title: "", spec: "", rate: "", elapsed: "", finished: true }
        },
        progress: { done: 1, total: 1, currentPct: 0, pct: 100, title: "", spec: "", rate: "", elapsed: "", finished: true },
        selected: null,
        statusText: { done: "完成" },
        art: app.locals.art,
        linkLabel: app.locals.linkLabel
    },
    { filename: rowTplPath, root: viewsDir }
);
const legacyTitle = (legacyRow.match(/<span class="qrow-title"[^>]*>([^<]*)</) || [])[1] || "";
check("老任务标题不含百分号编码", !/%E[0-9A-Fa-f]{2}/.test(legacyTitle), `实际："${legacyTitle}"`);
check("老任务标题不是裸 URL", !legacyTitle.startsWith("http"), `实际："${legacyTitle}"`);
check("老任务仍给出可读的名字", /周杰伦|677907037/.test(legacyTitle), `实际："${legacyTitle}"`);
const realTpl = "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/x.rgb.jpg/{w}x{h}{f}";
check(
    "mzstatic 真实模板可展开",
    (await render({ ...nasty, artwork: realTpl })).includes("200x200bb.jpg")
);

/* 4. 引擎封顶低于 Apple 能力时要标 capped 并给出说明 */
const capped = await render({ ...nasty, formats: [{ codec: "alac", detail: "24-bit/96 kHz", hiRes: true, lossless: true, atmos: false, sampleRate: 96000, label: "l" }] }, false, { alacMaxHz: 48000 });
check("超封顶时芯片带 capped 类", /q-chip[^"]*\bcapped\b/.test(capped));
check("超封顶时给出文字说明", capped.includes("alac-max"));
const withinCeiling = await render({ ...nasty, formats: [{ codec: "alac", detail: "24-bit/48 kHz", hiRes: false, lossless: true, atmos: false, sampleRate: 48000, label: "l" }] }, false, { alacMaxHz: 96000 });
check("未超封顶时不带 capped 类", !/\bq-chip[^"]*\bcapped\b/.test(withinCeiling));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
