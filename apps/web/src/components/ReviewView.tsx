import { useState } from "react";
import type { ReviewRecord, TaskIssue } from "../types.ts";
import { IconAlert, IconCheck } from "./Icons.tsx";

interface Props {
  issues: TaskIssue[];
  reviews: ReviewRecord[];
  pending: number;
  onReview: (issueId: string, decision: "confirm" | "dismiss", comment: string) => void;
}

function typeTone(type: string): string {
  if (type.includes("差异") || type.includes("缺失")) return "border-rose-400/40 bg-rose-400/10 text-rose-300";
  if (type.includes("仅")) return "border-sky-400/40 bg-sky-400/10 text-sky-300";
  return "border-amber-400/40 bg-amber-400/10 text-amber-300";
}

const QUICK_COMMENTS = ["确认列入底稿", "无需处理", "需重新测算", "待客户补充资料"];

const COMMENT_TEMPLATES = [
  "经复核确认列入底稿，交付前请再次核对对应单元格与引用来源",
  "判定无需处理：差异属可接受的尾差/口径范围，已在结论中说明",
  "需客户补充佐证资料后复核，资料齐备前暂不调整底稿",
  "请以工具重新测算并对照政策限额核验，复核后再定处理方式",
];

/** 人工复核页签：税务师对工具核查与底稿比对发现的问题逐项确认或驳回。 */
export function ReviewView({ issues, reviews, pending, onReview }: Props) {
  const [comments, setComments] = useState<Record<string, string>>({});
  const [onlyPending, setOnlyPending] = useState(true);
  const reviewMap = new Map(reviews.map((r) => [r.issueId, r]));
  const shown = onlyPending ? issues.filter((i) => !reviewMap.has(i.id)) : issues;

  if (issues.length === 0) {
    return (
      <div className="py-10 text-center text-[13px] text-mist-600">
        暂无待复核事项。工具核查与底稿比对发现问题后会自动汇总到这里。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12.5px] text-mist-500">
        {pending > 0 ? (
          <>
            <IconAlert className="h-4 w-4 text-amber-300" />
            {pending} 项待税务师确认；全部复核完成后任务自动流转为已完成
          </>
        ) : (
          <>
            <IconCheck className="h-4 w-4 text-jade-400" />
            复核完成
          </>
      )}
      </div>

      {pending > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              for (const issue of issues) {
                if (!reviewMap.has(issue.id)) onReview(issue.id, "confirm", comments[issue.id] ?? "");
              }
            }}
            className="rounded-md border border-jade-400/40 bg-jade-400/10 px-2.5 py-1 text-[11.5px] text-jade-400 transition-colors hover:bg-jade-400/20"
          >
            全部确认（{pending}）
          </button>
          <button
            type="button"
            onClick={() => {
              for (const issue of issues) {
                if (!reviewMap.has(issue.id)) onReview(issue.id, "dismiss", comments[issue.id] ?? "");
              }
            }}
            className="rounded-md border border-line bg-night-800 px-2.5 py-1 text-[11.5px] text-mist-300 transition-colors hover:border-rose-400/40 hover:text-rose-300"
          >
            全部驳回
          </button>
          <span className="text-[11px] text-mist-600">批量操作使用各项已填写的复核意见（如有）</span>
        </div>
      )}

      {pending > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {issues
            .filter((i) => !reviewMap.has(i.id))
            .map((i, idx) => (
              <button
                key={i.id}
                type="button"
                className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10.5px] text-amber-300 transition-colors hover:border-amber-300"
                onClick={() =>
                  document.getElementById(`issue-${i.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })
                }
              >
                #{idx + 1} {i.issueType}
              </button>
            ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setOnlyPending(true)}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            onlyPending
              ? "border-glow-500 bg-glow-500/15 text-glow-300"
              : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
          }`}
        >
          仅看待复核（{pending}）
        </button>
        <button
          type="button"
          onClick={() => setOnlyPending(false)}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            !onlyPending
              ? "border-glow-500 bg-glow-500/15 text-glow-300"
              : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
          }`}
        >
          全部（{issues.length}）
        </button>
      </div>

      {shown.length === 0 && issues.length > 0 && (
        <div className="rounded-md border border-jade-400/30 bg-jade-400/10 px-3 py-2 text-[12.5px] text-jade-400">
          当前过滤下无事项；切换到「全部」可查看历史复核记录。
        </div>
      )}

      {shown.map((issue) => {
        const rev = reviewMap.get(issue.id);
        const commentValue = comments[issue.id] ?? rev?.comment ?? "";
        return (
          <div key={issue.id} id={`issue-${issue.id}`} className="glow-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-1.5 py-0.5 text-[10.5px] ${typeTone(issue.issueType)}`}>
                {issue.issueType}
              </span>
              <span className="font-mono text-[10.5px] text-mist-600">{issue.source}</span>
              {rev && (
                <span
                  className={`ml-auto rounded border px-1.5 py-0.5 text-[10.5px] ${
                    rev.decision === "confirm"
                      ? "border-jade-400/40 bg-jade-400/10 text-jade-400"
                      : "border-line bg-night-800 text-mist-500"
                  }`}
                >
                  {rev.decision === "confirm" ? "已确认列入底稿" : "已判定无需处理"}
                </span>
              )}
            </div>

            <p className="mt-2 text-[13px] leading-6 text-mist-100">{issue.description}</p>

            {issue.evidence.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {issue.evidence.slice(0, 6).map((e) => (
                  <span key={e} className="rounded bg-night-800 px-1.5 py-0.5 font-mono text-[10.5px] text-mist-500">
                    {e}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="flex w-full flex-wrap gap-1.5">
                {QUICK_COMMENTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setComments((prev) => ({ ...prev, [issue.id]: q }))}
                    className="rounded-full border border-line bg-night-850 px-2 py-0.5 text-[10.5px] text-mist-500 transition-colors hover:border-glow-500 hover:text-mist-100"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <input
                value={commentValue}
                onChange={(e) => setComments((prev) => ({ ...prev, [issue.id]: e.target.value }))}
                placeholder="复核意见（可选）"
                className="min-w-[200px] flex-1 rounded-md border border-line bg-night-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:glow-ring"
              />
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) setComments((prev) => ({ ...prev, [issue.id]: e.target.value }));
                }}
                className="rounded-md border border-line bg-night-850 px-2 py-1.5 text-[11.5px] text-mist-300 outline-none focus:glow-ring"
                title="插入意见模板"
              >
                <option value="">意见模板…</option>
                {COMMENT_TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t.slice(0, 16)}…
                  </option>
                ))}
              </select>
              <span className="shrink-0 font-mono text-[10px] text-mist-600">{commentValue.length} 字</span>
              <button
                type="button"
                onClick={() => onReview(issue.id, "confirm", commentValue)}
                className="rounded-md border border-jade-400/40 bg-jade-400/10 px-2.5 py-1.5 text-[12px] text-jade-400 transition-colors hover:bg-jade-400/20"
              >
                确认列入底稿
              </button>
              <button
                type="button"
                onClick={() => onReview(issue.id, "dismiss", commentValue)}
                className="rounded-md border border-line bg-night-800 px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:border-rose-400/40 hover:text-rose-300"
              >
                判定无需处理
              </button>
            </div>
          </div>
        );
      })}

      {reviews.length > 0 && (
        <div className="pt-2">
          <div className="kicker">复核历史</div>
          <ul className="mt-2 space-y-1.5">
            {[...reviews]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((r) => {
                const issue = issues.find((i) => i.id === r.issueId);
                return (
                  <li
                    key={`${r.issueId}-${r.createdAt}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-night-850 px-2.5 py-1.5 text-[11.5px]"
                  >
                    <span className="font-mono text-[10.5px] text-mist-600">
                      {new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false })}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        r.decision === "confirm"
                          ? "border-jade-400/40 bg-jade-400/10 text-jade-400"
                          : "border-line bg-night-800 text-mist-500"
                      }`}
                    >
                      {r.decision === "confirm" ? "确认" : "驳回"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-mist-300">{issue?.issueType ?? r.issueId}</span>
                    {r.comment && <span className="w-full truncate text-[11px] text-mist-600">意见：{r.comment}</span>}
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}
