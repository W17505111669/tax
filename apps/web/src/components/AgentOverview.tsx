import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, PlatformStats } from "../types.ts";
import { IconBuilding, IconCheck, IconFlask, IconTool } from "./Icons.tsx";

/** 大数字进入页面时从 0 缓动递增，对齐参考片数据页的计数质感。 */
function useCountUp(target: number, duration = 900): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

interface Props {
  agents: AgentInfo[];
  activeAgentId: string;
  stats: { tasks: number; completed: number; platform: PlatformStats | null };
  breakdown: { processing: number; waiting_review: number; completed: number; failed: number };
  createdAts: string[];
  onSelect: (id: string) => void;
}

export function AgentOverview({ agents, activeAgentId, stats, breakdown, createdAts, onSelect }: Props) {
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;
  const p = stats.platform;
  const heroValue = p?.tasks ?? stats.tasks;
  const heroShown = useCountUp(heroValue);
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
  const sparkPts = days.map((v, i) => `${((i / 13) * 100).toFixed(2)},${(28 - (v / dayMax) * 24).toFixed(2)}`).join(" ");
  const weekNow = days.slice(7).reduce((a, b) => a + b, 0);
  const weekPrev = days.slice(0, 7).reduce((a, b) => a + b, 0);
  const weekDelta = weekNow - weekPrev;
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
            <p className="mt-2 max-w-3xl text-[13px] leading-6 text-mist-500">{agent.description}</p>
          </div>
        </div>

        <div className="mt-7 grid gap-8 lg:grid-cols-[300px_1fr]">
          <div>
            <div className="stat-hero">{heroShown.toLocaleString("zh-CN")}</div>
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
                <span>今日 {days[13] ?? 0} 件</span>
              </div>
              <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-10 w-full" aria-hidden>
                <polygon points={`0,30 ${sparkPts} 100,30`} fill="rgba(34, 211, 238, 0.12)" />
                <polyline
                  points={sparkPts}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          </div>
        </div>

        {stats.platform && (
          <div className="mt-5">
            <div className="kicker">平台应用效果 · 实时运行数据</div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              {[
                { label: "累计任务", value: String(stats.platform.tasks), unit: "个" },
                { label: "已完成", value: String(stats.platform.completed), unit: "个" },
                {
                  label: "工具成功率",
                  value:
                    stats.platform.toolCalls > 0
                      ? String(Math.round((stats.platform.toolOk / stats.platform.toolCalls) * 10000) / 100)
                      : "—",
                  unit: "%",
                },
                { label: "底稿产物", value: String(stats.platform.artifacts), unit: "份" },
                {
                  label: "记录级比对准确率",
                  value: stats.platform.compareAccuracy !== null ? String(stats.platform.compareAccuracy) : "—",
                  unit: "%",
                },
                {
                  label: "OCR 平均置信度",
                  value:
                    stats.platform.ocrAvgConfidence !== null ? String(stats.platform.ocrAvgConfidence) : "—",
                  unit: stats.platform.ocrRuns > 0 ? `%·${stats.platform.ocrRuns}次` : "%",
                },
              ].map((kpi) => (
                <div key={kpi.label} className="glow-card px-4 py-3">
                  <div className="text-[11px] text-mist-600">{kpi.label}</div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-[22px] font-semibold tracking-tight text-jade-400">{kpi.value}</span>
                    <span className="text-[11px] text-mist-600">{kpi.unit}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="kicker">核心业务能力</div>
            <ul className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {agent.capabilities.map((c) => (
                <li key={c} className="flex items-start gap-2 text-[13px] text-mist-300">
                  <IconCheck className="mt-1 h-3.5 w-3.5 shrink-0 text-jade-400" />
                  {c}
                </li>
              ))}
            </ul>
          </div>

          <div className="hidden lg:block">
            <div className="flex items-center gap-1.5 kicker">
              <IconTool className="h-3.5 w-3.5" />
              已注册工具
            </div>
            <ul className="mt-2.5 space-y-2">
              {agent.tools.map((tool) => (
                <li key={tool.name} className="glow-card px-3 py-2">
                  <div className="font-mono text-[11.5px] text-glow-300">{tool.name}</div>
                  <div className="mt-0.5 text-[12px] text-mist-500">{tool.label}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {agents.length > 1 && (
        <div className="flex items-center gap-2 border-t border-line px-8 py-2.5">
          <span className="text-[12px] text-mist-600">切换作品：</span>
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
