/**
 * 政策文号联网复查：把「无法从留存数据核验」的文号用自建检索通道再查一遍，
 * 判定结果按条落库（刷新不丢、可进交付包与整页 MD）。
 *
 * 判定口径不在这里重写：服务端只负责发请求与存取，四级判定与检索词构造共用
 * apps/web/src/ref-check.ts 的纯函数，与前端界面、验证脚本同一份实现。
 */
import { describeAttempts, searchWebDetailed, type DetailedSearch, type SearchAttempt } from "@tax/business-tools";
import { db, nowIso } from "../db.ts";
import { gradeCitation } from "../../../web/src/citation-grade.ts";
import {
  buildRefQuery,
  gradeRefCheck,
  refKey,
  refCheckTargets,
  refQueryVariants,
  type RefCheckEvidence,
  type RefCheckKind,
  type RefCheckResult,
  type RefCheckTarget,
  type RefCheckVerdict,
} from "../../../web/src/ref-check.ts";
import { traceDocRefs } from "../../../web/src/policy-trace.ts";
import { getTask } from "./task-store.ts";

/** 检索实现可注入，验证脚本用假检索器离线跑通全链路 */
export type Searcher = (query: string, signal?: AbortSignal) => Promise<DetailedSearch>;

export interface RefCheckRecord {
  key: string;
  kind: RefCheckKind;
  text: string;
  query: string;
  verdict: RefCheckVerdict;
  note: string;
  evidence: RefCheckEvidence | null;
  attempts: SearchAttempt[];
  checkedAt: string;
}

/** 单次复查条数上限：联网检索是慢操作，一次点按最多处理这么多条 */
export const MAX_REF_CHECKS = 10;

/** 单条检索超时（毫秒）：RSS 通道实测数百毫秒，给足冗余但不让界面长时间挂住 */
export const REF_CHECK_TIMEOUT_MS = 12000;

/** 批量复查的默认预算与硬上限：联网检索是慢操作，一次点按不能无限制地跑下去 */
export const BATCH_REF_BUDGET = 12;
export const BATCH_REF_MAX = 30;

/**
 * 某任务当前待复查的文号（与结果页复查面板同一口径：待人工确认 + 无法从留存数据核验）。
 * 服务端独立算一遍，批量入口不依赖前端传清单。
 */
export function pendingRefTargets(taskId: string): RefCheckTarget[] {
  const text = getTask(taskId)?.result ?? "";
  if (!text.trim()) return [];
  const rows = db
    .prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`)
    .all(taskId) as unknown as Array<{ tool_name: string; result: string | null; ok: number | null }>;
  const parsed = rows
    .filter((r) => r.ok !== 0)
    .map((r) => {
      try {
        return r.result ? JSON.parse(r.result) : null;
      } catch {
        return null;
      }
    });
  return refCheckTargets(traceDocRefs(text, parsed, rows.map((r) => r.tool_name)));
}

export type BatchPlanItem = { id: string; title: string; targets: RefCheckTarget[] };

/**
 * 批量复查计划：按候选顺序取每个任务的待复查文号，直到用完预算。
 * 没有待复查文号的任务不进计划也不占预算；待办多的任务优先由调用方排序。
 * 纯函数（待办清单由参数注入），便于离线校验预算切分。
 */
export function planBatchRefChecks(
  candidates: Array<{ id: string; title: string }>,
  pendingOf: (id: string) => RefCheckTarget[],
  budget: number = BATCH_REF_BUDGET,
): BatchPlanItem[] {
  let left = Math.max(0, Math.min(budget, BATCH_REF_MAX));
  const out: BatchPlanItem[] = [];
  for (const c of candidates) {
    if (left <= 0) break;
    const targets = pendingOf(c.id).slice(0, left);
    if (targets.length === 0) continue;
    out.push({ id: c.id, title: c.title, targets });
    left -= targets.length;
  }
  return out;
}

/** 把请求体里的条目规范化成复查目标（主键由服务端算，不信任客户端传入） */
export function toTargets(items: unknown): RefCheckTarget[] {
  if (!Array.isArray(items)) return [];
  const out: RefCheckTarget[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (text === "") continue;
    const kind: RefCheckKind = o.kind === "citation" ? "citation" : "docref";
    out.push({
      key: refKey(kind, text),
      kind,
      text,
      context: typeof o.context === "string" ? o.context : undefined,
    });
    if (out.length >= MAX_REF_CHECKS) break;
  }
  // 同一文号只查一次
  return out.filter((t, i) => out.findIndex((x) => x.key === t.key) === i);
}

/** 逐条复查并落库；返回本批记录（含判定、证据与逐引擎尝试过程） */
export async function runRefChecks(
  taskId: string,
  targets: RefCheckTarget[],
  searcher: Searcher = searchWebDetailed,
): Promise<RefCheckRecord[]> {
  const at = nowIso();
  const out: RefCheckRecord[] = [];
  for (const t of targets.slice(0, MAX_REF_CHECKS)) {
    // 依次尝试检索词候选：拿到「找到出处」或「有候选页」就收手，只有空手而归才换一种写法再查
    const variants = refQueryVariants(t);
    const attempts: SearchAttempt[] = [];
    let graded: RefCheckResult | null = null;
    // 记录的是「得出结论所用」的检索词：换写法才查到时就记换后的，全都没查到时记最初那条最具体的
    let usedQuery = variants[0] ?? t.text;
    let tried = 0;
    let failure: string | null = null;
    for (const q of variants) {
      tried += 1;
      let found: DetailedSearch;
      try {
        found = await searcher(q, AbortSignal.timeout(REF_CHECK_TIMEOUT_MS));
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        continue;
      }
      attempts.push(...found.attempts);
      const g = gradeRefCheck(t, {
        hits: found.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, relevance: r.relevance })),
        note: describeAttempts(found.attempts),
        // 全部引擎都是请求失败才算「检索失败」；引擎正常但结果无关属于「未检索到」
        failed: found.attempts.length > 0 && found.attempts.every((a) => a.status === "error"),
      });
      if (graded === null) graded = g;
      if (g.verdict === "matched" || g.verdict === "candidate") {
        graded = g;
        usedQuery = q;
        break;
      }
    }
    const rec: RefCheckRecord = {
      key: t.key,
      kind: t.kind,
      text: t.text,
      query: usedQuery,
      verdict: graded?.verdict ?? "error",
      note: graded
        ? tried > 1 && graded.verdict !== "matched" && graded.verdict !== "candidate"
          ? `${graded.note}（另试 ${tried - 1} 种检索词，均无可用结果）`
          : graded.note
        : (failure ?? "检索请求失败"),
      evidence: graded?.evidence ?? null,
      attempts,
      checkedAt: at,
    };
    saveRefCheck(taskId, rec);
    out.push(rec);
  }
  return out;
}

/** 写入一条复查结果（同一 key 覆盖为最新一次） */
export function saveRefCheck(taskId: string, rec: RefCheckRecord): void {
  db.prepare(
    `INSERT INTO ref_checks
       (task_id, ref_key, kind, text, query, verdict, note, evidence_title, evidence_url, evidence_grade, evidence_snippet, attempts, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, ref_key) DO UPDATE SET
       kind = excluded.kind, text = excluded.text, query = excluded.query, verdict = excluded.verdict,
       note = excluded.note, evidence_title = excluded.evidence_title, evidence_url = excluded.evidence_url,
       evidence_grade = excluded.evidence_grade, evidence_snippet = excluded.evidence_snippet,
       attempts = excluded.attempts, checked_at = excluded.checked_at`,
  ).run(
    taskId,
    rec.key,
    rec.kind,
    rec.text,
    rec.query,
    rec.verdict,
    rec.note,
    rec.evidence?.title ?? null,
    rec.evidence?.url ?? null,
    rec.evidence?.grade ?? null,
    rec.evidence?.snippet ?? null,
    JSON.stringify(rec.attempts),
    rec.checkedAt,
  );
}

type Row = {
  ref_key: string;
  kind: string;
  text: string;
  query: string;
  verdict: string;
  note: string | null;
  evidence_title: string | null;
  evidence_url: string | null;
  evidence_grade: string | null;
  evidence_snippet: string | null;
  attempts: string | null;
  checked_at: string;
};

const VERDICTS = new Set<RefCheckVerdict>(["matched", "candidate", "empty", "error"]);

/** 读取某任务已持久化的复查结果（按文号原文排序，保证列表稳定） */
export function listRefChecks(taskId: string): RefCheckRecord[] {
  const rows = db
    .prepare(`SELECT * FROM ref_checks WHERE task_id = ? ORDER BY text ASC`)
    .all(taskId) as unknown as Row[];
  return rows.map((r) => {
    let attempts: SearchAttempt[] = [];
    try {
      const parsed = JSON.parse(r.attempts ?? "[]") as unknown;
      if (Array.isArray(parsed)) attempts = parsed as SearchAttempt[];
    } catch {
      attempts = [];
    }
    const verdict: RefCheckVerdict = VERDICTS.has(r.verdict as RefCheckVerdict)
      ? (r.verdict as RefCheckVerdict)
      : "error";
    return {
      key: r.ref_key,
      kind: r.kind === "citation" ? "citation" : "docref",
      text: r.text,
      query: r.query,
      verdict,
      note: r.note ?? "",
      evidence:
        r.evidence_url === null
          ? null
          : {
              title: r.evidence_title ?? r.evidence_url,
              url: r.evidence_url,
              snippet: r.evidence_snippet ?? "",
              grade: r.evidence_grade ?? "professional",
              // 判定理由不入库，读取时按同一口径重算，避免存两份可能不一致的文案
              gradeReason: gradeCitation(r.evidence_url, r.evidence_title ?? "").reason,
            },
      attempts,
      checkedAt: r.checked_at,
    };
  });
}
