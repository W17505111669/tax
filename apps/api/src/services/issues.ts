import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db.ts";

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
 */
export function extractIssues(taskId: string): TaskIssue[] {
  const calls = db
    .prepare(`SELECT id, tool_name, result FROM tool_calls WHERE task_id = ? AND ok = 1 AND result IS NOT NULL ORDER BY started_at ASC`)
    .all(taskId) as unknown as Array<{ id: string; tool_name: string; result: string }>;

  const seen = new Map<string, TaskIssue>();

  for (const call of calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.result);
    } catch {
      continue;
    }

    const issues = (parsed as { issues?: unknown } | null)?.issues;
    if (Array.isArray(issues)) {
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
