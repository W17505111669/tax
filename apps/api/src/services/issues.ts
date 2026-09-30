import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db.ts";
import { buildDerivedFrom, isTemplateCompare } from "./compare-stats.ts";

export interface TaskIssue {
  id: string;
  source: string;
  issueType: string;
  description: string;
  evidence: string[];
  requiresReview: boolean;
}

export interface ReviewRecord {
  issueId: string;
  decision: "confirm" | "dismiss";
  comment: string;
  createdAt: string;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  return String(v);
}

/**
 * 从工具调用结果中提取待复核问题：
 * - 业务工具返回的 details.issues（账账差异、资料缺失、未匹配等）
 * - compare_workpapers 返回的差异/单方缺失格
 * 同一问题跨多次调用去重（按 source+type+description）。
 *
 * 三道过滤，都是为了让这份清单只列**当前还需要人看**的项：没有结论的任务整条不列；与自身原始模板
 * 的比对不列（模板本来是空的，「只有一侧有」正是填进去的值）；被后续运行取代的旧结果不列——底稿
 * 比对只取最近一次与人工底稿的比对，返回完整 issues 清单的业务工具只取同名工具最近一次成功调用。
 * 改之前全平台 135 条待复核里，43 条来自一个 failed 任务、15 条来自与自身模板的比对、还有一批来自
 * 被后续运行取代的旧比对——真正要人看的项被埋在里面。
 */
export function extractIssues(taskId: string): TaskIssue[] {
  // 没有结论就没有可交付物：失败或中断那次运行留下的差异与缺失项是残渣，不是待复核欠账
  //（与「没有结论的任务不计证据欠账」同一条口径）。直接读库而不走 task-store：task-store 反过来
  // 依赖本模块的 pendingReviewCount，互相 import 会成环
  const taskRow = db.prepare(`SELECT result FROM tasks WHERE id = ?`).get(taskId) as
    | { result: string | null }
    | undefined;
  if (String(taskRow?.result ?? "").trim() === "") return [];

  const calls = db
    .prepare(
      `SELECT id, tool_name, args, result, started_at FROM tool_calls
        WHERE task_id = ? AND ok = 1 AND result IS NOT NULL ORDER BY started_at ASC`,
    )
    .all(taskId) as unknown as Array<{
    id: string;
    tool_name: string;
    args: string | null;
    result: string;
    started_at: string | null;
  }>;

  const seen = new Map<string, TaskIssue>();

  // 比对类问题只取最近一次「与人工底稿」的比对：
  // 1. 与自己的原始模板比对不算问题——模板本来是空的，「只有一侧有」正是填进去的值；
  // 2. 同一任务反复比对时，早先那次的差异已被后来那次取代（实测 aabd138a 09-29 05:57 那次有 48 处
  //    「仅系统底稿」，06:36 重跑后只剩 1 处差异；留着旧的那些，等于让人复核一个已经不存在的状态）。
  // calls 已按 started_at 升序，最后一条即最近一次
 const derived = buildDerivedFrom(calls);
 const peerCompares = calls.filter(
   (c) => c.tool_name === "compare_workpapers" && !isTemplateCompare(c.args, derived),
 );
 const latestCompareId = peerCompares.length > 0 ? peerCompares[peerCompares.length - 1]!.id : null;

  // 「被后续运行取代」这条口径不止适用于底稿比对：凡是返回**完整 issues 清单**的工具（归集核查、
  // 合同发票关联、发票账面关联、金额一致性…），每次调用都是对同一套输入的全量重算，同一任务里
  // 重跑一遍，早先那次描述的状态就已经不存在了。实测 09046f0a 续跑后，旧一轮「HT-001 建安工程
  // 合同 / 关联 1 张发票」的差异仍挂在清单上，与新一轮「HT-001 总承包合同 / 关联 2 张发票」并存，
  // 同一件事出现两条，去重键（source+type+description）拦不住——描述里带了合同名与发票张数。
  // 按工具名动态分组取最后一次，不写死工具清单，新增同类工具自动适用。
  // 代价：同一任务里对两个不同主体各跑一次同类工具时，只留最后一次。这与底稿比对既有的取舍一致
  // （平台是一件业务一个任务），换来的是清单不再让人复核过期快照。
  const latestIssuesCallByTool = new Map<string, string>();
  for (const call of calls) {
    let probe: unknown;
    try {
      probe = JSON.parse(call.result);
    } catch {
      continue;
    }
    if (!Array.isArray((probe as { issues?: unknown } | null)?.issues)) continue;
    // calls 已按 started_at 升序，后一次覆盖前一次，留下的就是最近一次
    latestIssuesCallByTool.set(call.tool_name, call.id);
  }

  for (const call of calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.result);
    } catch {
      continue;
    }

    const issues = (parsed as { issues?: unknown } | null)?.issues;
    if (Array.isArray(issues) && latestIssuesCallByTool.get(call.tool_name) === call.id) {
      issues.forEach((raw, i) => {
        const it = raw as { issueType?: string; description?: string; evidence?: unknown; requiresReview?: boolean };
        const issue: TaskIssue = {
          id: `${call.id}:${i}`,
          source: call.tool_name,
          issueType: it.issueType ?? "未分类",
          description: it.description ?? "",
          evidence: Array.isArray(it.evidence) ? it.evidence.map(String) : [],
          requiresReview: it.requiresReview !== false,
        };
        const key = `${issue.source}|${issue.issueType}|${issue.description}`;
        if (!seen.has(key)) seen.set(key, issue);
      });
    }

    const sheets = (parsed as { sheets?: unknown } | null)?.sheets;
    if (Array.isArray(sheets)) {
      if (call.id !== latestCompareId) continue;
      sheets.forEach((s, si) => {
        const diffs = (s as { diffs?: unknown }).diffs;
        if (!Array.isArray(diffs)) return;
        diffs.forEach((d, di) => {
          const dd = d as { kind?: string; address?: string; a?: unknown; b?: unknown };
          if (!dd.kind || !dd.address) return;
          const issueType =
            dd.kind === "mismatch" ? "底稿差异" : dd.kind === "only_a" ? "仅系统底稿" : "仅人工底稿";
          const issue: TaskIssue = {
            id: `${call.id}:s${si}:d${di}`,
            source: call.tool_name,
            issueType,
            description: `${dd.address}：系统=${fmtVal(dd.a)}，人工=${fmtVal(dd.b)}`,
            evidence: [dd.address],
            requiresReview: true,
          };
          const key = `${issue.source}|${issue.issueType}|${issue.description}`;
          if (!seen.has(key)) seen.set(key, issue);
        });
      });
    }
  }

  return [...seen.values()];
}

export function listReviews(taskId: string): ReviewRecord[] {
  const rows = db
    .prepare(`SELECT issue_id, decision, comment, created_at FROM reviews WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as unknown as Array<{ issue_id: string; decision: string; comment: string | null; created_at: string }>;
  return rows.map((r) => ({
    issueId: r.issue_id,
    decision: r.decision as ReviewRecord["decision"],
    comment: r.comment ?? "",
    createdAt: r.created_at,
  }));
}

export function saveReview(taskId: string, issueId: string, decision: "confirm" | "dismiss", comment: string): ReviewRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reviews (id, task_id, issue_id, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, issue_id) DO UPDATE SET decision = excluded.decision, comment = excluded.comment, created_at = excluded.created_at`,
  ).run(id, taskId, issueId, decision, comment, nowIso());
  return { issueId, decision, comment, createdAt: nowIso() };
}

export function pendingReviewIssues(taskId: string): TaskIssue[] {
  const reviewed = new Set(listReviews(taskId).map((r) => r.issueId));
  return extractIssues(taskId).filter((i) => i.requiresReview && !reviewed.has(i.id));
}

/**
 * 复核状态一致性判定：任务已标记完成，但仍有待复核问题时需要重新打开复核。
 * 问题清单是从工具结果实时提取的，完成后新增工具调用或去重口径变化都可能让两者不一致。
 */
export function needsReopenReview(status: string, pending: number): boolean {
  return status === "completed" && pending > 0;
}

/** 批量重开复核的目标筛选：只挑「已完成且仍有待复核问题」的任务 id */
export function selectReopenTargets(tasks: Array<{ id: string; status: string; pending: number }>): string[] {
  return tasks.filter((t) => needsReopenReview(t.status, t.pending)).map((t) => t.id);
}

/** 待复核数量缓存：列表接口要为每个任务算一次，按工具调用/复核记录的变化签名失效 */
const pendingCache = new Map<string, { sig: string; pending: number }>();

function pendingSig(taskId: string): string {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(started_at), '') AS s, COALESCE(MAX(ended_at), '') AS e
       FROM tool_calls WHERE task_id = ? AND ok = 1`,
    )
    .get(taskId) as { n: number; s: string; e: string };
  const r = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(created_at), '') AS last FROM reviews WHERE task_id = ?`)
    .get(taskId) as { n: number; last: string };
  return `${c.n}|${c.s}|${c.e}|${r.n}|${r.last}`;
}

/** 带缓存的待复核问题数（列表接口用），口径与 pendingReviewIssues 一致 */
export function pendingReviewCount(taskId: string): number {
  const sig = pendingSig(taskId);
  const cached = pendingCache.get(taskId);
  if (cached && cached.sig === sig) return cached.pending;
  const pending = pendingReviewIssues(taskId).length;
  pendingCache.set(taskId, { sig, pending });
  return pending;
}
