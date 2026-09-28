import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { api } from "../api.ts";
import type {
  AgentInfo,
  ArtifactInfo,
  CompareRecord,
  FileInfo,
  LinkCheck,
  ReviewRecord,
  TaskInfo,
  TaskIssue,
} from "../types.ts";
import { useTaskEvents } from "../hooks/useTaskEvents.ts";
import { MarkdownView, type Annotation } from "./MarkdownView.tsx";
import { readerKey, SideReader, type ReaderTarget } from "./SideReader.tsx";
import { loadTags, saveTags } from "../tags.ts";
import { matchToolCalls } from "../timeline-calls.ts";
import { artifactsOfRun, artifactTable, fmtBytes, runWindows, unattributedArtifacts } from "../run-artifacts.ts";
import { artifactSources } from "../artifact-sources.ts";
import { callStats, callsByRun, durationMs, fmtDuration, mdCell, summarizeArgs } from "../run-tools.ts";
import { amountKey, traceAmounts } from "../amount-trace.ts";
import { reviewSection } from "../review-export.ts";
import { deliveryCheck, deliverySection, type CheckInput, type CheckResult } from "../delivery-check.ts";
import { linkVerdict, summarizeLinkChecks, VERDICT_HINT, VERDICT_TEXT, type LinkSummary } from "../link-check.ts";
import { CompareView } from "./CompareView.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { ReviewView } from "./ReviewView.tsx";
import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFile,
  IconPanel,
  IconPlay,
  IconPrint,
  IconRefresh,
  IconSpinner,
  IconTool,
} from "./Icons.tsx";

interface Props {
  agent: AgentInfo;
  task: TaskInfo;
  files: FileInfo[];
  tab: "timeline" | "result" | "compare" | "review";
  onTabChange: (tab: "timeline" | "result" | "compare" | "review") => void;
  onRerun: () => void;
  secInto: number | null;
}

const SEARCH_TOOLS = new Set([
  "web_search",
  "search_public_cases",
  "fetch_content",
  "fetch_public_document",
  "get_search_content",
]);

const STATUS_META: Record<string, { label: string; className: string }> = {
  created: { label: "待执行", className: "border-line bg-night-800 text-mist-500" },
  processing: { label: "执行中", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  waiting_review: { label: "待复核", className: "border-sky-400/40 bg-sky-400/10 text-sky-300" },
  completed: { label: "已完成", className: "border-jade-400/40 bg-jade-400/10 text-jade-400" },
  failed: { label: "已中断", className: "border-rose-400/40 bg-rose-400/10 text-rose-300" },
};

interface Citation {
  title: string;
  url: string;
}

const STEP_RING = 2 * Math.PI * 12;

/** 去除 Markdown 语法，供纯文本复制使用 */
const DOMAIN_KEYWORDS = [
  "研发费用",
  "加计扣除",
  "土地增值税",
  "扣除项目",
  "核验",
  "比对",
  "底稿",
  "政策依据",
  "限额",
  "置信度",
  "OCR",
  "mermaid",
  "发票",
  "合同",
  "差异",
  "准确率",
];

function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[\w-]*\n?/g, "").replace(/```/g, ""))
    .replace(/^#{1,6} /gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*\| ?---.*$/gm, "")
    .replace(/\|/g, "  ")
    .replace(/^> /gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

export function TaskWorkbench({ agent, task, files, tab, onTabChange, onRerun, secInto }: Props) {
  const { timeline, toolCalls, status, connected, reconnect } = useTaskEvents(task.id);
  const [compares, setCompares] = useState<CompareRecord[]>([]);
  const [issues, setIssues] = useState<TaskIssue[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  // 「转为待复核」后的本地乐观标记，服务端状态由 App 轮询同步
  const [reopened, setReopened] = useState(false);
  // 已人工核对的金额（键 → 核对时间与备注），点击正文标注即可标记或撤销
  const [amountChecks, setAmountChecks] = useState<Record<string, { at: string; note: string }>>({});
  // 引用链接可达性核验（按需触发，不自动请求外网）
  const [linkChecks, setLinkChecks] = useState<Record<string, LinkCheck>>({});
  const [linkCheckedAt, setLinkCheckedAt] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [pendingReviews, setPendingReviews] = useState(0);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerTabs, setReaderTabs] = useState<ReaderTarget[]>([]);
  const [readerActive, setReaderActive] = useState(0);
  const [readerSplitReq, setReaderSplitReq] = useState<{ secondKey: string; nonce: number } | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeText, setResumeText] = useState("");
  const [resumeFiles, setResumeFiles] = useState<File[]>([]);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const [fs, setFs] = useState<"sm" | "md" | "lg">(() => {
    const v = localStorage.getItem("taxai-result-fs");
    return v === "sm" || v === "lg" ? v : "md";
  });
  const [autoFollow, setAutoFollow] = useState(true);

  useEffect(() => {
    localStorage.setItem("taxai-result-fs", fs);
  }, [fs]);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [metaCopied, setMetaCopied] = useState(false);
  const [tags, setTags] = useState<string[]>(() => loadTags()[task.id] ?? []);
  const [tagInput, setTagInput] = useState("");

  const mutateTags = (next: string[]) => {
    setTags(next);
    const map = loadTags();
    if (next.length === 0) delete map[task.id];
    else map[task.id] = next;
    saveTags(map);
  };
  const [starred, setStarred] = useState<boolean>(() => {
    try {
      return (JSON.parse(localStorage.getItem("taxai-starred") ?? "[]") as string[]).includes(task.id);
    } catch {
      return false;
    }
  });
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const liveStatus = status === "created" ? task.status : status;
  const meta = STATUS_META[liveStatus] ?? STATUS_META.created!;
  const running = liveStatus === "processing";

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(task.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const copyShare = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/agent/${agent.id}/task/${task.id}/tab/${tab}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const copyMeta = async () => {
    const lines = [
      `标题：${task.title}`,
      `任务 ID：${task.id}`,
      `智能体：${agent.shortName}${agent.model ? `（${agent.model}）` : ""}`,
      `案例：${task.caseId}`,
      `状态：${meta.label}`,
      `创建：${new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}`,
      `更新：${new Date(task.updatedAt).toLocaleString("zh-CN", { hour12: false })}`,
      `工具调用：${toolCalls.length} 次`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setMetaCopied(true);
      window.setTimeout(() => setMetaCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const toggleStar = () => {
    const next = !starred;
    setStarred(next);
    try {
      const list = new Set(JSON.parse(localStorage.getItem("taxai-starred") ?? "[]") as string[]);
      if (next) list.add(task.id);
      else list.delete(task.id);
      localStorage.setItem("taxai-starred", JSON.stringify([...list]));
    } catch {
      /* 忽略存储不可用 */
    }
  };

  // 执行中每秒 tick，驱动头部实时计时
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const openReader = (target: ReaderTarget) => {
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    const key = readerKey(target);
    const idx = readerTabs.findIndex((t) => readerKey(t) === key);
    if (idx >= 0) {
      // 同一文件再次打开时刷新定位信息，否则连点两条差异行会停留在上一次的定位
      setReaderTabs((prev) => prev.map((t, i) => (i === idx ? target : t)));
      setReaderActive(idx);
    } else {
      setReaderTabs((prev) => [...prev, target]);
      setReaderActive(readerTabs.length);
    }
    setReaderOpen(true);
  };

  const closeTab = (index: number) => {
    const next = readerTabs.filter((_, i) => i !== index);
    setReaderTabs(next);
    setReaderActive((a) => (a >= index ? Math.max(0, a - 1) : a));
    if (next.length === 0) setReaderOpen(false);
  };

  // 关闭阅读器时把焦点归还给触发元素（键盘可达性）
  const closeReader = () => {
    setReaderOpen(false);
    lastFocusRef.current?.focus?.();
  };

  // 拖拽排序阅读器标签页，active 索引随之平移
  const reorderTabs = (from: number, to: number) => {
    setReaderTabs((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
    setReaderActive((a) => {
      if (a === from) return to;
      if (from < to && a > from && a <= to) return a - 1;
      if (from > to && a < from && a >= to) return a + 1;
      return a;
    });
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .listArtifacts(task.id)
        .then((list) => {
          if (!cancelled) setArtifacts(list);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task.id, task.status]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .listCompares(task.id)
        .then((list) => {
          if (!cancelled) setCompares(list);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task.id]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .listIssues(task.id)
        .then((data) => {
          if (cancelled) return;
          setIssues(data.issues);
          setReviews(data.reviews);
          setPendingReviews(data.pending);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task.id]);

  // 切换任务时清掉乐观标记，避免沿用上一个任务的状态
  useEffect(() => setReopened(false), [task.id]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAmountChecks(task.id)
      .then((list) => {
        if (!cancelled)
          setAmountChecks(Object.fromEntries(list.map((c) => [c.key, { at: c.createdAt, note: c.note }])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  /** 标记 / 撤销一处金额的人工核对：先乐观更新，失败回滚 */
  const toggleAmountCheck = (key: string) => {
    const checked = !(key in amountChecks);
    setAmountChecks((prev) => {
      const next = { ...prev };
      if (checked) next[key] = { at: new Date().toISOString(), note: prev[key]?.note ?? "" };
      else delete next[key];
      return next;
    });
    void api.toggleAmountCheck(task.id, key, checked).then(
      (list) =>
        setAmountChecks(Object.fromEntries(list.map((c) => [c.key, { at: c.createdAt, note: c.note }]))),
      () =>
        setAmountChecks((prev) => {
          const next = { ...prev };
          if (checked) delete next[key];
          else next[key] = { at: "", note: "" };
          return next;
        }),
    );
  };

  /** 保存已核对金额的备注：保持已核对状态，只更新备注（后端 upsert） */
  const saveAmountNote = (key: string, note: string) => {
    setAmountChecks((prev) => ({
      ...prev,
      [key]: { at: prev[key]?.at ?? new Date().toISOString(), note },
    }));
    void api
      .toggleAmountCheck(task.id, key, true, note)
      .then((list) =>
        setAmountChecks(Object.fromEntries(list.map((c) => [c.key, { at: c.createdAt, note: c.note }]))),
      )
      .catch(() => undefined);
  };

  // 切换任务时清空上一个任务的核验结果
  useEffect(() => {
    setLinkChecks({});
    setLinkCheckedAt(null);
    setLinkBusy(false);
  }, [task.id]);

  /** 核验引用链接可达性：GET + 8 秒超时，只取状态不下载正文（URL 由调用方传入，避免依赖顺序） */
  const checkCitationLinks = (urls: string[]) => {
    const unique = [...new Set(urls)];
    if (unique.length === 0 || linkBusy) return;
    setLinkBusy(true);
    void api
      .checkLinks(unique)
      .then((res) => {
        setLinkChecks(Object.fromEntries(res.results.map((r) => [r.url, r])));
        setLinkCheckedAt(res.checkedAt);
      })
      .catch(() => undefined)
      .finally(() => setLinkBusy(false));
  };

  const handleReopenReview = () => {
    void api
      .reopenReview(task.id)
      .then(() => api.listIssues(task.id))
      .then((data) => {
        setIssues(data.issues);
        setReviews(data.reviews);
        setPendingReviews(data.pending);
        setReopened(true);
      })
      .catch(() => undefined);
  };

  const handleReview = (issueId: string, decision: "confirm" | "dismiss", comment: string) => {
    void api
      .submitReview(task.id, { issueId, decision, comment })
      .then(() => api.listIssues(task.id))
      .then((data) => {
        setIssues(data.issues);
        setReviews(data.reviews);
        setPendingReviews(data.pending);
      })
      .catch(() => undefined);
  };

  const handleResume = async () => {
    if (!resumeText.trim() || resumeBusy) return;
    setResumeBusy(true);
    try {
      if (resumeFiles.length > 0) await api.uploadFiles(task.id, resumeFiles);
      await api.resumeTask(task.id, resumeText.trim());
      setResumeOpen(false);
      setResumeText("");
      setResumeFiles([]);
    } finally {
      setResumeBusy(false);
    }
  };

  type CompareTargetRef = {
    kind: "upload" | "artifact";
    name: string;
    highlight?: string;
    highlightValue?: string | number | null;
  };

  const toReaderTarget = (ref: CompareTargetRef): ReaderTarget | null => {
    if (ref.kind === "artifact") {
      return {
        kind: "artifact",
        taskId: task.id,
        name: ref.name,
        highlight: ref.highlight,
        highlightValue: ref.highlightValue,
      };
    }
    const file = files.find((f) => f.fileName === ref.name);
    if (!file) return null;
    return {
      kind: "file",
      taskId: task.id,
      fileId: file.id,
      name: file.fileName,
      highlight: ref.highlight,
      highlightValue: ref.highlightValue,
    };
  };

  const openCompareTarget = (ref: CompareTargetRef) => {
    const target = toReaderTarget(ref);
    if (target) openReader(target);
  };

  /** 差异行联动：A 进主栏、B 进副栏，并自动开启双栏对照（两份都会预载） */
  const openComparePair = (a: CompareTargetRef, b: CompareTargetRef) => {
    const ta = toReaderTarget(a);
    const tb = toReaderTarget(b);
    if (!ta || !tb) {
      if (ta) openReader(ta);
      if (tb) openReader(tb);
      return;
    }
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    const next = [...readerTabs];
    const place = (t: ReaderTarget): number => {
      const i = next.findIndex((x) => readerKey(x) === readerKey(t));
      if (i >= 0) {
        next[i] = t; // 同一份底稿再次定位时刷新高亮信息
        return i;
      }
      next.push(t);
      return next.length - 1;
    };
    const ia = place(ta);
    const ib = place(tb);
    setReaderTabs(next);
    setReaderActive(ia);
    setReaderSplitReq(
      ia === ib ? null : (prev) => ({ secondKey: readerKey(tb), nonce: (prev?.nonce ?? 0) + 1 }),
    );
    setReaderOpen(true);
  };

  const finalResult = useMemo(() => {
    const last = [...timeline].reverse().find((t) => t.kind === "agent_text" && t.detail);
    return task.result ?? last?.detail ?? "";
  }, [timeline, task.result]);

  const citations = useMemo<Citation[]>(() => {
    const out: Citation[] = [];
    for (const call of toolCalls) {
      if (!SEARCH_TOOLS.has(call.toolName)) continue;
      const results = (call.result as { results?: Array<{ title?: string; url?: string }> } | null)?.results;
      if (!results) continue;
      for (const r of results) {
        if (r.url && !out.some((c) => c.url === r.url)) out.push({ title: r.title ?? r.url, url: r.url });
      }
    }
    return out.slice(0, 12);
  }, [toolCalls]);

  // 步骤时间线：提问 → 工具核验 → 联网检索 → 结论生成 → 交付
  const totalDuration = useMemo(() => {
    const start = timeline.find((t) => t.kind === "run_started")?.at;
    const end = [...timeline].reverse().find((t) => t.kind === "run_completed" || t.kind === "run_failed")?.at;
    if (!start || !end) return "";
    const s = (Date.parse(end) - Date.parse(start)) / 1000;
    return s >= 90 ? `${Math.round(s / 60)} 分钟` : `${s.toFixed(1)} 秒`;
  }, [timeline]);

  const liveElapsed = useMemo(() => {
    const start = timeline.find((t) => t.kind === "run_started")?.at;
    if (!running || !start) return "";
    void tick;
    const s = (Date.now() - Date.parse(start)) / 1000;
    return s >= 90 ? `${Math.round(s / 60)} 分钟` : `${s.toFixed(0)} 秒`;
  }, [timeline, running, tick]);

  const runCount = useMemo(() => timeline.filter((t) => t.kind === "run_started").length, [timeline]);

  // 执行中最近一条 SSE 事件距今秒数（tick 驱动刷新）
  const lastEventAge = useMemo(() => {
    if (!running || timeline.length === 0) return null;
    const last = timeline[timeline.length - 1]?.at;
    if (!last) return null;
    void tick;
    return Math.max(0, Math.round((Date.now() - Date.parse(last)) / 1000));
  }, [timeline, running, tick]);

  const toolTime = useMemo(() => {
    const ended = toolCalls.filter((c) => c.endedAt);
    if (ended.length === 0) return null;
    const totalMs = ended.reduce((acc, c) => acc + Math.max(0, Date.parse(c.endedAt ?? c.at) - Date.parse(c.at)), 0);
    return { total: totalMs / 1000, avg: totalMs / 1000 / ended.length };
  }, [toolCalls]);

  // 总耗时三分段：工具调用 / 结论生成 / 等待其他
  const timeSplit = useMemo(() => {
    const ended = toolCalls.filter((c) => c.endedAt);
    const start = timeline.find((t) => t.kind === "run_started")?.at;
    const end = [...timeline].reverse().find((t) => t.kind === "run_completed" || t.kind === "run_failed")?.at;
    if (!start || !end) return null;
    const totalMs = Math.max(1, Date.parse(end) - Date.parse(start));
    const toolMs = ended.reduce((acc, c) => acc + Math.max(0, Date.parse(c.endedAt ?? c.at) - Date.parse(c.at)), 0);
    const lastEnds = ended.map((c) => Date.parse(c.endedAt ?? c.at));
    const genMs = lastEnds.length > 0 ? Math.max(0, Date.parse(end) - Math.max(...lastEnds)) : 0;
    const otherMs = Math.max(0, totalMs - toolMs - genMs);
    return { toolMs, genMs, otherMs, totalMs };
  }, [toolCalls, timeline]);

  // 步骤条点击跳转到对应首事件
  const jumpToStep = (i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    if (i === 0) {
      el.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const nameOf = (t: (typeof timeline)[number]) =>
      String((t.payload as { toolName?: string } | undefined)?.toolName ?? "");
    let target: string | undefined;
    if (i === 1) target = timeline.find((t) => t.kind === "tool_start" && !SEARCH_TOOLS.has(nameOf(t)))?.id;
    if (i === 2) target = timeline.find((t) => t.kind === "tool_start" && SEARCH_TOOLS.has(nameOf(t)))?.id;
    if (i === 3) target = timeline.find((t) => t.kind === "agent_text")?.id;
    if (i === 4) target = [...timeline].reverse().find((t) => t.kind === "run_completed" || t.kind === "run_failed")?.id;
    if (!target) return;
    el.querySelector(`[data-tlid="${target}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const lastRunAt = useMemo(() => {
    const last = [...timeline].reverse().find((t) => t.kind === "run_started");
    return last ? new Date(last.at).toLocaleString("zh-CN", { hour12: false }) : "";
  }, [timeline]);

  // 产物溯源：每份产物对应到真正生成它的工具调用（按结果里的 fileName/path 基名匹配）
  const artSrc = useMemo(
    () => artifactSources(artifacts.map((a) => a.name), toolCalls),
    [artifacts, toolCalls],
  );

  /** 切到时间线并滚动到指定 callId 的工具调用事件 */
  const locateCall = (callId: string) => {
    const item = timeline.find(
      (t) => t.kind === "tool_start" && (t.payload as { callId?: string } | undefined)?.callId === callId,
    );
    onTabChange("timeline");
    if (!item) return;
    window.setTimeout(() => {
      document.querySelector(`[data-tlid="${item.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
  };

  // 交付包里的产物溯源表：来源工具 + 所属运行（复用时间线导出的同一套时间窗判定）
  const runWins = useMemo(() => runWindows(timeline), [timeline]);
  const runOfArtifact = (name: string): number | null => {
    const a = artifacts.find((x) => x.name === name);
    if (!a) return null;
    const w = runWins.find((x) => artifactsOfRun([a], x).length > 0);
    return w ? w.run : null;
  };

  const toc = useMemo(
    () =>
      (finalResult.match(/^#{2,3} .+$/gm) ?? [])
        .map((h) => h.replace(/^#{2,3} /, ""))
        .slice(0, 24),
    [finalResult],
  );

  const summary = useMemo(() => {
    if (!finalResult) return null;
    const firstPara =
      finalResult.split(/\n{2,}/).find((s) => s.trim() && !s.startsWith("#") && !s.startsWith("|") && !s.startsWith("```")) ??
      "";
    return {
      firstPara: firstPara.trim().slice(0, 220),
      tables: (finalResult.match(/^\| ?---/gm) ?? []).length,
      mermaids: (finalResult.match(/```mermaid/g) ?? []).length,
      heads: (finalResult.match(/^#{2,4} /gm) ?? []).length,
    };
  }, [finalResult]);

  // 结论关键词云：领域词表计数 Top8
  const topWords = useMemo(() => {
    if (!finalResult) return [];
    return DOMAIN_KEYWORDS.map((w) => ({ w, n: finalResult.split(w).length - 1 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  }, [finalResult]);

  const [kwFilter, setKwFilter] = useState<string | null>(null);
  const kwParas = useMemo(() => {
    if (!kwFilter || !finalResult) return [];
    return finalResult
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.includes(kwFilter))
      .slice(0, 6);
  }, [kwFilter, finalResult]);

  // 续跑场景：上一次运行的结论摘录，供对照本次结论
  const prevConclusion = useMemo(() => {
    const texts = timeline.filter((t) => t.kind === "agent_text" && t.detail && !t.streaming);
    if (texts.length < 2) return "";
    return texts[texts.length - 2]?.detail ?? "";
  }, [timeline]);

  // 续跑结论句级差异：新增/删除的句子片段
  const conclDiff = useMemo(() => {
    if (!prevConclusion || !finalResult) return null;
    const split = (s: string) =>
      s
        .split(/[\n。；;]/)
        .map((x) => x.trim())
        .filter((x) => x.length > 8);
    const prevSet = new Set(split(prevConclusion));
    const curSet = new Set(split(finalResult));
    const added = split(finalResult).filter((x) => !prevSet.has(x));
    const removed = split(prevConclusion).filter((x) => !curSet.has(x));
    if (added.length === 0 && removed.length === 0) return null;
    return { added: added.slice(0, 6), removed: removed.slice(0, 6) };
  }, [prevConclusion, finalResult]);

  const steps = useMemo(() => {
    const hasRun = timeline.some((t) => t.kind === "run_started");
    const toolDone = toolCalls.some((c) => !SEARCH_TOOLS.has(c.toolName) && c.ok !== null);
    const searchDone = toolCalls.some((c) => SEARCH_TOOLS.has(c.toolName) && c.ok !== null);
    const concluded = timeline.some((t) => t.kind === "agent_text");
    const delivered = liveStatus === "completed";
    const done = [hasRun, toolDone, searchDone, delivered, delivered];
    const labels = ["提问", "工具核验", "联网检索", "结论生成", "交付"];
    const activeIdx = running ? done.findIndex((d) => !d) : -1;
    // 各步耗时细分：工具核验/联网检索取调用区间，结论生成取末次工具返回→运行完成
    const span = (list: typeof toolCalls) => {
      const ended = list.filter((c) => c.endedAt);
      if (ended.length === 0) return "";
      const start = Math.min(...ended.map((c) => Date.parse(c.at)));
      const end = Math.max(...ended.map((c) => Date.parse(c.endedAt ?? c.at)));
      const s = (end - start) / 1000;
      return s >= 90 ? `${Math.round(s / 60)}m` : `${s.toFixed(0)}s`;
    };
    const concludedAt = [...timeline].reverse().find((t) => t.kind === "run_completed")?.at;
    const lastEnds = toolCalls.filter((c) => c.endedAt).map((c) => Date.parse(c.endedAt ?? c.at));
    const genSpan =
      concludedAt && lastEnds.length > 0
        ? (() => {
            const s = (Date.parse(concludedAt) - Math.max(...lastEnds)) / 1000;
            return s > 0 ? (s >= 90 ? `${Math.round(s / 60)}m` : `${s.toFixed(0)}s`) : "";
          })()
        : "";
    const durs = ["", span(toolCalls.filter((c) => !SEARCH_TOOLS.has(c.toolName))), span(toolCalls.filter((c) => SEARCH_TOOLS.has(c.toolName))), genSpan, ""];
    return labels.map((label, i) => ({
      label,
      dur: durs[i] ?? "",
      state: done[i] ? "done" : i === activeIdx ? "active" : concluded && i === 3 && running ? "active" : "pending",
    }));
  }, [timeline, toolCalls, liveStatus, running]);

  const doneCount = steps.filter((s) => s.state === "done").length;

  // 整页 MD 包行（下载与复制共用）
  // 结论金额溯源：结论里的每处金额是否能在工具结果或客户指令里找到出处
  const amountTrace = useMemo(
    () =>
      traceAmounts(
        finalResult,
        toolCalls.filter((c) => c.ok !== false).map((c) => c.result),
        task.instruction ?? "",
      ),
    [finalResult, toolCalls, task.instruction],
  );

  // 待人工确认的金额：已核对的不再计入交付自检提醒
  const amountPending = useMemo(
    () => amountTrace.untraced.filter((u) => !(amountKey(u) in amountChecks)),
    [amountTrace, amountChecks],
  );
  const amountAcked = amountTrace.untraced.length - amountPending.length;

  // 就地标注：待确认（琥珀，点击标记为已核对）与已核对（青绿，点击撤销）
  const amountAnnotations = useMemo<Annotation[]>(
    () =>
      amountTrace.untraced.slice(0, 60).map((u) => {
        const key = amountKey(u);
        const ack = amountChecks[key];
        return ack
          ? {
              text: u.match,
              key,
              className: "md-annot-ok",
              label: `已人工核对（${new Date(ack.at).toLocaleString("zh-CN", { hour12: false })}）${
                ack.note ? ` · 备注：${ack.note}` : ""
              } · 点击撤销标记`,
            }
          : {
              text: u.match,
              key,
              className: "md-annot-warn",
              label: `待人工确认：该金额未在本次工具调用结果与客户指令中找到出处 · 点击标记为已核对\n上下文：…${u.context}…`,
            };
      }),
    [amountTrace, amountChecks],
  );

  // 复核页的金额核对清单：与正文就地标注同源，待确认与已核对分列
  const amountReviewItems = useMemo(() => {
    // 同一金额的多种写法合并成一条（键只由值决定），并统计出现处数
    const pend = new Map<string, { key: string; raw: string; context: string; occurrences: number }>();
    const acked = new Map<string, { key: string; raw: string; at: string; note: string; occurrences: number }>();
    for (const u of amountTrace.untraced) {
      const key = amountKey(u);
      const ack = amountChecks[key];
      const bucket = ack ? acked : pend;
      const cur = bucket.get(key);
      if (cur) {
        cur.occurrences += 1;
        continue;
      }
      if (ack) acked.set(key, { key, raw: u.raw, at: ack.at, note: ack.note, occurrences: 1 });
      else pend.set(key, { key, raw: u.raw, context: u.context, occurrences: 1 });
    }
    return { pend: [...pend.values()], acked: [...acked.values()] };
  }, [amountTrace, amountChecks]);

  // 链接核验汇总：可访问 / 失效 / 拒绝自动访问（反爬）/ 无法核验，四类分开计数
  const linkSummary = useMemo(() => summarizeLinkChecks(Object.values(linkChecks)), [linkChecks]);

  // 交付自检输入：结论字数、产物与溯源、工具调用结果、待复核与联网引用
  const deliveryInput = (): CheckInput => ({
    status: reopened ? "waiting_review" : task.status,
    resultChars: finalResult.trim().length,
    artifacts: artifacts.length,
    unattributedArtifacts: artifacts.filter((a) => !artSrc.has(a.name)).length,
    toolTotal: toolCalls.length,
    toolFailed: toolCalls.filter((c) => c.ok === false).length,
    toolRunning: toolCalls.filter((c) => c.ok === null).length,
    pendingReview: pendingReviews,
    citations: citations.length,
    linkCheck: linkCheckedAt ? linkSummary : null,
    amountTotal: amountTrace.total,
    amountUntraced: amountPending.length,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const delivery = useMemo(
    () => deliveryCheck(deliveryInput()),
    [reopened, task.status, finalResult, artifacts, artSrc, toolCalls, pendingReviews, citations, linkSummary, linkCheckedAt],
  );

  // 交付包里的工具调用清单：按运行分组，含结果、耗时与入参摘要（表格单元格已做竖线/换行安全化）
  const toolCallSection = (): string[] => {
    if (toolCalls.length === 0) return ["（本次任务没有工具调用记录）"];
    const grouped = callsByRun(toolCalls, runWins);
    const st = callStats(toolCalls);
    const lines: string[] = [
      `- 合计 ${st.total} 次调用：成功 ${st.ok} · 失败 ${st.failed} · 执行中 ${st.running} · 平均耗时 ${fmtDuration(st.avgMs)}`,
      "",
    ];
    for (const k of [...grouped.keys()].sort((a, b) => a - b)) {
      const list = grouped.get(k) ?? [];
      const w = runWins.find((x) => x.run === k);
      lines.push(
        k === 0 ? "### 运行窗口之外" : `### 第 ${k} 次运行（${w?.start ?? "?"} ~ ${w?.end ?? "未结束"}）`,
        "",
        "| # | 工具 | 结果 | 耗时 | 开始时间 | 入参摘要 |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      list.forEach((c, i) => {
        lines.push(
          `| ${i + 1} | ${c.toolName} | ${c.ok === null ? "执行中" : c.ok ? "成功" : "失败"} | ${fmtDuration(
            durationMs(c.at, c.endedAt),
          )} | ${c.at} | ${summarizeArgs(c.args)} |`,
        );
      });
      lines.push("");
    }
    return lines;
  };

  const bundleLines = () => [
    `# ${task.title}`,
    "",
    `- 任务 ID：${task.id}`,
    `- 智能体：${agent.shortName}${agent.model ? `（${agent.model}）` : ""}`,
    `- 案例：${task.caseId}　状态：${liveStatus}　运行次数：${runCount}`,
    `- 创建：${new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}　导出：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "## 交付自检",
    "",
    ...deliverySection(deliveryInput()),
    "",
    "## 目录",
    "",
    ...toc.map((h, i) => `${i + 1}. ${h}`),
    "",
    "## 审查结论",
    "",
    finalResult,
    "",
    "## 联网引用",
    "",
    ...(citations.length > 0 ? citations.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}`) : ["（本次任务无联网引用）"]),
    "",
    ...(linkCheckedAt
      ? [
          `- 链接核验：${new Date(linkCheckedAt).toLocaleString("zh-CN", { hour12: false })} · 可访问 ${
            linkSummary.ok
          }/${linkSummary.total} · 失效 ${linkSummary.dead} · 拒绝自动访问 ${linkSummary.blocked} · 无法核验 ${
            linkSummary.unreachable
          }`,
          ...Object.values(linkChecks)
            .filter((r) => linkVerdict(r) !== "ok")
            .map(
              (r) =>
                `  - ${VERDICT_TEXT[linkVerdict(r)]}：${r.url}（${r.status ?? r.error ?? "无响应"}，耗时 ${r.ms} ms）`,
            ),
          "",
        ]
      : []),
    "## 生成产物与溯源",
    "",
    ...(artifacts.length > 0
      ? [
          "| 文件 | 大小 | 来源工具 | 关系 | 时间 | 所属运行 |",
          "| --- | --- | --- | --- | --- | --- |",
          ...artifacts.map((a) => {
            const src = artSrc.get(a.name);
            const run = runOfArtifact(a.name);
            return `| ${a.name} | ${fmtBytes(a.byteSize)} | ${src?.toolName ?? "—"} | ${
              src ? (src.role === "producer" ? "生成" : "引用") : "未识别"
            } | ${src ? new Date(src.at).toLocaleString("zh-CN", { hour12: false }) : "—"} | ${
              run !== null ? `第 ${run} 次` : "—"
            } |`;
          }),
        ]
      : ["（本次任务无生成产物）"]),
    "",
    "## 工具调用清单（按运行分组）",
    "",
    ...toolCallSection(),
    "",
    "## 人工复核记录",
    "",
    ...reviewSection(issues, reviews, reopened ? "waiting_review" : task.status),
    "",
    "## 结论金额溯源",
    "",
    `- 结论中识别出金额 ${amountTrace.total} 处：工具结果可溯源 ${amountTrace.traced} 处 · 来自客户指令 ${amountTrace.fromInput} 处 · 待人工确认 ${amountPending.length} 处${
      amountAcked > 0 ? ` · 已人工核对 ${amountAcked} 处` : ""
    }`,
    ...(amountPending.length > 0
      ? [
          "",
          "| # | 金额 | 结论中的上下文 | 处理建议 |",
          "| --- | --- | --- | --- |",
          ...amountPending.slice(0, 20).map(
            (u, i) => `| ${i + 1} | ${u.raw} | ${mdCell(u.context)} | 核对来源或在正文中点击标记为已核对 |`,
          ),
          "",
          ...(amountPending.length > 20 ? [`（另有 ${amountPending.length - 20} 处未列出）`, ""] : []),
        ]
      : [
          "",
          "（没有待人工确认的金额：结论中的金额都能在工具调用结果或客户指令中找到出处，或已完成人工核对）",
        ]),
    "",
    ...(amountReviewItems.acked.length > 0
      ? [
          "### 已人工核对",
          "",
          "| # | 金额 | 出现处数 | 核对时间 | 备注 |",
          "| --- | --- | --- | --- | --- |",
          ...amountReviewItems.acked.map(
            (a, i) =>
              `| ${i + 1} | ${a.raw} | ${a.occurrences} | ${new Date(a.at).toLocaleString("zh-CN", {
                hour12: false,
              })} | ${mdCell(a.note || "（无）")} |`,
          ),
          "",
        ]
      : []),
    "",
  ];

  // 切换页签时回到底部并恢复钉底跟随
  useEffect(() => {
    if (tab === "timeline") {
      pinnedRef.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    setShowJump(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // 仅钉底时自动跟随流式输出，用户上滚阅读历史不被打断
  useEffect(() => {
    const el = scrollRef.current;
    if (el && tab === "timeline" && pinnedRef.current && autoFollow) el.scrollTop = el.scrollHeight;
  }, [timeline, tab, autoFollow]);

  // Esc 依次收起续跑面板与侧边阅读器
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (resumeOpen) setResumeOpen(false);
      else if (readerOpen) closeReader();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [resumeOpen, readerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Alt+1~4 切换工作台页签
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx < 0) return;
      e.preventDefault();
      onTabChange((["timeline", "result", "compare", "review"] as const)[idx]!);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onTabChange]);

  // 深链 /sec/N：结果页渲染后滚动到对应章节锚点
  useEffect(() => {
    if (tab !== "result" || secInto === null) return;
    const t = window.setTimeout(() => {
      document.getElementById(`sec-${secInto}`)?.scrollIntoView({ block: "start" });
    }, 150);
    return () => window.clearTimeout(t);
  }, [tab, secInto, finalResult]);

  const download = (name: string, content: string) => {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-night-950 px-8 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-mist-100">{task.title}</h2>
            <button
              type="button"
              onClick={toggleStar}
              title={starred ? "取消收藏" : "收藏任务"}
              className="action-btn shrink-0"
            >
              <span className={starred ? "text-amber-300" : "text-mist-600"}>{starred ? "★" : "☆"}</span>
            </button>
            <span
              className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${meta.className} ${
                running ? "animate-pulse" : ""
              }`}
            >
              {running ? (
                <span className="inline-flex items-center gap-1">
                  <IconSpinner className="h-3 w-3" />
                  {meta.label}
                </span>
              ) : (
                meta.label
              )}
            </span>
            <button
              type="button"
              className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              title={`步骤 ${doneCount}/5 · 点击跳转首个未完成步骤`}
              onClick={() => jumpToStep(doneCount >= 5 ? 4 : doneCount)}
            >
              <svg viewBox="0 0 32 32" className="h-5 w-5">
                <circle cx="16" cy="16" r="12" fill="none" stroke="#1b2c47" strokeWidth="6" />
                <circle
                  cx="16"
                  cy="16"
                  r="12"
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="6"
                  strokeDasharray={`${(doneCount / 5) * STEP_RING} ${STEP_RING}`}
                  transform="rotate(-90 16 16)"
                />
              </svg>
              <span className="absolute font-mono text-[8px] text-mist-300">{doneCount}</span>
            </button>
            <button type="button" onClick={() => void copyId()} title="复制任务 ID" className="action-btn shrink-0">
              {copied ? <span className="text-jade-400">已复制</span> : <IconCopy className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={() => void copyShare()} title="复制任务深链（含页签）" className="action-btn shrink-0">
              {shareCopied ? <span className="text-jade-400">已复制</span> : <IconExternal className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={() => void copyMeta()} title="复制任务全部元信息" className="action-btn shrink-0">
              {metaCopied ? <span className="text-jade-400">已复制</span> : <IconFile className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={() => window.print()} title="打印 / 导出 PDF（沿用当前版式）" className="action-btn shrink-0">
              <IconPrint className="h-3.5 w-3.5" />
            </button>
            {runCount > 1 && (
              <span
                className="rounded border border-line bg-night-800 px-1.5 py-0.5 text-[11px] text-mist-600"
                title="本任务含续跑运行次数"
              >
                第 {runCount} 次运行
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mist-600">
            <span className="text-glow-300">{agent.shortName}</span>
            {agent.model && (
              <span
                className="rounded border border-line bg-night-850 px-1.5 py-0.5 font-mono text-[10px] text-mist-500"
                title="运行模型（网关配置）"
              >
                {agent.model}
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1">
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-0.5 rounded-full border border-glow-500/35 bg-glow-500/10 px-1.5 py-0.5 text-[10px] text-glow-300"
                >
                  {t}
                  <button
                    type="button"
                    className="hover:text-rose-300"
                    title="移除标签"
                    onClick={() => mutateTags(tags.filter((x) => x !== t))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim() && !tags.includes(tagInput.trim())) {
                    mutateTags([...tags, tagInput.trim()]);
                    setTagInput("");
                  }
                }}
                placeholder="+标签"
                title="输入标签后回车添加"
                className="w-16 rounded border border-line bg-night-850 px-1 py-0.5 text-[10px] text-mist-300 outline-none focus:glow-ring"
              />
            </span>
            <span className="text-line">|</span>
            <button
              type="button"
              className="rounded border border-line bg-night-850 px-1.5 py-0.5 transition-colors hover:border-glow-500 hover:text-glow-300"
              title="点击复制案例编号"
              onClick={() => void navigator.clipboard?.writeText(task.caseId).catch(() => undefined)}
            >
              案例 {task.caseId}
            </button>
            <span className="text-line">|</span>
            <span>工具调用 {toolCalls.length} 次</span>
            {toolTime && (
              <>
                <span className="text-line">|</span>
                <span title="工具总耗时 / 平均单次耗时">
                  工具 {toolTime.total.toFixed(1)}s · 均 {toolTime.avg.toFixed(1)}s
                </span>
              </>
            )}
            <span className="text-line">|</span>
            <span title="SSE 事件数（含流式增量）">事件 {timeline.length}</span>
            {(totalDuration || liveElapsed) && (
              <>
                <span className="text-line">|</span>
                <span className={running ? "text-amber-300" : undefined}>
                  {running ? `已用时 ${liveElapsed}` : `总耗时 ${totalDuration}`}
                </span>
              </>
            )}
            <span className="text-line">|</span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-jade-400" : "bg-amber-400"}`}
                title={connected ? "SSE 事件流已连接" : "SSE 事件流断开，自动重连中"}
              />
              {connected ? "事件流已连接" : "事件流重连中"}
            </span>
            {lastEventAge !== null && (
              <>
                <span className="text-line">|</span>
                <span
                  className={lastEventAge > 30 ? "text-amber-300" : undefined}
                  title="距最近一条 SSE 事件秒数（>30s 琥珀提示）"
                >
                  最近事件 {lastEventAge}s
                </span>
              </>
            )}
            {!connected && (
              <button type="button" className="action-btn" onClick={reconnect} title="手动重连事件流（重放持久化事件）">
                <IconRefresh className="h-3 w-3" />
                重连
              </button>
            )}
            <span className="text-line">|</span>
            <span>创建 {new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
            {task.updatedAt !== task.createdAt && (
              <>
                <span className="text-line">|</span>
                <span>更新 {new Date(task.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setResumeOpen((v) => !v)}
          disabled={running}
          title="补充资料或补充意见后继续本任务（恢复会话历史）"
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] transition-colors disabled:opacity-40 ${
            resumeOpen
              ? "border-glow-500 bg-night-700 text-glow-300"
              : "border-line bg-night-850 text-mist-300 hover:border-glow-500 hover:text-mist-100"
          }`}
        >
          <IconPlay className="h-3 w-3" />
          续跑任务
        </button>
        <button
          type="button"
          onClick={() => (readerOpen ? closeReader() : setReaderOpen(true))}
          title={readerOpen ? "收起侧边阅读器" : "展开侧边阅读器"}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] transition-colors ${
            readerOpen
              ? "border-glow-500 bg-night-700 text-glow-300"
              : "border-line bg-night-850 text-mist-300 hover:border-glow-500 hover:text-mist-100"
          }`}
        >
          <IconPanel className="h-3.5 w-3.5" />
          阅读器
        </button>
        <button
          type="button"
          onClick={onRerun}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-night-850 px-3 py-1.5 text-[12.5px] text-mist-300 transition-colors hover:border-glow-500 hover:text-mist-100 disabled:opacity-40"
        >
          <IconPlay className="h-3 w-3" />
          重新执行
        </button>
      </header>

      {resumeOpen && (
        <div className="no-print border-b border-line bg-night-900 px-8 py-3">
          <div className="glow-card flex flex-col gap-2 px-4 py-3">
            <textarea
              rows={3}
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              placeholder="补充说明或新意见，例如：已补充上传研发人员名单，请结合名单复核人员人工归集…"
              className="w-full resize-y rounded-md border border-line bg-night-850 px-3 py-2 text-[13px] leading-6 text-mist-100 outline-none placeholder:text-mist-600 focus:glow-ring"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-night-800 px-2.5 py-1.5 text-[12px] text-mist-300 hover:border-glow-500">
                <IconFile className="h-3.5 w-3.5" />
                补充资料{resumeFiles.length > 0 ? `（${resumeFiles.length}）` : ""}
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    setResumeFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => void handleResume()}
                disabled={!resumeText.trim() || resumeBusy}
                className="user-bubble px-3.5 py-1.5 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
              >
                {resumeBusy ? "提交中…" : "提交续跑"}
              </button>
              <button
                type="button"
                onClick={() => setResumeOpen(false)}
                className="rounded-md border border-line bg-night-800 px-2.5 py-1.5 text-[12px] text-mist-500 hover:text-mist-100"
              >
                取消
              </button>
              <span className="text-[11px] text-mist-600">
                续跑会恢复本任务完整会话历史，Agent 结合此前结论继续处理
                {runCount > 1 && lastRunAt && ` · 已含 ${runCount - 1} 次续跑，上次运行启动于 ${lastRunAt}`}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="no-print flex items-center gap-0 border-b border-line bg-night-900 px-8 py-3">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center">
            {i > 0 && (
              <div
                className={`mx-2 h-px w-8 sm:w-14 ${steps[i - 1]!.state === "done" ? "bg-glow-500/60" : "bg-line"}`}
              />
            )}
            <button
              type="button"
              onClick={() => jumpToStep(i)}
              title="跳转到对应首事件"
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-night-800"
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold ${
                  step.state === "done"
                    ? "border-glow-500 bg-glow-500/15 text-glow-300"
                    : step.state === "active"
                      ? "border-glow-400 text-glow-300 glow-ring animate-pulse"
                      : "border-line text-mist-600"
                }`}
              >
                {step.state === "done" ? <IconCheck className="h-3 w-3" /> : String(i + 1).padStart(2, "0")}
              </span>
              <span
                className={`text-[12px] ${step.state === "pending" ? "text-mist-600" : "text-mist-100"}`}
              >
                {step.label}
                {step.dur && <span className="ml-1 font-mono text-[10px] text-mist-600">{step.dur}</span>}
              </span>
            </button>
          </div>
        ))}
      </div>

      {timeSplit && (
        <div className="no-print flex items-center gap-2 border-b border-line bg-night-900 px-8 pb-2">
          <span className="shrink-0 text-[10.5px] text-mist-600">耗时分布</span>
          <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-night-700">
            <span
              className="h-full bg-glow-500"
              style={{ width: `${(timeSplit.toolMs / timeSplit.totalMs) * 100}%` }}
              title={`工具调用 ${(timeSplit.toolMs / 1000).toFixed(1)}s`}
            />
            <span
              className="h-full bg-jade-400"
              style={{ width: `${(timeSplit.genMs / timeSplit.totalMs) * 100}%` }}
              title={`结论生成 ${(timeSplit.genMs / 1000).toFixed(1)}s`}
            />
            <span
              className="h-full bg-mist-600/60"
              style={{ width: `${(timeSplit.otherMs / timeSplit.totalMs) * 100}%` }}
              title={`等待/其他 ${(timeSplit.otherMs / 1000).toFixed(1)}s`}
            />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-mist-600">{(timeSplit.totalMs / 1000).toFixed(0)}s</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-0">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {scrollPct > 0.02 && scrollPct < 0.999 && (
            <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5">
              <span className="block h-full bg-glow-500/70" style={{ width: `${scrollPct * 100}%` }} />
            </span>
          )}
          <div className="no-print flex justify-center border-b border-line bg-night-950 py-2">
            <div className="seg-tabs">
            {(
              [
                ["timeline", "执行过程"],
                ["result", "审查结论"],
                ["compare", "底稿比对"],
                ["review", "人工复核"],
              ] as const
            ).map(([key, label], tabIdx) => (
              <button
                key={key}
                type="button"
                onClick={() => onTabChange(key)}
                className="seg-tab"
                data-on={tab === key}
                title={`${label}（Alt+${tabIdx + 1}）`}
              >
                {label}
                {key === "review" && liveStatus === "waiting_review" && (
                  <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                )}
                {key === "result" && citations.length > 0 && (
                  <span className="ml-1.5 rounded bg-glow-500/15 px-1 py-0.5 text-[10px] text-glow-300">
                    {citations.length}
                  </span>
                )}
                {key === "compare" && compares.length > 0 && (
                  <span className="ml-1.5 rounded bg-glow-500/15 px-1 py-0.5 text-[10px] text-glow-300">
                    {compares.length}
                  </span>
                )}
                {key === "review" && pendingReviews > 0 && (
                  <span className="ml-1.5 rounded bg-amber-400/15 px-1 py-0.5 text-[10px] text-amber-300">
                    {pendingReviews}
                  </span>
                )}
              </button>
            ))}
            </div>
          </div>

          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              pinnedRef.current = autoFollow && pinned;
              setShowJump(!pinned && tab === "timeline");
              const range = el.scrollHeight - el.clientHeight;
              setScrollPct(range > 0 ? el.scrollTop / range : 0);
            }}
            className="print-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5"
          >
            <div className="chat-col mx-auto">
              {liveStatus === "waiting_review" && tab !== "review" && (
                <div className="no-print mb-3 flex items-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-[12px] text-sky-300">
                  <IconAlert className="h-3.5 w-3.5 shrink-0" />
                  任务待人工复核，复核完成后自动流转为已完成
                  <button type="button" className="action-btn ml-auto" onClick={() => onTabChange("review")}>
                    前往复核
                  </button>
                </div>
              )}
              {liveStatus === "completed" && pendingReviews > 0 && tab !== "review" && (
                <div className="no-print mb-3 flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-300">
                  <IconAlert className="h-3.5 w-3.5 shrink-0" />
                  任务已完成，但仍有 {pendingReviews} 项问题未复核
                  <button type="button" className="action-btn ml-auto" onClick={() => onTabChange("review")}>
                    前往复核
                  </button>
                </div>
              )}
            {tab === "timeline" && (
              <TimelineView
                instruction={task.instruction}
                items={timeline}
                toolCalls={toolCalls}
                citations={citations}
                artifacts={artifacts}
                onOpenUrl={openReader}
                onRerun={onRerun}
                autoFollow={autoFollow}
                onToggleAutoFollow={() => {
                  const nv = !autoFollow;
                  setAutoFollow(nv);
                  if (nv) {
                    pinnedRef.current = true;
                    const el = scrollRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                  }
                }}
              />
            )}
            {tab === "result" && (
              <>
                <div className="print-only mb-4 border-b border-gray-300 pb-2">
                  <div className="text-[13px] font-semibold text-gray-900">税务智能审查平台 · 审查结论</div>
                  <div className="mt-0.5 text-[11px] text-gray-600">
                    任务：{task.title}　案例：{task.caseId}　状态：{liveStatus}　打印时间：
                    {new Date().toLocaleString("zh-CN", { hour12: false })}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-gray-600">
                    任务 ID：{task.id}　模型：{agent.model ?? "—"}　运行次数：{runCount}
                  </div>
                </div>
                {prevConclusion && (
                  <div className="no-print mb-3 rounded-md border border-line bg-night-850 px-3 py-2 text-[11.5px] leading-5 text-mist-500">
                    <span className="kicker mr-2">上次运行结论</span>
                    {prevConclusion.replace(/\s+/g, " ").slice(0, 120)}…（{prevConclusion.length} 字 · 本次 {finalResult.length} 字）
                  </div>
                )}
                {conclDiff && (
                  <div className="no-print mb-3 rounded-md border border-line bg-night-850 px-3 py-2">
                    <div className="kicker mb-1">结论较上次运行变化</div>
                    {conclDiff.added.length > 0 && (
                      <ul className="space-y-0.5 text-[11.5px] leading-5 text-jade-400">
                        {conclDiff.added.map((s, i) => (
                          <li key={`a${i}`}>+ {s}</li>
                        ))}
                      </ul>
                    )}
                    {conclDiff.removed.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[11.5px] leading-5 text-rose-300">
                        {conclDiff.removed.map((s, i) => (
                          <li key={`r${i}`}>- {s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="glow-card mb-4 px-4 py-3">
                  <div className="text-[12px] font-semibold text-mist-100 print:text-gray-900">目录</div>
                  <ul className="mt-1 list-decimal pl-5 text-[11px] leading-5 text-mist-400 print:text-gray-700">
                    {toc.map((h, i) => (
                      <li key={h}>
                        <button
                          type="button"
                          className="underline decoration-transparent underline-offset-2 transition-colors hover:text-glow-300 hover:decoration-glow-400 print:hover:text-gray-700"
                          onClick={() =>
                            document.getElementById(`sec-${i}`)?.scrollIntoView({ block: "start", behavior: "smooth" })
                          }
                        >
                          {h}
                        </button>
                        <button
                          type="button"
                          className="action-btn no-print !px-1 !py-0"
                          title="复制段落深链"
                          onClick={() =>
                            void navigator.clipboard
                              ?.writeText(
                                `${window.location.origin}${window.location.pathname}#/agent/${agent.id}/task/${task.id}/tab/result/sec/${i}`,
                              )
                              .catch(() => undefined)
                          }
                        >
                          <IconExternal className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="no-print mb-3 flex items-center gap-2 rounded-md border border-line bg-night-850 px-3 py-1.5 text-[11.5px] text-mist-500">
                  <IconPrint className="h-3.5 w-3.5 shrink-0 text-glow-400" />
                  打印 / PDF 导出将沿用当前版式主题，可在下方「交付」区切换四套纸张版式后预览。
                </div>
                {summary && summary.firstPara && (
                  <div className="mb-4 glow-card px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="kicker">结论要点</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="text-[10.5px] text-mist-600">
                          {summary.heads} 节 · {summary.tables} 表 · {summary.mermaids} 图 · {finalResult.length} 字 · 约{" "}
                          {Math.max(1, Math.round(finalResult.length / 400))} 分钟
                        </span>
                        {amountTrace.total > 0 && (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                              amountPending.length === 0
                                ? "bg-jade-400/15 text-jade-300"
                                : "bg-amber-400/15 text-amber-300"
                            }`}
                            title={`结论金额溯源：${amountTrace.traced}/${amountTrace.total} 处可在工具结果中找到出处，${amountTrace.fromInput} 处来自客户指令，${amountPending.length} 处待人工确认${
                              amountAcked > 0 ? `，${amountAcked} 处已人工核对` : ""
                            }${
                              amountPending.length > 0
                                ? `\n点击正文中的琥珀标记可标记为已核对：\n${amountPending
                                    .slice(0, 5)
                                    .map((u) => `· ${u.raw}：…${u.context}…`)
                                    .join("\n")}`
                                : ""
                            }`}
                          >
                            金额溯源 {amountTrace.traced}/{amountTrace.total}
                            {amountPending.length > 0 ? ` · 待确认 ${amountPending.length}` : ""}
                            {amountAcked > 0 ? ` · 已核对 ${amountAcked}` : ""}
                          </span>
                        )}
                        <button
                          type="button"
                          className="action-btn"
                          title="复制要点"
                          onClick={() => void navigator.clipboard?.writeText(summary.firstPara).catch(() => undefined)}
                        >
                          <IconCopy className="h-3 w-3" />
                        </button>
                      </span>
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-6 text-mist-300">{summary.firstPara}…</p>
                    {topWords.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {topWords.map((x, i) => (
                          <button
                            type="button"
                            onClick={() => setKwFilter((v) => (v === x.w ? null : x.w))}
                            className={`rounded-full border px-2 py-0.5 text-glow-300 transition-colors ${
                              kwFilter === x.w
                                ? "border-glow-400 bg-glow-500/25"
                                : "border-glow-500/30 bg-glow-500/10 hover:border-glow-400"
                            }`}
                            style={{ fontSize: `${11.5 - i * 0.6}px` }}
                            title={`出现 ${x.n} 次，点击过滤段落`}
                          >
                            {x.w} ×{x.n}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {kwFilter && (
                  <div className="mb-4 rounded-md border border-glow-500/35 bg-glow-500/5 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="kicker">含「{kwFilter}」的段落</span>
                      <button type="button" className="action-btn ml-auto" onClick={() => setKwFilter(null)}>
                        清除
                      </button>
                    </div>
                    {kwParas.length === 0 ? (
                      <p className="mt-1 text-[11.5px] text-mist-600">无匹配段落</p>
                    ) : (
                      <ul className="mt-1 space-y-1.5">
                        {kwParas.map((p, i) => (
                          <li key={i} className="rounded bg-night-800 px-2 py-1 text-[11.5px] leading-5 text-mist-300">
                            {p.replace(/\s+/g, " ").slice(0, 160)}…
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              <ResultView
                result={finalResult}
                error={task.error}
                status={liveStatus}
                citations={citations}
                onOpenUrl={openReader}
                linkChecks={linkChecks}
                linkBusy={linkBusy}
                linkCheckedAt={linkCheckedAt}
                linkSummary={linkSummary}
                onCheckLinks={() => checkCitationLinks(citations.map((c) => c.url))}
                onDownloadReport={() => download(`${task.title}-审查报告.md`, finalResult)}
                onDownloadCitations={() =>
                  download(
                    `${task.title}-引用清单.md`,
                    citations.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}`).join("\n") || "（本次任务无联网引用）",
                  )
                }
                onDownloadBibtex={() =>
                  download(
                    "references.bib",
                    citations
                      .map(
                        (c, i) =>
                          `@misc{ref${i + 1},\n  title = {${c.title.replace(/[{}]/g, "")}},\n  howpublished = {\\url{${c.url}}},\n  note = { Accessed: ${new Date().toISOString().slice(0, 10)} }\n}`,
                      )
                      .join("\n\n") || "% 本次任务无联网引用\n",
                  )
                }
                onCopyBibtex={() =>
                  void navigator.clipboard
                    ?.writeText(
                      citations
                        .map(
                          (c, i) =>
                            `@misc{ref${i + 1},\n  title = {${c.title.replace(/[{}]/g, "")}},\n  howpublished = {\\url{${c.url}}},\n  note = { Accessed: ${new Date().toISOString().slice(0, 10)} }\n}`,
                        )
                        .join("\n\n") || "% 本次任务无联网引用\n",
                    )
                    .catch(() => undefined)
                }
              onPrint={() => window.print()}
                fs={fs}
                onFs={setFs}
                delivery={delivery}
                annotations={amountAnnotations}
                onAnnotateClick={toggleAmountCheck}
                onCopyBundle={() =>
                  void navigator.clipboard?.writeText(bundleLines().join("\n")).catch(() => undefined)
                }
                onExportBundle={() => {
                  const lines = bundleLines();
                  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${task.title}-整页-${new Date().toISOString().slice(0, 10)}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              />
              </>
            )}
            {tab === "compare" && (
              <CompareView compares={compares} onOpenTarget={openCompareTarget} onOpenPair={openComparePair} />
            )}
            {tab === "review" && (
              <ReviewView
                issues={issues}
                reviews={reviews}
                pending={pendingReviews}
                status={reopened ? "waiting_review" : task.status}
                onReview={handleReview}
                onReopen={handleReopenReview}
                amounts={{
                  total: amountTrace.total,
                  traced: amountTrace.traced,
                  fromInput: amountTrace.fromInput,
                  pending: amountReviewItems.pend,
                  acked: amountReviewItems.acked,
                  pendingOccurrences: amountReviewItems.pend.reduce((s, a) => s + a.occurrences, 0),
                  ackedOccurrences: amountReviewItems.acked.reduce((s, a) => s + a.occurrences, 0),
                }}
                onToggleAmount={toggleAmountCheck}
                onAmountNote={saveAmountNote}
              />
            )}
            </div>
          </div>
          {showJump && (
            <button
              type="button"
              onClick={() => {
                const el = scrollRef.current;
                if (!el) return;
                el.scrollTop = el.scrollHeight;
                pinnedRef.current = true;
                setShowJump(false);
              }}
              className="no-print absolute bottom-4 right-6 z-10 rounded-full border border-glow-500/50 bg-night-800/95 px-3 py-1.5 text-[11.5px] text-glow-300 shadow-lg transition-colors hover:bg-night-700"
            >
              回到最新 ↓ {Math.round(scrollPct * 100)}%
            </button>
          )}
          {tab === "result" && toc.length > 3 && (
            <div className="no-print absolute bottom-4 right-6 z-10 w-44 rounded-lg border border-line bg-night-900/95 p-2 shadow-xl">
              <div className="kicker mb-1">目录</div>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {toc.map((h, i) => (
                  <li key={h}>
                    <button
                      type="button"
                      className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-mist-500 transition-colors hover:bg-night-800 hover:text-mist-100"
                      onClick={() =>
                        document.getElementById(`sec-${i}`)?.scrollIntoView({ block: "start", behavior: "smooth" })
                      }
                    >
                      {h}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside
          className={`no-print w-[280px] shrink-0 overflow-y-auto border-l border-line bg-night-950 px-5 py-5 ${
            readerOpen ? "hidden" : "hidden xl:block"
          }`}
        >
          <div className="kicker">任务指令</div>
          <p className="mt-1.5 whitespace-pre-wrap rounded-md bg-night-800 px-3 py-2 text-[12.5px] leading-5 text-mist-300">
            {task.instruction}
          </p>

          <div className="mt-5 kicker">业务资料</div>
          {files.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-mist-600">本任务未上传资料</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => openReader({ kind: "file", taskId: task.id, fileId: f.id, name: f.fileName })}
                    className="flex w-full items-start gap-2 rounded border border-line bg-night-850 px-2 py-1.5 text-left transition-colors hover:border-glow-500"
                    title="在侧边阅读器中预览"
                  >
                    <IconFile className="mt-0.5 h-3.5 w-3.5 shrink-0 text-glow-400" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-mist-300">{f.fileName}</span>
                      <span className="block text-[11px] text-mist-600">
                        {(f.byteSize / 1024).toFixed(1)} KB · {f.parseStatus}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 kicker">生成产物</div>
          {artifacts.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-mist-600">暂无产物（底稿导出后在此预览）</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {artifacts.map((a) => {
                const src = artSrc.get(a.name);
                const srcAt = src ? new Date(src.at).toLocaleString("zh-CN", { hour12: false }) : "";
                return (
                  <li key={a.name} className="flex items-stretch gap-1">
                    <button
                      type="button"
                      onClick={() => openReader({ kind: "artifact", taskId: task.id, name: a.name })}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded border border-line bg-night-850 px-2 py-1.5 text-left transition-colors hover:border-glow-500"
                      title="在侧边阅读器中预览"
                    >
                      <IconFile className="mt-0.5 h-3.5 w-3.5 shrink-0 text-glow-400" />
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] text-mist-300">{a.name}</span>
                        <span className="block truncate text-[11px] text-mist-600">
                          {fmtBytes(a.byteSize)}
                          {src
                            ? src.role === "producer"
                              ? ` · 由 ${src.toolName} 生成于 ${srcAt}`
                              : ` · 被 ${src.toolName} 引用（${srcAt}），非该调用生成`
                            : " · 来源未识别"}
                        </span>
                      </span>
                    </button>
                    {src && (
                      <button
                        type="button"
                        className="action-btn shrink-0"
                        title={`在时间线中定位${src.role === "producer" ? "生成" : "引用"}它的 ${src.toolName} 调用`}
                        onClick={() => locateCall(src.id)}
                      >
                        定位
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-5 kicker">可用工具</div>
          <ul className="mt-1.5 space-y-1">
            {agent.tools.map((t) => (
              <li key={t.name} className="font-mono text-[11.5px] text-mist-500">
                {t.name}
              </li>
            ))}
          </ul>
        </aside>

        {readerOpen && (
          <SideReader
            tabs={readerTabs}
            splitRequest={readerSplitReq}
            activeIndex={readerActive}
            onSelect={setReaderActive}
            onCloseTab={closeTab}
            onReorder={reorderTabs}
            onCloseAll={(keep) => {
              const next = readerTabs.filter((t) => keep.includes(readerKey(t)));
              const activeKeyNow = readerTabs[readerActive] ? readerKey(readerTabs[readerActive]!) : "";
              const idx = next.findIndex((t) => readerKey(t) === activeKeyNow);
              setReaderTabs(next);
              setReaderActive(idx >= 0 ? idx : 0);
              if (next.length === 0) setReaderOpen(false);
            }}
            onClose={closeReader}
          />
        )}
      </div>
    </div>
  );
}

const KIND_LEGEND = [
  { id: "run_started", label: "运行开始", color: "#38bdf8" },
  { id: "tool_start", label: "工具调用", color: "#22d3ee" },
  { id: "agent_text", label: "结论输出", color: "#34d399" },
  { id: "agent_status", label: "状态", color: "#64798f" },
  { id: "run_completed", label: "运行结束", color: "#a3e635" },
  { id: "run_failed", label: "运行失败", color: "#fb7185" },
];

const kindColor = (k: string) => KIND_LEGEND.find((x) => x.id === k)?.color ?? "#64798f";

function TimelineView({
  instruction,
  items,
  toolCalls,
  citations,
  artifacts,
  onOpenUrl,
  onRerun,
  autoFollow,
  onToggleAutoFollow,
}: {
  instruction: string;
  items: ReturnType<typeof useTaskEvents>["timeline"];
  toolCalls: ReturnType<typeof useTaskEvents>["toolCalls"];
  citations: Citation[];
  artifacts: ArtifactInfo[];
  onOpenUrl: (target: ReaderTarget) => void;
  onRerun: () => void;
  autoFollow: boolean;
  onToggleAutoFollow: () => void;
}) {
  const kindCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) m[it.kind] = (m[it.kind] ?? 0) + 1;
    return m;
  }, [items]);

  // 按工具名聚合：调用次数 / 成功数 / 平均耗时
  const toolStats = useMemo(() => {
    const m = new Map<string, { n: number; ok: number; sum: number }>();
    for (const c of toolCalls) {
      const e = m.get(c.toolName) ?? { n: 0, ok: 0, sum: 0 };
      e.n += 1;
      if (c.ok === true) e.ok += 1;
      if (c.endedAt) e.sum += Math.max(0, (Date.parse(c.endedAt) - Date.parse(c.at)) / 1000);
      m.set(c.toolName, e);
    }
    return [...m.entries()]
      .map(([name, e]) => ({ name, n: e.n, ok: e.ok, avg: (e.sum / Math.max(1, e.n)).toFixed(1) }))
      .sort((a, b) => b.n - a.n);
  }, [toolCalls]);
  const [statsSort, setStatsSort] = useState<"n" | "avg">("n");
  const toolStatsSorted = useMemo(
    () => [...toolStats].sort((a, b) => (statsSort === "n" ? b.n - a.n : Number(b.avg) - Number(a.avg))),
    [toolStats, statsSort],
  );

  // 事件列表序列化为 Markdown 行（工具入参/返回截断 2000 字）
  // tool_start 事件 ↔ 工具调用记录：按 callId 精确配对，任何子集导出（按次运行 / 过滤视图）都不会挂错
  const callIdxOf = useMemo(() => matchToolCalls(items, toolCalls), [items, toolCalls]);
  const callOfItem = useMemo(() => {
    const map = new Map<TItem, (typeof toolCalls)[number] | undefined>();
    items.forEach((it, i) => {
      if (it.kind !== "tool_start") return;
      const idx = callIdxOf[i] ?? -1;
      map.set(it, idx >= 0 ? toolCalls[idx] : undefined);
    });
    return map;
  }, [items, callIdxOf, toolCalls]);

  // 导出用的 JSON 片段：超长时明确标注截断，避免交付物看起来像完整数据
  const clipJson = (v: unknown): string => {
    const s = JSON.stringify(v, null, 2);
    return s.length > 2000 ? `${s.slice(0, 2000)}\n…（已截断，完整内容见工具调用记录）` : s;
  };

  // 每次运行的时间窗与归属产物：导出 MD 与运行头部角标共用同一套判定
  const windows = useMemo(() => runWindows(items), [items]);
  const artsOfRun = (runIdx: number) => artifactsOfRun(artifacts, windows.find((w) => w.run === runIdx));

  const buildMd = (list: TItem[]): string[] => {
    const lines: string[] = [];
    for (const it of list) {
      if (it.kind === "tool_start") {
        const name = String((it.payload as { toolName?: string } | undefined)?.toolName ?? "");
        const call = callOfItem.get(it);
        lines.push(
          `## ${it.at} 工具 ${name}（${!call || call.ok === null ? "执行中" : call.ok ? "成功" : "失败"}）`,
          "",
          "```json",
          clipJson(call?.args ?? null),
          "```",
          "",
        );
        if (call && call.ok !== null) {
          lines.push("返回：", "", "```json", clipJson(call.result), "```", "");
        }
      } else if (it.kind === "agent_text") {
        lines.push(`## ${it.at} 结论输出`, "", it.detail ?? "", "");
      } else {
        lines.push(`- ${it.at} ${it.title}${it.detail ? `：${it.detail}` : ""}`);
      }
    }
    return lines;
  };

  const downloadRun = (runIdx: number) => {
    const list = items.filter((_, i2) => runInfo.of[i2] === runIdx);
    const win = windows.find((w) => w.run === runIdx);
    const arts = artifactsOfRun(artifacts, win);
    const lines = [
      `# 第 ${runIdx} 次运行时间线`,
      "",
      `- 事件数 ${list.length}`,
      `- 时间窗：${win ? `${win.start} ~ ${win.end ?? "（未结束）"}` : "（无 run_started 事件）"}`,
      `- 本次运行产物：${arts.length} 份`,
      "",
      ...buildMd(list),
      "## 本次运行产物",
      "",
      ...artifactTable(arts, "（本次运行未生成产物）"),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `运行${runIdx}-时间线-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  type TItem = (typeof items)[number];
  const isVisible = (it: TItem) => {
    if (view === "tools" && it.kind !== "tool_start" && it.kind !== "run_started") return false;
    if (view === "text" && !["agent_text", "run_started", "run_completed", "run_failed"].includes(it.kind)) {
      return false;
    }
    if (view === "fails" && it.kind !== "tool_start" && it.kind !== "run_failed") return false;
    const qq = tlQuery.trim().toLowerCase();
    if (qq && it.kind !== "tool_start" && !`${it.title} ${it.detail ?? ""}`.toLowerCase().includes(qq)) return false;
    if (legendKind && it.kind !== legendKind) return false;
    return true;
  };
  const counters = useRef<Record<string, number>>({});
  counters.current = {};
  const lastTextId = [...items].reverse().find((t) => t.kind === "agent_text" && t.detail)?.id;
  const [collapseOld, setCollapseOld] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const [legendKind, setLegendKind] = useState<string | null>(null);
  const runInfo = useMemo(() => {
    let cur = 0;
    const counts: number[] = [];
    const of: number[] = [];
    for (const it of items) {
      if (it.kind === "run_started") cur += 1;
      of.push(cur);
      counts[cur] = (counts[cur] ?? 0) + 1;
    }
    return { of, counts, max: cur };
  }, [items]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"all" | "tools" | "text" | "fails">("all");
  const [tlQuery, setTlQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const [showTs, setShowTs] = useState(false);
  const fmtTs = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  if (items.length === 0) {
    return <div className="py-10 text-center text-[13px] text-mist-600">等待执行事件…</div>;
  }

  return (
    <div className="space-y-4" ref={listRef}>
      <div className="flex gap-1.5">
        {(
          [
            ["all", "全部"],
            ["tools", "仅工具"],
            ["text", "仅结论"],
            ["fails", "仅看失败"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              view === id
                ? "border-glow-500 bg-glow-500/15 text-glow-300"
                : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowTs((v) => !v)}
          title="显示每条事件的时间戳（调试视角）"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            showTs ? "border-glow-500 bg-glow-500/15 text-glow-300" : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
          }`}
        >
          时间戳
        </button>
        <button
          type="button"
          className="action-btn"
          title="折叠全部工具行"
          onClick={() =>
            listRef.current?.querySelectorAll<HTMLDetailsElement>("details.tool-row").forEach((d) => {
              d.open = false;
            })
          }
        >
          折叠全部
        </button>
        <button
          type="button"
          className="action-btn"
          title="展开全部工具行"
          onClick={() =>
            listRef.current?.querySelectorAll<HTMLDetailsElement>("details.tool-row").forEach((d) => {
              d.open = true;
            })
          }
        >
          展开全部
        </button>
        <button
          type="button"
          className="action-btn"
          title="复制事件流 JSON（seq/kind/at/detail 截断 120 字，调试用）"
          onClick={() =>
            copyText(
              JSON.stringify(
                items.map((t) => ({ seq: t.seq, kind: t.kind, at: t.at, detail: (t.detail ?? "").slice(0, 120) })),
                null,
                2,
              ),
            )
          }
        >
          <IconCopy className="h-3 w-3" />
          事件 JSON
        </button>
        <button
          type="button"
          className="action-btn"
          title="复制当前视图条件与可见事件摘要"
          onClick={() => {
            const visible = items.filter(isVisible);
            const lines = [
              `视图：view=${view} 过滤=${tlQuery || "(无)"} 隔离=${legendKind ?? "(无)"} 时间戳=${showTs ? "开" : "关"}`,
              `可见事件 ${visible.length}/${items.length}`,
              ...visible
                .slice(0, 50)
                .map((it) => `#${it.seq} ${it.kind} ${it.at} ${(it.detail ?? it.title).replace(/\s+/g, " ").slice(0, 60)}`),
            ];
            copyText(lines.join("\n"));
          }}
        >
          <IconCopy className="h-3 w-3" />
          复制视图
        </button>
        <button
          type="button"
          className="action-btn"
          title="导出当前视图时间线为 Markdown 文件"
          onClick={() => {
            const lines = [
              "# 执行时间线导出",
              "",
              `- 视图：view=${view} 过滤=${tlQuery || "(无)"} 隔离=${legendKind ?? "(无)"}`,
              `- 事件数 ${items.filter(isVisible).length}/${items.length}`,
              "",
            ];
            lines.push(...buildMd(items.filter(isVisible)));
            const unattr = unattributedArtifacts(artifacts, windows);
            lines.push(
              "## 产物清单（按运行归属）",
              "",
              ...windows.flatMap((w) => [
                `### 第 ${w.run} 次运行（${w.start} ~ ${w.end ?? "未结束"}）`,
                "",
                ...artifactTable(artifactsOfRun(artifacts, w), "（本次运行未生成产物）"),
              ]),
            );
            if (unattr.length > 0) {
              lines.push("### 未归属到具体运行", "", ...artifactTable(unattr, ""));
            }
            const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `时间线-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <IconDownload className="h-3 w-3" />
          导出 MD
        </button>
        <button
          type="button"
          onClick={onToggleAutoFollow}
          title="流式输出时是否自动滚动跟随"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            autoFollow
              ? "border-glow-500 bg-glow-500/15 text-glow-300"
              : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
          }`}
        >
          自动跟随
        </button>
        {runInfo.max > 1 && (
          <button
            type="button"
            onClick={() => setCollapseOld((v) => !v)}
            title="将非最新一次运行折叠为单行摘要"
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              collapseOld
                ? "border-glow-500 bg-glow-500/15 text-glow-300"
                : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
            }`}
          >
            折叠历史运行
          </button>
        )}
        <button
          type="button"
          className="action-btn ml-auto"
          title="复制全部工具调用摘要（名称/状态/耗时/关键入参）"
          onClick={() => {
            const lines = toolCalls.map((c, i) => {
              const dur = c.endedAt
                ? `${Math.max(0, (Date.parse(c.endedAt) - Date.parse(c.at)) / 1000).toFixed(1)}s`
                : "执行中";
              const a = c.args as Record<string, unknown> | null;
              const arg =
                a && typeof a === "object"
                  ? (Object.values(a).find((x) => typeof x === "string") as string | undefined)
                  : undefined;
              return `${i + 1}. ${c.toolName} | ${c.ok === null ? "执行中" : c.ok ? "成功" : "失败"} | ${dur}${
                arg ? ` | ${arg.slice(0, 60)}` : ""
              }`;
            });
            copyText(lines.join("\n"));
          }}
        >
          <IconCopy className="h-3 w-3" />
          复制工具摘要
        </button>
        <input
          value={tlQuery}
          onChange={(e) => setTlQuery(e.target.value)}
          placeholder="过滤事件…"
          className="w-28 rounded-full border border-line bg-night-850 px-2.5 py-0.5 text-[11px] text-mist-100 outline-none placeholder:text-mist-600 focus:glow-ring"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-mist-600">
        {KIND_LEGEND.filter((k) => (kindCounts[k.id] ?? 0) > 0).map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setLegendKind((v) => (v === k.id ? null : k.id))}
            title="点击隔离该类事件（再点取消）"
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 transition-colors ${
              legendKind === k.id ? "border-glow-500 bg-glow-500/10 text-mist-100" : "border-transparent hover:border-line"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: k.color }} />
            {k.label} {kindCounts[k.id]}
          </button>
        ))}
      </div>
      {toolStats.length > 0 && (
        <details className="tool-row glow-card">
          <summary className="flex items-center gap-2 px-3.5 py-2">
            <span className="chev text-[10px] text-glow-400">▶</span>
            <IconTool className="h-3.5 w-3.5 text-glow-400" />
            <span className="text-[12px] text-mist-100">工具分组统计</span>
            <button
              type="button"
              className="action-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setStatsSort((v) => (v === "n" ? "avg" : "n"));
              }}
              title="切换排序：调用次数 / 平均耗时"
            >
              排序：{statsSort === "n" ? "次数" : "均耗时"}
            </button>
            <span className="ml-auto text-[11px] text-mist-600">{toolStats.length} 种工具</span>
          </summary>
          <div className="border-t border-line px-3.5 py-2">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-mist-600">
                  <th className="py-0.5 text-left font-normal">工具</th>
                  <th className="text-right font-normal">调用</th>
                  <th className="text-right font-normal">成功</th>
                  <th className="text-right font-normal">均耗时</th>
                </tr>
              </thead>
              <tbody className="font-mono text-mist-300">
                {toolStatsSorted.map((s) => (
                  <tr key={s.name}>
                    <td className="py-0.5 pr-2">{s.name}</td>
                    <td className="text-right">{s.n}</td>
                    <td className="text-right text-jade-400">
                      {s.ok}/{s.n}
                    </td>
                    <td className="text-right">{s.avg}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className="flex justify-end">
        <div className="user-bubble max-w-[78%] whitespace-pre-wrap px-4 py-2.5 text-[13px] leading-6">
          {instruction}
        </div>
      </div>

      {items.map((item, ii) => {
        const runIdx = runInfo.of[ii] ?? 0;
        const cls = runIdx > 1 ? "ml-3 border-l-2 border-line/70 pl-3" : "";
        const runArts = runIdx > 0 ? artsOfRun(runIdx) : [];
        if (collapseOld && runIdx > 0 && runIdx < runInfo.max && !expandedRuns.has(runIdx)) {
          if (item.kind === "run_started") {
            return (
              <div key={item.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="action-btn flex-1 justify-between"
                  onClick={() => setExpandedRuns((prev) => new Set(prev).add(runIdx))}
                >
                  第 {runIdx} 次运行 · {runInfo.counts[runIdx] ?? 0} 事件
                  {runArts.length > 0 ? ` · 产物 ${runArts.length}` : ""}（已折叠）
                  <span className="ml-2">点击展开 ▸</span>
                </button>
                <button
                  type="button"
                  className="action-btn"
                  title="导出本次运行时间线 MD"
                  onClick={() => downloadRun(runIdx)}
                >
                  <IconDownload className="h-3 w-3" />
                </button>
              </div>
            );
          }
          return null;
        }
        if (view === "tools" && item.kind !== "tool_start" && item.kind !== "run_started") return null;
        if (
          view === "text" &&
          item.kind !== "agent_text" &&
          item.kind !== "run_started" &&
          item.kind !== "run_completed" &&
          item.kind !== "run_failed"
        ) {
          return null;
        }
        if (view === "fails" && item.kind !== "tool_start" && item.kind !== "run_failed") return null;
        const q = tlQuery.trim().toLowerCase();
        if (q && item.kind !== "tool_start") {
          const hay = `${item.title} ${item.detail ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return null;
        }
        if (legendKind && item.kind !== legendKind) return null;
        if (item.kind === "tool_start") {
          const name = String((item.payload as { toolName?: string } | undefined)?.toolName ?? "");
          const idx = counters.current[name] ?? 0;
          counters.current[name] = idx + 1;
          const call = toolCalls.filter((c) => c.toolName === name)[idx];
          if (view === "fails" && call?.ok !== false) return null;
          if (q && !name.toLowerCase().includes(q)) return null;
          return (
            <div key={item.id} data-tlid={item.id} className={cls}>
              <ToolRow
                name={name}
                call={call}
                ts={showTs ? `#${item.seq} ${fmtTs(item.at)}` : undefined}
                autoOpen={call === undefined || call.ok === null}
              />
            </div>
          );
        }
        if (item.kind === "tool_end") return null;

        const isFail = item.kind === "run_failed";
        const isDone = item.kind === "run_completed";
        const isText = item.kind === "agent_text";

        if (!isText && !isFail && !isDone && item.kind !== "agent_status" && item.kind !== "run_started") {
          return null;
        }

        if (item.kind === "agent_status" || item.kind === "run_started") {
          if (item.kind === "run_started") {
            if (runIdx > 1) {
              return (
                <div key={item.id} className="flex items-center gap-3 pt-3">
                  <span className="h-px flex-1 bg-line" />
                  <span
                    className="text-[11px] text-mist-600"
                    title={
                      runArts.length > 0
                        ? `本次运行产物：${runArts.map((a) => `${a.name}（${fmtBytes(a.byteSize)}）`).join("、")}`
                        : "本次运行未生成产物"
                    }
                  >
                    第 {runIdx} 次运行（续跑）
                    {runArts.length > 0 ? ` · 产物 ${runArts.length}` : ""}
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              );
            }
          }
          return (
            <div
              key={item.id}
              data-tlid={item.id}
              className={`group flex items-center gap-2 text-[11.5px] text-mist-600 ${cls}`}
            >
              {showTs && (
                <span className="font-mono text-[9.5px] text-mist-600">{`#${item.seq} ${fmtTs(item.at)}`}</span>
              )}
              <span className="h-1 w-1 rounded-full" style={{ background: kindColor(item.kind) }} />
              {item.detail ?? item.title}
              <button
                type="button"
                className="action-btn ml-auto opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 group-hover:opacity-100"
                title="复制本事件 JSON"
                onClick={() =>
                  copyText(
                    JSON.stringify(
                      { seq: item.seq, kind: item.kind, at: item.at, detail: item.detail ?? null, payload: item.payload ?? null },
                      null,
                      2,
                    ),
                  )
                }
              >
                <IconCopy className="h-3 w-3" />
              </button>
            </div>
          );
        }

        return (
          <div key={item.id} data-tlid={item.id} className={`group glow-card relative px-4 py-3 ${cls}`}>
            <span
              className="absolute left-1.5 top-3 h-1.5 w-1.5 rounded-full"
              style={{ background: kindColor(item.kind) }}
              title={item.kind}
            />
            {showTs && (
              <div className="mb-1 font-mono text-[9.5px] text-mist-600">{`#${item.seq} ${fmtTs(item.at)}`}</div>
            )}
            {isText && (
              <button
                type="button"
                className="action-btn absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => copyText(item.detail ?? "")}
                title="复制本条结论"
              >
                <IconCopy className="h-3 w-3" />
              </button>
            )}
            {isText && (
              <div
                className={
                  !item.streaming && !expanded.has(item.id) && (item.detail ?? "").length > 1200
                    ? "relative max-h-64 overflow-hidden"
                    : undefined
                }
              >
                <MarkdownView
                  text={item.detail ?? ""}
                  live={item.streaming}
                  onOpenUrl={(url) => onOpenUrl({ kind: "url", url })}
                />
                {!item.streaming && !expanded.has(item.id) && (item.detail ?? "").length > 1200 && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-night-900 to-transparent" />
                )}
              </div>
            )}
            {isText && !item.streaming && !expanded.has(item.id) && (item.detail ?? "").length > 1200 && (
              <button
                type="button"
                className="action-btn mt-1"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    next.add(item.id);
                    return next;
                  })
                }
              >
                展开全文（{(item.detail ?? "").length} 字）
              </button>
            )}
            {isText && item.streaming && (
              <>
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-glow-400 align-middle" />
                <span className="ml-2 font-mono text-[10.5px] text-mist-600">{(item.detail ?? "").length} 字</span>
              </>
            )}
            {isText && item.id === lastTextId && !item.streaming && (
              <>
                {citations.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {citations.map((c) => (
                      <button
                        key={c.url}
                        type="button"
                        onClick={() => onOpenUrl({ kind: "url", url: c.url })}
                        title={c.url}
                        className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-glow-500/40 bg-glow-500/10 px-2.5 py-0.5 text-[11px] text-glow-300 transition-colors hover:border-glow-400"
                      >
                        <IconExternal className="h-3 w-3 shrink-0" />
                        <span className="truncate">{c.title}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2.5 flex items-center gap-1 border-t border-line pt-2">
                  <button type="button" className="action-btn" onClick={() => copyText(item.detail ?? "")}>
                    <IconCopy className="h-3.5 w-3.5" />
                    复制
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => copyText(toPlainText(item.detail ?? ""))}
                    title="复制去除 Markdown 语法的纯文本"
                  >
                    <IconCopy className="h-3.5 w-3.5" />
                    复制纯文本
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    title="复制渲染后的结论 HTML"
                    onClick={() => copyText(marked.parse(item.detail ?? "", { async: false }) as string)}
                  >
                    <IconCopy className="h-3.5 w-3.5" />
                    复制 HTML
                  </button>
                  <button type="button" className="action-btn" onClick={onRerun} title="重新执行本任务">
                    <IconRefresh className="h-3.5 w-3.5" />
                    重新生成
                  </button>
                  <span className="ml-auto text-[11px] text-mist-600">
                    {citations.length > 0 ? `${citations.length} 条联网引用` : "无联网引用"}
                  </span>
                </div>
              </>
            )}
            {isDone && (
              <span className="inline-flex items-center gap-1 text-[12px] text-jade-400">
                <IconCheck className="h-3.5 w-3.5" />
                本次运行已结束
              </span>
            )}
            {isFail && (
              <span className="inline-flex items-center gap-1 text-[12px] text-rose-300">
                <IconAlert className="h-3.5 w-3.5" />
                {item.detail ?? "运行异常终止"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolRow({
  name,
  call,
  ts,
  autoOpen = false,
}: {
  name: string;
  call:
    | { args: unknown; result: unknown; ok: boolean | null; at: string; endedAt: string | null }
    | undefined;
  ts?: string;
  autoOpen?: boolean;
}) {
  const isSearch = SEARCH_TOOLS.has(name);
  const duration =
    call && call.ok !== null && call.endedAt
      ? `${Math.max(0, (Date.parse(call.endedAt) - Date.parse(call.at)) / 1000).toFixed(1)}s`
      : "";
  // 折叠态显示首个字符串入参作为摘要（如检索词、文件路径）
  const argPreview = (() => {
    const a = call?.args as Record<string, unknown> | null | undefined;
    if (!a || typeof a !== "object") return "";
    const v = Object.values(a).find((x) => typeof x === "string" && x.trim().length > 0);
    if (typeof v !== "string") return "";
    return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  })();
  // 成功时结果首关键字段预览（如 accuracyPercent、count）
  const resultPreview = (() => {
    if (!call || call.ok !== true || typeof call.result !== "string") return "";
    try {
      const r = JSON.parse(call.result) as Record<string, unknown>;
      if (!r || typeof r !== "object") return "";
      const entry = Object.entries(r).find(
        ([, v]) => typeof v === "number" || (typeof v === "string" && v.length > 0 && v.length <= 24),
      );
      if (!entry) return "";
      return `${entry[0]}: ${String(entry[1])}`;
    } catch {
      return "";
    }
  })();
  // 失败时提取错误原因一行摘要（error/message/detail 或原文首行）
  const errorPreview = (() => {
    if (!call || call.ok !== false || typeof call.result !== "string") return "";
    const clip = (v: string) => (v.length > 48 ? `${v.slice(0, 48)}…` : v);
    try {
      const r = JSON.parse(call.result) as Record<string, unknown>;
      const v = r?.error ?? r?.message ?? r?.detail;
      if (typeof v === "string" && v.length > 0) return clip(v);
      return "";
    } catch {
      const first = (call.result.split("\n")[0] ?? "").trim();
      return first ? clip(first) : "";
    }
  })();
  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  return (
    <details
      className="tool-row glow-card"
      ref={(el) => {
        // 运行中的工具行挂载时自动展开，便于观察入参/返回流
        if (el && autoOpen && !el.dataset.init) {
          el.open = true;
          el.dataset.init = "1";
        }
      }}
    >
      <summary className="flex items-center gap-2 px-3.5 py-2">
        {ts && <span className="font-mono text-[9.5px] text-mist-600">{ts}</span>}
        <IconTool className="h-3.5 w-3.5 text-glow-400" />
        <span className="font-mono text-[12px] text-mist-100">{name}</span>
        {argPreview && <span className="min-w-0 flex-1 truncate text-[11px] text-mist-600">{argPreview}</span>}
        {isSearch && (
          <span className="rounded border border-glow-500/40 bg-glow-500/10 px-1.5 py-0.5 text-[10px] text-glow-300">
            联网
          </span>
        )}
        {duration && <span className="ml-auto font-mono text-[10.5px] text-mist-600">{duration}</span>}
        <span className={duration ? "text-[11px]" : "ml-auto text-[11px]"}>
          {call?.ok === null || call === undefined ? (
            <span className="inline-flex items-center gap-1 text-amber-300">
              <IconSpinner className="h-3 w-3" />
              执行中
            </span>
          ) : call.ok ? (
            <span className="inline-flex items-center gap-1 text-jade-400">
              <IconCheck className="h-3 w-3" />
              完成
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-rose-300">
              <IconAlert className="h-3 w-3" />
              失败
            </span>
          )}
        </span>
        {errorPreview && (
          <span className="max-w-[160px] truncate text-[10.5px] text-rose-300/90" title={errorPreview}>
            {errorPreview}
          </span>
        )}
        {resultPreview && (
          <span className="max-w-[140px] truncate text-[10.5px] text-jade-400/80" title={resultPreview}>
            {resultPreview}
          </span>
        )}
        <span className="chev ml-1 text-[10px] text-glow-400">▶</span>
      </summary>
      <div className="grid gap-3 border-t border-line px-3.5 py-2.5 md:grid-cols-2">
        <div>
          <div className="flex items-center justify-between">
            <div className="kicker">入参</div>
            <button
              type="button"
              className="action-btn"
              title="复制入参 JSON"
              onClick={() => copyText(JSON.stringify(call?.args ?? null, null, 2))}
            >
              复制
            </button>
          </div>
          <pre className="mt-1 max-h-52 overflow-auto rounded bg-night-950 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-mist-300">
            {JSON.stringify(call?.args ?? null, null, 2)}
          </pre>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <div className="kicker">返回</div>
            <button
              type="button"
              className="action-btn"
              title="复制返回 JSON"
              onClick={() => copyText(JSON.stringify(call?.result ?? null, null, 2))}
            >
              复制
            </button>
          </div>
          <pre className="mt-1 max-h-52 overflow-auto rounded bg-night-950 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-mist-300">
            {call?.ok === null || call === undefined ? "—" : JSON.stringify(call.result, null, 2)}
          </pre>
        </div>
      </div>
    </details>
  );
}

function ResultView({
  result,
  error,
  status,
  citations,
  onOpenUrl,
  onDownloadReport,
  onDownloadCitations,
  onDownloadBibtex,
  onCopyBibtex,
  onCopyBundle,
  delivery,
  onPrint,
  annotations,
  onAnnotateClick,
  fs,
  onFs,
  onExportBundle,
  linkChecks,
  linkBusy,
  linkCheckedAt,
  linkSummary,
  onCheckLinks,
}: {
  result: string;
  error: string | null;
  status: string;
  citations: Citation[];
  onOpenUrl: (target: ReaderTarget) => void;
  onDownloadReport: () => void;
  onDownloadCitations: () => void;
  onDownloadBibtex: () => void;
  onCopyBibtex: () => void;
  onCopyBundle: () => void;
  delivery: CheckResult;
  annotations?: Annotation[];
  onAnnotateClick?: (key: string) => void;
  onPrint: () => void;
  fs: "sm" | "md" | "lg";
  onFs: (v: "sm" | "md" | "lg") => void;
  onExportBundle: () => void;
  /** 引用链接核验：结果、进行中状态、最近核验时间与触发回调 */
  linkChecks: Record<string, LinkCheck>;
  linkBusy: boolean;
  linkCheckedAt: string | null;
  linkSummary: LinkSummary;
  onCheckLinks: () => void;
}) {
  if (error) {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-300">
        <div className="font-medium">执行失败</div>
        <div className="mt-1 break-words">{error}</div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="py-10 text-center text-[13px] text-mist-600">
        {status === "processing" ? "Agent 正在执行…" : "暂无执行结论"}
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-5">
      <article className="glow-card px-6 py-5">
        <MarkdownView
          text={result}
          onOpenUrl={(url) => onOpenUrl({ kind: "url", url })}
          headingIds
          className={fs === "md" ? "" : `fs-${fs}`}
          annotations={annotations}
          onAnnotateClick={onAnnotateClick}
        />
      </article>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className="action-btn"
          onClick={() => void navigator.clipboard?.writeText(result).catch(() => undefined)}
        >
          <IconCopy className="h-3.5 w-3.5" />
          复制 Markdown
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={() => void navigator.clipboard?.writeText(toPlainText(result)).catch(() => undefined)}
        >
          <IconCopy className="h-3.5 w-3.5" />
          复制纯文本
        </button>
        <button
          type="button"
          className="action-btn"
          title="复制渲染后的 HTML 片段"
          onClick={() =>
            void navigator.clipboard?.writeText(marked.parse(result, { async: false }) as string).catch(() => undefined)
          }
        >
          <IconCopy className="h-3.5 w-3.5" />
          复制 HTML
        </button>
        <span
          className={`rounded px-1.5 py-0.5 text-[10.5px] ${
            delivery.verdict === "可交付"
              ? "bg-jade-400/15 text-jade-300"
              : delivery.verdict === "谨慎交付"
                ? "bg-amber-400/15 text-amber-300"
                : "bg-rose-400/15 text-rose-300"
          }`}
          title={`交付自检：阻断 ${delivery.blocks} 项 · 提醒 ${delivery.warns} 项\n${delivery.items
            .map((x) => `${x.level === "block" ? "✗" : x.level === "warn" ? "!" : "✓"} ${x.text}`)
            .join("\n")}`}
        >
          交付自检：{delivery.verdict}
        </span>
        <button type="button" className="action-btn" onClick={onPrint}>
          <IconPrint className="h-3.5 w-3.5" />
          打印 / PDF
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={onExportBundle}
          title="导出元信息 + 目录 + 结论 + 引用 + 产物溯源 + 工具调用清单 + 复核记录的单文件"
        >
          <IconDownload className="h-3.5 w-3.5" />
          导出整页
        </button>
        <button type="button" className="action-btn" onClick={onDownloadReport}>
          <IconDownload className="h-3.5 w-3.5" />
          下载报告
        </button>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-mist-600">
          字号
          {(["sm", "md", "lg"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="seg-tab !px-2 !py-0.5 !text-[10.5px]"
              data-on={fs === k}
              onClick={() => onFs(k)}
              title={`切换${k === "sm" ? "小" : k === "md" ? "中" : "大"}字号`}
            >
              {k === "sm" ? "小" : k === "md" ? "中" : "大"}
            </button>
          ))}
        </span>
      </div>

      {citations.length > 0 && (
        <div>
          <div className="flex items-center gap-2">
            <span className="kicker">联网引用</span>
            <span className="rounded bg-glow-500/15 px-1.5 py-0.5 font-mono text-[10px] text-glow-300">
              {citations.length}
            </span>
            <button
              type="button"
              className="action-btn"
              title="复制引用清单（编号+标题+URL）"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(citations.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}`).join("\n"))
                  .catch(() => undefined)
              }
            >
              <IconCopy className="h-3 w-3" />
              复制清单
            </button>
            <button
              type="button"
              className="action-btn disabled:cursor-not-allowed disabled:opacity-40"
              disabled={linkBusy}
              title="按需核验全部引用链接是否仍可访问（服务端 GET，8 秒超时，不下载正文）"
              onClick={onCheckLinks}
            >
              {linkBusy ? "核验中…" : linkCheckedAt ? "重新核验链接" : "核验链接"}
            </button>
          </div>
          {linkCheckedAt && (
            <p className="mt-1.5 text-[11px] text-mist-600">
              最近核验 {new Date(linkCheckedAt).toLocaleString("zh-CN", { hour12: false })} · 可访问 {linkSummary.ok}/
              {linkSummary.total}
              {linkSummary.dead > 0 && <span className="text-rose-300"> · 失效 {linkSummary.dead}</span>}
              {linkSummary.blocked > 0 && (
                <span className="text-sky-300"> · 拒绝自动访问 {linkSummary.blocked}</span>
              )}
              {linkSummary.unreachable > 0 && <span> · 无法核验 {linkSummary.unreachable}</span>}
              {linkSummary.dead > 0 && <span className="text-rose-300">（失效链接交付前请替换或补充依据）</span>}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {citations.map((c) => {
              const chk = linkChecks[c.url];
              const verdict = chk ? linkVerdict(chk) : null;
              return (
                <button
                  key={c.url}
                  type="button"
                  onClick={() => onOpenUrl({ kind: "url", url: c.url })}
                  title={
                    chk && verdict
                      ? `${c.url}\n核验：${
                          verdict === "ok"
                            ? `可访问 HTTP ${chk.status}`
                            : `${VERDICT_TEXT[verdict]}（${chk.status ?? chk.error ?? "无响应"}）· ${VERDICT_HINT[verdict]}`
                        } · ${chk.ms} ms`
                      : c.url
                  }
                  className={`inline-flex max-w-full items-center gap-1.5 rounded-full border bg-night-850 px-2.5 py-1 text-[11.5px] transition-colors ${
                    verdict === "dead"
                      ? "border-rose-400/50 text-rose-200 hover:border-rose-400"
                      : "border-line text-mist-300 hover:border-glow-500 hover:text-glow-300"
                  }`}
                >
                  <IconExternal className="h-3 w-3 shrink-0 text-glow-400" />
                  <span className="truncate">{c.title}</span>
                  {chk && verdict && (
                    <span
                      className={`shrink-0 rounded px-1 font-mono text-[9.5px] ${
                        verdict === "ok"
                          ? "bg-jade-400/15 text-jade-300"
                          : verdict === "dead"
                            ? "bg-rose-400/15 text-rose-300"
                            : verdict === "blocked"
                              ? "bg-sky-400/15 text-sky-300"
                              : "bg-night-700 text-mist-500"
                      }`}
                      title={VERDICT_HINT[verdict]}
                    >
                      {verdict === "ok" ? chk.status : VERDICT_TEXT[verdict]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="kicker">交付</div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-mist-600">打印版式</span>
          <ThemeSwitch />
        </div>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <button type="button" onClick={onDownloadReport} className="glow-card px-4 py-3 text-left transition-colors hover:border-glow-500">
            <IconDownload className="h-4 w-4 text-glow-400" />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">审查报告</div>
            <div className="text-[11px] text-mist-600">Markdown · 立即下载</div>
          </button>
          <button type="button" onClick={onPrint} className="glow-card px-4 py-3 text-left transition-colors hover:border-glow-500">
            <IconPrint className="h-4 w-4 text-glow-400" />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">打印 / PDF</div>
            <div className="text-[11px] text-mist-600">浏览器打印导出</div>
          </button>
          <button type="button" onClick={onDownloadCitations} className="glow-card px-4 py-3 text-left transition-colors hover:border-glow-500">
            <IconExternal className="h-4 w-4 text-glow-400" />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">引用清单</div>
            <div className="text-[11px] text-mist-600">{citations.length} 条联网来源</div>
          </button>
          <button type="button" onClick={onDownloadBibtex} className="glow-card px-4 py-3 text-left transition-colors hover:border-glow-500">
            <IconExternal className="h-4 w-4 text-glow-400" />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">BibTeX 引用</div>
            <div className="text-[11px] text-mist-600">{citations.length} 条 @misc 条目</div>
          </button>
          <button type="button" onClick={onCopyBibtex} className="glow-card px-4 py-3 text-left transition-colors hover:border-glow-500">
            <IconCopy className="h-4 w-4 text-glow-400" />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">复制 BibTeX</div>
            <div className="text-[11px] text-mist-600">剪贴板 · @misc 条目</div>
          </button>
          <button type="button" onClick={onCopyBundle} className="glow-card px-4 py-3 text-left transition-colors hover:border-glow-500">
            <IconCopy className="h-4 w-4 text-glow-400" />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">复制整页 MD</div>
            <div className="text-[11px] text-mist-600">剪贴板 · 含元信息/目录/引用</div>
          </button>
        </div>
      </div>
    </div>
  );
}
