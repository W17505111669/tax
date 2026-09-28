import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, PlatformStats } from "../types.ts";
import { IconBuilding, IconCheck, IconExternal, IconFile, IconFlask, IconTool } from "./Icons.tsx";

/** 大数字 odometer：每位数字独立滚轮到目标值，对齐参考片数据页质感。 */
const DESC_KEYWORDS = ["整数分", "行级", "记录级", "OCR", "mermaid", "联网"];

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
  recent: Array<{ id: string; title: string; status: string; at: string; runCount?: number }>;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
  onShowAll: () => void;
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
}: Props) {
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;
  const p = stats.platform;
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
  const sparkPts = days.map((v, i) => `${((i / 13) * 100).toFixed(2)},${(28 - (v / dayMax) * 24).toFixed(2)}`).join(" ");
  const weekNow = days.slice(7).reduce((a, b) => a + b, 0);
  const weekPrev = days.slice(0, 7).reduce((a, b) => a + b, 0);
  const weekDelta = weekNow - weekPrev;
  const [sparkHover, setSparkHover] = useState<number | null>(null);
  const [toolSort, setToolSort] = useState(false);
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
      `- 记录级比对准确率：${p.compareAccuracy ?? "—"}%（${p.compareRuns} 次）`,
      `- OCR 平均置信度：${p.ocrAvgConfidence ?? "—"}%（${p.ocrRuns} 次）`,
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
      `记录级比对准确率\t${p.compareAccuracy ?? "—"}%`,
      `OCR 平均置信度\t${p.ocrAvgConfidence ?? "—"}%`,
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
        <div className="kicker">Tax AI Native · {agent.id}</div>
        <div className="mt-3 flex items-start gap-4">
          <span className="glow-card flex h-12 w-12 shrink-0 items-center justify-center text-glow-300">
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
              {weekDelta !== 0 && (
                <span className={`ml-2 text-[11px] font-normal ${weekDelta > 0 ? "text-jade-400" : "text-rose-300"}`}>
                  {weekDelta > 0 ? "▲" : "▼"} 较上周 {weekDelta > 0 ? `+${weekDelta}` : weekDelta}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <span
                  key={c.label}
                  className="rounded-full border border-glow-500/35 bg-glow-500/10 px-2.5 py-1 text-[11px] text-glow-300"
                >
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
                      title={r.title}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-night-800"
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RECENT_DOT[r.status] ?? "bg-mist-600"}`} />
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
                <button type="button" className="action-btn" onClick={copyTsv} title="复制核心指标为 TSV">
                  复制表格
                </button>
              </span>
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              {[
                { label: "累计任务", value: stats.platform.tasks.toLocaleString("zh-CN"), unit: "个", desc: "全平台已创建任务总数（含未完成）" },
                { label: "已完成", value: stats.platform.completed.toLocaleString("zh-CN"), unit: "个", desc: "状态为 completed 的任务数" },
                {
                  label: "工具成功率",
                  desc: "tool_calls 中 ok=1 的占比",
                  value:
                    stats.platform.toolCalls > 0
                      ? String(Math.round((stats.platform.toolOk / stats.platform.toolCalls) * 10000) / 100)
                      : "—",
                  unit: "%",
                },
                { label: "底稿产物", value: stats.platform.artifacts.toLocaleString("zh-CN"), unit: "份", desc: "各任务 outputs 目录文件计数" },
                {
                  label: "记录级比对准确率",
                  desc: "最近一次记录级 compare_workpapers 的准确率",
                  value: stats.platform.compareAccuracy !== null ? String(stats.platform.compareAccuracy) : "—",
                  unit: "%",
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
                    <span className="text-[11px] text-mist-600">{kpi.unit}</span>
                  </div>
                </div>
              ))}
            </div>
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="kicker">核心业务能力</div>
            <ul className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {agent.capabilities.map((c) => (
                <li key={c} className="flex items-start gap-2 text-[13px] text-mist-300">
                  {(() => {
                    const I = capIcon(c);
                    return <I className={`mt-1 h-3.5 w-3.5 shrink-0 ${I === IconCheck ? "text-jade-400" : "text-glow-400"}`} />;
                  })()}
                  {c}
                </li>
              ))}
            </ul>
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
              {a.shortName}
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

/** 能力清单按关键词分类配图标 */
function capIcon(c: string) {
  if (/测算|计算|整数|限额|填列/.test(c)) return IconTool;
  if (/检索|联网|核验|政策/.test(c)) return IconExternal;
  if (/底稿|导出|文档|报告|版式/.test(c)) return IconFile;
  return IconCheck;
}
