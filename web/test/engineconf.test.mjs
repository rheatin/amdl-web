/**
 * amdl-web — 引擎配置层测试（engineconf.ts）
 *
 * 这里守的是「一份配置只有一个出处」：我们只在用户文件的基础上**按键覆盖**，
 * 绝不重写整份 YAML（否则上游注释与未知键会被抹掉，用户的配置就丢了）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-cfg-"));
const engineDir = path.join(tmp, "engine");
fs.mkdirSync(engineDir, { recursive: true });

const SAMPLE = `# 上游自带注释，必须原样保留
storefront: "cn"          # 店铺地区
language: "zh-Hans-CN"
song-file-format: "{SongNumer}. {SongName} # 不是注释"
embed-lrc: false
save-lrc-file: true
lrc-type: syllable-lyrics
lrc-extra: ""
lrc-format: ttml
media-user-token: "abcdefghijklmnop"
authorization-token: ""
max-memory-limit: 256 # MB
nested:
  inner: 1
`;
fs.writeFileSync(path.join(engineDir, "config.yaml"), SAMPLE);

process.env.DATA_DIR = path.join(tmp, "data");
process.env.ENGINE_DIR = engineDir;

const { parseFlatYaml, loadEngineConfig, applyOverrides, maskConfigText, lyricOptionsFromConfig } =
    await import("../dist/engineconf.js");

let failed = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
};

check("解析扁平 YAML：去引号、行尾注释、忽略嵌套块", () => {
    const { values } = parseFlatYaml(SAMPLE);
    assert.equal(values["storefront"], "cn");
    assert.equal(values["language"], "zh-Hans-CN");
    assert.equal(values["max-memory-limit"], "256");
    assert.equal(values["inner"], undefined, "缩进行属于嵌套块，不应被当成顶层键");
});

check("引号内的 # 不算注释（命名模板里常有）", () => {
    const { values } = parseFlatYaml(
        'song-file-format: "{SongNumer}. {SongName} # 不是注释"\n' +
        'other: "{A}" # 这才是注释\n'
    );
    assert.equal(values["song-file-format"], "{SongNumer}. {SongName} # 不是注释");
    assert.equal(values["other"], "{A}");
});

check("引号后紧跟注释也能正确剥掉", () => {
    const { values } = parseFlatYaml('lrc-type: "lyrics"   #lyrics or syllable-lyrics\n');
    assert.equal(values["lrc-type"], "lyrics");
});

check("空值键（lrc-extra / authorization-token）保留为空字符串", () => {
    const { values } = parseFlatYaml(SAMPLE);
    assert.equal(values["lrc-extra"], "");
    assert.equal(values["authorization-token"], "");
});

check("覆盖：命中已有键时整行替换，注释与其它键不受影响", () => {
    const out = applyOverrides(SAMPLE, [["save-lrc-file", false]]);
    assert.ok(out.includes("save-lrc-file: false"));
    assert.ok(out.includes("# 上游自带注释，必须原样保留"), "注释必须保留");
    assert.equal(out.match(/^save-lrc-file:/gm).length, 1, "不得产生重复键");
    assert.ok(out.includes('media-user-token: "abcdefghijklmnop"'), "其它键必须原样保留");
});

check("覆盖：缺失的键追加到末尾", () => {
    const out = applyOverrides(SAMPLE, [["wrapper-data-dir", "/wrapper-data"]]);
    assert.ok(out.trimEnd().endsWith('wrapper-data-dir: /wrapper-data'), "新键应追加到文件末尾");
    assert.deepEqual(parseFlatYaml(out).values["wrapper-data-dir"], "/wrapper-data");
});

check("覆盖：bool/数字必须裸写（写成字符串会让 Go 引擎解析失败）", () => {
    const out = applyOverrides(SAMPLE, [
        ["exit-on-error", true],
        ["embed-lrc", false],
        ["alac-max", 96000]
    ]);
    assert.ok(out.includes("exit-on-error: true"), "bool 不得被引号包成字符串");
    assert.ok(out.includes("embed-lrc: false"));
    assert.ok(out.includes("alac-max: 96000"));
    assert.ok(!out.includes('"true"') && !out.includes('"96000"'));
    const { values } = parseFlatYaml(out);
    assert.equal(values["exit-on-error"], "true"); // 裸标量读回来仍是 true
    assert.equal(values["alac-max"], "96000");
});

check("覆盖：字符串只在必要时加引号，普通取值保持裸写", () => {
    const out = applyOverrides(SAMPLE, [
        ["lite-server", "http://wrapper-lite:12340"],
        ["lrc-extra", ""],
        ["song-file-format", "{SongNumer}. {SongName}"] // 含 `: ` 之外的模板：裸写
    ]);
    assert.ok(out.includes("lite-server: http://wrapper-lite:12340"));
    assert.ok(out.includes('lrc-extra: ""'), "空字符串必须显式写成空串，否则读回来会是 undefined");
    // 空值键的语义：写 "" 后仍能被解析为「空字符串」而不是缺失
    assert.equal(parseFlatYaml(out).values["lrc-extra"], "");
});

check("覆盖：可能与 bool/数字混淆的字符串要加引号", () => {
    const out = applyOverrides(SAMPLE, [
        ["explicit-choice", "no"],
        ["some-number", "123"],
        ["some-colon", "a: b"]
    ]);
    assert.ok(out.includes('explicit-choice: "no"'));
    assert.ok(out.includes('some-number: "123"'));
    assert.ok(out.includes('some-colon: "a: b"'));
});

check("覆盖：值里的引号/反斜杠被转义，不会破坏 YAML", () => {
    const out = applyOverrides(SAMPLE, [["album-folder-format", 'a"b\\c']]);
    assert.equal(parseFlatYaml(out).values["album-folder-format"], 'a"b\\c');
});

check("展示打码：凭据被替换，其它键不动", () => {
    const masked = maskConfigText(SAMPLE);
    assert.ok(!masked.includes("abcdefghijklmnop"), "凭据本体不得出现在展示文本里");
    assert.ok(masked.includes("media-user-token:"), "键名保留，便于确认是否已配置");
    assert.ok(masked.includes('storefront: "cn"'), "非凭据键保持原样");
});

check("歌词选项读自 config.yaml（界面预填的就是真正生效的值）", () => {
    const o = lyricOptionsFromConfig(engineDir);
    assert.equal(o.embedLrc, false);
    assert.equal(o.saveLrcFile, true);
    assert.equal(o.lrcType, "syllable-lyrics");
    assert.equal(o.lrcExtra, "");
    assert.equal(o.lrcFormat, "ttml");
});

check("config.yaml 缺失时回落到 config.example.yaml（bind mount 成目录的场景）", () => {
    fs.rmSync(path.join(engineDir, "config.yaml"));
    fs.writeFileSync(path.join(engineDir, "config.example.yaml"), 'storefront: "us"\nembed-lrc: true\n');
    const cfg = loadEngineConfig(engineDir);
    assert.equal(path.basename(cfg.file), "config.example.yaml");
    assert.equal(cfg.values["storefront"], "us");
    // 缺失键用默认值补齐
    assert.equal(lyricOptionsFromConfig(engineDir).saveLrcFile, false);
});

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
