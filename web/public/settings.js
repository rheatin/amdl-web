/*
 * 配置页。
 *
 * 只做两件事：把改过的项写回 config.yaml、提交 2FA 验证码。
 * 请求封装复用 app.js 的 postJson（普通脚本，函数在全局作用域）。
 */

/* ---------------------------------------------------------------- 配置表单 */

const engineForm = document.getElementById("engine-form");

if (engineForm) {
    const msg = document.getElementById("engine-msg");
    const revert = document.getElementById("engine-revert");

    /*
     * 记录每个控件「加载时的值」。提交时只上传**改过的**那些：
     *  · 少写几行 —— 文件里不会因为点一次"保存"就多出一堆无意义的重排；
     *  · 全部没改时可以直接告诉用户"没有变化"，而不是假装写入成功。
     */
    const initial = new Map();
    for (const el of engineForm.elements) {
        if (el.name) initial.set(el.name, el.value);
    }

    function dirtyFields() {
        const out = {};
        for (const el of engineForm.elements) {
            if (!el.name) continue;
            if (initial.get(el.name) !== el.value) out[el.name] = el.value;
        }
        return out;
    }

    function markDirty() {
        for (const row of engineForm.querySelectorAll(".cfg-row")) {
            const el = row.querySelector("[name]");
            row.classList.toggle("changed", Boolean(el) && initial.get(el.name) !== el.value);
        }
        if (msg) msg.textContent = "";
    }

    engineForm.addEventListener("input", markDirty);
    engineForm.addEventListener("change", markDirty);

    if (revert) {
        revert.addEventListener("click", () => {
            for (const el of engineForm.elements) {
                if (el.name && initial.has(el.name)) el.value = initial.get(el.name);
            }
            markDirty();
            if (msg) msg.textContent = "已放弃修改";
        });
    }

    engineForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const fields = dirtyFields();
        const names = Object.keys(fields);
        if (names.length === 0) {
            if (msg) msg.textContent = "没有变化";
            return;
        }

        const btn = engineForm.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        if (msg) msg.textContent = "写入中…";

        try {
            const data = await postJson("/api/config", { fields });
            /*
             * 写入成功后**不重载页面**：重载会滚回顶部，用户刚改的是页面下方的项。
             * 就地更新基准值与提示即可 —— 服务端已经把新值算好返回（fields）。
             */
            for (const f of data.fields || []) {
                const el = engineForm.elements[f.name];
                if (el) initial.set(f.name, el.value);
            }
            markDirty();
            const n = (data.changed || []).length;
            if (msg) {
                msg.textContent = n > 0
                    ? `已写入 ${n} 项，立即生效（备份 config.yaml.bak）`
                    : "写入完成，但值没有变化";
            }
        } catch (e) {
            /*
             * 校验失败（400）带着服务端的具体原因，直接显示原文 —— 它比
             * 前端猜的更准（例如"只能是 cn / jp"）。
             */
            if (msg) msg.textContent = e.message || "写入失败";
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

/* ------------------------------------------------------------------- 2FA */

const tfaForm = document.getElementById("tfa-form");

if (tfaForm) {
    const msg = document.getElementById("tfa-msg");
    tfaForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const code = (tfaForm.elements.code.value || "").trim();
        if (!/^\d{4,8}$/.test(code)) {
            if (msg) msg.textContent = "验证码应是 4–8 位数字";
            return;
        }
        const btn = tfaForm.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
            await postJson("/api/apple/2fa", { code });
            if (msg) msg.textContent = "已提交。Apple 那边验证通过后，wrapper-lite 会自行续上会话。";
            tfaForm.reset();
        } catch (e) {
            if (msg) msg.textContent = e.message || "提交失败";
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}
