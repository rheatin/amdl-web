/* amdl-web — 前端脚本：建任务、搜索结果下载、任务控制台（SSE） */

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
    });
    let data = null;
    try {
        data = await res.json();
    } catch {
        /* empty body */
    }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
}

async function delJson(url) {
    const res = await fetch(url, { method: "DELETE" });
    let data = null;
    try {
        data = await res.json();
    } catch {
        /* empty body */
    }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
}

/**
 * 任务页的整页刷新只做一次。
 * 「取消」的回调与 SSE 的终态事件都会想刷新页面去换成「重试/删除」，
 * 两边各刷一次会白闪一下（甚至把 toast 冲掉）。
 */
let pageReloading = false;
function reloadJobsPage(delay) {
    if (pageReloading) return;
    pageReloading = true;
    setTimeout(() => location.reload(), delay || 0);
}

function toast(msg) {
    const el = document.getElementById("toast") || document.getElementById("search-msg") || document.getElementById("job-form-msg");
    if (!el) return;
    el.textContent = msg;
    if (el.classList.contains("toast")) {
        el.classList.add("show");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => el.classList.remove("show"), 5000);
    } else {
        setTimeout(() => {
            if (el.textContent === msg) el.textContent = "";
        }, 6000);
    }
}

/* ---- 首页：两步式「先解析 → 再下载」---- */
const CODEC_LABEL = { alac: "ALAC 无损", atmos: "Dolby Atmos", aac: "AAC 有损", mv: "音乐视频（MV）" };

/**
 * 为一个可请求的编码挑出**最具代表性的那条音质明细**，用来写进下拉选项。
 *
 * 同一个编码可能有多条规格（例如 AAC 有 256/128 两档、ALAC 在同一张专辑里可能有
 * 24/96 与 16/44.1 两种），选项文字只放一条 —— 取最好的那条，完整清单在旁边的
 * 音质面板里列全。取不到就返回 null，标签退回原来的编码名（绝不编数字）。
 */
function bestFormatFor(codec, formats) {
    if (!Array.isArray(formats) || formats.length === 0) return null;
    const pick = {
        alac: (f) => f.codec === "alac",
        atmos: (f) => f.atmos,
        aac: (f) => f.codec === "aac" || f.codec === "he-aac"
    }[codec];
    if (!pick) return null;
    const candidates = formats.filter(pick);
    if (candidates.length === 0) return null;
    // formats 已由服务端排序（无损在前、位深/采样率/码率降序），第一条就是最好的
    return candidates[0];
}

/** 下拉选项文字：`ALAC 无损 · 24-bit/96 kHz · Hi-Res`。 */
function codecOptionLabel(codec, formats) {
    const best = bestFormatFor(codec, formats);
    const base = CODEC_LABEL[codec] || codec;
    return best && best.label ? `${base} · ${best.detail}` : base;
}

function renderCodecs(codecs, formats) {
    const sel = document.getElementById("job-codec");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    codecs.forEach((c) => {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = codecOptionLabel(c, formats);
        sel.appendChild(o);
    });
    if (codecs.includes(prev)) sel.value = prev;
}

const jobForm = document.getElementById("job-form");
if (jobForm) {
    const urlInput = jobForm.elements.url;
    const resultEl = document.getElementById("parse-result");
    const downloadRow = document.getElementById("download-row");
    const parseBtn = document.getElementById("parse-btn");
    const overrideChk = document.getElementById("opts-override");
    const overrideBox = document.getElementById("opts-box");
    const regionSel = document.getElementById("job-region");
    const autoMatchChk = document.getElementById("job-automatch");
    const regionNote = document.getElementById("region-note");
    const REGION_DEFAULT_NOTE = regionNote ? regionNote.innerHTML : "";
    let parsed = false;   // 只有解析成功（或明确回落）后才允许下载
    let debounce;

    // 临时覆盖开关：关掉 = 请求里不带 options，引擎完全按 config.yaml 执行
    const syncOverride = () => {
        if (!overrideChk || !overrideBox) return;
        overrideBox.disabled = !overrideChk.checked;
        overrideBox.classList.toggle("off", !overrideChk.checked);
    };
    if (overrideChk) {
        overrideChk.addEventListener("change", syncOverride);
        syncOverride();
    }

    const setResult = (html, cls) => {
        if (!resultEl) return;
        resultEl.className = `parse-result ${cls || "muted"}`;
        resultEl.innerHTML = html;
    };

    /**
     * 音质明细面板：把「这首歌到底有什么音质」逐条列出来。
     *
     * 位深与采样率来自 master playlist 的 BIT-DEPTH / SAMPLE-RATE（服务端已算好 label / detail），
     * 所以这里是纯呈现 —— 前端不重复实现一遍「24-bit/96 kHz 该怎么拼」。
     */
    const qualityPanel = document.getElementById("quality-panel");
    const renderQuality = (formats) => {
        if (!qualityPanel) return;
        // 拿不到明细就整块不显示 —— 播放列表/艺人本来就没有单曲音质，
        // 摆一句"拿不到"只是噪音。解析结果行里已经有编码信息了。
        if (!Array.isArray(formats) || formats.length === 0) {
            resetQuality();
            return;
        }
        const rows = formats
            .map((f) => {
                const badges = [];
                if (f.lossless) badges.push(`<span class="tag ok">无损</span>`);
                if (f.hiRes) badges.push(`<span class="tag hires">Hi-Res</span>`);
                if (f.atmos) badges.push(`<span class="tag atmos">Dolby Atmos</span>`);
                if (!f.lossless && f.codec === "aac") badges.push(`<span class="tag">有损</span>`);
                return (
                    `<li>` +
                    `<span class="q-kind">${f.kind}</span>` +
                    `<span class="q-detail">${f.detail}</span>` +
                    badges.join("") +
                    `</li>`
                );
            })
            .join("");
        qualityPanel.hidden = false;
        qualityPanel.className = "quality";
        qualityPanel.innerHTML =
            `<div class="quality-head"><span>音质明细</span>` +
            `<button type="button" class="ghost" id="quality-toggle">收起</button></div>` +
            `<ul class="quality-list">${rows}</ul>`;
        const toggle = document.getElementById("quality-toggle");
        const list = qualityPanel.querySelector(".quality-list");
        if (toggle && list) {
            toggle.addEventListener("click", () => {
                const wasHidden = list.hidden;
                list.hidden = !wasHidden;
                toggle.textContent = wasHidden ? "收起" : "展开";
            });
        }
    };

    const resetQuality = () => {
        if (!qualityPanel) return;
        qualityPanel.hidden = true;
        qualityPanel.innerHTML = "";
    };

    /**
     * 音乐视频的解析结果面板。
     *
     * MV 没有位深/采样率可言，也不需要选编码（引擎按 URL 里的 /music-video/ 自己分派），
     * 所以这里换掉"编码选择器 + 音质明细"，改说清它会以什么方式落盘 ——
     * 具体的音轨类型与分辨率上限来自 config.yaml，不是本页面能改的。
     */
    const renderMusicVideo = (data) => {
        if (!qualityPanel) return;
        qualityPanel.hidden = false;
        qualityPanel.className = "quality";
        qualityPanel.innerHTML =
            `<div class="quality-head"><span>音乐视频（MV）</span></div>` +
            `<ul class="quality-list">` +
            `<li><span class="q-kind">内容</span><span class="q-detail">视频 + 音轨，落盘为 .mp4</span>` +
            `<span class="tag atmos">MV</span></li>` +
            `<li><span class="q-kind">音轨 / 分辨率</span>` +
            `<span class="q-detail">按 config.yaml 的 mv-audio-type / mv-max</span></li>` +
            `<li><span class="q-kind">落盘目录</span><span class="q-detail">mv-save-folder</span></li>` +
            `</ul>` +
            `<p class="muted small" style="margin:8px 0 0">` +
            `MV 不需要选编码：引擎按链接里的 <code>/music-video/</code> 自行分派。` +
            `位深/采样率是音频曲目的概念，对视频没有意义。</p>`;
    };

    /**
     * 地区提示：服务端已经把「目标区有没有 / 要不要回退 / 有没有自动匹配」判完，
     * 这里只负责显示。关键是它出现在**点下载之前**，而不是建完任务之后。
     */
    const setRegionNote = (plan) => {
        if (!regionNote) return;
        if (!plan) {
            regionNote.className = "parse-result muted small";
            regionNote.innerHTML = REGION_DEFAULT_NOTE;
            return;
        }
        const bad = plan.fallback || plan.reason === "probe_failed" || plan.reason === "rewrite_failed";
        const head = plan.requested
            ? `元数据地区：请求 <b>${plan.requested}</b> → 实际 <b>${plan.effective || "-"}</b>。`
            : "";
        regionNote.className = `parse-result small ${bad ? "warn" : plan.requested ? "ok" : "muted"}`;
        regionNote.innerHTML = `${head}${plan.note || ""}`;
    };

    const resetParse = () => {
        parsed = false;
        if (downloadRow) downloadRow.hidden = true;
        resetQuality();
        setRegionNote(null);
    };

    const parseNow = async () => {
        const url = urlInput.value.trim();
        if (!url) {
            resetParse();
            setResult("粘贴链接后会自动解析，确认可用编码再下载。", "muted");
            return;
        }
        setResult("正在解析链接并查询 Apple 的真实能力…", "muted");
        try {
            const q = new URLSearchParams({ url });
            if (regionSel && regionSel.value) q.set("region", regionSel.value);
            if (autoMatchChk && autoMatchChk.checked) q.set("autoMatch", "1");
            const res = await fetch(`/api/codecs?${q.toString()}`);
            const data = await res.json();
            if (!res.ok) {
                resetParse();
                setResult(`解析失败（HTTP ${res.status}）`, "err");
                return;
            }
            setRegionNote(data.plan);
            const codecs = data.codecs && data.codecs.length ? data.codecs : ["alac", "atmos", "aac"];
            const formats = Array.isArray(data.formats) ? data.formats : [];

            // 音乐视频：换掉编码选择器 + 音质面板（MV 由链接决定，没有编码可选）
            if (data.musicVideo) {
                renderCodecs([data.codecs && data.codecs[0] ? data.codecs[0] : "mv"], []);
                renderMusicVideo(data);
                const title = data.title ? `<b>${data.artist ? data.artist + " — " : ""}${data.title}</b> · ` : "";
                const note = data.note ? ` — ${data.note}` : "";
                setResult(`${title}已识别为 <b>music-video</b>（音乐视频）${note}`, "ok");
                parsed = true;
                if (downloadRow) downloadRow.hidden = false;
                return;
            }

            renderCodecs(codecs, formats);
            renderQuality(formats);
            const title = data.title ? `<b>${data.artist ? data.artist + " — " : ""}${data.title}</b> · ` : "";
            const src = data.source ? `（${data.source}）` : "";
            const note = data.note ? ` — ${data.note}` : "";
            const kind = data.resolved && data.resolved.kind ? data.resolved.kind : "链接";
            setResult(
                `${title}已识别为 <b>${kind}</b>${src}<br>可用编码：<b>${data.summary || codecs.map((c) => CODEC_LABEL[c] || c).join(" / ")}</b>${note}`,
                "ok"
            );
            parsed = true;
            if (downloadRow) downloadRow.hidden = false;
        } catch (err) {
            // 网络异常时不彻底拦死：给出全部编码让用户自己决定
            renderCodecs(["alac", "atmos", "aac"]);
            resetQuality();
            setRegionNote(null);
            setResult(`解析出错：${err.message}（已回退为全部编码）`, "err");
            parsed = true;
            if (downloadRow) downloadRow.hidden = false;
        }
    };

    urlInput.addEventListener("input", () => {
        resetParse();                       // 链接一改就要求重新解析
        clearTimeout(debounce);
        debounce = setTimeout(parseNow, 700);
    });
    if (parseBtn) parseBtn.addEventListener("click", () => { clearTimeout(debounce); parseNow(); });
    // 地区/自动匹配一改，预览立刻跟着变（否则界面说的和实际做的会不一致）
    for (const el of [regionSel, autoMatchChk]) {
        if (!el) continue;
        el.addEventListener("change", () => {
            resetParse();
            if (urlInput.value.trim()) { clearTimeout(debounce); parseNow(); }
        });
    }

    jobForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!parsed) {
            toast("请先点「解析链接」，确认可用编码后再下载");
            return;
        }
        const url = urlInput.value.trim();
        const codec = jobForm.elements.codec.value;
        // 只有勾了「本次任务临时覆盖」才带 options；否则服务端完全不写任务配置
        const body = { url, codec };
        if (regionSel && regionSel.value) body.region = regionSel.value;
        if (autoMatchChk && autoMatchChk.checked) body.autoMatch = true;
        if (overrideChk && overrideChk.checked) {
            body.options = {
                embedLrc: jobForm.elements.embedLrc.checked,
                saveLrcFile: jobForm.elements.saveLrcFile.checked,
                lrcType: jobForm.elements.lrcType.value,
                lrcExtra: jobForm.elements.lrcExtra.value,
                lrcFormat: jobForm.elements.lrcFormat.value
            };
        }
        try {
            const { job } = await postJson("/api/jobs", body);
            window.location.href = `/jobs?job=${job.id}`;
        } catch (err) {
            toast(`创建失败：${err.message}`);
        }
    });
}

/* ---- 搜索页：一键下载（带着当前搜索的商店一起建任务）---- */
/*
 * 用**事件委托**而不是 querySelectorAll 逐个绑定：搜索结果现在是流式逐条插进 DOM 的
 * （见 search.js），页面加载那一刻这些按钮还不存在，直接绑定会漏掉全部结果。
 */
document.addEventListener("click", async (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const btn = target ? target.closest("button.dl") : null;
    if (!btn || btn.disabled) return;
    const url = btn.getAttribute("data-url");
    const codec = btn.getAttribute("data-codec") || "alac";
    const region = (btn.getAttribute("data-region") || "").trim();
    btn.disabled = true;
    try {
        const body = { url, codec };
        // 结果链接本来就带该商店的地区段，服务端会判定「与链接一致」——
        // 带 region 只是把用户的意图一并记录下来（含自动匹配的判定依据）。
        if (region) body.region = region;
        const { job } = await postJson("/api/jobs", body);
        toast(`已创建任务 #${job.id}（${codec}${region ? " · " + region : ""}），正在跳转…`);
        setTimeout(() => { window.location.href = `/jobs?job=${job.id}`; }, 700);
    } catch (err) {
        btn.disabled = false;
        toast(`创建失败：${err.message}`);
    }
});

/* ---- 登录页首次运行：创建管理员 ---- */
const setupForm = document.getElementById("setup-form");
if (setupForm) {
    setupForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const username = setupForm.elements.username.value.trim();
        const password = setupForm.elements.password.value;
        try {
            await postJson("/api/setup", { username, password });
            window.location.href = "/";
        } catch (err) {
            alert(`创建失败：${err.message}`);
        }
    });
}

/* ---- 配置页：只读展示（没有保存按钮 —— 改配置请编辑文件后重启容器）---- */
document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const sel = btn.getAttribute("data-copy");
        const el = sel ? document.querySelector(sel) : null;
        if (!el) return;
        try {
            await navigator.clipboard.writeText(el.textContent || "");
            toast("已复制到剪贴板");
        } catch {
            toast("复制失败：浏览器拒绝了剪贴板访问");
        }
    });
});

/* ---- 配置页：提交 Apple 2FA 验证码 ---- */
const tfaForm = document.getElementById("tfa-form");
if (tfaForm) {
    tfaForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const msg = document.getElementById("tfa-msg");
        const code = tfaForm.elements.code.value.trim();
        try {
            const r = await postJson("/api/apple/2fa", { code });
            if (msg) msg.textContent = `已写入 ${r.file}，wrapper-lite 会轮询读取。`;
            tfaForm.reset();
        } catch (err) {
            if (msg) msg.textContent = `提交失败：${err.message}`;
        }
    });
}

/* ---- 任务页：重试 / 取消 / 删除 / 清空已结束 ---- */
const retryBtn = document.querySelector("[data-retry]");
if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
        const id = retryBtn.getAttribute("data-retry");
        retryBtn.disabled = true;
        try {
            const data = await postJson(`/api/jobs/${id}/retry`, {});
            if (data && data.job) {
                location.href = `/jobs?job=${data.job.id}`;
                return;
            }
            throw new Error("服务端未返回新任务");
        } catch (err) {
            retryBtn.disabled = false;
            toast(`重试失败：${err.message}`);
        }
    });
}

/**
 * 取消 / 删除 / 清空已结束 —— 一律走 document 上的事件委托。
 *
 * 任务列表里每一行都可能带一个按钮，而且服务端会按状态决定给「取消」还是「删除」；
 * 逐个 querySelector 绑定既啰嗦又容易漏（搜索页的下载按钮就吃过这个亏）。
 * 三个动作都用 confirm 二次确认：删除与清空是不可逆的记录操作。
 */
document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-cancel], [data-del], [data-clear-finished]");
    if (!btn) return;

    const cancelId = btn.getAttribute("data-cancel");
    const delId = btn.getAttribute("data-del");

    if (cancelId) {
        if (!confirm(`取消任务 #${cancelId}？已经下载好的文件会保留。`)) return;
        btn.disabled = true;
        try {
            await postJson(`/api/jobs/${cancelId}/cancel`, {});
            toast(`任务 #${cancelId} 已取消`);
            reloadJobsPage(500);
        } catch (err) {
            btn.disabled = false;
            toast(`取消失败：${err.message}`);
        }
        return;
    }

    if (delId) {
        if (!confirm(`删除任务 #${delId} 的记录？（音乐库里已下载的文件不会被删）`)) return;
        btn.disabled = true;
        try {
            await delJson(`/api/jobs/${delId}`);
            toast(`任务 #${delId} 的记录已删除`);
            setTimeout(() => {
                location.href = "/jobs";
            }, 400);
        } catch (err) {
            btn.disabled = false;
            toast(`删除失败：${err.message}`);
        }
        return;
    }

    if (!confirm("清空所有已结束（完成 / 部分完成 / 失败 / 已取消）的任务记录？音乐库里的文件不会被删。")) return;
    btn.disabled = true;
    try {
        const data = await postJson("/api/jobs/clear-finished", {});
        toast(`已清空 ${data && typeof data.removed === "number" ? data.removed : ""} 条任务记录`);
        setTimeout(() => {
            location.href = "/jobs";
        }, 400);
    } catch (err) {
        btn.disabled = false;
        toast(`清空失败：${err.message}`);
    }
});

/* ---- 任务页：实时控制台 + 状态徽章 ---- */
const consoleEl = document.getElementById("console");
if (consoleEl) {
    const jobId = consoleEl.getAttribute("data-job");
    const statusEl = document.getElementById("job-status");
    const countEl = document.getElementById("track-count");
    const errorEl = document.getElementById("job-error");
    const lines = [];

    const paint = () => {
        consoleEl.textContent = lines.join("\n");
        consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    /**
     * 更新徽章：详情页的大徽章 + 左侧列表里对应的那个。
     * 列表是服务端渲染的，不处理就会一直显示旧状态。
     */
    const setBadge = (status) => {
        const targets = [statusEl, document.querySelector(`[data-job-badge="${jobId}"]`)];
        for (const el of targets) {
            if (!el) continue;
            el.textContent = status;
            el.className = `badge ${status}`;
        }
    };

    const refreshBadges = async () => {
        try {
            const res = await fetch("/api/jobs");
            if (!res.ok) return;
            const { jobs } = await res.json();
            for (const j of jobs) {
                const el = document.querySelector(`[data-job-badge="${j.id}"]`);
                if (el) {
                    el.textContent = j.status;
                    el.className = `badge ${j.status}`;
                }
            }
        } catch {
            /* 忽略：下次事件/刷新会纠正 */
        }
    };

    const setError = (msg) => {
        if (!errorEl || !msg) return;
        errorEl.textContent = msg;
        // 「部分完成」和「已取消」都不是故障，别用报错的红色（取消时还可能带着已落盘首数）
        errorEl.className = msg.startsWith("部分完成") || msg.startsWith("已取消") ? "warn" : "err";
        errorEl.hidden = false;
    };

    const source = new EventSource(`/api/jobs/${jobId}/events`);
    /**
     * 终态四个：done / partial / failed / cancelled。
     * 早先漏了 partial，于是「部分完成」的任务控制台不会收尾（徽章也不刷新）；
     * 后来又加了 cancelled（用户取消），同样得算终态，否则徽章会一直转。
     */
    const isTerminal = (s) => s === "done" || s === "partial" || s === "failed" || s === "cancelled";
    /**
     * 页面是带着「取消」按钮渲染出来的（= 任务当时还活着）。
     * 任务一旦收尾，详情区该换成「重试 / 删除」——那两行 HTML 是服务端按状态渲染的，
     * 所以这里只能整页刷新一次，不能就地拼。
     */
    const actionsWereActive = Boolean(document.querySelector("[data-cancel]"));
    const settle = (status) => {
        source.close();
        refreshBadges();
        if (actionsWereActive) reloadJobsPage(700);
    };
    source.onmessage = (ev) => {
        let data;
        try {
            data = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (data.type === "hello") {
            lines.length = 0;
            ((data.job && data.job.log) || []).forEach((l) => lines.push(l));
            paint();
            // 关键修复：页面可能在任务运行中渲染，而终态事件在 SSE 连接建立前就已发出。
            // hello 里带着最新任务状态，必须据此对齐，否则徽章会永远停在 running。
            if (data.job && data.job.status) {
                setBadge(data.job.status);
                if (countEl && data.job.tracks) countEl.textContent = String(data.job.tracks.length);
                setError(data.job.error);
                if (isTerminal(data.job.status)) settle(data.job.status);
            }
            return;
        }
        if (data.type === "log") {
            lines.push(data.line);
            if (lines.length > 4000) lines.splice(0, lines.length - 4000);
            paint();
            return;
        }
        if (data.type === "status") {
            setBadge(data.status);
            if (countEl && typeof data.tracks === "number") countEl.textContent = String(data.tracks);
            setError(data.error);
            if (isTerminal(data.status)) settle(data.status);
        }
    };
    source.onerror = () => {
        /* 断线时浏览器会自动重连，重连后的 hello 会带上最新状态 */
    };
}
