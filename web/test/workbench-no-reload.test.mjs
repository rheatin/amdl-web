import assert from "node:assert/strict";
import fs from "node:fs";

/*
 * 工作台脚本的**静态**回归守卫。
 *
 * 守的是一个真实发生过的、且后果很严重的 bug：workbench.js 曾在 SSE 的 hello
 * 与 status 事件里调用 reloadJobsPage()。而页面每次加载都会建立 SSE 连接，
 * hello 又带着当前状态 —— 于是"任务已结束 → 刷新 → 又是 hello → 再刷新"，
 * 是个死循环，表现为浏览器不停地自己刷新、什么都点不了。
 *
 * 这类 bug 靠截图看不出来（截图是静态的），靠手点也很难稳定复现
 * （需要恰好选中一条已结束的任务）。所以在这里静态断言：
 * **工作台脚本里不允许出现任何整页刷新**。
 *
 * 正确做法是只更新那一个队列行 —— 见 syncRowState 的注释。
 */
const src = fs.readFileSync(new URL("../public/workbench.js", import.meta.url), "utf8");

let failures = 0;
const check = (name, cond, detail = "") => {
    if (cond) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
    }
};

check(
    "工作台脚本里没有整页刷新（location.reload / reloadJobsPage）",
    !/location\s*\.\s*reload|reloadJobsPage|window\.location\s*=/.test(src),
    "工作台不允许刷新整页：SSE 的 hello 每次加载都会带终态，一刷新就死循环"
);

check(
    "工作台脚本是合法 JS",
    (() => {
        try {
            new Function(src);
            return true;
        } catch (e) {
            return `解析失败：${e.message}`;
        }
    })()
);

check(
    "状态变化走的是行级更新 syncRowState",
    /const syncRowState = async/.test(src),
    "状态变化应只重画那一行，而不是整页刷新"
);

check(
    "行级更新前会先比对状态，避免无谓请求",
    /data-status"\)\s*===\s*job\.status/.test(src),
    "终态任务每次 SSE 重连的 hello 都会再报一次状态；不比对就会反复重画"
);

check(
    "行内状态标签的配色与服务端一致（TAG_CLASS 与 task-row.ejs 相同）",
    /TAG_CLASS\s*=\s*\{\s*done:\s*"ok",\s*partial:\s*"hires"/.test(src),
    "SSE 改徽章颜色时若与服务端不一致，会出现'刷新前后颜色不同'"
);

/* task-row.ejs 是服务端渲染的唯一定义处；客户端的 TAG_CLASS 必须与之**行为一致**：
   同样一个状态键，要映射到同一个类名。形状不必相同（服务端为了兜底多写了几个空串键）。 */
const rowTpl = fs.readFileSync(new URL("../views/partials/task-row.ejs", import.meta.url), "utf8");
const parseTagMap = (text) => {
    const body = (text.match(/TAG_CLASS\s*=\s*\{([^}]*)\}/) || [, ""])[1];
    const out = {};
    for (const m of body.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) out[m[1]] = m[2];
    return out;
};
const clientTags = parseTagMap(src);
const serverTags = parseTagMap(rowTpl);
check(
    "客户端与服务端的 TAG_CLASS 对每个状态都一致",
    // 服务端多出的空串键 = "该状态没有额外类名"，与客户端"键缺失"等价
    Object.entries(serverTags).every(([k, v]) => (clientTags[k] ?? "") === v),
    `客户端 ${JSON.stringify(clientTags)} / 服务端 ${JSON.stringify(serverTags)}`
);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
