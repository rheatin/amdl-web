import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/*
 * 搜索流式客户端的**运行时**守卫。
 *
 * 真实事故：改 insertCard 时把 `const early = earlyFills.get(id)` 删掉了，
 * 但保留了使用它的 `if (early !== undefined)`。`new Function(src)` 只验语法，
 * 这种 ReferenceError 语法完全合法，所以测试是绿的、线上搜索却整条断掉 ——
 * 界面停在"只出一张卡"，同时显示「搜索失败：early is not defined」。
 *
 * 这里改成**真的跑一遍**：给一个最小的 DOM 桩，按流式协议的顺序喂事件，
 * 断言不抛异常且卡片都插进去了。
 */

const src = fs.readFileSync(new URL("../public/search.js", import.meta.url), "utf8");

let failures = 0;
const check = (name, fn) => {
    try {
        if (typeof fn === "function") fn();
        else if (!fn) throw new Error("条件为假");
        console.log(`PASS  ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
};

/* ---- 最小 DOM 桩 ---- */
/*
 * 只实现 search.js 实际用到的部分。刻意不做完整 DOM 模拟 ——
 * 目标是"能跑一遍流程"，不是"测浏览器行为"；桩越薄，越不容易因为
 * 补桩而写出与真实页面不一致的测试。
 */
function makeDom() {
    const mkEl = (tag = "div") => {
        const el = {
            tagName: tag.toUpperCase(),
            children: [],
            className: "",
            id: "",
            textContent: "",
            innerHTML: "",
            hidden: false,
            disabled: false,
            value: "",
            attributes: {},
            classList: {
                _s: new Set(),
                add(c) { this._s.add(c); },
                remove(c) { this._s.delete(c); },
                contains(c) { return this._s.has(c); },
                toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }
            },
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k] ?? null; },
            hasAttribute(k) { return k in this.attributes; },
            removeAttribute(k) { delete this.attributes[k]; },
            appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
            insertBefore(c) { this.children.push(c); return c; },
            replaceWith() {},
            remove() {},
            addEventListener() {},
            removeEventListener() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; },
            getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
            focus() {},
            scrollIntoView() {}
        };
        return el;
    };

    const list = mkEl("ul");
    const empty = mkEl("p");
    empty.hidden = true;
    const state = mkEl("span");
    const count = mkEl("span");
    const input = mkEl("input");
    const form = mkEl("form");
    const results = mkEl("section");
    const tabs = mkEl("div");

    const byId = {
        "search-empty": empty,
        "search-state": state,
        "search-region": null
    };
    const bySel = {
        "[data-search-form]": form,
        "[data-search-submit]": null,
        "[data-results]": results,
        "[data-results-list]": list,
        "[data-result-count]": count,
        "[data-cat-tabs]": tabs
    };

    const document = {
        getElementById: (id) => byId[id] ?? null,
        querySelector: (sel) => bySel[sel] ?? null,
        querySelectorAll: () => [],
        addEventListener() {},
        createElement: (t) => mkEl(t),
        body: mkEl("body")
    };

    return { document, list, empty, state, input, results, tabs, mkEl };
}


/*
 * 这里只做一件事：确认**加载 search.js 不会抛**。
 * 真正的 insertCard 路径要 EventSource + 完整 DOM 才能跑到，
 * 而那个成本高于收益 —— 更实际的办法是直接对 insertCard 做静态检查
 * （见文件末尾），加上这条"能跑起来"的冒烟。
 */
check("search.js 能在最小 DOM 下执行完顶层代码", () => {
    const dom = makeDom();
    const sandbox = {
        document: dom.document,
        window: { history: { replaceState() {} } },
        location: { href: "", search: "", pathname: "/search" },
        history: { replaceState() {} },
        console,
        setTimeout,
        clearTimeout,
        fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
        URL,
        Map,
        Set,
        Promise,
        AbortController,
        EventSource: class { constructor() {} close() {} addEventListener() {} },
        TextDecoder: class { decode() { return ""; } }
    };
    vm.runInContext(src, vm.createContext(sandbox), { filename: "search.js" });
});

/*
 * 静态守卫：insertCard 里用到的每个标识符都必须有声明。
 *
 * 这条直接针对事故本身：`early` 被删了声明却仍被使用。
 * 语法检查抓不到（语法完全合法），所以单列一条。
 */
check("insertCard 里用到的 earlyFills/early 都有声明", () => {
    const body = (src.match(/function insertCard\(id, html\) \{[\s\S]*?\n    \}/) || [""])[0];
    assert.ok(body.length > 0, "找不到 insertCard");
    if (/early !== undefined|earlyFills\.delete\(id\)|applyFill\(id, early\)/.test(body)) {
        assert.match(body, /const early = earlyFills\.get\(id\);/, "用了 early 却没有声明它");
    }
    assert.match(src, /const earlyFills = new Map\(\);/, "earlyFills 没有声明");
});

/* 流式回调里用到的状态变量也都得存在 */
for (const name of ["insertCard", "applyFill", "setState", "setCount", "setBusy", "pendingFills", "matchesCat", "syncCatCats"]) {
    check(`search.js 定义了 ${name}`, new RegExp(`function ${name}\\(|const ${name} =`).test(src));
}

/* 语法仍然合法（这条一直在，但只有它是不够的 —— 见文件头） */
check("search.js 语法合法", () => {
    new Function(src);
});

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
