/**
 * 从引擎的**实时输出**里解析出下载进度。
 *
 * 为什么要单独一个模块：进度是界面唯一需要「边跑边更新」的数字，而它只能从
 * 引擎逐行打印的文本里拿。引擎**没有**进度接口，汇总行（`Completed: 11/12`）
 * 只在**全部跑完之后**才打印一次 —— 所以在那之前，界面上能显示的只有
 * 「进行中」三个字，进度条是空的。
 *
 * 实测格式（取自真实任务日志，见 test/fixtures/job-14.log）：
 *
 *   Queue 1 of 1: Album          ← 下载项序号（单曲专辑任务恒为 1 of 1）
 *   EGOIST                       ← 艺人
 *   Track 1 of 12: songs         ← **第几首 / 共几首**（专辑与播放列表才有）
 *   01. 原罪の灯                  ← 曲目标题（Track 行之后的第一行非空）
 *   16-bit / 44100 Hz            ← 该曲规格
 *   Decrypting...  43%  (5.1/12 MB, 414 kB/s)   ← **曲内进度**
 *   Decrypting... 100%  (12/12 MB, 1.1 MB/s) [10s]
 *   Decrypted                     ← 该曲完成
 *   =======  [✔ ] Completed: 11/12  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1 =======
 *
 * 注意行首混着 `\r`（引擎用回车原地刷新进度条），同一行里会出现多次刷新，
 * 所以每行先剥掉控制字符、再取**最后一个**匹配（那才是最新的）。
 */

const TRACK_N_OF_M = /^\s*Track\s+(\d+)\s+of\s+(\d+)/i;
const DECRYPT = /Decrypting\.\.\.\s*(\d+)%\s*(?:\(([^)]*)\))?(?:\s*\[([^\]]+)\])?/i;
const DECRYPTED = /^\s*Decrypted\s*$/;
const SPEC_LINE = /^\s*\d+[- ]?bit\s*\//i;

/**
 * 解析器的内部状态 —— 还没算整体百分比。
 *
 * 与对外的 Progress 分开：tracker 每行都会被调用一次，而整体百分比只在
 * **广播出去之前**才算一次，省掉每行的除法与取整。
 */
export type TrackerState = {
    /** 已完成的曲目数（由 `Decrypted` 计数，收尾时以汇总行为准） */
    done: number;
    /** 总曲目数；单曲任务没有 Track 行，回落到 1 */
    total: number;
    /** 当前曲 0-100；没有 Decrypting 行时为 0 */
    currentPct: number;
    /** 当前正在下的曲目标题 */
    title: string;
    /** 当前曲的规格行，例如 `16-bit / 44100 Hz`；没有时为空串 */
    spec: string;
    /** 当前曲的体积/速度读数，例如 `5.1/12 MB, 414 kB/s` */
    rate: string;
    /** 该曲已用时，例如 `10s`（来自 `100% ... [10s]`） */
    elapsed: string;
    /** 收尾汇总里的警告数；没有汇总行为 undefined */
    warnings?: number;
    /** 收尾汇总里的错误数；没有汇总行为 undefined */
    errors?: number;
    /** 已读到收尾汇总（任务已跑完，无论成功失败） */
    finished: boolean;
};

/** 对外的进度读数（接口与 SSE 广播用）。 */
export type Progress = TrackerState & {
    /** 整体 0-100（整数） */
    pct: number;
};

const EMPTY: TrackerState = {
    done: 0,
    total: 1,
    currentPct: 0,
    title: "",
    spec: "",
    rate: "",
    elapsed: "",
    finished: false
};

/*
 * 收尾汇总行：`=======  [✔ ] Completed: 12/12  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 0  =======`
 *
 * 为什么必须有它：实测**成功**的任务日志里一条 `Decrypted` 都没有
 * （引擎只在部分代码路径上打那一行），只靠数它，进度条永远停在 91%。
 * 汇总行每次收尾都有，且带权威的完成数 —— 它是唯一的终点信号。
 */
const SUMMARY = /Completed:\s*(\d+)\s*\/\s*(\d+).*?Warnings:\s*(\d+).*?Errors:\s*(\d+)/i;

export function createProgressTracker(): { feed: (line: string) => TrackerState } {
    const state: TrackerState = { ...EMPTY };
    /* Track 行之后的第一行非空文本就是曲目标题 —— 用"下一行非空"而不是"下一行"，
       因为引擎用 \r 刷新会在中间留下空行。 */
    let expectingTitle = false;

    const feed = (raw: string): TrackerState => {
        /*
         * 引擎用 \r 原地刷新进度条，于是**一行里会串着多次刷新**：
         *   "\rDecrypting... 0% ...\r\rDecrypting... 92% ..."
         * 直接 replace(/\r/g,"") 会把它们首尾相连，于是第一个匹配胜出、
         * 进度永远停在 0%。所以按 \r 切片，**只取最后一段**再解析。
         */
        const line = raw.split("\r").pop()?.trim() ?? "";
        if (!line) return state;

        /*
         * 收尾汇总：唯一的终点信号。
         * 它的完成数是权威的 —— 直接覆盖 done/total，
         * 因为成功任务的日志里可能一条 Decrypted 都没有（只数它会停在 91%）。
         * 注意 Errors>0 时**不**把 pct 拉到 100：任务确实没下完，
         * 界面报"跑完了"是在骗人。pct 的处理见 withPct。
         */
        const s = line.match(SUMMARY);
        if (s) {
            state.done = Number(s[1]) || state.done;
            state.total = Number(s[2]) || state.total;
            state.warnings = Number(s[3]) || 0;
            state.errors = Number(s[4]) || 0;
            state.finished = true;
            state.currentPct = state.errors > 0 ? state.currentPct : 100;
            return state;
        }

        const t = line.match(TRACK_N_OF_M);
        if (t) {
            const total = Number(t[2]);
            if (Number.isFinite(total) && total > 0) {
                state.total = total;
                state.currentPct = 0;
                state.title = "";
                state.spec = "";
                state.rate = "";
                state.elapsed = "";
                expectingTitle = true;
            }
            return state;
        }

        const d = line.match(DECRYPT);
        if (d) {
            state.currentPct = Math.min(100, Math.max(0, Number(d[1]) || 0));
            state.rate = (d[2] ?? "").trim();
            state.elapsed = (d[3] ?? "").trim();
            return state;
        }

        if (DECRYPTED.test(line)) {
            state.done = Math.min(state.total, state.done + 1);
            state.currentPct = 0;
            state.elapsed = "";
            return state;
        }

        if (expectingTitle) {
            state.title = line;
            expectingTitle = false;
            return state;
        }

        /* 规格行只在本曲已有标题时认 —— 否则像 `16-bit / 44100 Hz` 这种
           独立出现的行会被当成曲名。 */
        if (state.title && SPEC_LINE.test(line)) {
            state.spec = line;
        }

        return state;
    };

    return { feed };
}

/** 整体百分比：已完成曲目 + 当前曲的余量，按曲目数摊分。 */
function overallPct(s: TrackerState): number {
    if (s.total <= 0) return 0;
    const frac = (s.done + s.currentPct / 100) / s.total;
    return Math.max(0, Math.min(100, Math.round(frac * 100)));
}

/**
 * 给 tracker 状态补上整体百分比。
 *
 * 「跑完了」只在**真的全下完**时报 100%：
 * 收尾汇总里 Errors>0（partial / failed）时按实际完成数显示，
 * 否则一个"11/12、1 首失败"的任务会显示满条进度条，
 * 而用户去检查时少了一首 —— 界面在骗人。
 */
export function withPct(s: TrackerState): Progress {
    return { ...s, pct: s.done >= s.total ? 100 : overallPct(s) };
}

/**
 * 用整份日志（存量任务）算一次进度。
 *
 * 界面首次加载时会拿到 job.log —— 那些任务**没有**任何实时进度事件，
 * 用它回填一次就能得到与运行中一致的读数，
 * 于是"刚刷新页面进度条就空了"这个老问题也不存在了。
 */
export function progressFromLog(lines: string[]): Progress {
    const { feed } = createProgressTracker();
    let last: TrackerState = feed("");
    for (const l of lines ?? []) last = feed(l);
    return withPct(last);
}
