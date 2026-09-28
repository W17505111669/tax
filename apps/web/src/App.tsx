import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { AgentInfo, FileInfo, TaskInfo } from "./types.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { AgentOverview } from "./components/AgentOverview.tsx";
import { NewTaskPanel } from "./components/NewTaskPanel.tsx";
import { TaskWorkbench } from "./components/TaskWorkbench.tsx";
import { IconAlert } from "./components/Icons.tsx";

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<{ task: TaskInfo; files: FileInfo[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendDown, setBackendDown] = useState(false);

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
    <div className="flex h-full">
      <Sidebar
        agents={agents}
        activeAgentId={activeAgentId}
        activeTaskId={activeTaskId}
        tasks={visibleTasks}
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
          <TaskWorkbench agent={activeAgent} task={taskDetail.task} files={taskDetail.files} onRerun={handleRerun} />
        ) : activeAgent ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AgentOverview
              agents={agents}
              activeAgentId={activeAgent.id}
              stats={{
                tasks: visibleTasks.length,
                completed: visibleTasks.filter((t) => t.status === "completed").length,
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
      </main>
    </div>
  );
}
