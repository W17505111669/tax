import type { AgentInfo } from "../types.ts";
import { IconBuilding, IconFlask, IconTool } from "./Icons.tsx";

interface Props {
  agents: AgentInfo[];
  activeAgentId: string;
  onSelect: (id: string) => void;
}

export function AgentOverview({ agents, activeAgentId, onSelect }: Props) {
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;

  return (
    <section className="border-b border-ink-200 bg-white">
      <div className="flex gap-6 px-8 py-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${agent.accent}1a`, color: agent.accent }}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[19px] font-semibold tracking-tight text-ink-900">{agent.displayName}</h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-500">
                <span>Agent Runtime：Pi Agent SDK</span>
                <span className="text-ink-300">|</span>
                <span>业务工具 {agent.tools.length} 个</span>
                <span className="text-ink-300">|</span>
                <span>内置编码工具已禁用</span>
              </div>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-[13.5px] leading-6 text-ink-600">{agent.description}</p>

          <div className="mt-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">核心业务能力</div>
            <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {agent.capabilities.map((c) => (
                <li key={c} className="flex items-start gap-2 text-[13px] text-ink-700">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: agent.accent }} />
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="hidden w-[300px] shrink-0 border-l border-ink-100 pl-6 lg:block">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">
            <IconTool className="h-3.5 w-3.5" />
            已注册工具
          </div>
          <ul className="mt-2.5 space-y-2">
            {agent.tools.map((tool) => (
              <li key={tool.name} className="rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2">
                <div className="font-mono text-[11.5px] text-ink-800">{tool.name}</div>
                <div className="mt-0.5 text-[12px] text-ink-500">{tool.label}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {agents.length > 1 && (
        <div className="flex items-center gap-2 border-t border-ink-100 px-8 py-2.5">
          <span className="text-[12px] text-ink-400">切换作品：</span>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                a.id === activeAgentId
                  ? "border-ink-300 bg-ink-100 text-ink-900"
                  : "border-ink-200 bg-white text-ink-500 hover:border-ink-300 hover:text-ink-800"
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
