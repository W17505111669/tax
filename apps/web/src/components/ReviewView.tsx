import { useState } from "react";
import type { ReviewRecord, TaskIssue } from "../types.ts";
import { IconAlert, IconCheck } from "./Icons.tsx";
import {
  amountNoteTemplates,
  composeNote,
  dropLastNoteSegment,
  noteIsMeaningful,
} from "../amount-note.ts";

interface Props {
  issues: TaskIssue[];
  reviews: ReviewRecord[];
  pending: number;
  /** 任务当前状态：完成态仍有待复核问题时要给出补救入口 */
  status: string;
  /** 所属作品：金额核对备注模板按作品给（研发看辅助账、土增看清算底稿） */
  agentId?: string;
  onReview: (issueId: string, decision: "confirm" | "dismiss", comment: string) => void;
  onReopen: () => void;
  /** 结论金额溯源与人工核对状态（与正文就地标注同源） */
  amounts?: {
    total: number;
    traced: number;
    fromInput: number;
    pending: Array<{ key: string; raw: string; context: string; occurrences: number }>;
    acked: Array<{ key: string; raw: string; at: string; note: string; occurrences: number }>;
    /** 待确认 / 已核对金额在结论中出现的总处数（同一金额多种写法合并前） */
    pendingOccurrences: number;
    ackedOccurrences: number;
  };
  onToggleAmount?: (key: string) => void;
  /** 保存已核对金额的备注（写入交付包） */
  onAmountNote?: (key: string, note: string) => void;
}

function typeTone(type: string): string {
  if (type.includes("差异") || type.includes("缺失")) return "border-rose-400/40 bg-rose-400/10 text-rose-300";
  if (type.includes("仅")) return "border-sky-400/40 bg-sky-400/10 text-sky-300";
  return "border-amber-400/40 bg-amber-400/10 text-amber-300";
}

const REVIEW_RING = 2 * Math.PI * 12;

const QUICK_COMMENTS = ["确认列入底稿", "无需处理", "需重新测算", "待客户补充资料"];

const COMMENT_TEMPLATES = [
  "经复核确认列入底稿，交付前请再次核对对应单元格与引用来源",
  "判定无需处理：差异属可接受的尾差/口径范围，已在结论中说明",
  "需客户补充佐证资料后复核，资料齐备前暂不调整底稿",
  "请以工具重新测算并对照政策限额核验，复核后再定处理方式",
];

/** 人工复核页签：税务师对工具核查与底稿比对发现的问题逐项确认或驳回。 */
export function ReviewView({
  issues,
  reviews,
  pending,
  status,
  agentId,
  onReview,
  onReopen,
  amounts,
  onToggleAmount,
  onAmountNote,
}: Props) {
  const [comments, setComments] = useState<Record<string, string>>({});
  const [amountNotes, setAmountNotes] = useState<Record<string, string>>({});
  const [onlyPending, setOnlyPending] = useState(true);
  const reviewMap = new Map(reviews.map((r) => [r.issueId, r]));

  // 结论金额核对：与正文里的就地标注同一份数据，这里给出可批量处理的清单
  const amountBlock =
    amounts && amounts.total > 0 ? (
      <div className="rounded-md border border-line bg-night-900/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="kicker">结论金额核对</span>
          <span className="text-[11.5px] text-mist-600">
            共 {amounts.total} 处：工具可溯源 {amounts.traced} · 来自客户指令 {amounts.fromInput} · 待确认{" "}
            {amounts.pendingOccurrences} 处（{amounts.pending.length} 个金额）· 已核对 {amounts.ackedOccurrences} 处
          </span>
          {amounts.pending.length === 0 && (
            <span className="rounded bg-jade-400/15 px-1.5 py-0.5 text-[10.5px] text-jade-300">金额核对已完成</span>
          )}
        </div>
        {amounts.pending.length > 0 && (
          <ul className="mt-2 space-y-1">
            {amounts.pending.slice(0, 20).map((a) => (
              <li
                key={a.key}
                className="flex items-center gap-2 rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1.5"
              >
                <span className="shrink-0 font-mono text-[11.5px] text-amber-300">{a.raw}</span>
                {a.occurrences > 1 && (
                  <span className="shrink-0 text-[10.5px] text-mist-600">出现 {a.occurrences} 处</span>
                )}
                <span className="min-w-0 flex-1 truncate text-[11px] text-mist-600" title={a.context}>
                  …{a.context}…
                </span>
                <button
                  type="button"
                  className="action-btn shrink-0"
                  title="标记为已核对（写入状态事件留痕，可撤销）"
                  onClick={() => onToggleAmount?.(a.key)}
                >
                  标记已核对
                </button>
              </li>
            ))}
            {amounts.pending.length > 20 && (
              <li className="text-[11px] text-mist-600">
                另有 {amounts.pending.length - 20} 处，可在结论正文中点击琥珀标记处理
              </li>
            )}
          </ul>
        )}
        {amounts.acked.length > 0 && (
          <ul className="mt-2 space-y-1">
            {amounts.acked.map((a) => (
              <li key={a.key} className="rounded border border-jade-400/25 bg-jade-400/5 px-2 py-1">
                <div className="flex items-center gap-2">
                  <IconCheck className="h-3 w-3 shrink-0 text-jade-400" />
                  <span className="shrink-0 font-mono text-[11.5px] text-jade-300">{a.raw}</span>
                  {a.occurrences > 1 && (
                    <span className="shrink-0 text-[10.5px] text-mist-600">出现 {a.occurrences} 处</span>
                  )}
                  <span className="font-mono text-[10.5px] text-mist-600">
                    {new Date(a.at).toLocaleString("zh-CN", { hour12: false })}
                  </span>
                  <button
                    type="button"
                    className="action-btn ml-auto shrink-0"
                    title="撤销核对标记，重新计入待确认"
                    onClick={() => onToggleAmount?.(a.key)}
                  >
                    撤销
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    {amountNoteTemplates(agentId ?? "").map((t) => (
                      <button
                        key={t.label}
                        type="button"
                        className="shrink-0 rounded-full border border-line bg-night-850 px-2 py-0.5 text-[10.5px] text-mist-400 transition-colors hover:border-glow-500 hover:text-glow-300"
                        title={`填入「${t.text}」；已有内容时按分号追加，重复点不会重复追加`}
                        onClick={() =>
                          setAmountNotes((prev) => ({
                            ...prev,
                            [a.key]: composeNote(prev[a.key] ?? a.note, t.text),
                          }))
                        }
                      >
                        {t.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="action-btn shrink-0 !text-[10.5px]"
                      title="删掉最近一段备注（点错模板时用）"
                      onClick={() =>
                        setAmountNotes((prev) => ({
                          ...prev,
                          [a.key]: dropLastNoteSegment(prev[a.key] ?? a.note),
                        }))
                      }
                    >
                      删上一段
                    </button>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    value={amountNotes[a.key] ?? a.note}
                    onChange={(e) => setAmountNotes((prev) => ({ ...prev, [a.key]: e.target.value }))}
                    placeholder="核对依据备注（写入交付包），例如：与辅助账第 3 行核对一致"
                    className="min-w-0 flex-1 rounded border border-line bg-night-850 px-2 py-0.5 text-[11px] text-mist-100 outline-none focus:glow-ring"
                  />
                  <button
                    type="button"
                    className="action-btn shrink-0"
                    title="保存备注并保持已核对状态"
                    onClick={() => onAmountNote?.(a.key, (amountNotes[a.key] ?? a.note).trim())}
                  >
                    保存备注
                  </button>
                </div>
                {!noteIsMeaningful(amountNotes[a.key] ?? a.note) && (
                  <p className="mt-1 text-[10.5px] leading-4 text-amber-300">
                    还没有写核对依据：备注会进整页交付 MD 与交付包，空着等于没有留痕
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  const exportReviews = () => {
    const lines = ["# 复核记录", ""];
    for (const r of [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const issue = issues.find((i) => i.id === r.issueId);
      lines.push(
        `- ${new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false })} | ${
          r.decision === "confirm" ? "确认" : "驳回"
        } | ${issue?.issueType ?? r.issueId} | 意见：${r.comment || "（无）"}`,
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `复核记录-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const shown = onlyPending ? issues.filter((i) => !reviewMap.has(i.id)) : issues;

  if (issues.length === 0) {
    return (
      <div className="space-y-3">
        <div className="py-10 text-center text-[13px] text-mist-600">
          暂无待复核事项。工具核查与底稿比对发现问题后会自动汇总到这里。
        </div>
        {amountBlock}
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
        {issues.length > 0 && (
          <span className="ml-auto flex items-center gap-2" title={`已复核 ${reviewMap.size}/${issues.length}`}>
            <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
              <circle cx="16" cy="16" r="12" fill="none" stroke="#1b2c47" strokeWidth="5" />
              <circle
                cx="16"
                cy="16"
                r="12"
                fill="none"
                stroke="#34d399"
                strokeWidth="5"
                strokeDasharray={`${(reviewMap.size / issues.length) * REVIEW_RING} ${REVIEW_RING}`}
                transform="rotate(-90 16 16)"
              />
            </svg>
            <span className="font-mono text-[10.5px] text-mist-400">
              {reviewMap.size}/{issues.length}
            </span>
          </span>
        )}
      </div>

      {status === "completed" && pending > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">
          <IconAlert className="h-4 w-4 shrink-0" />
          <span>
            任务已标记完成，但仍有 {pending} 项问题未复核；问题清单由工具结果实时提取，可能在完成后才汇总到这里。
          </span>
          <button
            type="button"
            onClick={onReopen}
            title="把任务状态改回待复核，避免带着未复核问题交付"
            className="ml-auto rounded-md border border-amber-300/50 px-2.5 py-1 text-[11.5px] text-amber-100 transition-colors hover:bg-amber-300/20"
          >
            转为待复核
          </button>
        </div>
      )}

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
          <div className="flex items-center justify-between">
            <span className="kicker">复核历史</span>
            <button type="button" className="action-btn" onClick={exportReviews} title="导出复核记录 Markdown">
              导出 MD
            </button>
          </div>
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
      {amountBlock}
    </div>
  );
}
