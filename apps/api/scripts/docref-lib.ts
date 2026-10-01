/**
 * 文号溯源的真实数据取数：`verify:policytrace` 与 `verify:docrefmd` 共用这一份。
 *
 * 此前每个脚本各写一遍 SQL（tool_calls 只取成功调用、ref_checks 取 matched 的文号原文），
 * 口径改一处忘一处就会出现「两个门禁对同一批任务算出不同的数」，而且谁都对不上看板。
 * 复查记录改走 `listRefChecks` 服务（与界面同一个读取口），不再自己拼 SQL。
 */
import { db } from "../src/db.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";
import { traceDocRefs, type RefTraceResult } from "../../web/src/policy-trace.ts";
import { summarizeRefChecks, type RefCheckSummary } from "../../web/src/ref-check.ts";
import type { RefCheckRecord } from "../../web/src/types.ts";

export type TaskDocRefs = {
  taskId: string;
  title: string;
  /** 结论正文（空结论的任务不在返回列表里） */
  result: string;
  res: RefTraceResult;
  /** 全部复查记录（含引用类）；消费方自己按 kind 过滤 */
  refChecks: RefCheckRecord[];
  /** 只对文号类复查做的汇总，与界面、交付 MD、看板同一口径 */
  refSummary: RefCheckSummary;
};

/** 全库有结论的任务，逐个算好文号溯源结果与复查汇总 */
export function loadTaskDocRefs(): TaskDocRefs[] {
  const out: TaskDocRefs[] = [];
  for (const t of listTasks()) {
    const detail = getTask(t.id);
    const text = detail?.result ?? "";
    if (!text.trim()) continue;
    const rows = db
      .prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`)
      .all(t.id) as Array<{ tool_name: string; result: string | null; ok: number | null }>;
    const parsed = rows
      .filter((r) => r.ok === 1)
      .map((r) => {
        try {
          return r.result ? (JSON.parse(r.result) as unknown) : null;
        } catch {
          return null;
        }
      });
    const refChecks = listRefChecks(t.id);
    const docChecks = refChecks.filter((c) => c.kind === "docref");
    // 与看板、结果页、证据表同一口径：复查判定 matched 的文号也算有出处
    const rechecked = docChecks.filter((c) => c.verdict === "matched").map((c) => c.text);
    out.push({
      taskId: t.id,
      title: t.title,
      result: text,
      res: traceDocRefs(text, parsed, rows.map((r) => r.tool_name), rechecked),
      refChecks,
      refSummary: summarizeRefChecks(docChecks),
    });
  }
  return out;
}
