import { useEffect, useRef, useState } from "react";
import type { AgentInfo, TaskInfo } from "../types.ts";
import { IconBuilding, IconFlask, IconPanel, IconPlus, IconRefresh } from "./Icons.tsx";

interface Props {
  agents: AgentInfo[];
  activeAgentId: string | null;
  activeTaskId: string | null;
  tasks: TaskInfo[];
  open: boolean;
  onSelectAgent: (id: string) => void;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
}

const STATUS_TEXT: Record<string, string> = {
  created: "待执行",
  processing: "执行中",
  waiting_review: "待复核",
  completed: "已完成",
  failed: "已中断",
};

const STATUS_DOT: Record<string, string> = {
  created: "bg-mist-600",
  processing: "bg-amber-400 animate-pulse",
  waiting_review: "bg-sky-400",
  completed: "bg-jade-400",
  failed: "bg-rose-400",
};

type StatusFilter = "all" | "processing" | "waiting_review" | "completed" | "failed";

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "processing", label: "执行中" },
  { id: "waiting_review", label: "待复核" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "已中断" },
];

export function IconRail({
  sidebarOpen,
  onToggleSidebar,
  onNewTask,
  onRefresh,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewTask: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="icon-rail no-print flex w-[46px] shrink-0 flex-col items-center gap-1.5 py-3">
      <div
        className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-[10px] bg-night-950/45 text-[14px] font-bold text-white"
        title="税务智能审查平台"
      >
        税
      </div>
      <button
        type="button"
        className="rail-btn"
        data-on={sidebarOpen}
        onClick={onToggleSidebar}
        title={sidebarOpen ? "收起会话侧栏" : "展开会话侧栏"}
      >
        <IconPanel className="h-4 w-4" />
      </button>
      <button type="button" className="rail-btn" onClick={onNewTask} title="新建任务">
        <IconPlus className="h-4 w-4" />
      </button>
      <button type="button" className="rail-btn" onClick={onRefresh} title="刷新任务列表">
        <IconRefresh className="h-4 w-4" />
      </button>
      <div className="mt-auto flex flex-col items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-jade-400" title="后端服务已连接" />
        <span className="text-[9px] font-semibold tracking-[0.08em] text-white/70">v1</span>
      </div>
    </div>
  );
}

export function Sidebar({
  agents,
  activeAgentId,
  activeTaskId,
  tasks,
  open,
  onSelectAgent,
  onSelectTask,
  onNewTask,
}: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+K 聚焦任务搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = tasks.filter(
    (t) =>
      (statusFilter === "all" || t.status === statusFilter) &&
      (q === "" || t.title.toLowerCase().includes(q) || (t.instruction ?? "").toLowerCase().includes(q)),
  );
  if (!open) return null;
  return (
    <aside className="no-print relative flex w-[268px] shrink-0 flex-col border-r border-line bg-night-950 text-mist-300">
      <div className="rail-gradient absolute inset-y-0 left-0 w-[3px]" aria-hidden />

      <div className="border-b border-line px-5 py-4">
        <div className="kicker">Tax AI Native</div>
        <div className="mt-1 text-[15px] font-semibold tracking-tight text-mist-100">税务智能审查平台</div>
        <div className="mt-0.5 text-[11px] text-mist-600">AI 赋能涉税专业服务 · 双智能体</div>
      </div>

      <nav className="px-3 py-3">
        <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-mist-600">智能体</div>
        {agents.map((agent) => {
          const active = agent.id === activeAgentId;
          const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent(agent.id)}
              className={`mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                active ? "bg-night-700 text-mist-100 glow-ring" : "text-mist-500 hover:bg-night-800 hover:text-mist-100"
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-night-700 text-glow-300">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{agent.shortName}</span>
                <span className="block truncate text-[11px] text-mist-600">{agent.tools.length} 个业务工具</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex items-center justify-between px-5 pb-2 pt-1">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-mist-600">任务历史</span>
        <button
          type="button"
          onClick={onNewTask}
          className="rounded border border-line px-1.5 py-0.5 text-[11px] text-glow-300 transition-colors hover:border-glow-500 hover:bg-night-800"
        >
          新建
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="mb-2 px-1">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务…（Ctrl+K）"
            className="w-full rounded-md border border-line bg-night-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none placeholder:text-mist-600 focus:glow-ring"
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`rounded border px-1.5 py-0.5 text-[10.5px] transition-colors ${
                  statusFilter === f.id
                    ? "border-glow-500 bg-night-700 text-glow-300"
                    : "border-line bg-night-850 text-mist-600 hover:text-mist-100"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {filtered.length === 0 && <div className="px-2 py-3 text-[12px] text-mist-600">无匹配任务</div>}
        {filtered.map((task) => {
          const active = task.id === activeTaskId;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelectTask(task.id)}
              className={`mb-1 block w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                active ? "bg-night-700 glow-ring" : "hover:bg-night-800"
              }`}
            >
              <span className={`block truncate text-[12.5px] ${active ? "text-mist-100" : "text-mist-300"}`}>
                {task.title}
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-[11px] text-mist-600">
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[task.status] ?? "bg-mist-600"}`} />
                <span>{STATUS_TEXT[task.status] ?? task.status}</span>
                <span className="truncate">· {new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-line px-5 py-3 text-[11px] text-mist-600">
        Pi Agent SDK · Fastify · React
      </div>
    </aside>
  );
}
