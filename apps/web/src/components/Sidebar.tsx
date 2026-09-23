import type { AgentInfo, TaskInfo } from "../types.ts";
import { IconBuilding, IconFlask } from "./Icons.tsx";

interface Props {
  agents: AgentInfo[];
  activeAgentId: string | null;
  activeTaskId: string | null;
  tasks: TaskInfo[];
  onSelectAgent: (id: string) => void;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
}

const STATUS_TEXT: Record<string, string> = {
  created: "待执行",
  processing: "执行中",
  waiting_review: "待复核",
  completed: "已完成",
  failed: "失败",
};

export function Sidebar({ agents, activeAgentId, activeTaskId, tasks, onSelectAgent, onSelectTask, onNewTask }: Props) {
  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-ink-800 bg-ink-900 text-ink-100">
      <div className="border-b border-ink-800 px-5 py-4">
        <div className="text-[15px] font-semibold tracking-tight text-white">税务智能审查平台</div>
        <div className="mt-0.5 text-[11px] text-ink-400">AI 赋能涉税专业服务</div>
      </div>

      <nav className="px-3 py-3">
        <div className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-ink-500">智能体</div>
        {agents.map((agent) => {
          const active = agent.id === activeAgentId;
          const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent(agent.id)}
              className={`mb-1 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
                active ? "bg-ink-800 text-white" : "text-ink-300 hover:bg-ink-800/60 hover:text-white"
              }`}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                style={{ backgroundColor: `${agent.accent}26`, color: agent.id === "rd-audit" ? "#5eead4" : "#fdba74" }}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{agent.shortName}</span>
                <span className="block truncate text-[11px] text-ink-500">{agent.tools.length} 个业务工具</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex items-center justify-between px-5 pb-2 pt-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-500">任务历史</span>
        <button
          type="button"
          onClick={onNewTask}
          className="rounded px-1.5 py-0.5 text-[11px] text-ink-300 hover:bg-ink-800 hover:text-white"
        >
          新建
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {tasks.length === 0 && <div className="px-2 py-3 text-[12px] text-ink-600">暂无任务</div>}
        {tasks.map((task) => {
          const active = task.id === activeTaskId;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelectTask(task.id)}
              className={`mb-1 block w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                active ? "bg-ink-800" : "hover:bg-ink-800/50"
              }`}
            >
              <span className={`block truncate text-[12.5px] ${active ? "text-white" : "text-ink-200"}`}>{task.title}</span>
              <span className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-500">
                <span
                  className={
                    task.status === "completed"
                      ? "text-emerald-400"
                      : task.status === "failed"
                        ? "text-rose-400"
                        : task.status === "processing"
                          ? "text-amber-400"
                          : "text-ink-500"
                  }
                >
                  {STATUS_TEXT[task.status] ?? task.status}
                </span>
                <span className="text-ink-700">·</span>
                <span className="truncate">{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-ink-800 px-5 py-3 text-[11px] text-ink-600">
        Pi Agent SDK · Fastify · React
      </div>
    </aside>
  );
}
