import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, TaskInfo } from "../types.ts";
import { IconBuilding, IconCopy, IconFlask, IconInfo, IconPanel, IconPlus, IconRefresh, IconX } from "./Icons.tsx";
import { loadTags, saveTags } from "../tags.ts";

interface Props {
  agents: AgentInfo[];
  activeAgentId: string | null;
  activeTaskId: string | null;
  tasks: TaskInfo[];
  open: boolean;
  revealNonce: number;
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

const GROUP_ORDER: Array<{ id: string; label: string }> = [
  { id: "processing", label: "执行中" },
  { id: "waiting_review", label: "待复核" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "已中断" },
  { id: "created", label: "待执行" },
];

function relTime(iso: string): string {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

const SIDEBAR_RING = 2 * Math.PI * 12;

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "processing", label: "执行中" },
  { id: "waiting_review", label: "待复核" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "已中断" },
];

// 搜索框支持状态关键字联合过滤（如输入「已完成」）
const STATUS_KEYWORDS: Record<string, string> = {
  已完成: "completed",
  执行中: "processing",
  待复核: "waiting_review",
  已中断: "failed",
  待执行: "created",
};

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
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const h = () => setHelpOpen((v) => !v);
    window.addEventListener("taxai-toggle-help", h);
    return () => window.removeEventListener("taxai-toggle-help", h);
  }, []);
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
      <div className="relative">
        <button
          type="button"
          className="rail-btn"
          data-on={helpOpen}
          onClick={() => setHelpOpen((v) => !v)}
          title="键盘快捷键"
        >
          <IconInfo className="h-4 w-4" />
        </button>
        {helpOpen && (
          <div className="absolute left-[42px] top-0 z-40 w-60 rounded-lg border border-line bg-night-900 p-3 shadow-2xl">
            <div className="kicker mb-2">键盘快捷键</div>
            <ul className="space-y-1.5 text-[11.5px] text-mist-300">
              {[
                { keys: "Ctrl+K", desc: "聚焦任务搜索" },
                { keys: "Ctrl+Enter", desc: "提交新任务" },
                { keys: "Esc", desc: "收起续跑面板 / 阅读器" },
                { keys: "↑ / ↓", desc: "选择比对差异行" },
                { keys: "Enter", desc: "阅读器双底稿定位" },
                { keys: "Alt+1~4", desc: "切换工作台页签" },
                { keys: "搜索框 ↑/↓+Enter", desc: "选择并打开任务" },
                { keys: "? / Ctrl+/", desc: "开关本帮助" },
              ].map((s) => (
                <li key={s.keys} className="flex items-center justify-between gap-2">
                  <span>{s.desc}</span>
                  <kbd className="rounded border border-line bg-night-800 px-1.5 py-0.5 font-mono text-[10.5px] text-glow-300">
                    {s.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
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
  revealNonce,
  onSelectAgent,
  onSelectTask,
  onNewTask,
}: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [starOnly, setStarOnly] = useState(false);
  const [weekOnly, setWeekOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [dragTag, setDragTag] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [tagNonce, setTagNonce] = useState(0);
  const tagsMap = useMemo(() => loadTags(), [tagNonce, tasks]);
  const allTags = [...new Set(Object.values(tagsMap).flat())];

  const mutateAllTags = (fn: (map: Record<string, string[]>) => Record<string, string[]>) => {
    saveTags(fn(loadTags()));
    setTagNonce((n) => n + 1);
  };

  const commitRename = (old: string) => {
    const nv = renameVal.trim();
    setRenaming(null);
    if (!nv || nv === old) return;
    mutateAllTags((map) => {
      for (const k of Object.keys(map)) map[k] = (map[k] ?? []).map((x) => (x === old ? nv : x));
      return map;
    });
  };
  const [sortTools, setSortTools] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("taxai-sidebar-groups") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem("taxai-sidebar-groups", JSON.stringify(collapsed));
  }, [collapsed]);

  // 「查看全部」时展开所有分组
  useEffect(() => {
    if (revealNonce > 0) setCollapsed({});
  }, [revealNonce]);

  // Ctrl+Shift+↑ 全折 / Ctrl+Shift+↓ 全展
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCollapsed(Object.fromEntries([...GROUP_ORDER.map((g) => [g.id, true]), ["starred", true]]));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCollapsed({});
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 收藏集合（与工作台星标共享 localStorage）
  const [starNonce, setStarNonce] = useState(0);
  const starred = useMemo(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("taxai-starred") ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  }, [tasks, starNonce]);

  // 手动排序（拖拽置顶），localStorage 持久化
  const [order, setOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("taxai-task-order") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const dragIdRef = useRef<string | null>(null);
  const sortByOrder = (list: TaskInfo[]) => {
    const idx = (id: string) => {
      const i = order.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...list].sort((a, b) => {
      const byOrder = idx(a.id) - idx(b.id);
      if (byOrder !== 0 && (order.indexOf(a.id) !== -1 || order.indexOf(b.id) !== -1)) return byOrder;
      if (sortTools) return (b.toolCount ?? 0) - (a.toolCount ?? 0);
      return b.createdAt.localeCompare(a.createdAt);
    });
  };

  // 导出当前过滤结果为 CSV（BOM + 转义，Excel 中文可直接打开）
  const exportCsv = () => {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["标题,状态,案例,创建时间,运行次数,工具次数,进度,标签,任务ID"];
    for (const t of filtered) {
      lines.push(
        [
          esc(t.title),
          esc(STATUS_TEXT[t.status] ?? t.status),
          esc(t.caseId),
          esc(new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false })),
          t.runCount ?? 1,
          t.toolCount ?? 0,
          t.progress ?? 0,
          esc((tagsMap[t.id] ?? []).join("|")),
          esc(t.id),
        ].join(","),
      );
    }
    const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `任务清单-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const dropOn = (targetId: string) => {
    const from = dragIdRef.current;
    dragIdRef.current = null;
    if (!from || from === targetId) return;
    const next = order.filter((id) => id !== from);
    const at = next.indexOf(targetId);
    next.splice(at === -1 ? next.length : at, 0, from);
    setOrder(next);
    localStorage.setItem("taxai-task-order", JSON.stringify(next));
  };

  // 标签芯片拖到任务行即打标签
  const addTagToTask = (taskId: string, tag: string) => {
    const map = loadTags();
    const arr = map[taskId] ?? [];
    if (!arr.includes(tag)) {
      map[taskId] = [...arr, tag];
      saveTags(map);
      setTagNonce((n) => n + 1);
    }
  };

  const renderTaskRow = (task: TaskInfo) => {
    const active = task.id === activeTaskId;
    const hl = (text: string) => {
      const qq = query.trim();
      if (!qq) return text;
      const esc = qq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const parts = text.split(new RegExp(`(${esc})`, "gi"));
      return parts.map((p, i) =>
        p.toLowerCase() === qq.toLowerCase() ? (
          <mark key={i} className="rounded-sm bg-amber-200/80 px-0.5 text-gray-900">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      );
    };
    return (
      <div
        key={task.id}
        draggable
        onDragStart={() => {
          dragIdRef.current = task.id;
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragEnter={(e) => {
          if (dragTag) {
            e.preventDefault();
            setDragOverId(task.id);
          }
        }}
        onDragLeave={() => setDragOverId((v) => (v === task.id ? null : v))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverId(null);
          setDragTag(null);
          const tag = e.dataTransfer.getData("text/tag");
          if (tag) {
            addTagToTask(task.id, tag);
            return;
          }
          dropOn(task.id);
        }}
        onDragEnd={() => {
          dragIdRef.current = null;
        }}
        title="拖拽可手动排序/置顶"
        className={`group relative mb-1 rounded-lg transition-colors ${
          active ? "bg-night-700 glow-ring" : "hover:bg-night-800"
        } ${task.id === cursorId ? "ring-1 ring-glow-500/60" : ""} ${
          dragOverId === task.id ? "ring-1 ring-glow-400" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => onSelectTask(task.id)}
          title={task.instruction ? `${task.title}\n${task.instruction.slice(0, 140)}` : task.title}
          className="block w-full rounded-lg px-2.5 py-2 pr-8 text-left"
        >
          <span className={`block truncate text-[12.5px] ${active ? "text-mist-100" : "text-mist-300"}`}>
            {starred.has(task.id) && <span className="mr-1 text-amber-300">★</span>}
            {hl(task.title)}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-mist-600">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[task.status] ?? "bg-mist-600"}`} />
           <span>{STATUS_TEXT[task.status] ?? task.status}</span>
            {q !== "" && (task.id.toLowerCase().includes(q) || task.caseId.toLowerCase().includes(q)) && (
              <span className="font-mono text-[9.5px] text-glow-300">{task.id.slice(0, 8)}</span>
            )}
           {(task.toolCount ?? 0) > 0 && <span className="shrink-0">· 工具 {task.toolCount}</span>}
            {(tagsMap[task.id] ?? []).slice(0, 3).map((t) => (
              <span key={t} className="shrink-0 rounded bg-glow-500/10 px-1 text-[9px] text-glow-300">
                #{t}
              </span>
            ))}
                        {(task.runCount ?? 1) > 1 && (
                          <span className="font-mono text-[9.5px] text-glow-300" title={`共 ${task.runCount} 次运行（含续跑）`}>
                            ↻{task.runCount}
                          </span>
                        )}
            <span className="truncate">
              · {new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}（{relTime(task.createdAt)}）
            </span>
          </span>
          {task.status === "processing" && (
            <span className="mt-1.5 flex items-center gap-1.5" title={`进度 ${(task.progress ?? 0)}/5`}>
              <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
                <svg viewBox="0 0 32 32" className="h-3.5 w-3.5">
                  <circle cx="16" cy="16" r="12" fill="none" stroke="#122036" strokeWidth="7" />
                  <circle
                    cx="16"
                    cy="16"
                    r="12"
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth="7"
                    strokeDasharray={`${((task.progress ?? 0) / 5) * SIDEBAR_RING} ${SIDEBAR_RING}`}
                    transform="rotate(-90 16 16)"
                  />
                </svg>
              </span>
              <span className="font-mono text-[9px] text-mist-600">{task.progress ?? 0}/5</span>
            </span>
          )}
        </button>
        <button
          type="button"
          title="复制任务 ID"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(task.id).catch(() => undefined);
          }}
          className="absolute right-1.5 top-2 rounded p-1 text-mist-600 opacity-0 transition-opacity hover:text-glow-300 group-hover:opacity-100"
        >
          <IconCopy className="h-3 w-3" />
        </button>
      </div>
    );
  };

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
  const kwStatus = STATUS_KEYWORDS[query.trim()];
  const filtered = tasks.filter(
    (t) =>
      (statusFilter === "all" || t.status === statusFilter) &&
      (!starOnly || starred.has(t.id)) &&
      (!weekOnly || Date.now() - Date.parse(t.createdAt) < 7 * 86400000) &&
      (!tagFilter || (tagsMap[t.id] ?? []).includes(tagFilter)) &&
      (q === "" ||
        t.title.toLowerCase().includes(q) ||
        (t.instruction ?? "").toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.caseId.toLowerCase().includes(q) ||
        kwStatus === t.status),
  );

  const [cursor, setCursor] = useState<number | null>(null);
  // 与渲染顺序一致的扁平可见列表（收藏组优先）
  const flatVisible = useMemo(() => {
    const star = sortByOrder(filtered.filter((t) => starred.has(t.id)));
    const groups = GROUP_ORDER.flatMap((g) =>
      sortByOrder(filtered.filter((t) => t.status === g.id && !starred.has(t.id))),
    );
    return [...star, ...groups];
  }, [filtered, starred, order, sortTools]);
  const cursorId = cursor !== null ? (flatVisible[cursor]?.id ?? null) : null;
  if (!open) return null;
  return (
    <aside className="no-print relative flex w-[268px] shrink-0 flex-col border-r border-line bg-night-950 text-mist-300">
      <div className="rail-gradient absolute inset-y-0 left-0 w-[3px]" aria-hidden />

      <div className="border-b border-line px-5 py-4">
        <div className="kicker">Tax AI Native</div>
        <div className="mt-1 text-[15px] font-semibold tracking-tight text-mist-100">税务智能审查平台</div>
        <div className="mt-0.5 text-[11px] text-mist-600">AI 赋能涉税专业服务 · 双智能体</div>
        <div className="mt-2 flex gap-1.5">
          <span className="rounded-full border border-line bg-night-850 px-2 py-0.5 text-[10px] text-mist-500">
            全部 {tasks.length}
          </span>
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-300">
            ★ {starred.size}
          </span>
        </div>
        <span
          className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-night-700"
          title={`已完成 ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`}
        >
          <span
            className="bar-fill block h-full"
            style={{
              width: `${tasks.length ? (tasks.filter((t) => t.status === "completed").length / tasks.length) * 100 : 0}%`,
            }}
          />
        </span>
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
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                style={{ background: `${agent.accent}2e`, color: agent.accent }}
              >
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
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="action-btn !px-1.5 !py-0.5 !text-[10px]"
            title="折叠全部分组"
            onClick={() =>
              setCollapsed(Object.fromEntries([...GROUP_ORDER.map((g) => [g.id, true]), ["starred", true]]))
            }
          >
            全折
          </button>
          <button
            type="button"
            className="action-btn !px-1.5 !py-0.5 !text-[10px]"
            title="展开全部分组"
            onClick={() => setCollapsed({})}
          >
            全展
          </button>
          <button
            type="button"
            className="action-btn !px-1.5 !py-0.5 !text-[10px]"
            title="导出当前过滤结果为 CSV"
            onClick={exportCsv}
          >
            导出
          </button>
          <button
            type="button"
            onClick={onNewTask}
            className="rounded border border-line px-1.5 py-0.5 text-[11px] text-glow-300 transition-colors hover:border-glow-500 hover:bg-night-800"
          >
            新建
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="relative mb-2 px-1">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => {
                  const base = c ?? -1;
                  const next = e.key === "ArrowDown" ? base + 1 : base - 1;
                  return Math.max(0, Math.min(flatVisible.length - 1, next));
                });
              } else if (e.key === "Enter") {
                const t = cursor !== null ? flatVisible[cursor] : undefined;
                if (t) onSelectTask(t.id);
              } else if (e.key === "Escape") {
                setCursor(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="搜索任务…（Ctrl+K）"
            className="w-full rounded-md border border-line bg-night-850 px-2.5 py-1.5 pr-7 text-[12px] text-mist-100 outline-none placeholder:text-mist-600 focus:glow-ring"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="清除搜索"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-mist-600 hover:text-mist-100"
            >
              <IconX className="h-3 w-3" />
            </button>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => {
              const count = f.id === "all" ? tasks.length : tasks.filter((t) => t.status === f.id).length;
              return (
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
                  <span className="ml-1 font-mono text-[9.5px] opacity-70">{count}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setStarOnly((v) => !v)}
              title="仅显示收藏任务"
              className={`rounded border px-1.5 py-0.5 text-[10.5px] transition-colors ${
                starOnly
                  ? "border-amber-400/50 bg-amber-400/10 text-amber-300"
                  : "border-line bg-night-850 text-mist-600 hover:text-mist-100"
              }`}
            >
              ★ 收藏
            </button>
            <button
              type="button"
              onClick={() => setWeekOnly((v) => !v)}
              title="仅显示近 7 天创建的任务"
              className={`rounded border px-1.5 py-0.5 text-[10.5px] transition-colors ${
                weekOnly
                  ? "border-glow-500 bg-night-700 text-glow-300"
                  : "border-line bg-night-850 text-mist-600 hover:text-mist-100"
              }`}
            >
              本周
            </button>
            <button
              type="button"
              className="action-btn !px-1.5 !py-0.5 !text-[10px]"
              onClick={() => setManaging((v) => !v)}
              title="标签管理（重命名/删除）"
            >
              管理
            </button>
          </div>
          {allTags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/tag", t);
                    setDragTag(t);
                  }}
                  onDragEnd={() => {
                    setDragTag(null);
                    setDragOverId(null);
                  }}
                  onClick={() => setTagFilter((v) => (v === t ? null : t))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTagFilter(null);
                  }}
                  className={`rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${
                    tagFilter === t
                      ? "border-glow-500 bg-glow-500/15 text-glow-300"
                      : "border-line bg-night-850 text-mist-600 hover:text-mist-100"
                  }`}
                >
                  #{t}
                  <span className="ml-1 opacity-70">
                    {Object.values(tagsMap).filter((arr) => arr.includes(t)).length}
                  </span>
                </button>
              ))}
            </div>
          )}
          {managing && allTags.length > 0 && (
            <div className="mt-1.5 space-y-1 rounded-md border border-line bg-night-850 p-2">
              {allTags.map((t) => (
                <div key={t} className="flex items-center gap-1.5">
                  {renaming === t ? (
                    <>
                      <input
                        autoFocus
                        value={renameVal}
                        onChange={(e) => setRenameVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(t);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-line bg-night-800 px-1.5 py-0.5 text-[10.5px] text-mist-100 outline-none focus:glow-ring"
                      />
                      <button
                        type="button"
                        className="action-btn !px-1.5 !py-0.5 !text-[10px]"
                        onClick={() => commitRename(t)}
                      >
                        确定
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-300">#{t}</span>
                      <button
                        type="button"
                        className="action-btn !px-1.5 !py-0.5 !text-[10px]"
                        onClick={() => {
                          setRenaming(t);
                          setRenameVal(t);
                        }}
                      >
                        重命名
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="action-btn !px-1.5 !py-0.5 !text-[10px] hover:!text-rose-300"
                    onClick={() =>
                      mutateAllTags((map) => {
                        for (const k of Object.keys(map)) map[k] = (map[k] ?? []).filter((x) => x !== t);
                        return map;
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {filtered.length === 0 && <div className="px-2 py-3 text-[12px] text-mist-600">无匹配任务</div>}
        {(() => {
          const starList = sortByOrder(filtered.filter((t) => starred.has(t.id)));
          if (starList.length === 0) return null;
          const closed = collapsed.starred ?? false;
          return (
            <div className="mb-1">
              <div className="group flex items-center">
                <button
                  type="button"
                  onClick={() => setCollapsed((prev) => ({ ...prev, starred: !closed }))}
                  className="flex flex-1 items-center gap-1.5 px-2 py-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-mist-600 transition-colors hover:text-mist-300"
                >
                  <span className={`chev text-[9px] ${closed ? "" : "rotate-90"}`}>▶</span>
                  <span className="text-amber-300">★</span>
                  收藏
                  <span className="ml-auto font-mono text-[10px]">{starList.length}</span>
                </button>
                <button
                  type="button"
                  title="导出收藏清单（复制 Markdown）"
                  onClick={() => {
                    const lines = starList.map(
                      (t) =>
                        `- ${t.title}（${STATUS_TEXT[t.status] ?? t.status} · ${new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false })}）`,
                    );
                    void navigator.clipboard?.writeText(`# 收藏清单\n${lines.join("\n")}`).catch(() => undefined);
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] text-mist-600 opacity-0 transition-opacity hover:text-glow-300 group-hover:opacity-100"
                >
                  导出
                </button>
                <button
                  type="button"
                  title="清空收藏"
                  onClick={() => {
                    localStorage.setItem("taxai-starred", "[]");
                    setStarNonce((n) => n + 1);
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] text-mist-600 opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
                >
                  清空
                </button>
              </div>
              {!closed && starList.map((task) => renderTaskRow(task))}
            </div>
          );
        })()}
        {GROUP_ORDER.map((g) => {
          const list = sortByOrder(filtered.filter((t) => t.status === g.id && !starred.has(t.id)));
          if (list.length === 0) return null;
          const closed = collapsed[g.id] ?? false;
          const toolSum = list.reduce((a, t) => a + (t.toolCount ?? 0), 0);
          return (
            <div key={g.id} className="mb-1">
              <button
                type="button"
                onClick={() => setCollapsed((prev) => ({ ...prev, [g.id]: !closed }))}
                title={
                  list.length
                    ? `最早 ${new Date(Math.min(...list.map((t) => Date.parse(t.createdAt)))).toLocaleString("zh-CN", {
                        hour12: false,
                      })} · 最晚 ${new Date(Math.max(...list.map((t) => Date.parse(t.createdAt)))).toLocaleString("zh-CN", { hour12: false })}`
                    : undefined
                }
                className="flex w-full items-center gap-1.5 px-2 py-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-mist-600 transition-colors hover:text-mist-300"
              >
                <span className={`chev text-[9px] ${closed ? "" : "rotate-90"}`}>▶</span>
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[g.id] ?? "bg-mist-600"}`} />
                {list.some((t) => t.status === "processing") && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" title="组内含运行中任务" />
                )}
                {g.label}
                <button
                  type="button"
                  className="ml-auto font-mono text-[10px] transition-colors hover:text-glow-300"
                  title={`组内任务 ${list.length} 件 · 工具调用合计 ${toolSum}（点击按工具数排序）`}
                  data-on={sortTools}
                  onClick={() => setSortTools((v) => !v)}
                >
                  {list.length}
                  <span className="ml-1 opacity-70">Σ{toolSum}</span>
                </button>
              </button>
              {!closed && list.map((task) => renderTaskRow(task))}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3 text-[11px] text-mist-600">
        <span>Pi Agent SDK · Fastify · React</span>
        {order.length > 0 && (
          <button
            type="button"
            className="action-btn"
            title="清除手动排序，恢复时间倒序"
            onClick={() => {
              setOrder([]);
              localStorage.removeItem("taxai-task-order");
            }}
          >
            复位排序
          </button>
        )}
      </div>
    </aside>
  );
}
