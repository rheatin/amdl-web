/**
 * 试听地址（30 秒片段）的取值规则。
 *
 * 这个值会**直接进 <audio src>**，所以它不是"读个字段"这么简单：
 * 目录内容算外部输入，一条 `javascript:` 或相对路径进到 src 里就是可执行/可越权的。
 * 服务端只放行 https，其余一律当作"没有试听"（界面因此不出按钮）。
 */
import assert from "node:assert/strict";

const { previewUrlOf } = await import("../dist/ampmusic.js");

let failed = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
};

check("正常给 https 地址时取第一条", () => {
    assert.equal(
        previewUrlOf({ previews: [{ url: "https://audio-ssl.itunes.apple.com/a.m4a" }] }),
        "https://audio-ssl.itunes.apple.com/a.m4a"
    );
});

check("没有 previews 返回 undefined", () => {
    assert.equal(previewUrlOf(undefined), undefined);
    assert.equal(previewUrlOf({}), undefined);
    assert.equal(previewUrlOf({ previews: [] }), undefined);
});

check("拒绝非 https（会进 <audio src>）", () => {
    assert.equal(previewUrlOf({ previews: [{ url: "javascript:alert(1)" }] }), undefined);
    assert.equal(previewUrlOf({ previews: [{ url: "http://x/a.m4a" }] }), undefined);
    assert.equal(previewUrlOf({ previews: [{ url: "/relative/a.m4a" }] }), undefined);
    assert.equal(previewUrlOf({ previews: [{ url: "data:text/html,<script>" }] }), undefined);
});

check("跳过空/异常条目，取后面那条合法的", () => {
    assert.equal(
        previewUrlOf({
            previews: [{}, { url: "  " }, { url: "javascript:x" }, { url: "https://ok/a.m4a" }]
        }),
        "https://ok/a.m4a"
    );
});

check("previews 不是数组时不炸", () => {
    assert.equal(previewUrlOf({ previews: "https://x" }), undefined);
    assert.equal(previewUrlOf({ previews: null }), undefined);
});

if (failed > 0) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
}
console.log("\n全部通过");
