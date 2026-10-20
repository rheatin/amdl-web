/*
 * 引擎配置「写回」的回归测试。
 *
 * 保护的是三个真实会咬人的点：
 *  1. 原地写必须**保住 inode** —— compose 是单文件 bind mount，rename 会让容器看到旧文件；
 *  2. 用户写的**注释和无关键必须原样保留** —— 那是他们唯一的配置源；
 *  3. 旧扁平键文件里不能写出并行新键（`embed-lrc` + `metadata.lyrics.embed` 并存）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* engineconf 依赖 config（读环境变量定 engineDir），所以必须先设好再 import */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-cfg-"));
process.env.ENGINE_DIR = dir;

const { applyOverrides, editableFields, validateEditable, writeEngineConfig, writeEngineConfigTo } =
    await import("../dist/engineconf.js");

let pass = 0;
function ok(name, fn) {
    fn();
    pass++;
    console.log(`PASS ${name}`);
}

/* 一份带注释、带旧扁平键的真实形状配置 */
const ORIGINAL = `# 我的配置 —— 注释必须活下来
general:
  storefront: us
  language: en-US

metadata:
  lyrics:
    embed: true      # 写进标签
    save-file: true
    type: lyrics

media:
  alac-max: 48000
  atmos-max: 2768
# 末尾注释
`;

function freshName(base) {
    const f = path.join(dir, base);
    fs.writeFileSync(f, ORIGINAL, "utf8");
    return f;
}

/* config.yaml 优先于 config.example.yaml，所以每个用例写同一份 */
function setup() {
    fs.writeFileSync(path.join(dir, "config.yaml"), ORIGINAL, "utf8");
    return path.join(dir, "config.yaml");
}

ok("写入保留注释与其它键", () => {
    const file = setup();
    writeEngineConfig([{ name: "alacMax", value: "96000" }]);
    const out = fs.readFileSync(file, "utf8");
    assert.match(out, /# 我的配置 —— 注释必须活下来/);
    assert.match(out, /# 末尾注释/);
    assert.match(out, /embed: true      # 写进标签/, "行内注释也要留着");
    assert.match(out, /alac-max: 96000/, "值被替换");
    assert.match(out, /atmos-max: 2768/, "没碰的键不动");
    assert.match(out, /storefront: us/);
});

ok("改一个键时，**那一行**的行尾注释也要留着", () => {
    const file = setup();
    writeEngineConfig([{ name: "lyricsEmbed", value: "false" }]);
    const out = fs.readFileSync(file, "utf8");
    /* 这条配置几乎每行都有说明性注释，改个值就把文档抹掉是不可接受的 */
    assert.match(out, /^\s+embed: false +# 写进标签$/m, "行尾注释必须原样保留");
});

ok("引号里的 # 不算注释（不能被截断）", () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), 'general:\n  language: "a#b"\n', "utf8");
    const file = path.join(dir, "config.yaml");
    writeEngineConfig([{ name: "storefront", value: "jp" }]);
    assert.match(fs.readFileSync(file, "utf8"), /language: "a#b"/, "引号内的 # 是值的一部分");
});

ok("原始文件没有注释时不凭空造出注释", () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), "alac-max: 44100\n", "utf8");
    const file = path.join(dir, "config.yaml");
    writeEngineConfig([{ name: "alacMax", value: "96000" }]);
    assert.equal(fs.readFileSync(file, "utf8"), "alac-max: 96000\n");
});

ok("原地写保住 inode（bind mount 的关键）", () => {
    const file = setup();
    const before = fs.statSync(file).ino;
    writeEngineConfig([{ name: "alacMax", value: "192000" }]);
    const after = fs.statSync(file).ino;
    assert.equal(after, before, "inode 变了 → 容器里看不到改动");
});

ok("旧扁平键：改已有的那条，不新增并行键", () => {
    fs.writeFileSync(
        path.join(dir, "config.yaml"),
        "embed-lrc: true\nalac-max: 44100\n",
        "utf8"
    );
    const file = path.join(dir, "config.yaml");
    writeEngineConfig([
        { name: "lyricsEmbed", value: "false" },
        { name: "alacMax", value: "96000" }
    ]);
    const out = fs.readFileSync(file, "utf8");
    assert.match(out, /^embed-lrc: false$/m, "扁平键被就地改掉");
    assert.doesNotMatch(out, /lyrics:/, "不能凭空长出嵌套块");
    assert.match(out, /^alac-max: 96000$/m);
    assert.equal(out.match(/embed-lrc/g)?.length, 1, "同一个语义只能出现一次");
});

ok("白名单外一律拒绝", () => {
    for (const bad of ["paths.alac", "media-user-token", "general.authorization-token", "wat"]) {
        assert.ok(validateEditable(bad, "x"), `${bad} 应该被拒绝`);
    }
});

ok("取值校验：枚举 / 数值 / 地区 / 语言", () => {
    assert.ok(validateEditable("lyricsType", "nope"), "枚举外拒绝");
    assert.equal(validateEditable("lyricsType", "syllable-lyrics"), null);
    assert.ok(validateEditable("alacMax", "abc"), "非整数拒绝");
    assert.ok(validateEditable("alacMax", "0"), "0 拒绝");
    assert.ok(validateEditable("alacMax", "999999"), "超范围拒绝");
    assert.equal(validateEditable("alacMax", "192000"), null);
    assert.ok(validateEditable("storefront", "CHN"), "地区必须两位小写");
    assert.equal(validateEditable("storefront", "jp"), null);
    assert.equal(validateEditable("language", "zh-Hans-CN"), null);
});

ok("换行注入被拒绝（唯一能破坏 YAML 结构的输入）", () => {
    assert.ok(validateEditable("storefront", "cn\nevil: 1"));
    assert.ok(validateEditable("language", "en\r\nx"));
});

ok("批量中有一项非法 → 整批不写（不半途而废）", () => {
    const file = setup();
    assert.throws(() =>
        writeEngineConfig([
            { name: "alacMax", value: "96000" },
            { name: "nope", value: "1" }
        ])
    );
    assert.equal(fs.readFileSync(file, "utf8"), ORIGINAL, "文件必须一字未动");
});

ok("写前留备份（且备份落在可写目录，不是 /engine）", () => {
    const file = setup();
    const backupDir = path.join(dir, "data");
    const r = writeEngineConfigTo([{ name: "aacType", value: "aac" }], dir, backupDir);
    assert.equal(r.backup, path.join(backupDir, "config.yaml.bak"), "备份不能写在配置文件旁边");
    assert.ok(fs.existsSync(r.backup), "必须留下 .bak");
    assert.equal(fs.readFileSync(r.backup, "utf8"), ORIGINAL, "备份是写入前的内容");
    /* 配置文件旁边的目录可能属于 root 且不可写 —— 绝不能往那里写 */
    assert.ok(!fs.existsSync(`${file}.bak`));
});

ok("editableFields 报告实际生效路径", () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), "metadata:\n  lyrics:\n    embed: false\n", "utf8");
    const f = editableFields().find((x) => x.name === "lyricsEmbed");
    assert.equal(f.value, "false");
    assert.equal(f.path, "metadata.lyrics.embed", "要报真实路径");
});

ok("applyOverrides 不改未知键（回归：曾把 embed 插进 artwork）", () => {
    const src = "metadata:\n  artwork: true\n  lyrics:\n    type: lyrics\n";
    const out = applyOverrides(src, [["metadata.lyrics.embed", "true"]]);
    assert.equal(out.match(/embed/g)?.length, 1, "embed 只能出现一次");
    assert.match(out, /artwork: true\n\s+lyrics:/, "artwork 后面直接是 lyrics");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n全部通过（${pass} 组）`);
