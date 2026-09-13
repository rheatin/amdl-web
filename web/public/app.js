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
const CODEC_LABEL = { alac: "ALAC 无损", atmos: "Dolby Atmos", aac: "AAC 有损" };

function renderCodecs(codecs) {
    const sel = document.getElementById("job-codec");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    codecs.forEach((c) => {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = CODEC_LABEL[c] || c;
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

    const resetParse = () => {
        parsed = false;
        if (downloadRow) downloadRow.hidden = true;
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
            const res = await fetch(`/api/codecs?url=${encodeURIComponent(url)}`);
            const data = await res.json();
            if (!res.ok) {
                resetParse();
                setResult(`解析失败（HTTP ${res.status}）`, "err");
                return;
            }
            const codecs = data.codecs && data.codecs.length ? data.codecs : ["alac", "atmos", "aac"];
            renderCodecs(codecs);
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

/* ---- 搜索页：一键下载 ---- */
document.querySelectorAll("button.dl").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const url = btn.getAttribute("data-url");
        const codec = btn.getAttribute("data-codec") || "alac";
        btn.disabled = true;
        try {
            const { job } = await postJson("/api/jobs", { url, codec });
            toast(`已创建任务 #${job.id}（${codec}），正在跳转…`);
            setTimeout(() => { window.location.href = `/jobs?job=${job.id}`; }, 700);
        } catch (err) {
            btn.disabled = false;
            toast(`创建失败：${err.message}`);
        }
    });
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

/* ---- 任务页：重试按钮 ---- */
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
        errorEl.className = msg.startsWith("部分完成") ? "warn" : "err";
        errorEl.hidden = false;
    };

    const source = new EventSource(`/api/jobs/${jobId}/events`);
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
                if (data.job.status === "done" || data.job.status === "failed") {
                    source.close();
                    refreshBadges();
                }
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
            if (data.status === "done" || data.status === "failed") {
                source.close();
                refreshBadges();
            }
        }
    };
    source.onerror = () => {
        /* 断线时浏览器会自动重连，重连后的 hello 会带上最新状态 */
    };
}
