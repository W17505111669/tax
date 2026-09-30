import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { AgentInfo, FileInfo, PlatformStats, TaskInfo } from "./types.ts";
import { taskStatusLabel } from "./task-status.ts";
import { IconRail, Sidebar } from "./components/Sidebar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { AgentOverview } from "./components/AgentOverview.tsx";
import { NewTaskPanel } from "./components/NewTaskPanel.tsx";
import { TaskWorkbench } from "./components/TaskWorkbench.tsx";
import { IconAlert } from "./components/Icons.tsx";
import { partitionFiles, policyMessage, type UploadPolicy } from "./upload-policy.ts";

type WbTab = "timeline" | "result" | "compare" | "review";

interface Route {
  agentId?: string;
  taskId?: string;
  tab?: WbTab;
  sec?: number;
}

const TABS: WbTab[] = ["timeline", "result", "compare", "review"];

function parseHash(): Route {
  const m = /^#\/agent\/([a-z-]+)(?:\/task\/([\w-]+))?(?:\/tab\/(\w+))?(?:\/sec\/(\d+))?$/.exec(
    window.location.hash,
  );
  if (!m) return {};
  const tab = TABS.includes(m[3] as WbTab) ? (m[3] as WbTab) : undefined;
  return { agentId: m[1], taskId: m[2], tab, sec: m[4] ? Number(m[4]) : undefined };
}

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(() => sessionStorage.getItem("taxai-agent"));
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<{ task: TaskInfo; files: FileInfo[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [platform, setPlatform] = useState<PlatformStats | null>(null);
  const [wbTab, setWbTab] = useState<WbTab>("timeline");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [revealNonce, setRevealNonce] = useState(0);
  const [reviewNonce, setReviewNonce] = useState(0);
  const [secTarget, setSecTarget] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  // 上传策略取自服务端，新建任务的资料上传也在前端先预检一遍
  const [uploadPolicy, setUploadPolicy] = useState<UploadPolicy | null>(null);
  useEffect(() => {
    void api
      .uploadPolicy()
      .then(setUploadPolicy)
      .catch(() => undefined);
  }, []);
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
      if (route.sec !== undefined) setSecTarget(route.sec);
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

  // 记住上次选择的智能体，刷新后恢复
  useEffect(() => {
    if (activeAgentId) sessionStorage.setItem("taxai-agent", activeAgentId);
  }, [activeAgentId]);

  // 任务状态变化播报（屏幕阅读器）
  useEffect(() => {
    const s = taskDetail?.task.status;
    if (!s) return;
    // 读屏播报也要分清「服务重启打断」与「执行失败」：前者续跑就行，后者要查错误原因
    setAnnounce(`任务状态：${taskStatusLabel(s, taskDetail?.task.error)}`);
  }, [taskDetail?.task.status]);

  // 「?」键开关快捷键帮助浮层
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "?" || (e.ctrlKey && e.key === "/")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("taxai-toggle-help"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 深链进入时按任务归属纠正智能体选择
  useEffect(() => {
    if (!activeTaskId || tasks.length === 0) return;
    const task = tasks.find((t) => t.id === activeTaskId);
    if (task && task.agentId !== activeAgentId) setActiveAgentId(task.agentId);
  }, [activeTaskId, tasks, activeAgentId]);

  // 平台应用效果看板：挂载与周期刷新；批量操作后可立即刷新
  const refreshPlatform = useCallback(async () => {
    try {
      setPlatform(await api.getStats());
    } catch {
      // 看板拉取失败不打断主流程，下一轮周期刷新会重试
    }
  }, []);

  useEffect(() => {
    void refreshPlatform();
    const timer = setInterval(() => void refreshPlatform(), 15000);
    return () => clearInterval(timer);
  }, [refreshPlatform]);

  /** 概览页「批量转为待复核」：返回成功转换的任务数 */
  const handleBatchReopen = async (ids: string[]): Promise<number> => {
    const res = await api.reopenReviewBatch(ids);
    await Promise.all([refreshTasks(), refreshPlatform()]);
    if (res.total > 0) {
      // 展开侧栏并切到「复核」过滤，转换结果立刻可见
      setSidebarOpen(true);
      setReviewNonce((n) => n + 1);
    }
    return res.total;
  };

  /** 批量联网复查（政策文号 / 弱证据引用）：复查完刷新平台统计，证据缺口条的数字随之更新 */
  const handleBatchRefCheck = async (ids: string[], kinds: Array<"docref" | "citation">) => {
    const res = await api.batchRefChecks(ids, kinds);
    await refreshPlatform();
    return res;
  };

  /**
   * 跨任务批量处置同一类待复核问题：处置完刷新平台统计与任务列表
   *（待复核清零的任务会流转为已完成，两处都得跟着变）。
   */
  const handleBatchReview = async (
    items: Array<{ taskId: string; issueId: string }>,
    decision: "confirm" | "dismiss",
    comment: string,
  ): Promise<number> => {
    const res = await api.reviewBatch(items, decision, comment);
    await Promise.all([refreshTasks(), refreshPlatform()]);
    if (res.total > 0) setReviewNonce((n) => n + 1);
    return res.total;
  };

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

  // 浏览器标题随路由更新，多标签切换不迷路
  useEffect(() => {
    const base = "税务智能审查平台";
    document.title = taskDetail?.task
      ? `${taskDetail.task.title} · ${base}`
      : activeAgent
        ? `${activeAgent.shortName} · ${base}`
        : base;
  }, [taskDetail?.task.title, activeAgent]);

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
      if (input.files.length > 0) {
        const split = uploadPolicy
          ? partitionFiles(input.files, uploadPolicy)
          : { accepted: input.files, rejected: [] as Array<{ name: string; reason: string }> };
        const note = policyMessage(split.accepted.length, split.rejected);
        if (note) {
          setAnnounce(note);
          if (split.accepted.length === 0) setError(note);
        }
        if (split.accepted.length > 0) await api.uploadFiles(task.id, split.accepted);
      }
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
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
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
        revealNonce={revealNonce}
        reviewNonce={reviewNonce}
        onSelectAgent={(id) => {
          setActiveAgentId(id);
          setActiveTaskId(null);
        }}
        onSelectTask={(id) => setActiveTaskId(id)}
        onNewTask={() => setActiveTaskId(null)}
        onRerunTask={(id) => {
          const t = tasks.find((x) => x.id === id);
          if (!t) return;
          void api
            .runTask(id, t.instruction ?? "")
            .then(() => refreshTasks())
            .catch(() => setError("重新执行失败"));
        }}
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
            secInto={secTarget}
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
                // 服务重启打断的不算执行失败：那类续跑就行，混在一起会让看板上的「失败」虚高
                failed: visibleTasks.filter((t) => t.status === "failed" && !t.interrupted).length,
                interrupted: visibleTasks.filter((t) => t.status === "failed" && t.interrupted).length,
              }}
              createdAts={visibleTasks.map((t) => t.createdAt)}
              recent={[...visibleTasks]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 5)
                .map((t) => ({
                  id: t.id,
                  title: t.title,
                  status: t.status,
                  at: t.createdAt,
                  runCount: t.runCount,
                  agentId: t.agentId,
                  interrupted: t.interrupted,
                }))}
              onSelect={(id) => {
                setActiveAgentId(id);
                setActiveTaskId(null);
              }}
              onOpenTask={(id) => {
                // 概览里的复核缺口可能指向另一个作品的任务，跳转时一并切换智能体
                const t = tasks.find((x) => x.id === id);
                if (t) setActiveAgentId(t.agentId);
                setActiveTaskId(id);
              }}
              onBatchReopen={handleBatchReopen}
              onBatchReview={handleBatchReview}
              onBatchRefCheck={handleBatchRefCheck}
              perAgentCreatedAts={Object.fromEntries(
                agents.map((a) => [a.id, tasks.filter((t) => t.agentId === a.id).map((t) => t.createdAt)]),
              )}
              onShowAll={() => {
                setSidebarOpen(true);
                setRevealNonce((n) => n + 1);
              }}
              lastAt={Object.fromEntries(
                agents.map((a) => [
                  a.id,
                  tasks
                    .filter((t) => t.agentId === a.id)
                    .map((t) => t.createdAt)
                    .sort()
                    .pop() ?? "",
                ]),
              )}
            />
            <NewTaskPanel
              agent={activeAgent}
              busy={creating}
              error={error}
              onSubmit={handleCreate}
              uploadPolicy={uploadPolicy}
            />
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
