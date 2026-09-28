import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { AgentInfo, FileInfo, PlatformStats, TaskInfo } from "./types.ts";
import { IconRail, Sidebar } from "./components/Sidebar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { AgentOverview } from "./components/AgentOverview.tsx";
import { NewTaskPanel } from "./components/NewTaskPanel.tsx";
import { TaskWorkbench } from "./components/TaskWorkbench.tsx";
import { IconAlert } from "./components/Icons.tsx";

type WbTab = "timeline" | "result" | "compare" | "review";

interface Route {
  agentId?: string;
  taskId?: string;
  tab?: WbTab;
}

const TABS: WbTab[] = ["timeline", "result", "compare", "review"];

function parseHash(): Route {
  const m = /^#\/agent\/([a-z-]+)(?:\/task\/([\w-]+))?(?:\/tab\/(\w+))?$/.exec(window.location.hash);
  if (!m) return {};
  const tab = TABS.includes(m[3] as WbTab) ? (m[3] as WbTab) : undefined;
  return { agentId: m[1], taskId: m[2], tab };
}

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<{ task: TaskInfo; files: FileInfo[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [platform, setPlatform] = useState<PlatformStats | null>(null);
  const [wbTab, setWbTab] = useState<WbTab>("timeline");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const applyingHash = useRef(false);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
      setBackendDown(false);
    } catch (err) {
      setBackendDown(true);
      setError(err instanceof Error ? err.message : "无法连接后端服务");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.listAgents();
        setAgents(list);
        setActiveAgentId((prev) => prev ?? list[0]?.id ?? null);
        setBackendDown(false);
      } catch (err) {
        setBackendDown(true);
        setError(err instanceof Error ? err.message : "无法连接后端服务");
      }
    })();
    void refreshTasks();
  }, [refreshTasks]);

  // 哈希路由：刷新/深链恢复智能体、任务与页签
  useEffect(() => {
    const apply = () => {
      const route = parseHash();
      applyingHash.current = true;
      if (route.agentId) setActiveAgentId(route.agentId);
      if (route.taskId !== undefined) setActiveTaskId(route.taskId || null);
      if (route.tab) setWbTab(route.tab);
      window.setTimeout(() => {
        applyingHash.current = false;
      }, 0);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  // 状态 → 哈希（replaceState 不触发 hashchange）
  useEffect(() => {
    if (applyingHash.current) return;
    const target = activeTaskId
      ? `#/agent/${activeAgentId ?? "rd-audit"}/task/${activeTaskId}/tab/${wbTab}`
      : activeAgentId
        ? `#/agent/${activeAgentId}`
        : "#/";
    if (window.location.hash !== target) window.history.replaceState(null, "", target);
  }, [activeAgentId, activeTaskId, wbTab]);

  // 深链进入时按任务归属纠正智能体选择
  useEffect(() => {
    if (!activeTaskId || tasks.length === 0) return;
    const task = tasks.find((t) => t.id === activeTaskId);
    if (task && task.agentId !== activeAgentId) setActiveAgentId(task.agentId);
  }, [activeTaskId, tasks, activeAgentId]);

  // 平台应用效果看板：挂载与周期刷新
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .getStats()
        .then((s) => {
          if (!cancelled) setPlatform(s);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 任务详情加载 + 运行期间轮询，保证状态与结果以持久化数据为准
  useEffect(() => {
    if (!activeTaskId) {
      setTaskDetail(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await api.getTask(activeTaskId);
        if (!cancelled) setTaskDetail({ task: detail.task, files: detail.files });
      } catch {
        /* 保留上一次结果 */
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTaskId]);

  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? null;

  // 任务终态后刷新历史列表，保证侧栏状态与持久化状态一致
  useEffect(() => {
    const status = taskDetail?.task.status;
    if (status === "completed" || status === "failed") void refreshTasks();
  }, [taskDetail?.task.status, refreshTasks]);

  const visibleTasks = tasks.filter((t) => !activeAgentId || t.agentId === activeAgentId);

  const handleCreate = async (input: { instruction: string; caseId: string; title: string; files: File[] }) => {
    if (!activeAgentId) return;
    setCreating(true);
    setError(null);
    try {
      const task = await api.createTask({
        agentId: activeAgentId,
        caseId: input.caseId,
        ...(input.title ? { title: input.title } : {}),
        instruction: input.instruction,
      });
      if (input.files.length > 0) await api.uploadFiles(task.id, input.files);
      await api.runTask(task.id, input.instruction);
      await refreshTasks();
      setActiveTaskId(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "任务创建失败");
    } finally {
      setCreating(false);
    }
  };

  const handleRerun = async () => {
    if (!activeTaskId || !taskDetail) return;
    try {
      await api.runTask(activeTaskId, taskDetail.task.instruction);
      await refreshTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新执行失败");
    }
  };

  return (
    <ErrorBoundary>
      <div className="flex h-full">
      <IconRail
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onNewTask={() => setActiveTaskId(null)}
        onRefresh={() => void refreshTasks()}
      />
      <Sidebar
        agents={agents}
        activeAgentId={activeAgentId}
        activeTaskId={activeTaskId}
        tasks={visibleTasks}
        open={sidebarOpen}
        onSelectAgent={(id) => {
          setActiveAgentId(id);
          setActiveTaskId(null);
        }}
        onSelectTask={(id) => setActiveTaskId(id)}
        onNewTask={() => setActiveTaskId(null)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-night-900">
        {backendDown && (
          <div className="flex items-center gap-2 border-b border-amber-400/40 bg-amber-400/10 px-8 py-2.5 text-[12.5px] text-amber-300">
            <IconAlert className="h-4 w-4 shrink-0" />
            无法连接后端服务。请在项目根目录执行 <code className="mx-1 rounded bg-night-800 px-1.5 py-0.5 font-mono">pnpm dev</code>
            启动 API 与前端。
          </div>
        )}

        {activeTaskId && taskDetail && activeAgent ? (
          <TaskWorkbench
            agent={activeAgent}
            task={taskDetail.task}
            files={taskDetail.files}
            tab={wbTab}
            onTabChange={setWbTab}
            onRerun={handleRerun}
          />
        ) : activeAgent ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AgentOverview
              agents={agents}
              activeAgentId={activeAgent.id}
              stats={{
                tasks: visibleTasks.length,
                completed: visibleTasks.filter((t) => t.status === "completed").length,
                platform,
              }}
              breakdown={{
                processing: visibleTasks.filter((t) => t.status === "processing").length,
                waiting_review: visibleTasks.filter((t) => t.status === "waiting_review").length,
                completed: visibleTasks.filter((t) => t.status === "completed").length,
                failed: visibleTasks.filter((t) => t.status === "failed").length,
              }}
              onSelect={(id) => {
                setActiveAgentId(id);
                setActiveTaskId(null);
              }}
            />
            <NewTaskPanel agent={activeAgent} busy={creating} error={error} onSubmit={handleCreate} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-mist-600">正在加载智能体配置…</div>
        )}

        <footer className="no-print flex shrink-0 items-center justify-between border-t border-line bg-night-950 px-6 py-1.5 text-[10.5px]">
          <span className="font-medium tracking-[0.16em] text-glow-400/80">税务智能审查平台 · TAX AI NATIVE</span>
          <span className="text-mist-600">Pi Agent SDK · Fastify · React · SSE 实时事件流</span>
        </footer>
      </main>
      </div>
    </ErrorBoundary>
  );
}
