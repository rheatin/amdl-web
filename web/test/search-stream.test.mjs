/**
 * amdl-web — 搜索页流式结果（/search/results/stream）端到端测试
 *
 * 为什么要有这个测试：这条路径的价值就是「增量」，而增量最难在浏览器里肉眼验证。
 * 用户抱怨的"十几秒全空白"正是因为全部音质探测串在一次服务端渲染里完成 ——
 * 于是这里把 Apple 目录与 wrapper-lite 两条外部依赖换成桩（不联网、不需要凭据），
 * 并且**按事件到达时刻**断言：骨架卡必须远早于音质回填，且回填是逐条来的。
 *
 * 运行：npm run build && node test/search-stream.test.mjs
 *
 * 桩的时序刻意模仿真实：目录搜索 120ms（真实约 1~3 秒，这里只要它明显快于探测）、
 * wrapper /m3u8 每个 260ms（实测约 780ms，等比缩小）、专辑曲目关系 400ms。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIST = new URL("../dist/", import.meta.url);
if (!fs.existsSync(new URL("index.js", DIST))) {
    console.error("找不到 dist/index.js —— 先跑 npm run build");
    process.exit(2);
}

const SONG_ID = "648276085";
const ALBUM_ID = "1440833098";
const ARTIST_ID = "160847";
const MV_ID = "1553273901";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 桩里的目录数据 */

/** 目录自带的 enhancedHls：刻意是"低一档"的空清单，用来证明走的是 wrapper 那条路 */
const CATALOG_HLS = "https://catalog.invalid/lowbit.m3u8";
const WRAPPER_HLS_URL = "https://wrapper.invalid/hires.m3u8";
/** wrapper 给的清单：ALAC 24-bit/192 kHz（Hi-Res）+ 一档 AAC */
const WRAPPER_HLS = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-192000-24",AUTOSELECT=YES,CHANNELS="2",NAME="songEnhanced",SAMPLE-RATE=192000,BIT-DEPTH=24
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=264338,BANDWIDTH=268377,CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
aac.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=6000000,BANDWIDTH=6200000,CODECS="alac",AUDIO="audio-alac-stereo-192000-24"
alac.m3u8
`;

/**
 * 目录 enhancedHls 那条路的清单（wrapper 拿不到时的兜底）：
 * 只有一档 48 kHz/16-bit 的无损，用来区分"走了 wrapper"还是"走了目录兜底"。
 */
const CATALOG_HLS_BODY = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-48000-16",CHANNELS="2",SAMPLE-RATE=48000,BIT-DEPTH=16
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000000,CODECS="alac",AUDIO="audio-alac-stereo-48000-16"
alac.m3u8
`;

/**
 * token 发现（tokenCandidates）会先抓 music.apple.com 首页、再用正则找 bundle。
 * 桩必须给一份"长得像"的 HTML，否则第一条目录请求就会抛
 * `could not locate the music.apple.com index bundle`（真跑过，就是这么挂的）。
 */
const FAKE_JWT_HEADER = "eyJraWQiOiJXZWJQbGF5S2lkIn0";
const FAKE_JWT = `${FAKE_JWT_HEADER}.ZmFrZXBheWxvYWQ.ZmFrZXNpZw`;
const INDEX_HTML = `<html><head><script src="/assets/index~abc123.js"></script></head><body></body></html>`;
const BUNDLE_JS = `const t="${FAKE_JWT}";`;

const searchPayload = {
    results: {
        songs: {
            data: [
                {
                    id: SONG_ID,
                    type: "songs",
                    attributes: {
                        name: "安静了",
                        artistName: "S.H.E",
                        albumName: "我的电台 FM S.H.E",
                        url: `https://music.apple.com/cn/song/%E5%AE%89%E9%9D%99%E4%BA%86/${SONG_ID}`,
                        artwork: { url: "https://art.invalid/{w}x{h}.jpg" },
                        durationInMillis: 253000,
                        extendedAssetUrls: { enhancedHls: CATALOG_HLS }
                    }
                },
                {
                    id: ALBUM_ID,
                    type: "albums",
                    attributes: {
                        name: "我的电台 FM S.H.E",
                        artistName: "S.H.E",
                        url: `https://music.apple.com/cn/album/x/${ALBUM_ID}`,
                        artwork: { url: "https://art.invalid/{w}x{h}.jpg" },
                        trackCount: 11,
                        extendedAssetUrls: { enhancedHls: CATALOG_HLS }
                    }
                },
                {
                    id: ARTIST_ID,
                    type: "artists",
                    attributes: {
                        name: "S.H.E",
                        artistName: "S.H.E",
                        url: `https://music.apple.com/cn/artist/she/${ARTIST_ID}`,
                        artwork: { url: "https://art.invalid/{w}x{h}.jpg" }
                    }
                },
                {
                    id: MV_ID,
                    type: "music-videos",
                    attributes: {
                        name: "安静了 (MV)",
                        artistName: "S.H.E",
                        url: `https://music.apple.com/cn/music-video/x/${MV_ID}`,
                        artwork: { url: "https://art.invalid/{w}x{h}.jpg" },
                        durationInMillis: 260000
                    }
                }
            ]
        }
    }
};

/* ------------------------------------------------------------------ fetch 桩 */
/*
 * 必须在 import app 之前装好：app 的模块图一旦执行，任何一次网络调用都可能已经发出。
 * 用动态 import 就是为了控制这个顺序（ESM 的静态 import 会被提升到文件顶部）。
 */
const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* 测试自己也要发 HTTP 请求（打到本进程的 Express），那一律走真 fetch */
const realFetch = globalThis.fetch;
const calls = { m3u8: 0, search: 0, album: 0 };
const unexpected = [];
const callLog = [];
/** 由用例控制：为 true 时 wrapper-lite 表现为掉线（用来走目录 enhancedHls 兜底那条路） */
let wrapperOffline = false;

globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);

    if (url.includes("/m3u8?")) {
        calls.m3u8 += 1;
        const adamId = new URL(url).searchParams.get("adamId") ?? "?";
        callLog.push(`m3u8#${calls.m3u8} adamId=${adamId} offline=${wrapperOffline}`);
        if (wrapperOffline) return new Response("wrapper down", { status: 503 });
        await sleep(260);
        return json({ code: 0, data: { m3u8: WRAPPER_HLS_URL } });
    }
    if (url.includes("/v1/catalog/") && url.includes("/search")) {
        calls.search += 1;
        await sleep(120);
        return json(searchPayload);
    }
    /* 专辑曲目关系：比单曲慢，用来验证 stage2 各条可独立回流 */
    if (url.includes("/v1/catalog/") && url.includes("/albums/")) {
        calls.album += 1;
        await sleep(400);
        return json({
            data: [
                {
                    id: ALBUM_ID,
                    type: "albums",
                    attributes: { name: "我的电台 FM S.H.E", artistName: "S.H.E" },
                    relationships: {
                        tracks: {
                            data: [
                                { id: "900000001", type: "songs", attributes: { name: "t1" } },
                                { id: "900000002", type: "songs", attributes: { name: "t2" } },
                                { id: "900000003", type: "songs", attributes: { name: "t3" } }
                            ]
                        }
                    }
                }
            ]
        });
    }
    if (url === WRAPPER_HLS_URL) {
        return new Response(WRAPPER_HLS, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }
    if (url === CATALOG_HLS) {
        return new Response(CATALOG_HLS_BODY, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }

    /* token 发现：首页要给出 bundle 路径，bundle 里要有一个长得像 JWT 的串 */
    if (url === "https://music.apple.com") {
        return new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });
    }
    if (url.startsWith("https://music.apple.com/assets/")) {
        return new Response(BUNDLE_JS, { headers: { "content-type": "application/javascript" } });
    }
    unexpected.push(url);
    return new Response("", { status: 404 });
};

/* --------------------------------------------------------------- 环境与依赖就位 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amdl-web-stream-"));
process.env.DATA_DIR = tmp;
process.env.PORT = "0";
process.env.ADMIN_USER = "";
process.env.ADMIN_PASSWORD = "";
process.env.LITE_SERVER = "http://wrapper.invalid:12340";
process.env.MUSIC_DIR = path.join(tmp, "music");
/* 由测试自己 listen：见 src/index.ts 末尾的说明 */
process.env.AMDL_NO_LISTEN = "1";
fs.mkdirSync(process.env.MUSIC_DIR, { recursive: true });

const { app } = await import(new URL("index.js", DIST).href);
const { store } = await import(new URL("store.js", DIST).href);
const { issueSession, hashPassword } = await import(new URL("auth.js", DIST).href);
const { clearFormatCache } = await import(new URL("ampmusic.js", DIST).href);

/* 造一个登录用户，并直接签一份 session cookie（测试只关心流，不想依赖登录表单） */
let cookieHeader = "";
const { hash, salt } = hashPassword("stream-test");
const user = store.addUser("stream-tester", hash, salt);
issueSession({ cookie: (_name, value) => (cookieHeader = `amdl_session=${value}`) }, user);
assert.ok(cookieHeader.startsWith("amdl_session="), "session cookie 应该被签出来");

const server = app.listen(0);
const port = await new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server.address().port));
    server.once("error", reject);
});
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
};

try {
    /* ------------------------------------------------------ 1. 无 JS 的完整渲染 */
    /*
     * 这一轮先把 wrapper 打成"不可用"：要走通的是目录 enhancedHls 兜底那条路，
     * 顺便断言"兜底只打目录、不打 wrapper"（这正是搜索从十几秒降到几秒的原因）。
     */
    wrapperOffline = true;
    console.log(`      [debug] wrapperOffline=${wrapperOffline} calls=${JSON.stringify(calls)}`);
    const blockingStart = Date.now();
    const blocking = await fetch(`${base}/search?q=${encodeURIComponent("安静了")}`, {
        headers: { cookie: cookieHeader }
    });
    const blockingHtml = await blocking.text();
    const blockingMs = Date.now() - blockingStart;
    console.log(`      [debug] 完整渲染后 calls=${JSON.stringify(calls)}`);
    if (process.env.DEBUG_STREAM) {
        const chips = blockingHtml.match(/<span class="q-chip[^>]*>[^<]*/g) ?? [];
        console.log(`      [debug] 完整渲染芯片：${JSON.stringify(chips)}`);
        console.log(`      [debug] 含 Hi-Res = ${blockingHtml.includes("Hi-Res")}`);
        console.log(`      [debug] 调用序列：\n        ${callLog.join("\n        ")}`);
        const items = blockingHtml.split('<li class="result"').slice(1);
        items.forEach((it, i) => {
            const title = /<div class="title">([^<]*)/.exec(it)?.[1] ?? "?";
            const chips = (it.match(/<span class="q-chip[^>]*>[^<]*/g) ?? []).join(" | ");
            const fill = it.includes("data-fill-id") ? "有骨架" : "无骨架";
            console.log(`      [debug] 结果${i}「${title}」${fill} 芯片：${chips}`);
        });
    }
    check("GET /search（无 stream=1）仍是完整服务端渲染", () => {
        assert.equal(blocking.status, 200);
        assert.ok(blockingHtml.includes("安静了"), "应包含结果标题");
        assert.ok(!blockingHtml.includes('<p class="err">'), "完整渲染不应报错");
        assert.ok(blockingHtml.includes("data-results-list"), "结果容器必须常驻");
        assert.ok(!blockingHtml.includes("data-fill-state"), "完整渲染不应出现骨架占位");
        assert.ok(blockingHtml.includes("q-chip"), "芯片要有样式类");
        assert.ok(
            blockingHtml.includes("ALAC 无损 · 16-bit/48 kHz"),
            "wrapper 掉线时应显示目录兜底那一档（48 kHz/16-bit 无损）"
        );
        assert.ok(!blockingHtml.includes("192 kHz"), "wrapper 掉线时不可能出现 192 kHz");
        /* 单曲走 formatsFromCatalog（有目录兜底）；专辑走 collectionFormats（只问 wrapper） */
        assert.ok(
            blockingHtml.includes("未取到（wrapper-lite 没返回该曲目的播放清单）"),
            "专辑在 wrapper 掉线时应显示未取到"
        );
        assert.equal(calls.m3u8, 3, "wrapper 掉线时仍会被问 3 次（单曲 1 + 专辑前 2 首）");
    });
    console.log(`      完整渲染（wrapper 掉线 · 目录兜底）耗时 ${blockingMs}ms`);

    /* 从这一轮起 wrapper 正常：流式要证明"优先走 wrapper" */
    wrapperOffline = false;
    /*
     * 上一轮（wrapper 掉线）的目录兜底结果也进了音质缓存（见 ampmusic 的 remember），
     * 不清掉的话单曲会直接用那一份 48 kHz 的兜底值，测不出"优先走 wrapper"。
     */
    clearFormatCache();
    const beforeFast = { ...calls };

    /* ------------------------------------------------------ 2. stream=1 立刻返回 */
    const fastStart = Date.now();
    const skeletal = await fetch(`${base}/search?q=${encodeURIComponent("安静了")}&stream=1`, {
        headers: { cookie: cookieHeader }
    });
    const skeletalHtml = await skeletal.text();
    const fastMs = Date.now() - fastStart;
    check("GET /search?stream=1 不做探测、立刻返回骨架页", () => {
        assert.equal(skeletal.status, 200);
        assert.ok(skeletalHtml.includes("data-results-list"), "结果容器必须常驻");
        assert.ok(skeletalHtml.includes("/static/search.js"), "搜索页要引入流式脚本");
        assert.ok(!skeletalHtml.includes("data-fill-state"), "骨架由客户端推入，不在首屏 HTML 里");
        assert.equal(calls.m3u8, beforeFast.m3u8, "这一路径不该打 wrapper");
    });
    check("stream=1 是立刻返回的骨架页", () => {
        assert.ok(fastMs < 200, `骨架页用了 ${fastMs}ms，太慢`);
    });
    console.log(`      骨架页耗时 ${fastMs}ms`);

    /* ------------------------------------------------------ 3. NDJSON 流的到达时序 */
    const baseline = { ...calls };
    const started = Date.now();

    const res = await fetch(`${base}/search/results/stream?q=${encodeURIComponent("安静了")}`, {
        headers: { cookie: cookieHeader, accept: "application/x-ndjson" }
    });
    check("流式接口响应头正确（不缓冲、可长连）", () => {
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
        assert.match(res.headers.get("cache-control") ?? "", /no-store/);
        assert.equal(res.headers.get("x-accel-buffering"), "no");
    });

    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        for (;;) {
            const nl = buf.indexOf("\n");
            if (nl < 0) break;
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line || line.startsWith(":")) continue;
            events.push({ at: Date.now() - started, msg: JSON.parse(line), m3u8SoFar: calls.m3u8 - baseline.m3u8 });
        }
    }

    const all = (pred) => events.filter(pred);
    const ofType = (t) => events.filter((e) => e.msg.t === t || e.msg.type === t);
    const cards = all((e) => e.msg.t === "card");
    const fills = all((e) => e.msg.t === "fill");

    if (process.env.DEBUG_STREAM) {
        for (const e of events) {
            const m = e.msg;
            console.log(
                `      +${String(e.at).padStart(5)}ms  ${m.t ?? m.type}` +
                    (m.id ? ` id=${m.id}` : "") +
                    (m.total !== undefined ? ` total=${m.total}` : "") +
                    (m.message ? ` message=${m.message}` : "") +
                    `  m3u8=${e.m3u8SoFar}`
            );
        }
        const errLine = blockingHtml.match(/<p class="err">[^<]*<\/p>/);
        console.log(`      完整渲染 error 段：${errLine ? errLine[0] : "(无)"}`);
    }

    check("事件序列：meta → total → card… → fill… → done", () => {
        const kinds = events.map((e) => e.msg.t ?? e.msg.type);
        assert.equal(kinds[0], "meta");
        assert.equal(kinds[1], "total");
        assert.equal(kinds[kinds.length - 1], "done");
        assert.ok(kinds.includes("card") && kinds.includes("fill"));
        assert.equal(ofType("error").length, 0, "不应有 error 事件");
    });

    check("total = 4（歌 / 专辑 / 艺人 / MV）", () => {
        assert.equal(ofType("total")[0].msg.total, 4);
    });

    check("4 张卡都推来了，song/album 的卡是骨架", () => {
        assert.equal(cards.length, 4);
        for (const id of [SONG_ID, ALBUM_ID]) {
            const card = cards.find((c) => c.msg.id === id);
            assert.ok(card, `缺 ${id} 的卡`);
            assert.ok(card.msg.html.includes(`data-fill-id="${id}"`), `${id} 的卡应是骨架`);
            assert.ok(card.msg.html.includes("sk-chip"), `${id} 的卡应有骨架块`);
        }
    });

    check("艺人卡没有音质骨架（艺人没有音质可言）", () => {
        const artist = cards.find((c) => c.msg.id === ARTIST_ID);
        assert.ok(artist, "缺艺人卡");
        assert.ok(!artist.msg.html.includes("data-fill-id"), "艺人卡不该有音质骨架");
    });

    check("MV 卡走视频分支", () => {
        const mv = cards.find((c) => c.msg.id === MV_ID);
        assert.ok(mv, "缺 MV 卡");
        assert.ok(mv.msg.html.includes("MV · 视频 + 音轨"));
        assert.ok(mv.msg.html.includes('data-codec="mv"'));
    });

    check("音质回填刚好 2 条（歌 + 专辑），id 不重复", () => {
        assert.equal(fills.length, 2);
        assert.deepEqual(
            fills.map((f) => f.msg.id).sort(),
            [ALBUM_ID, SONG_ID].sort()
        );
    });

    /*
     * 这一条只能断言"骨架阶段没有为了探测而阻塞"：第一张卡到达时最多只有一条探测在飞，
     * 而且卡片是先于全部探测写出的（见 streamSearchResults 的阶段一/二）。
     * 不能断言 m3u8SoFar === 0 —— 计数是在网络上数请求，分片到达顺序不受服务端写序约束。
     */
    check("**关键**：骨架卡不等探测（写到卡时最多一条探测在飞）", () => {
        assert.ok(cards[0].m3u8SoFar <= 1, `首张卡到达时已有 ${cards[0].m3u8SoFar} 条探测在飞`);
    });

    check("**关键**：全部骨架都在任何回填之前到达（两阶段不交叉）", () => {
        const lastCard = Math.max(...cards.map((c) => c.at));
        const firstFill = Math.min(...fills.map((f) => f.at));
        if (process.env.DEBUG_STREAM) {
            console.log(`        卡片时刻 ${cards.map((c) => c.at).join(",")}；回填时刻 ${fills.map((f) => f.at).join(",")}`);
        }
        assert.ok(lastCard <= firstFill, `最后一张卡 ${lastCard}ms 却晚于首条回填 ${firstFill}ms`);
        assert.ok(firstFill - lastCard >= 150, `首条回填只比骨架晚 ${firstFill - lastCard}ms，增量不明显`);
    });

    check("两条回填各自到达（不是攒成一批）", () => {
        assert.ok(Math.abs(fills[0].at - fills[1].at) >= 100, "两条回填像是同一批送达");
    });

    check("回填内容是真音质芯片：Hi-Res ALAC 192 kHz/24-bit", () => {
        const songFill = fills.find((f) => f.msg.id === SONG_ID);
        if (process.env.DEBUG_STREAM) {
            for (const f of fills) {
                const h = f.msg.html ?? "";
                console.log(`        fill ${f.msg.id} 长度=${h.length}`);
                console.log(`        fill ${f.msg.id} 内容=${JSON.stringify(h).slice(0, 600)}`);
            }
        }
        assert.ok(songFill.msg.html.includes("Hi-Res"), "应标 Hi-Res");
        assert.ok(songFill.msg.html.includes("192 kHz"), "应显示 192 kHz");
        assert.ok(songFill.msg.html.includes("24-bit"), "应显示 24-bit");
        assert.ok(!songFill.msg.html.includes("data-fill-state"), "回填后不该还带骨架状态");
        assert.ok(songFill.msg.html.includes('data-codec="alac"'), "ALAC 按钮要带上具体规格");
    });

    check("wrapper 调用次数 = 3（单曲 1 + 专辑前 2 首，缓存已清空）", () => {
        assert.equal(calls.m3u8 - baseline.m3u8, 3, `实际 ${calls.m3u8 - baseline.m3u8} 次`);
        assert.equal(calls.album - baseline.album, 1, "专辑曲目关系应查一次");
        assert.equal(calls.search - baseline.search, 1, "目录搜索应查一次");
    });

    check("专辑的音质也逐条回填（第二档 AAC 也在）", () => {
        const albumFill = fills.find((f) => f.msg.id === ALBUM_ID);
        assert.ok(albumFill.msg.html.includes('q-chip hires'), "专辑应有 Hi-Res 芯片");
        assert.ok(albumFill.msg.html.includes("192 kHz"), "专辑回填应带具体采样率");
        assert.ok(albumFill.msg.html.includes('data-codec="atmos"'), "专辑也要有 Atmos 按钮");
    });

    /* ------------------------------------------------------ 3b. 音质缓存（同一 q 再搜一次） */
    const beforeRepeat = { ...calls };
    const repeat = await fetch(`${base}/search/results/stream?q=${encodeURIComponent("安静了")}`, {
        headers: { cookie: cookieHeader, accept: "application/x-ndjson" }
    });
    const repeatText = await repeat.text();
    check("10 分钟内重复搜索全部命中音质缓存（不再问 wrapper）", () => {
        assert.equal(calls.m3u8 - beforeRepeat.m3u8, 0, `重复搜索又问了 wrapper ${calls.m3u8 - beforeRepeat.m3u8} 次`);
        assert.ok(repeatText.includes('"t":"fill"'), "重复搜索也要照常回填");
        assert.ok(repeatText.includes("Hi-Res"), "回填内容来自缓存，仍然是 Hi-Res");
    });

    check("所有请求都落在预期路径上（没有意外出网）", () => {
        assert.deepEqual(unexpected, []);
    });

    /* ------------------------------------------------------ 4. 鉴权与边界 */
    /* redirect: "manual" —— 否则 fetch 会自己跟到 /login 并返回 200，看不到这次跳转 */
    const anon = await fetch(`${base}/search/results/stream?q=x`, { redirect: "manual" });
    check("未登录访问流式接口被挡回登录页", () => {
        assert.equal(anon.status, 302);
        assert.match(anon.headers.get("location") ?? "", /\/login/);
    });

    const bare = await fetch(`${base}/search?stream=1`, { headers: { cookie: cookieHeader } });
    check("stream=1 且没有 q 时不炸（空态照常渲染）", () => {
        assert.equal(bare.status, 200);
    });

    const noQ = await fetch(`${base}/search/results/stream`, { headers: { cookie: cookieHeader } });
    check("没有 q 的流式请求返回 400（客户端会把它当作错误显示）", () => {
        assert.equal(noQ.status, 400);
    });
} finally {
    server.closeAllConnections?.();
    server.close();
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
        /* Windows 上偶发占用，忽略 */
    }
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
