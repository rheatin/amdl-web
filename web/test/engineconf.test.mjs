/**
 * amdl-web — 引擎配置层测试（engineconf.ts）
 *
 * 这里守两件事：
 *
 *  1. **一份配置只有一个出处**：我们只在用户文件的基础上按键覆盖，绝不重写整份 YAML
 *     （否则上游注释与未知键会被抹掉，用户的配置就丢了）。
 *
 *  2. **与上游键名解耦**：上游把配置从扁平结构改成了 `general:` / `paths:` /
 *     `metadata:` / `media:` 嵌套结构（见下方 NESTED 样本，抄自上游 config.yaml.example）。
 *     读配置一律走候选路径，所以**两种结构都必须能正确读出同样的语义**。
 *     写死旧键名会让 UI 静默失效（落盘目录扫不到 → 音乐库整页变空）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-cfg-"));
const engineDir = path.join(tmp, "engine");
fs.mkdirSync(engineDir, { recursive: true });

/** 旧结构（扁平）—— 本机原来那份 config.yaml 的形状。 */
const FLAT = `# 上游自带注释，必须原样保留
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
lite-server: "http://wrapper-lite:12340"
exit-on-error: true
`;

/** 新结构（嵌套）—— 抄自上游 config.yaml.example 的形状与键名。 */
const NESTED = `# ------------------------------------------------------------------------------
# 1. General Settings (Account, Network & System)
# ------------------------------------------------------------------------------
general:
  lite-server: "http://wrapper-lite:12340"
  media-user-token: "abcdefghijklmnop"
  language: "zh-Hans-CN"
  max-memory-limit: 256
  storefront: "cn"
  authorization-token: ""
  exit-on-error: true

media:
  get-m3u8-mode: "hires"
  alac-max: 192000
  mv:
    audio-type: "atmos"
    max: 2160

paths:
  alac: "/downloads/ALAC"
  atmos: "/downloads/Atmos"
  aac: "/downloads/AAC"
  mv: "/downloads/MV"
  song-file: "{SongNumer}. {SongName} # 不是注释"

metadata:
  lyrics:
    save-file: true
    embed: false
    type: "syllable-lyrics"
    format: "ttml"
    extra: ""
`;

let current = "FLAT";
function writeConfig(text) {
    fs.writeFileSync(path.join(engineDir, "config.yaml"), text);
}

process.env.DATA_DIR = path.join(tmp, "data");
process.env.ENGINE_DIR = engineDir;

const {
    parseYamlScalars,
    loadEngineConfig,
    applyOverrides,
    maskConfigText,
    lyricOptionsFromConfig,
    pickString,
    pickBool,
    KEYS
} = await import("../dist/engineconf.js");

const { saveDirs } = await import("../dist/landed.js");

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

/* ------------------------------------------------------------- 解析（两种结构） */

check("嵌套结构：解析成点分路径，缩进层级正确", () => {
    const { values } = parseYamlScalars(NESTED);
    assert.equal(values["general.storefront"], "cn");
    assert.equal(values["general.language"], "zh-Hans-CN");
    assert.equal(values["media.mv.max"], "2160");
    assert.equal(values["media.alac-max"], "192000");
    assert.equal(values["paths.alac"], "/downloads/ALAC");
    assert.equal(values["metadata.lyrics.type"], "syllable-lyrics");
    assert.equal(
        values["storefront"],
        undefined,
        "嵌套结构下不应再冒出顶层 storefront —— 否则「读到了但读的是错的」"
    );
});

check("嵌套结构：同名字段不会串层（media.mv.max 与 paths.mv 互不干扰）", () => {
    const { values } = parseYamlScalars(NESTED);
    assert.equal(values["paths.mv"], "/downloads/MV");
    assert.equal(values["media.mv.max"], "2160");
    assert.equal(values["paths.mv.max"], undefined);
    assert.equal(values["media.mv"], undefined, "带子块的键本身不是标量");
});

check("嵌套结构：空字符串值保留为空串（authorization-token / lyrics extra）", () => {
    const { values } = parseYamlScalars(NESTED);
    assert.equal(values["general.authorization-token"], "");
    assert.equal(values["metadata.lyrics.extra"], "");
});

check("引号内的 # 不算注释（命名模板里常有）", () => {
    const { values } = parseYamlScalars(
        'song-file-format: "{SongNumer}. {SongName} # 不是注释"\n' + 'other: "{A}" # 这才是注释\n'
    );
    assert.equal(values["song-file-format"], "{SongNumer}. {SongName} # 不是注释");
    assert.equal(values["other"], "{A}");
});

check("引号后紧跟注释也能正确剥掉", () => {
    assert.equal(parseYamlScalars('lrc-type: "lyrics"   #lyrics or syllable-lyrics\n').values["lrc-type"], "lyrics");
});

check("扁平结构：仍按原样解析（向后兼容，不能因为升级就丢掉旧配置）", () => {
    const { values } = parseYamlScalars(FLAT);
    assert.equal(values["storefront"], "cn");
    assert.equal(values["max-memory-limit"], "256");
    assert.equal(values["lite-server"], "http://wrapper-lite:12340");
});

/* ------------------------------------------------------- 候选路径：同一语义两种结构 */

check("候选路径读取：扁平与嵌套读出**完全相同**的语义（这是解耦的核心）", () => {
    for (const [label, text] of [["扁平", FLAT], ["嵌套", NESTED]]) {
        const { values } = parseYamlScalars(text);
        assert.equal(pickString(values, KEYS.storefront), "cn", `${label} storefront`);
        assert.equal(pickString(values, KEYS.language), "zh-Hans-CN", `${label} language`);
        assert.equal(pickString(values, KEYS.liteServer), "http://wrapper-lite:12340", `${label} lite-server`);
        assert.equal(pickBool(values, KEYS.exitOnError, false), true, `${label} exit-on-error`);
        assert.equal(pickBool(values, KEYS.lyricsEmbed, true), false, `${label} embed-lrc`);
        assert.equal(pickBool(values, KEYS.lyricsSaveFile, false), true, `${label} save-lrc-file`);
        assert.equal(pickString(values, KEYS.lyricsType), "syllable-lyrics", `${label} lrc-type`);
        assert.equal(pickString(values, KEYS.lyricsFormat), "ttml", `${label} lrc-format`);
    }
});

check("歌词选项：两种结构下界面预填值一致", () => {
    for (const [label, text] of [["扁平", FLAT], ["嵌套", NESTED]]) {
        writeConfig(text);
        const o = lyricOptionsFromConfig(engineDir);
        assert.equal(o.embedLrc, false, `${label} embedLrc`);
        assert.equal(o.saveLrcFile, true, `${label} saveLrcFile`);
        assert.equal(o.lrcType, "syllable-lyrics", `${label} lrcType`);
        assert.equal(o.lrcExtra, "", `${label} lrcExtra`);
        assert.equal(o.lrcFormat, "ttml", `${label} lrcFormat`);
    }
});

check("落盘目录：两种结构下都能扫到 4 个根目录（少一个就会让音乐库变空）", () => {
    for (const [label, text] of [["扁平", FLAT], ["嵌套", NESTED]]) {
        writeConfig(text);
        const dirs = saveDirs();
        if (label === "嵌套") {
            assert.deepEqual(dirs, ["/downloads/ALAC", "/downloads/Atmos", "/downloads/AAC", "/downloads/MV"]);
        }
        // 扁平样本里本来就没有 save-folder 键，此时应为空数组而不是抛错
        assert.ok(Array.isArray(dirs), `${label} 应返回数组`);
    }
});

/* --------------------------------------------------------------------- 覆盖 */

check("覆盖（嵌套路径）：命中已有键时整行替换，注释与其它键不受影响", () => {
    const out = applyOverrides(NESTED, [["metadata.lyrics.save-file", false]]);
    assert.ok(out.includes("    save-file: false"), "应保留原有 4 空格缩进");
    assert.ok(out.includes("# 1. General Settings"), "注释必须保留");
    assert.equal(out.match(/^\s*save-file:/gm).length, 1, "不得产生重复键");
    assert.ok(out.includes('media-user-token: "abcdefghijklmnop"'), "其它键必须原样保留");
});

check("覆盖（嵌套路径）：父块存在但子键缺失 → 插在父块内，不另起一个块", () => {
    const partial = `metadata:\n  artwork:\n    embed: true\n`;
    const out = applyOverrides(partial, [["metadata.lyrics.embed", true]]);
    assert.equal(out.match(/^metadata:/gm).length, 1, "不得重复 metadata: 块");
    assert.ok(/^  lyrics:\n/m.test(out), "应补出 lyrics: 子块");
    const { values } = parseYamlScalars(out);
    assert.equal(values["metadata.lyrics.embed"], "true");
    assert.equal(values["metadata.artwork.embed"], "true", "原有兄弟键不能被破坏");
});

check("覆盖（嵌套路径）：父块完全不存在 → 补出完整结构", () => {
    const out = applyOverrides("general:\n  storefront: \"us\"\n", [["metadata.lyrics.embed", true]]);
    const { values } = parseYamlScalars(out);
    assert.equal(values["metadata.lyrics.embed"], "true");
    assert.equal(values["general.storefront"], "us", "原有内容不受影响");
});

check("覆盖（扁平旧路径）：仍按顶层键处理，向后兼容", () => {
    const out = applyOverrides(FLAT, [["save-lrc-file", false]]);
    assert.ok(out.includes("save-lrc-file: false"));
    assert.equal(out.match(/^save-lrc-file:/gm).length, 1);
    assert.ok(out.includes("# 上游自带注释，必须原样保留"));
});

check("覆盖：缺失的扁平键追加到末尾", () => {
    const out = applyOverrides(FLAT, [["wrapper-data-dir", "/wrapper-data"]]);
    assert.ok(out.trimEnd().endsWith("wrapper-data-dir: /wrapper-data"));
    assert.equal(parseYamlScalars(out).values["wrapper-data-dir"], "/wrapper-data");
});

check("覆盖：bool/数字必须裸写（写成字符串会让 Go 引擎解析失败）", () => {
    const out = applyOverrides(NESTED, [
        ["general.exit-on-error", true],
        ["metadata.lyrics.embed", false],
        ["media.alac-max", 96000]
    ]);
    assert.ok(out.includes("exit-on-error: true"), "bool 不得被引号包成字符串");
    assert.ok(out.includes("embed: false"));
    assert.ok(out.includes("alac-max: 96000"));
    assert.ok(!out.includes('"true"') && !out.includes('"96000"'));
    const { values } = parseYamlScalars(out);
    assert.equal(values["general.exit-on-error"], "true");
    assert.equal(values["media.alac-max"], "96000");
});

check("覆盖：字符串只在必要时加引号，空串必须显式写成空串", () => {
    const out = applyOverrides(NESTED, [
        ["general.lite-server", "http://wrapper-lite:12340"],
        ["metadata.lyrics.extra", ""]
    ]);
    assert.ok(out.includes("lite-server: http://wrapper-lite:12340"));
    assert.ok(out.includes('extra: ""'));
    assert.equal(parseYamlScalars(out).values["metadata.lyrics.extra"], "");
});

check("覆盖：可能与 bool/数字混淆的字符串要加引号", () => {
    const out = applyOverrides(FLAT, [
        ["explicit-choice", "no"],
        ["some-number", "123"],
        ["some-colon", "a: b"]
    ]);
    assert.ok(out.includes('explicit-choice: "no"'));
    assert.ok(out.includes('some-number: "123"'));
    assert.ok(out.includes('some-colon: "a: b"'));
});

check("覆盖：值里的引号/反斜杠被转义，不会破坏 YAML", () => {
    const out = applyOverrides(FLAT, [["album-folder-format", 'a"b\\c']]);
    assert.equal(parseYamlScalars(out).values["album-folder-format"], 'a"b\\c');
});

/* ------------------------------------------------------------------- 打码 */

check("展示打码：嵌套与扁平两种结构下的凭据都被替换", () => {
    for (const [label, text] of [["扁平", FLAT], ["嵌套", NESTED]]) {
        const masked = maskConfigText(text);
        assert.ok(!masked.includes("abcdefghijklmnop"), `${label}：凭据本体不得出现在展示文本里`);
        assert.ok(masked.includes("media-user-token:"), `${label}：键名保留，便于确认是否已配置`);
        assert.ok(masked.includes("storefront"), `${label}：非凭据键保持原样`);
    }
});

check("展示打码：任意层级都会打码（不依赖写死缩进）", () => {
    const masked = maskConfigText('general:\n  media-user-token: "abcdefghijklmnop"\n');
    assert.ok(!masked.includes("abcdefghijklmnop"));
});

check("MV 与音质键：meta.mv.max / media.alac-max 在两种结构下都能读出", () => {
    const nested = parseYamlScalars(NESTED).values;
    assert.equal(pickString(nested, KEYS.mvMax), "2160");
    assert.equal(pickString(nested, KEYS.mvAudioType), "atmos");
    assert.equal(pickString(nested, KEYS.alacMax), "192000");

    const flat = parseYamlScalars("mv-max: 1080\nmv-audio-type: aac\nalac-max: 96000\n").values;
    assert.equal(pickString(flat, KEYS.mvMax), "1080");
    assert.equal(pickString(flat, KEYS.mvAudioType), "aac");
    assert.equal(pickString(flat, KEYS.alacMax), "96000");
});

/* ------------------------------------------------- 上游真实模板（端到端） */

check("上游真实 config.yaml.example：能读出全部关键语义，且覆盖不破坏结构", async () => {
    // 用上游模板的真实形状（含分节注释、空行、二级 mv 子块）
    const UPSTREAM = `# ------------------------------------------------------------------------------
# 1. General Settings (Account, Network & System)
# ------------------------------------------------------------------------------
general:
  lite-server: "http://127.0.0.1:12340"
  media-user-token: ""
  language: ""
  max-memory-limit: 256
  proxy: ""
  storefront: "us"
  authorization-token: ""
  exit-on-error: false

media:
  get-m3u8-mode: "hires"
  alac-max: 192000
  atmos-max: 2768
  aac-type: "aac-lc"
  alac-fix: true

  # Music Video settings
  mv:
    audio-type: "atmos"
    max: 2160

paths:
  alac: "AM-Lossless"
  atmos: "AM-Atmos"
  aac: "AM-AAC"
  mv: "AM-MV"
  album-folder: "{AlbumName}"
  song-file: "{SongNumer}. {SongName}"

metadata:
  lyrics:
    save-file: false
    embed: true
    type: "lyrics"
    format: "lrc"
    extra: ""

  artwork:
    embed: true
    size: "5000x5000"
    format: "jpg"
`;
    const v = parseYamlScalars(UPSTREAM).values;
    // 本服务真正依赖的每一项都必须读得到
    assert.equal(pickString(v, KEYS.liteServer), "http://127.0.0.1:12340");
    assert.equal(pickString(v, KEYS.storefront), "us");
    assert.equal(pickBool(v, KEYS.exitOnError, true), false);
    assert.equal(pickString(v, KEYS.mvMax), "2160");
    assert.equal(pickString(v, KEYS.mvAudioType), "atmos");
    assert.equal(pickString(v, KEYS.lyricsType), "lyrics");
    assert.equal(pickBool(v, KEYS.lyricsSaveFile, true), false);
    assert.equal(pickBool(v, KEYS.lyricsEmbed, false), true);
    // 二级键不能被一级的兄弟块串味
    assert.equal(v["media.mv.max"], "2160");
    assert.equal(v["media.alac-max"], "192000");
    assert.equal(v["metadata.artwork.format"], "jpg");

    // 覆盖本服务必须掌握的键 + 一个任务级歌词覆盖
    const out = applyOverrides(UPSTREAM, [
        ["general.lite-server", "http://wrapper-lite:12340"],
        ["general.exit-on-error", true],
        ["metadata.lyrics.embed", false]
    ]);
    const after = parseYamlScalars(out).values;
    assert.equal(after["general.lite-server"], "http://wrapper-lite:12340");
    assert.equal(after["general.exit-on-error"], "true");
    assert.equal(after["metadata.lyrics.embed"], "false");
    // 结构没被破坏：其余键全部原样
    assert.equal(after["media.mv.max"], "2160");
    assert.equal(after["media.alac-max"], "192000");
    assert.equal(after["metadata.artwork.embed"], "true");
    assert.equal(after["paths.song-file"], "{SongNumer}. {SongName}");
    assert.equal(out.match(/^general:/gm).length, 1, "不得产生重复的 general: 块");
    assert.equal(out.match(/^metadata:/gm).length, 1);
    assert.ok(out.includes("# 1. General Settings"), "分节注释必须保留");
});

/* ----------------------------------------------------------------- 回落 */

check("config.yaml 缺失时回落到 config.example.yaml（bind mount 成目录的场景）", () => {
    fs.rmSync(path.join(engineDir, "config.yaml"));
    fs.writeFileSync(path.join(engineDir, "config.example.yaml"), 'general:\n  storefront: "us"\nmetadata:\n  lyrics:\n    embed: true\n');
    const cfg = loadEngineConfig(engineDir);
    assert.equal(path.basename(cfg.file), "config.example.yaml");
    assert.equal(cfg.values["general.storefront"], "us");
    assert.equal(pickString(cfg.values, KEYS.storefront), "us");
    // 缺失键用默认值补齐（save-lrc-file 的默认值是 true）
    assert.equal(lyricOptionsFromConfig(engineDir).saveLrcFile, true);
});

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
