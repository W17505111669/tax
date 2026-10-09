import { useMemo, useState } from "react";
import type { PlatformStats } from "../types.ts";
import type { IssueGroup } from "../review-queue.ts";
import type { PendingIssueRow } from "../review-queue.ts";
import { downloadText } from "../download.ts";
import { dateTimeStamp, dayStamp, relTime } from "../time-format.ts";

/**
 * 复核队列（#/review）：跨任务同类待复核问题一次看清、一次处置。
 * 分组口径用 review-queue.ts 的 groupPendingIssues（服务端已按同一份纯函数分组下发），
 * 处置走与看板同一批 reviewBatch / 批量联网复查回调，各任务分别留痕。
 */
interface Props {
  platform: PlatformStats | null;
  tasks: Array<{ id: string; title: string; updatedAt: string }>;
  backendDown: boolean;
  onOpenTask: (taskId: string) => void;
  onReview: (
    items: Array<{ taskId: string; issueId: string }>,
    decision: "confirm" | "dismiss",
    comment: string,
  ) => Promise<number>;
  onRefCheck: (ids: string[], kinds: Array<"docref" | "citation">) => Promise<unknown>;
}

const typeTag = (t: string): string =>
  t.includes("失效链接") ? "bad" : t.includes("金额") ? "acc" : "warn";

export function ReviewQueueView({ platform, tasks, backendDown, onOpenTask, onReview, onRefCheck }: Props) {
  const groups: IssueGroup[] = platform?.reviewGroups ?? [];
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sel, setSel] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const keyOf = (g: IssueGroup) => `${g.issueType}|${g.description}`;
  const shown = typeFilter === "all" ? groups : groups.filter((g) => g.issueType === typeFilter);
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.issueType, (m.get(g.issueType) ?? 0) + g.items.length);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [groups]);
  // 已选组跨过滤保留：切类型过滤不应把已勾选的组静默排除出批量范围
  const selGroups = groups.filter((g) => sel.includes(keyOf(g)));
  const selItems = selGroups.flatMap((g) => g.items.map((i) => ({ taskId: i.taskId, issueId: i.issueId })));
  const selTaskIds = [...new Set(selGroups.flatMap((g) => g.items.map((i) => i.taskId)))];
  const ev = platform?.evidence;
  const deadLinks = typeCounts.find(([t]) => t.includes("失效链接"))?.[1] ?? 0;
  const [statusFilter, setStatusFilter] = useState<"pending" | "confirm" | "dismiss">("pending");
  const [viewMode, setViewMode] = useState<"type" | "task" | "time">("type");
  const decidedRows = [...(platform?.reviewDecidedItems ?? [])]
    .filter((d) => d.decision === statusFilter)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  // 视图段：按类型聚合（默认）/ 按任务分组 / 按任务更新时间倒序平铺
  const pendingItems = shown.flatMap((g) => g.items);
  const taskOrder = new Map(tasks.map((t) => [t.id, t.updatedAt]));
  const taskGroups = [
    ...pendingItems
      .reduce((m, i) => {
        const l = m.get(i.taskId) ?? [];
        l.push(i);
        m.set(i.taskId, l);
        return m;
      }, new Map<string, PendingIssueRow[]>())
      .entries(),
  ].sort((a, b) => (taskOrder.get(b[0]) ?? "").localeCompare(taskOrder.get(a[0]) ?? ""));
  const timeRows = [...pendingItems].sort(
    (a, b) =>
      (taskOrder.get(b.taskId) ?? "").localeCompare(taskOrder.get(a.taskId) ?? "") ||
      a.issueType.localeCompare(b.issueType),
  );
  const itemView = (i: PendingIssueRow, key: string) => (
    <div key={key} className="h6-card h6-qrow">
      <span className="h6-tag warn">{i.issueType}</span>
      <div className="h6-qmain">
        <b>{i.description}</b>
        <span className="h6-anno">{i.taskTitle}</span>
      </div>
      <button type="button" className="h6-btn-g h6-btn-s" onClick={() => onOpenTask(i.taskId)}>
        前往任务
      </button>
    </div>
  );
  const toggle = (k: string) => setSel((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]));
  const run = (decision: "confirm" | "dismiss") => {
    if (busy !== "" || selItems.length === 0) return;
    setBusy(decision);
    setMsg("");
    void onReview(selItems, decision, comment)
      .then((n) => setMsg(`已${decision === "confirm" ? "确认" : "驳回"} ${n} 项，各任务分别留复核记录与事件留痕`))
      .catch(() => setMsg("批量处置失败，请到各任务复核页逐个处理"))
      .finally(() => {
        setBusy("");
        setSel([]);
      });
  };
  const refCheck = () => {
    if (busy !== "" || selTaskIds.length === 0) return;
    setBusy("ref");
    setMsg("");
    void onRefCheck(selTaskIds, ["docref", "citation"])
      .then(() => setMsg("批量联网复查完成，结果已落库；请到各任务结果页确认后写回"))
      .catch(() => setMsg("批量联网复查失败"))
      .finally(() => setBusy(""));
  };
  // 导出当前过滤视图的复核清单 MD：类型聚合 + 逐任务行，口径与界面同一份 shown
  const exportMd = () => {
    const lines = [
      "",
      `导出时间：${dateTimeStamp(new Date())}`,
      `过滤：处置状态=${statusFilter === "pending" ? "待处置" : statusFilter === "confirm" ? "已确认" : "已驳回"} · 问题类型=${typeFilter === "all" ? "全部" : typeFilter} · 视图=${viewMode === "type" ? "按类型聚合" : viewMode === "task" ? "按任务分组" : "按时间倒序"}`,
      "",
    ];
    if (statusFilter === "pending") {
      const total = shown.reduce((s, g) => s + g.items.length, 0);
      lines.unshift(`# 复核清单（待处置 · 按类型聚合 ${shown.length} 类 / ${total} 项）`);
      for (const g of shown) {
        lines.push(`## ${g.issueType} · ${g.items.length} 项`, "", g.description, "");
        for (const i of g.items) lines.push(`- ${i.taskTitle}（${i.taskId}）`);
        lines.push("");
      }
    } else {
      const label = statusFilter === "confirm" ? "已确认" : "已驳回";
      lines.unshift(`# 复核清单（${label} · ${decidedRows.length} 项）`);
      for (const d of decidedRows) {
        lines.push(`## ${d.issueType} · ${label}`, "", d.description, "");
        lines.push(`- ${d.taskTitle} · ${dateTimeStamp(new Date(d.decidedAt))}`);
        if (d.comment) lines.push(`- 意见：${d.comment}`);
        lines.push("");
      }
    }
    downloadText(`复核清单-${dayStamp(new Date())}.md`, lines.join("\n"), "text/markdown");
  };

  return (
    <div className="h6-page">
      <main className="h6-home" style={{ maxWidth: 1500 }}>
        <div className="h6-page-h">
          <div>
            <div className="kicker">REVIEW QUEUE · 全平台</div>
            <h1 className="h6-bh1">复核队列</h1>
            <i className="h6-underline" aria-hidden />
          </div>
          <div className="h6-page-acts">
            <button type="button" className="h6-btn-g h6-btn-s" onClick={exportMd}>
              导出复核清单
            </button>
            <button
              type="button"
              className="h6-btn-g h6-btn-s"
              onClick={refCheck}
              disabled={busy !== "" || selTaskIds.length === 0}
            >
              批量联网复查
            </button>
            <button
              type="button"
              className="h6-btn-p h6-btn-s"
              onClick={() => run("confirm")}
              disabled={busy !== "" || selItems.length === 0}
            >
              批量处置（已选 {selItems.length}）
            </button>
          </div>
        </div>
        {backendDown ? <p className="h6-anno">后端未连接，队列数据暂不可用</p> : null}
        <section className="h6-trust" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>
          <div className="t">
            <b className="warn">{platform?.reviewPendingIssues ?? "—"}</b>
            <span>待处置问题</span>
          </div>
          <div className="t">
            <b>{ev?.weakCitations ?? "—"}</b>
            <span>弱证据引用</span>
          </div>
          <div className="t">
            <b>{ev?.docRefPending ?? "—"}</b>
            <span>政策文号无出处</span>
          </div>
          <div className="t">
            <b>{deadLinks}</b>
            <span>失效链接未处置</span>
          </div>
          <div className="t">
            <b>{platform ? platform.reviewDecided.confirm + platform.reviewDecided.dismiss : "—"}</b>
            <span>
              累计已处置（确认 {platform?.reviewDecided.confirm ?? 0} / 驳回 {platform?.reviewDecided.dismiss ?? 0}）
            </span>
          </div>
        </section>
        <div className="h6-queue">
          <aside className="h6-card h6-qside">
            <div className="h6-card-h">
              <h2>问题类型</h2>
            </div>
            <div className="h6-card-b h6-stack">
              <button
                type="button"
                className={`h6-qfilter${typeFilter === "all" ? " on" : ""}`}
                onClick={() => setTypeFilter("all")}
              >
                全部 <b>{platform?.reviewPendingIssues ?? 0}</b>
              </button>
              {typeCounts.map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  className={`h6-qfilter${typeFilter === t ? " on" : ""}`}
                  onClick={() => setTypeFilter(t)}
                >
                  {t} <b>{n}</b>
                </button>
              ))}
            </div>
            <div className="h6-card-h">
              <h2>处置状态</h2>
            </div>
            <div className="h6-card-b h6-stack">
              <button
                type="button"
                className={`h6-qfilter${statusFilter === "pending" ? " on" : ""}`}
                onClick={() => setStatusFilter("pending")}
              >
                待处置 <b>{platform?.reviewPendingIssues ?? 0}</b>
              </button>
              <button
                type="button"
                className={`h6-qfilter${statusFilter === "confirm" ? " on" : ""}`}
                onClick={() => setStatusFilter("confirm")}
              >
                已确认 <b>{platform?.reviewDecided.confirm ?? 0}</b>
              </button>
              <button
                type="button"
                className={`h6-qfilter${statusFilter === "dismiss" ? " on" : ""}`}
                onClick={() => setStatusFilter("dismiss")}
              >
                已驳回 <b>{platform?.reviewDecided.dismiss ?? 0}</b>
              </button>
            </div>
            <div className="h6-card-h">
              <h2>视图</h2>
            </div>
            <div className="h6-card-b h6-stack">
              <button
                type="button"
                className={`h6-qfilter${viewMode === "type" ? " on" : ""}`}
                onClick={() => setViewMode("type")}
                title="同类问题跨任务聚合（默认）"
              >
                按类型聚合
              </button>
              <button
                type="button"
                className={`h6-qfilter${viewMode === "task" ? " on" : ""}`}
                onClick={() => setViewMode("task")}
                title="按任务分组，一次看全一个任务的全部待处置问题"
              >
                按任务分组
              </button>
              <button
                type="button"
                className={`h6-qfilter${viewMode === "time" ? " on" : ""}`}
                onClick={() => setViewMode("time")}
                title="按任务更新时间倒序平铺"
              >
                按时间倒序
              </button>
            </div>
          </aside>
          <section className="h6-qlist">
            {statusFilter === "pending" ? (viewMode === "type" ? shown.map((g) => {
              const k = keyOf(g);
              const tasks = [...new Set(g.items.map((i) => i.taskTitle))];
              return (
                <div key={k} className={`h6-card h6-qrow${sel.includes(k) ? " h6-selcard" : ""}`}>
                  <input
                    type="checkbox"
                    className="h6-cbox"
                    checked={sel.includes(k)}
                    onChange={() => toggle(k)}
                    aria-label={`选择 ${g.description}`}
                  />
                  <span className={`h6-tag ${typeTag(g.issueType)}`}>{g.issueType}</span>
                  <div className="h6-qmain">
                    <b>{g.description}</b>
                    <span className="h6-anno">
                      {tasks.slice(0, 2).join("、")}
                      {tasks.length > 2 ? ` 等 ${tasks.length - 2} 个任务` : ""}
                    </span>
                  </div>
                  <span className="h6-badge acc">×{g.items.length}</span>
                  <button
                    type="button"
                    className="h6-btn-g h6-btn-s"
                    onClick={() => onOpenTask(g.items[0]?.taskId ?? "")}
                  >
                    前往任务
                  </button>
                </div>
              );
            }) : viewMode === "task" ? (
              taskGroups.map(([tid, items]) => (
                <div key={tid} className="h6-card">
                  <div className="h6-card-h">
                    <h2>{items[0]?.taskTitle ?? tid}</h2>
                    <span className="h6-meta">{items.length} 项</span>
                  </div>
                  <div className="h6-card-b h6-stack">
                    {items.map((i, idx) => itemView(i, `${tid}-${i.issueId}-${idx}`))}
                  </div>
                </div>
              ))
            ) : (
              timeRows.map((i, idx) => itemView(i, `${i.issueId}-${idx}`))
            )
            ) : decidedRows.map((d) => (
              <div key={`${d.taskId}-${d.decidedAt}`} className="h6-card h6-qrow">
                <span className={`h6-tag ${d.decision === "confirm" ? "ok" : "bad"}`}>
                  {d.decision === "confirm" ? "已确认" : "已驳回"}
                </span>
                <span className="h6-tag warn">{d.issueType}</span>
                <div className="h6-qmain">
                  <b>{d.description}</b>
                  <span className="h6-anno">
                    {d.taskTitle} · {relTime(d.decidedAt)}
                    {d.comment ? ` · 意见：${d.comment}` : ""}
                  </span>
                </div>
              </div>
            ))}
            {statusFilter === "pending" && shown.length === 0 ? (
              <div className="h6-card h6-empty">没有待处置问题，复核闭环无缺口</div>
            ) : null}
            {statusFilter !== "pending" && decidedRows.length === 0 ? (
              <div className="h6-card h6-empty">该状态下没有处置记录</div>
            ) : null}
          </section>
          <aside className="h6-card h6-qpanel">
            <div className="h6-card-h">
              <h2>处置面板</h2>
              <span className="h6-meta">已选 {selItems.length} 项</span>
            </div>
            <div className="h6-card-b h6-stack">
              <textarea
                className="h6-ta"
                rows={4}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="复核意见（批量处置共用，写入各任务复核记录）"
              />
              <div className="h6-qacts">
                <button
                  type="button"
                  className="h6-btn-p h6-btn-s"
                  onClick={() => run("confirm")}
                  disabled={busy !== "" || selItems.length === 0}
                >
                  {busy === "confirm" ? "处置中…" : "批量确认"}
                </button>
                <button
                  type="button"
                  className="h6-btn-g h6-btn-s"
                  onClick={() => run("dismiss")}
                  disabled={busy !== "" || selItems.length === 0}
                >
                  {busy === "dismiss" ? "处置中…" : "批量驳回"}
                </button>
                <button
                  type="button"
                  className="h6-btn-g h6-btn-s"
                  onClick={refCheck}
                  disabled={busy !== "" || selTaskIds.length === 0}
                >
                  批量联网复查
                </button>
              </div>
              {msg ? (
                <p className="h6-anno" aria-live="polite">
                  {msg}
                </p>
              ) : null}
              <p className="h6-anno">
                同类问题跨任务聚合一次处置，各任务分别留复核记录与事件留痕；已声明「仅作背景参考」的不计入此处。
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
