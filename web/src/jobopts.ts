/**
 * 任务级选项的解析（网页「临时覆盖」的服务端一半）。
 *
 * 语义：请求里**显式给出且取值合法**的键才覆盖引擎 config.yaml，其它键一概不写 ——
 * 一份配置只有一个出处（config.yaml），任务选项只是「这一次的例外」，用完即弃、不落盘。
 *
 * 非法值既不报错也不改成内置默认值，而是**剔除**：剔除后引擎回落到 config.yaml 的
 * 有效值，也就是用户原本期望的行为（非法输入不可能把用户配置改坏）。
 */
import { sanitizeJobOptions, type JobOptions } from "./store.js";

const BOOL_KEYS: Array<keyof JobOptions> = ["embedLrc", "saveLrcFile"];
const STRING_KEYS: Array<keyof JobOptions> = ["lrcType", "lrcExtra", "lrcFormat"];

export function explicitJobOptions(raw: unknown): Partial<JobOptions> {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const given: Record<string, unknown> = {};
    for (const key of [...BOOL_KEYS, ...STRING_KEYS]) {
        const v = o[key];
        if (v === undefined || v === null) continue;
        given[key] = v;
    }

    // 基准传空对象：sanitize 对非法值的回落目标是内置默认值，
    // 于是「结果 === 内置默认值 且 输入不是内置默认值」即等价于「输入非法」。
    const sanitized = sanitizeJobOptions(given, {} as JobOptions);
    const out: Partial<JobOptions> = {};
    for (const key of BOOL_KEYS) {
        if (given[key] === true || given[key] === false) {
            (out as Record<string, unknown>)[key] = given[key];
        }
    }
    for (const key of STRING_KEYS) {
        if (!(key in given)) continue;
        // sanitize 已做白名单校验；只有「输入即输出」才说明它是合法取值
        if (given[key] === sanitized[key]) (out as Record<string, unknown>)[key] = sanitized[key];
    }
    return out;
}
