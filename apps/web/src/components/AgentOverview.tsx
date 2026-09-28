import type { AgentInfo } from "../types.ts";
import { IconBuilding, IconCheck, IconFlask, IconTool } from "./Icons.tsx";

interface Props {
  agents: AgentInfo[];
  activeAgentId: string;
  stats: { tasks: number; completed: number };
  onSelect: (id: string) => void;
}

export function AgentOverview({ agents, activeAgentId, stats, onSelect }: Props) {
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;

  const kpis = [
    { label: "业务工具", value: String(agent.tools.length), unit: "个" },
    { label: "核心能力", value: String(agent.capabilities.length), unit: "项" },
    { label: "历史任务", value: String(stats.tasks), unit: "个" },
    { label: "已完成", value: String(stats.completed), unit: "个" },
  ];

  return (
    <section className="starfield relative border-b border-line">
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

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="glow-card px-4 py-3">
              <div className="text-[11px] text-mist-600">{kpi.label}</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-[26px] font-semibold tracking-tight text-glow-300">{kpi.value}</span>
                <span className="text-[11px] text-mist-600">{kpi.unit}</span>
              </div>
            </div>
          ))}
        </div>

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
