import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, PlatformStats } from "../types.ts";
import { IconBuilding, IconCheck, IconExternal, IconFile, IconFlask, IconTool } from "./Icons.tsx";

/** 大数字 odometer：每位数字独立滚轮到目标值，对齐参考片数据页质感。 */
const DESC_KEYWORDS = ["整数分", "行级", "记录级", "OCR", "mermaid", "联网"];

const RING_C = 2 * Math.PI * 12;

/** 智能体描述中的能力关键词高亮。 */
function renderDesc(text: string) {
  const re = new RegExp(`(${DESC_KEYWORDS.join("|")})`, "g");
  return text.split(re).map((part, i) =>
    DESC_KEYWORDS.includes(part) ? (
      <mark key={i} className="rounded bg-glow-500/15 px-0.5 text-glow-300">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Odometer({ value }: { value: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setOn(true), 60);
    return () => window.clearTimeout(t);
  }, []);
  const text = value.toLocaleString("zh-CN");
  return (
    <span className="stat-hero inline-flex">
      {text.split("").map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} className="inline-block h-[1em] overflow-hidden">
            <span
              className="flex flex-col transition-transform duration-700 ease-out"
              style={{ transform: `translateY(-${on ? Number(ch) : 0}em)` }}
            >
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d} className="block h-[1em] leading-[1em]">
                  {d}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} className="inline-block">
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

interface Props {
  agents: AgentInfo[];
  activeAgentId: string;
  stats: { tasks: number; completed: number; platform: PlatformStats | null };
  breakdown: { processing: number; waiting_review: number; completed: number; failed: number };
  createdAts: string[];
  recent: Array<{
    id: string;
    title: string;
    status: string;
    at: string;
    runCount?: number;
    agentId: string;
  }>;
  lastAt: Record<string, string>;
  perAgentCreatedAts: Record<string, string[]>;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
  onShowAll: () => void;
  /** 批量把「已完成但仍有未复核问题」的任务改回待复核，返回成功数量 */
  onBatchReopen?: (ids: string[]) => Promise<number>;
}

export function AgentOverview({
  agents,
  activeAgentId,
  stats,
  breakdown,
  createdAts,
  recent,
  onSelect,
  onOpenTask,
  onShowAll,
  onBatchReopen,
  lastAt,
  perAgentCreatedAts,
}: Props) {
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;
  const p = stats.platform;
  // 复核缺口按作品分组：跨作品时一眼看出各自欠账
  const backlogByAgent = useMemo(() => {
    const m = new Map<string, PlatformStats["reviewBacklog"]>();
    for (const b of p?.reviewBacklog ?? []) {
      const list = m.get(b.agentId);
      if (list) list.push(b);
      else m.set(b.agentId, [b]);
    }
    return [...m.entries()].sort((a, b2) => b2[1].length - a[1].length);
  }, [p?.reviewBacklog]);
  // 证据缺口按作品分组：弱证据引用与待复查文号，点击直达结果页处理
  const gapByAgent = useMemo(() => {
    const m = new Map<string, PlatformStats["evidence"]["gaps"]>();
    for (const g of p?.evidence?.gaps ?? []) {
      const list = m.get(g.agentId);
      if (list) list.push(g);
      else m.set(g.agentId, [g]);
    }
    return [...m.entries()].sort((a, b2) => b2[1].length - a[1].length);
  }, [p?.evidence]);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.shortName ?? id;
  // 缺口任务自身的未复核项合计（与「全平台待复核合计」不同：后者还包含待复核态任务）
  const backlogPending = (p?.reviewBacklog ?? []).reduce((s, b) => s + b.pending, 0);
  const heroValue = p?.tasks ?? stats.tasks;
  const bars = [
    { label: "已完成", value: breakdown.completed },
    { label: "执行中", value: breakdown.processing },
    { label: "待复核", value: breakdown.waiting_review },
    { label: "已中断", value: breakdown.failed },
  ];
  const barMax = Math.max(1, ...bars.map((b) => b.value));
  // 近 14 天任务创建分布（按本地日桶）
  const days = useMemo(() => {
    const buckets = Array.from({ length: 14 }, () => 0);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    for (const c of createdAts) {
      const d = new Date(c);
      const diff = Math.floor((today - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
      if (diff >= 0 && diff < 14) buckets[13 - diff] = (buckets[13 - diff] ?? 0) + 1;
    }
    return buckets;
  }, [createdAts]);
  const dayMax = Math.max(1, ...days);
  const dayAvg = days.reduce((a, b) => a + b, 0) / 14;
  const runDays = useMemo(() => {
    if (createdAts.length === 0) return 0;
    const first = Math.min(...createdAts.map((c) => Date.parse(c)));
    return Math.floor((Date.now() - first) / 86400000) + 1;
  }, [createdAts]);
  const sparkPts = days.map((v, i) => `${((i / 13) * 100).toFixed(2)},${(28 - (v / dayMax) * 24).toFixed(2)}`).join(" ");
  const weekNow = days.slice(7).reduce((a, b) => a + b, 0);
  const weekPrev = days.slice(0, 7).reduce((a, b) => a + b, 0);
  const weekDelta = weekNow - weekPrev;
  const [sparkHover, setSparkHover] = useState<number | null>(null);
  const [toolSort, setToolSort] = useState(false);
  const [capsOpen, setCapsOpen] = useState(false);
  const [weekDeltas, setWeekDeltas] = useState<Record<string, number>>({});
  // 批量「转为待复核」的两步确认：armed / busy 记的是范围标签（全平台或某个作品）
  const [batchArmed, setBatchArmed] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState("");
  const [batchMsg, setBatchMsg] = useState("");
  const armBatch = (label: string, ids: string[]) => {
    if (batchBusy !== "" || !onBatchReopen || ids.length === 0) return;
    if (batchArmed !== label) {
      setBatchArmed(label);
      setBatchMsg("");
      window.setTimeout(() => setBatchArmed((v) => (v === label ? null : v)), 3000);
      return;
    }
    setBatchArmed(null);
    setBatchBusy(label);
    void onBatchReopen(ids)
      .then((n) => setBatchMsg(`${label}：已把 ${n} 个任务转为待复核，状态事件已留痕`))
      .catch(() => setBatchMsg(`${label}：批量转换失败，请到各任务复核页逐个处理`))
      .finally(() => setBatchBusy(""));
  };

  // 平台指标周环比：每日快照入 localStorage，与 7 天前（或最近可得）快照对比
  useEffect(() => {
    if (!p) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const snap = JSON.parse(localStorage.getItem("taxai-stats-snapshots") ?? "{}") as Record<
        string,
        { tasks: number; completed: number; artifacts: number }
      >;
      snap[today] = { tasks: p.tasks, completed: p.completed, artifacts: p.artifacts };
      const keys = Object.keys(snap).sort();
      if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete snap[k];
      localStorage.setItem("taxai-stats-snapshots", JSON.stringify(snap));
      const d = new Date();
      d.setDate(d.getDate() - 7);
      const target = d.toISOString().slice(0, 10);
      const prevKey = snap[target] ? target : [...Object.keys(snap).filter((k) => k <= target)].sort().pop();
      const prev = prevKey ? snap[prevKey] : undefined;
      setWeekDeltas(
        prev
          ? { tasks: p.tasks - prev.tasks, completed: p.completed - prev.completed, artifacts: p.artifacts - prev.artifacts }
          : {},
      );
    } catch {
      /* 忽略存储不可用 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.tasks, p?.completed, p?.artifacts]);

  const deltaBadge = (k: string) => {
    const v = weekDeltas[k];
    if (v === undefined || v === 0) return null;
    return (
      <span className={`ml-1 text-[10px] ${v > 0 ? "text-jade-400" : "text-rose-300"}`} title="较 7 天前快照">
        {v > 0 ? `▲${v}` : `▼${Math.abs(v)}`}
      </span>
    );
  };
  const sparkDate = (idx: number) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - idx));
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const perTool = p?.perTool ?? [];
  const toolCount = (name: string) => perTool.find((t) => t.name === name)?.calls ?? 0;

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 平台看板快照导出（MD 表格 / JSON 原始）
  const exportStats = (fmt: "json" | "md") => {
    if (!p) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === "json") {
      downloadBlob(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }), `platform-stats-${stamp}.json`);
      return;
    }
    const rate = p.toolCalls > 0 ? Math.round((p.toolOk / p.toolCalls) * 10000) / 100 : "—";
    const lines = [
      "# 平台应用效果快照",
      "",
      `- 日期：${stamp}`,
      `- 累计任务：${p.tasks}（已完成 ${p.completed}）`,
      `- 工具调用：${p.toolCalls} 次 · 成功 ${p.toolOk} · 成功率 ${rate}%`,
      `- 底稿产物：${p.artifacts} 份`,
      `- 记录级比对准确率：最近一次 ${p.compareAccuracy ?? "—"}%（共 ${p.compareRuns} 次，按调用时间取最新）· 累计 ${
        p.compareAccuracyOverall ?? "—"
      }%（一致 ${p.compareMatched} / 比对 ${p.compareCompared}）`,
      `- OCR 平均置信度：${p.ocrAvgConfidence ?? "—"}%（${p.ocrRuns} 次）`,
      `- 复核闭环：待复核问题合计 ${p.reviewPendingIssues} 项；已完成但仍有未复核问题的任务 ${p.reviewBacklog.length} 个`,
      ...(p.reviewBacklog.length > 0
        ? [
            "",
            "| 任务 | 智能体 | 未复核 |",
            "| --- | --- | --- |",
            ...p.reviewBacklog.map((b) => `| ${b.title} | ${b.agentId} | ${b.pending} |`),
          ]
        : []),
      "",
      "| 智能体 | 任务 | 已完成 | 工具调用 | 成功 | 产物 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...p.perAgent.map((a) => `| ${a.agentId} | ${a.tasks} | ${a.completed} | ${a.toolCalls} | ${a.toolOk} | ${a.artifacts} |`),
      "",
      "| 工具 | 调用 | 成功 |",
      "| --- | --- | --- |",
      ...p.perTool.map((t) => `| ${t.name} | ${t.calls} | ${t.ok} |`),
    ];
    downloadBlob(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }), `platform-stats-${stamp}.md`);
  };

  // 概览全量快照：hero/状态分布/14 天桶/perAgent/perTool
  const exportOverview = () => {
    const lines = [
      `# 平台概览快照 · ${agent.shortName}`,
      "",
      `- 累计审查任务：${heroValue}（日均 ${dayAvg.toFixed(1)} 件 · 今日 ${days[13] ?? 0} 件）`,
      `- 周环比：${weekDelta > 0 ? `+${weekDelta}` : weekDelta}（本周 ${weekNow} / 上周 ${weekPrev}）`,
      `- 状态分布：${bars.map((b) => `${b.label} ${b.value}`).join(" / ")}`,
      `- 近 14 天日桶：${days.join(", ")}`,
      "",
      "| 智能体 | 任务 | 已完成 | 完成率 |",
      "| --- | --- | --- | --- |",
      ...(p?.perAgent ?? []).map((pa) => {
        const rate = pa.tasks > 0 ? Math.round((pa.completed / pa.tasks) * 100) : 0;
        return `| ${pa.agentId} | ${pa.tasks} | ${pa.completed} | ${rate}% |`;
      }),
      "",
      "| 工具 | 调用 | 成功 |",
      "| --- | --- | --- |",
      ...perTool.map((t) => `| ${t.name} | ${t.calls} | ${t.ok} |`),
      "",
      `- 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    ];
    downloadBlob(
      new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }),
      `概览快照-${new Date().toISOString().slice(0, 10)}.md`,
    );
  };

  const exportOverviewJson = () => {
    downloadBlob(
      new Blob(
        [
          JSON.stringify(
            {
              agent: agent.id,
              hero: heroValue,
              week: { now: weekNow, prev: weekPrev, delta: weekDelta },
              statusBars: bars,
              days14: days,
              perAgent: p?.perAgent ?? [],
              perTool,
              review: {
                pendingIssues: p?.reviewPendingIssues ?? 0,
                backlog: p?.reviewBacklog ?? [],
              },
              exportedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      `概览快照-${new Date().toISOString().slice(0, 10)}.json`,
    );
  };

  // 核心指标复制为 TSV，便于粘贴进表格软件
  const copyTsv = () => {
    if (!p) return;
    const rate = p.toolCalls > 0 ? Math.round((p.toolOk / p.toolCalls) * 10000) / 100 : "—";
    const lines = [
      "指标\t数值",
      `累计任务\t${p.tasks}`,
      `已完成\t${p.completed}`,
      `工具成功率\t${rate}%`,
      `底稿产物\t${p.artifacts}`,
      `记录级比对准确率（最近一次）\t${p.compareAccuracy ?? "—"}%`,
      `记录级比对准确率（累计）\t${p.compareAccuracyOverall ?? "—"}%`,
      `记录级比对项合计\t${p.compareCompared}`,
      `记录级比对一致项\t${p.compareMatched}`,
      `OCR 平均置信度\t${p.ocrAvgConfidence ?? "—"}%`,
      `待复核问题合计\t${p.reviewPendingIssues}`,
      `完成但未复核任务\t${p.reviewBacklog.length}`,
    ];
    void navigator.clipboard?.writeText(lines.join("\n")).catch(() => undefined);
  };

  // 键盘 ←/→ 切换作品（输入框内不触发）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (agents.length < 2) return;
      const idx = agents.findIndex((a) => a.id === activeAgentId);
      const next = e.key === "ArrowRight" ? Math.min(agents.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (next !== idx && next >= 0) onSelect(agents[next]!.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [agents, activeAgentId, onSelect]);
  const chips = [
    {
      label:
        p && p.toolCalls > 0
          ? `工具成功率 ${String(Math.round((p.toolOk / p.toolCalls) * 10000) / 100)}%`
          : `业务工具 ${agent.tools.length} 个`,
    },
    { label: p ? `底稿产物 ${p.artifacts} 份` : `核心能力 ${agent.capabilities.length} 项` },
    { label: p && p.compareAccuracy !== null ? `比对准确率 ${p.compareAccuracy}%` : `历史任务 ${stats.tasks} 个` },
  ];

  return (
    <section key={agent.id} className="starfield rise-in relative border-b border-line">
      <div className="px-8 pb-6 pt-7">
        <div className="kicker flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: agent.accent }} />
          Tax AI Native · {agent.id}
        </div>
        <div className="mt-3 flex items-start gap-4">
          <span
            className="glow-card flex h-12 w-12 shrink-0 items-center justify-center text-glow-300"
            style={{ boxShadow: `0 0 0 2px ${agent.accent}66, 0 10px 34px rgba(2, 8, 20, 0.55)` }}
          >
            <Icon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold leading-snug tracking-tight text-mist-100">
              {agent.shortName}
              <span className="ml-2 text-glow-300">让每一笔涉税判断都有据可查</span>
            </h1>
            <p className="mt-2 max-w-3xl text-[13px] leading-6 text-mist-500">{renderDesc(agent.description)}</p>
          </div>
        </div>

        <div className="mt-7 grid gap-8 lg:grid-cols-[300px_1fr]">
          <div>
            <Odometer value={heroValue} />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">
              累计审查任务
              <span className="ml-2 text-[11px] font-normal text-mist-600">逐条 OCR · 行级定位</span>
              {runDays > 0 && (
                <span className="ml-2 rounded-full border border-line bg-night-850 px-2 py-0.5 text-[10px] font-normal text-mist-500">
                  平台运行 · 第 {runDays} 天
                </span>
              )}
              {weekDelta !== 0 && (
                <span className={`ml-2 text-[11px] font-normal ${weekDelta > 0 ? "text-jade-400" : "text-rose-300"}`}>
                  {weekDelta > 0 ? "▲" : "▼"} 较上周 {weekDelta > 0 ? `+${weekDelta}` : weekDelta}
                </span>
              )}
            </div>
            <div className="mt-3 inline-flex flex-wrap items-center rounded-full border border-glow-500/35 bg-glow-500/10 px-3 py-1 text-[11px] text-glow-300">
              {chips.map((c, i) => (
                <span key={c.label} className="flex items-center">
                  {i > 0 && <span className="mx-2 text-glow-500/60">·</span>}
                  {c.label}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="kicker flex items-center justify-between">
              <span>任务状态分布 · 件数</span>
              <span>共 {stats.tasks} 件</span>
            </div>
            <ul className="mt-3 space-y-2.5">
              {bars.map((b) => (
                <li key={b.label} className="grid grid-cols-[56px_1fr_36px] items-center gap-3">
                  <span className="text-[11.5px] text-mist-500">{b.label}</span>
                  <span className="bar-track">
                    <span className="bar-fill block" style={{ width: `${(b.value / barMax) * 100}%` }} />
                  </span>
                  <span className="text-right font-mono text-[11.5px] text-mist-300">{b.value}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <div className="kicker flex items-center justify-between">
                <span>任务创建趋势 · 近 14 天</span>
                <span>
                  {sparkHover !== null
                    ? `${sparkDate(sparkHover)} · ${days[sparkHover] ?? 0} 件`
                    : `日均 ${dayAvg.toFixed(1)} 件 · 今日 ${days[13] ?? 0} 件`}
                </span>
              </div>
              <svg
                viewBox="0 0 100 30"
                preserveAspectRatio="none"
                className="mt-2 h-10 w-full"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientX - rect.left) / rect.width;
                  setSparkHover(Math.max(0, Math.min(13, Math.round(ratio * 13))));
                }}
                onMouseLeave={() => setSparkHover(null)}
              >
                <polygon points={`0,30 ${sparkPts} 100,30`} fill="rgba(34, 211, 238, 0.12)" />
                <line
                  x1="50"
                  y1="0"
                  x2="50"
                  y2="30"
                  stroke="rgba(230, 237, 247, 0.18)"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
                <polyline
                  points={sparkPts}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1="0"
                  y1={28 - (dayAvg / dayMax) * 24}
                  x2="100"
                  y2={28 - (dayAvg / dayMax) * 24}
                  stroke="rgba(230, 237, 247, 0.25)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
                {sparkHover !== null && (
                  <line
                    x1={(sparkHover / 13) * 100}
                    y1="0"
                    x2={(sparkHover / 13) * 100}
                    y2="30"
                    stroke="rgba(230, 237, 247, 0.4)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
              <div className="mt-3 grid grid-cols-[52px_1fr_40px] items-center gap-x-3 gap-y-1.5">
                <span className="text-[11px] text-mist-500">本周</span>
                <span className="bar-track">
                  <span
                    className="bar-fill block"
                    style={{ width: `${(weekNow / Math.max(1, weekNow, weekPrev)) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-[11px] text-mist-300">
                  {weekNow}
                  {weekDelta !== 0 && (
                    <span className={`ml-1 ${weekDelta > 0 ? "text-jade-400" : "text-rose-300"}`} title="本周较上周增量">
                      {weekDelta > 0 ? `+${weekDelta}` : weekDelta}
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-mist-500">上周</span>
                <span className="bar-track">
                  <span
                    className="bar-fill block opacity-60"
                    style={{ width: `${(weekPrev / Math.max(1, weekNow, weekPrev)) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-[11px] text-mist-300">{weekPrev}</span>
              </div>
            </div>
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <span className="kicker">最近活动</span>
                <button type="button" className="action-btn" onClick={onShowAll} title="展开侧栏查看全部任务">
                  查看全部
                </button>
              </div>
              <ul className="mt-2 space-y-1">
                {recent.length === 0 && <li className="px-1.5 text-[11.5px] text-mist-600">暂无任务</li>}
                {recent.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onOpenTask(r.id)}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          window.open(
                            `${window.location.pathname}#/agent/${activeAgentId}/task/${r.id}/tab/result`,
                            "_blank",
                          );
                        }
                      }}
                      title={r.title}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-night-800"
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RECENT_DOT[r.status] ?? "bg-mist-600"}`} />
                      {(() => {
                        const RIcon = r.agentId === "rd-audit" ? IconFlask : IconBuilding;
                        return <RIcon className="h-3 w-3 shrink-0 text-glow-400" />;
                      })()}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-mist-300">{r.title}</span>
                      {(r.runCount ?? 1) > 1 && (
                        <span className="shrink-0 font-mono text-[9.5px] text-glow-300" title="运行次数（含续跑）">
                          ↻{r.runCount}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-mist-600">{RECENT_TEXT[r.status] ?? r.status}</span>
                      <span className="shrink-0 text-[10.5px] text-mist-600">{relTime(r.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {stats.platform && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <span className="kicker">平台应用效果 · 实时运行数据</span>
              <span className="no-print flex gap-1.5">
                <button type="button" className="action-btn" onClick={() => exportStats("md")} title="导出 Markdown 快照">
                  导出 MD
                </button>
                <button type="button" className="action-btn" onClick={() => exportStats("json")} title="导出 JSON 原始数据">
                  导出 JSON
                </button>
                <button type="button" className="action-btn" onClick={exportOverview} title="导出概览全量快照 MD">
                  导出概览
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={exportOverviewJson}
                  title="导出概览快照 JSON（机器可读）"
                >
                  概览 JSON
                </button>
                <button type="button" className="action-btn" onClick={copyTsv} title="复制核心指标为 TSV">
                  复制表格
                </button>
              </span>
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              {[
                { label: "累计任务", key: "tasks", value: stats.platform.tasks.toLocaleString("zh-CN"), unit: "个", desc: "全平台已创建任务总数（含未完成）" },
                { label: "已完成", key: "completed", value: stats.platform.completed.toLocaleString("zh-CN"), unit: "个", desc: "状态为 completed 的任务数" },
                {
                  label: "工具成功率",
                  desc: "tool_calls 中 ok=1 的占比",
                  value:
                    stats.platform.toolCalls > 0
                      ? String(Math.round((stats.platform.toolOk / stats.platform.toolCalls) * 10000) / 100)
                      : "—",
                  unit: "%",
                },
                { label: "底稿产物", key: "artifacts", value: stats.platform.artifacts.toLocaleString("zh-CN"), unit: "份", desc: "各任务 outputs 目录文件计数" },
                {
                  label: "记录级比对准确率",
                  desc: `最近一次记录级比对的准确率（共 ${stats.platform.compareRuns} 次，按调用时间取最新${
                    stats.platform.compareLatestAt ? `：${stats.platform.compareLatestAt}` : ""
                  }）；累计口径为全部记录级比对的 一致项/比对项 合计 = ${stats.platform.compareMatched}/${
                    stats.platform.compareCompared
                  }`,
                  value: stats.platform.compareAccuracy !== null ? String(stats.platform.compareAccuracy) : "—",
                  unit:
                    stats.platform.compareAccuracyOverall !== null
                      ? `% · 累计 ${stats.platform.compareAccuracyOverall}%`
                      : "%",
                },
                {
                  label: "OCR 平均置信度",
                  desc: "parse_uploaded_files 各文档 tesseract 置信度均值",
                  value:
                    stats.platform.ocrAvgConfidence !== null ? String(stats.platform.ocrAvgConfidence) : "—",
                  unit: stats.platform.ocrRuns > 0 ? `%·${stats.platform.ocrRuns}次` : "%",
                },
              ].map((kpi) => (
                <div key={kpi.label} className="glow-card px-4 py-3" title={kpi.desc}>
                  <div className="text-[11px] text-mist-600">{kpi.label}</div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-[22px] font-semibold tracking-tight text-jade-400">{kpi.value}</span>
                    {kpi.key ? deltaBadge(kpi.key) : null}
                    <span className="text-[11px] text-mist-600">{kpi.unit}</span>
                  </div>
                </div>
              ))}
            </div>
            {stats.platform.reviewBacklog.length > 0 ? (
              <div className="mt-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-amber-200">
                  <span className="font-medium">全平台复核闭环缺口</span>
                  <span className="text-[11.5px] text-amber-200/85">
                    {stats.platform.reviewBacklog.length} 个已完成任务仍有 {backlogPending} 项问题未复核（全平台待复核合计 {stats.platform.reviewPendingIssues} 项）
                    {backlogByAgent.length > 1 && `（${backlogByAgent.map(([id, l]) => `${agentName(id)} ${l.length}`).join(" / ")}）`}
                  </span>
                  <span className="text-[11px] text-mist-500">点击任务前往复核页逐项处理</span>
                  {onBatchReopen && (
                    <button
                      type="button"
                      className="action-btn ml-auto !text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={batchBusy !== ""}
                      title="把下列已完成但仍有未复核问题的任务批量改回待复核状态，每个任务都会写入状态事件留痕"
                      onClick={() => {
                        armBatch("全平台", (stats.platform?.reviewBacklog ?? []).map((b) => b.id));
                      }}
                    >
                      {batchBusy === "全平台"
                        ? "处理中…"
                        : batchArmed === "全平台"
                          ? `再点一次确认（${stats.platform.reviewBacklog.length} 个）`
                          : "批量转为待复核"}
                    </button>
                  )}
                </div>
                {batchMsg && <div className="mt-1 text-[11px] text-jade-300">{batchMsg}</div>}
                <div className="mt-1.5 space-y-1">
                  {backlogByAgent.map(([agentId, list]) => {
                    const label = agentName(agentId);
                    return (
                    <div key={agentId} className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="w-[72px] shrink-0 truncate text-[10.5px] text-mist-500"
                        title={`${label}：${list.length} 个任务，合计 ${list.reduce(
                          (s, b) => s + b.pending,
                          0,
                        )} 项未复核`}
                      >
                        {label}
                      </span>
                      {list.slice(0, 6).map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          className="action-btn !text-[11px]"
                          onClick={() => onOpenTask(b.id)}
                          title={`${b.title}（${agentName(agentId)}，${b.pending} 项未复核）`}
                        >
                          {b.title.length > 16 ? `${b.title.slice(0, 16)}…` : b.title} · {b.pending}
                        </button>
                      ))}
                      {list.length > 6 && (
                        <span className="self-center text-[10.5px] text-mist-500">等 {list.length} 个</span>
                      )}
                      {onBatchReopen && (
                        <button
                          type="button"
                          className="action-btn ml-auto !text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={batchBusy !== ""}
                          title={`只把「${label}」的 ${list.length} 个已完成任务改回待复核（两步确认，逐个写入状态事件）`}
                          onClick={() => armBatch(label, list.map((b) => b.id))}
                        >
                          {batchBusy === label
                            ? "处理中…"
                            : batchArmed === label
                              ? "再点确认"
                              : `转该组 ${list.length}`}
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-jade-400/30 bg-jade-400/5 px-3 py-2 text-[11.5px] text-jade-300">
                全平台复核闭环无缺口：没有「已完成但仍有未复核问题」的任务（待复核态任务尚有 {stats.platform.reviewPendingIssues} 项在处理中）
              </div>
            )}
            {p?.evidence &&
              (p.evidence.gaps.length > 0 ? (
                <div className="mt-3 rounded-md border border-sky-400/35 bg-sky-400/5 px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-sky-200">
                    <span className="font-medium">全平台证据缺口</span>
                    <span className="text-[11.5px] text-sky-200/85">
                      {p.evidence.gaps.length} 个任务有弱证据引用或待复查文号：证据力弱 {p.evidence.weakCitations} 条 ·
                      政策文号待复查 {p.evidence.docRefPending} 处（已复查到公开出处 {p.evidence.docRefMatched} 处）·
                      联网检索拦下 {p.evidence.searchDropped + p.evidence.searchDroppedReplay} 条无关结果与门户首页
                      {p.evidence.searchDropped === 0 && p.evidence.searchDroppedReplay > 0
                        ? "（历史记录按现行相关度规则回算）"
                        : ""}
                      {gapByAgent.length > 1 &&
                        `（${gapByAgent.map(([id, l]) => `${agentName(id)} ${l.length}`).join(" / ")}）`}
                    </span>
                    <span className="text-[11px] text-mist-500">
                      点击任务前往结果页：引用胶囊看证据力分级，文号徽章可一键联网复查
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {gapByAgent.map(([agentId, list]) => (
                      <div key={agentId} className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="w-[72px] shrink-0 truncate text-[10.5px] text-mist-500"
                          title={`${agentName(agentId)}：${list.length} 个任务，弱证据引用 ${list.reduce(
                            (s, g) => s + g.weakCitations,
                            0,
                          )} 条 · 待复查文号 ${list.reduce((s, g) => s + g.docRefPending, 0)} 处`}
                        >
                          {agentName(agentId)}
                        </span>
                        {list.slice(0, 6).map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            className="action-btn !text-[11px]"
                            onClick={() => onOpenTask(g.id)}
                            title={`${g.title}（${agentName(agentId)}）：证据力弱引用 ${g.weakCitations} 条 · 待复查文号 ${g.docRefPending} 处`}
                          >
                            {g.title.length > 16 ? `${g.title.slice(0, 16)}…` : g.title}
                            {g.weakCitations > 0 ? ` · 弱${g.weakCitations}` : ""}
                            {g.docRefPending > 0 ? ` · 文号${g.docRefPending}` : ""}
                          </button>
                        ))}
                        {list.length > 6 && (
                          <span className="self-center text-[10.5px] text-mist-500">等 {list.length} 个</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-md border border-jade-400/30 bg-jade-400/5 px-3 py-2 text-[11.5px] text-jade-300">
                  全平台证据链无缺口：{p.evidence.citations} 条联网引用中没有门户首页或百科词条（官方原文{" "}
                  {p.evidence.officialCitations} 条），政策文号 {p.evidence.docRefs} 处全部有出处或已复查到公开出处；联网检索累计拦下{" "}
                  {p.evidence.searchDropped + p.evidence.searchDroppedReplay} 条无关结果与门户首页
                </div>
              ))}
            {stats.platform.perAgent.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {stats.platform.perAgent.map((pa) => {
                  const rate = pa.tasks > 0 ? Math.round((pa.completed / pa.tasks) * 100) : 0;
                  const info = agents.find((a) => a.id === pa.agentId);
                  return (
                    <div key={pa.agentId} className="glow-card flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 truncate text-[12px] text-mist-300">{info?.shortName ?? pa.agentId}</span>
                      <span className="bar-track flex-1">
                        <span className="bar-fill block" style={{ width: `${rate}%` }} />
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[11px] ${rate >= 80 ? "text-jade-400" : "text-mist-500"}`}
                        title={`已完成 ${pa.completed}/${pa.tasks}`}
                      >
                        {rate}%
                      </span>
                      {(() => {
                        const b = buckets14(perAgentCreatedAts[pa.agentId] ?? []);
                        const mx = Math.max(1, ...b);
                        const pts = b
                          .map((v, i) => `${((i / 13) * 100).toFixed(2)},${(28 - (v / mx) * 24).toFixed(2)}`)
                          .join(" ");
                        return (
                          <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-5 w-14 shrink-0" aria-hidden>
                            <polyline
                              points={pts}
                              fill="none"
                              stroke="#22d3ee"
                              strokeWidth="2"
                              vectorEffect="non-scaling-stroke"
                            />
                          </svg>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {p && p.toolCalls > 0 && (
          <div className="mt-4 flex items-center gap-4">
            <svg viewBox="0 0 32 32" className="h-14 w-14 shrink-0" aria-hidden>
              <circle
                cx="16"
                cy="16"
                r="12"
                fill="none"
                stroke="#34d399"
                strokeWidth="5"
                strokeDasharray={`${(p.toolOk / p.toolCalls) * RING_C} ${RING_C}`}
                transform="rotate(-90 16 16)"
              />
              <circle
                cx="16"
                cy="16"
                r="12"
                fill="none"
                stroke="#fb7185"
                strokeWidth="5"
                strokeDasharray={`${((p.toolCalls - p.toolOk) / p.toolCalls) * RING_C} ${RING_C}`}
                strokeDashoffset={-(p.toolOk / p.toolCalls) * RING_C}
                transform="rotate(-90 16 16)"
              />
              <text x="16" y="18" textAnchor="middle" fill="#e6edf7" style={{ fontSize: 8.5, fontWeight: 600 }}>
                {Math.round((p.toolOk / p.toolCalls) * 100)}%
              </text>
            </svg>
            <div className="space-y-0.5 text-[11px] text-mist-500">
              <div>
                工具调用 <span className="font-mono text-mist-300">{p.toolCalls}</span> 次 · 成功率{" "}
                <span className="font-mono text-jade-400">{Math.round((p.toolOk / p.toolCalls) * 1000) / 10}%</span>
              </div>
              <div>
                成功 <span className="font-mono text-jade-400">{p.toolOk}</span> · 失败{" "}
                <span className="font-mono text-rose-300">{p.toolCalls - p.toolOk}</span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="kicker">核心业务能力</div>
            <ul className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {(capsOpen ? agent.capabilities : agent.capabilities.slice(0, 8)).map((c) => (
                <li key={c} className="flex items-start gap-2 text-[13px] text-mist-300">
                  {(() => {
                    const I = capIcon(c);
                    return <I className={`mt-1 h-3.5 w-3.5 shrink-0 ${I === IconCheck ? "text-jade-400" : "text-glow-400"}`} />;
                  })()}
                  {c}
                </li>
              ))}
            </ul>
            {agent.capabilities.length > 8 && (
              <button type="button" className="action-btn mt-1.5" onClick={() => setCapsOpen((v) => !v)}>
                {capsOpen ? "收起" : `展开全部 ${agent.capabilities.length} 项`}
              </button>
            )}
          </div>

          <div className="hidden lg:block">
            <div className="flex items-center gap-1.5 kicker">
              <IconTool className="h-3.5 w-3.5" />
              已注册工具
              <button
                type="button"
                className="action-btn ml-auto"
                data-on={toolSort}
                onClick={() => setToolSort((v) => !v)}
                title="按历史调用数排序"
              >
                按调用排序
              </button>
            </div>
            <ul className="mt-2.5 space-y-2">
              {(toolSort
                ? [...agent.tools].sort((a, b) => toolCount(b.name) - toolCount(a.name))
                : agent.tools
              ).map((tool) => (
                <li key={tool.name} className="glow-card px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[11.5px] text-glow-300">{tool.name}</span>
                    {toolCount(tool.name) > 0 && (
                      <span
                        className="ml-auto shrink-0 rounded border border-glow-500/35 bg-glow-500/10 px-1.5 py-0.5 font-mono text-[10px] text-glow-300"
                        title={`历史调用 ${toolCount(tool.name)} 次`}
                      >
                        {toolCount(tool.name)} 次
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12px] text-mist-500">{tool.label}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {agents.length > 1 && (
        <div className="flex items-center gap-2 border-t border-line px-8 py-2.5">
          <span className="text-[12px] text-mist-600">切换作品（←/→）：</span>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                a.id === activeAgentId
                  ? "border-glow-500 bg-night-700 text-glow-300"
                  : "border-line bg-night-850 text-mist-500 hover:border-glow-500 hover:text-mist-100"
              }`}
              >
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: a.accent }} />
                {a.shortName}
                {lastAt[a.id] && <span className="ml-1 text-[10px] opacity-70">{relTime(lastAt[a.id]!)}</span>}
              </button>
          ))}
        </div>
      )}
    </section>
  );
}
const RECENT_DOT: Record<string, string> = {
  processing: "bg-amber-400",
  waiting_review: "bg-sky-400",
  completed: "bg-jade-400",
  failed: "bg-rose-400",
  created: "bg-mist-600",
};

const RECENT_TEXT: Record<string, string> = {
  processing: "执行中",
  waiting_review: "待复核",
  completed: "已完成",
  failed: "已中断",
  created: "待执行",
};

function relTime(iso: string): string {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 近 14 天日桶计数（按智能体子集复用）。 */
function buckets14(dates: string[]): number[] {
  const buckets = Array.from({ length: 14 }, () => 0);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  for (const c of dates) {
    const d = new Date(c);
    const diff = Math.floor((today - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff >= 0 && diff < 14) buckets[13 - diff] = (buckets[13 - diff] ?? 0) + 1;
  }
  return buckets;
}

/** 能力清单按关键词分类配图标 */
function capIcon(c: string) {
  if (/测算|计算|整数|限额|填列/.test(c)) return IconTool;
  if (/检索|联网|核验|政策/.test(c)) return IconExternal;
  if (/底稿|导出|文档|报告|版式/.test(c)) return IconFile;
  return IconCheck;
}
