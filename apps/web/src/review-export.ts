/**
 * 人工复核记录的交付导出：整页 MD 的「人工复核记录」一节。
 * 待复核口径与后端 pendingReviewIssues 保持一致（requiresReview !== false 且没有复核记录）。
 * 纯函数，便于 apps/api/scripts/verify-review-export.ts 直接校验。
 */
import { mdCell } from "./run-tools.ts";

export type IssueLike = {
  id: string;
  source: string;
  issueType: string;
  description: string;
  requiresReview?: boolean;
};

export type ReviewLike = { issueId: string; decision: "confirm" | "dismiss"; comment: string; createdAt: string };

export const DECISION_TEXT: Record<ReviewLike["decision"], string> = {
  confirm: "确认列入底稿",
  dismiss: "判定无需处理",
};

/** 复核计数：与后端 pendingReviewIssues 同口径 */
export function reviewCounts(issues: IssueLike[], reviews: ReviewLike[]): {
  total: number;
  done: number;
  pending: number;
  notRequired: number;
} {
  const reviewed = new Set(reviews.map((r) => r.issueId));
  const done = issues.filter((i) => reviewed.has(i.id)).length;
  const pending = issues.filter((i) => !reviewed.has(i.id) && i.requiresReview !== false).length;
  return { total: issues.length, done, pending, notRequired: issues.length - done - pending };
}

/** 生成「人工复核记录」一节的 Markdown 行 */
export function reviewSection(issues: IssueLike[], reviews: ReviewLike[], status: string): string[] {
  const c = reviewCounts(issues, reviews);
  const byId = new Map(reviews.map((r) => [r.issueId, r]));
  const lines: string[] = [
    `- 问题合计 ${c.total} 项：已复核 ${c.done} · 待复核 ${c.pending}${
      c.notRequired > 0 ? ` · 无需复核 ${c.notRequired}` : ""
    }`,
  ];
  if (status === "completed" && c.pending > 0) {
    lines.push(
      `- 状态提示：任务已标记完成但仍有 ${c.pending} 项未复核，交付前请在复核页「转为待复核」并逐项处理`,
    );
  }
  if (status === "waiting_review" && c.pending === 0) {
    lines.push(`- 状态提示：全部问题已复核，任务将流转为已完成`);
  }
  lines.push("");

  if (issues.length === 0) {
    lines.push("（本次任务未产生需要人工复核的问题）", "");
    return lines;
  }

  const done = issues.filter((i) => byId.has(i.id));
  if (done.length > 0) {
    lines.push(
      "### 已复核",
      "",
      "| # | 问题类型 | 问题描述 | 决定 | 复核意见 | 复核时间 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    [...done]
      .sort((a, b) => (byId.get(a.id)?.createdAt ?? "").localeCompare(byId.get(b.id)?.createdAt ?? ""))
      .forEach((i, idx) => {
        const r = byId.get(i.id);
        lines.push(
          `| ${idx + 1} | ${mdCell(i.issueType)} | ${mdCell(i.description)} | ${
            r ? DECISION_TEXT[r.decision] : "—"
          } | ${mdCell(r?.comment || "（无）")} | ${r?.createdAt ?? "—"} |`,
        );
      });
    lines.push("");
  }

  const pending = issues.filter((i) => !byId.has(i.id) && i.requiresReview !== false);
  if (pending.length > 0) {
    lines.push("### 待复核", "", "| # | 问题类型 | 问题描述 | 来源工具 |", "| --- | --- | --- | --- |");
    pending.forEach((i, idx) => {
      lines.push(`| ${idx + 1} | ${mdCell(i.issueType)} | ${mdCell(i.description)} | ${mdCell(i.source)} |`);
    });
    lines.push("");
  }

  return lines;
}
