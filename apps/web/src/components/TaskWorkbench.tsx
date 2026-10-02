import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { marked } from "marked";
import { api } from "../api.ts";
import { downloadBlob, downloadText } from "../download.ts";
import { isStarred, KEYS, readEnum, toggleStarred, writeRaw } from "../local-store.ts";
import { fmtDurationShort, fmtDurationZh, fmtSecondsShort } from "../format.ts";
import { dayStamp, fileStamp } from "../time-format.ts";
import type {
  AgentInfo,
  ArtifactInfo,
  CompareRecord,
  FileInfo,
  LinkCheck,
  RefCheckRecord,
  ReviewRecord,
  TaskInfo,
  TaskIssue,
} from "../types.ts";
import { useTaskEvents } from "../hooks/useTaskEvents.ts";
import { MarkdownView, type Annotation } from "./MarkdownView.tsx";
// 目录、摘要、差异行、关键词段落这些「一句话展示位」不能直接塞结论原文，否则 ###、反引号、
// ** 与表格竖线会原样显示出来。正文渲染仍走 MarkdownView，这里只负责把片段转成可读纯文本。
import { countTables, markdownToPlainText, plainLine, plainSnippet, tocEntries } from "../md-text.ts";
import { readerKey, SideReader, type ReaderTarget } from "./SideReader.tsx";
import { loadTags, saveTags } from "../tags.ts";
import { matchToolCalls } from "../timeline-calls.ts";
import { artifactsOfRun, artifactTable, fmtBytes, runWindows, unattributedArtifacts } from "../run-artifacts.ts";
import { artifactSources } from "../artifact-sources.ts";
import { callStats, toolCallSection } from "../run-tools.ts";
import {
  amountKey,
  classifyUntraced,
  TEXT_AMOUNT_TOOLS,
  traceAmounts,
  UNTRACED_ORIGIN_HINT,
  UNTRACED_ORIGIN_TEXT,
  type UntracedOrigin,
} from "../amount-trace.ts";
import { reviewSection } from "../review-export.ts";
import { deliveryCheck, deliverySection, type CheckInput, type CheckResult } from "../delivery-check.ts";
import {
  ageHours,
  ageText,
  freshness,
  linkVerdict,
  liveLinkChecks,
  summarizeLinkChecks,
  LINK_CHECK_BATCH,
  VERDICT_HINT,
  VERDICT_TEXT,
  type LinkSummary,
} from "../link-check.ts";
import {
  fileTable,
  parseDetail,
  parsedByFileName,
  parseStatusText,
  summarizeParsed,
  type ParsedDoc,
  type ParseSummary,
} from "../file-parse.ts";
import { buildManifest } from "../manifest.ts";
import { DOC_REF_TABLE_LIMIT, SOURCE_VIA_HINT, SOURCE_VIA_TEXT, traceDocRefs } from "../policy-trace.ts";
import { docRefSection } from "../delivery-docref.ts";
import { amountSection } from "../delivery-amount.ts";
import { citeSection } from "../delivery-cite.ts";
import { gradeCitation, GRADE_HINT, GRADE_TEXT, summarizeGrades } from "../citation-grade.ts";
import { offTopicCitationTitles } from "../ref-check.ts";
import { isInterruptedOnRestart, taskStatusLabel } from "../task-status.ts";
import { topDomainWords, topicHint } from "../domain-keywords.ts";
import { deltaDetail, deltaText, deltaVerdict, evidenceDelta, evidenceSnapshot } from "../revision-impact.ts";
import {
  evidenceSheetMarkdown,
  evidenceSheetDocument,
  evidenceSheetRows,
  evidenceSheetTodoGroups,
  NO_TODO_TEXT,
  type SheetInput,
} from "../evidence-sheet.ts";
import {
  buildRevisionInstruction,
  deadLinkTargets,
  citationTargets,
  disclaimedWeakUrls,
  disclaimedWeakItems,
  labeledDocRefTexts,
  pendingRevisionItems,
  settledWeakUrls,
  uncitedWeakItems,
  WEAK_SETTLED_LIST_LIMIT,
  refCheckTargets,
  refKey,
  REF_VERDICT_HINT,
  REF_VERDICT_TEXT,
  revisionCounts,
  summarizeRefChecks,
  toRevisionItems,
  type RefCheckSummary,
} from "../ref-check.ts";
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  MERGED_CITATION_LIMIT,
  retentionNote,
  retentionStats,
  SEARCH_TOOL_NAMES as SEARCH_TOOLS,
  searchEvidence,
  searchEvidenceNote,
  searchFiltering,
  UNCAPPED,
  type SearchEvidence,
} from "../search-evidence.ts";
import {
  bundleButtonLabel,
  bundleButtonTitle,
  bundleFreshness,
  freshnessText,
  type BundleFreshness,
  type ChangeStamp,
} from "../bundle-freshness.ts";
import { reviewCounts } from "../review-export.ts";
import {
  partitionFiles,
  policyHint,
  policyMessage,
  verdictItems,
  type UploadItem,
  type UploadPolicy,
} from "../upload-policy.ts";
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

const STATUS_META: Record<string, { label: string; className: string }> = {
  created: { label: "待执行", className: "border-line bg-night-800 text-mist-500" },
  processing: { label: "执行中", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  waiting_review: { label: "待复核", className: "border-sky-400/40 bg-sky-400/10 text-sky-300" },
  completed: { label: "已完成", className: "border-jade-400/40 bg-jade-400/10 text-jade-400" },
  failed: { label: "已中断", className: "border-rose-400/40 bg-rose-400/10 text-rose-300" },
};

/** 文号复查四级判定的配色（与引用核验四级同一套语义色） */
const REF_VERDICT_CLASS: Record<string, string> = {
  matched: "bg-jade-400/15 text-jade-300",
  candidate: "bg-sky-400/15 text-sky-300",
  empty: "bg-amber-400/15 text-amber-300",
  error: "bg-rose-400/15 text-rose-300",
};

interface Citation {
  title: string;
  url: string;
  /** 留下这条来源的工具名（search_public_cases / fetch_content / fetch_public_document） */
  via: string;
  /** 证据力分级：官方来源（含官方解读页）/ 专业来源 / 证据力弱（门户首页、百科词条、检索页） */
  grade: import("../citation-grade.ts").CitationGrade;
  gradeReason: string;
}

const STEP_RING = 2 * Math.PI * 12;

/** 去除 Markdown 语法，供纯文本复制使用 */
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
  // 政策文号联网复查：结果按任务持久化，面板按需展开
  const [refChecks, setRefChecks] = useState<Record<string, RefCheckRecord>>({});
  const [refBusy, setRefBusy] = useState(false);
  const [refPanelOpen, setRefPanelOpen] = useState(false);
  // 修订指令生成提示（指令本身填进「续跑任务」输入框，由人工核对后提交）
  const [revisionMsg, setRevisionMsg] = useState("");
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
  const [fs, setFs] = useState<"sm" | "md" | "lg">(() =>
    readEnum(KEYS.resultFontSize, ["sm", "md", "lg"] as const, "md"),
  );
  const [autoFollow, setAutoFollow] = useState(true);

  useEffect(() => {
    writeRaw(KEYS.resultFontSize, fs);
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
  const [starred, setStarred] = useState<boolean>(() => isStarred(task.id));
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const liveStatus = status === "created" ? task.status : status;
  const meta = STATUS_META[liveStatus] ?? STATUS_META.created!;
  const running = liveStatus === "processing";
  // failed 有两种事实：服务重启打断（续跑就行）与执行真的失败（要查错误原因）。
  // 徽章在一排操作按钮之间，文案加长会挤动整行，所以徽章只放短标签，完整说法与错误串进 title；
  // 复制文本与核对表没有宽度约束，用完整说法。
  const interrupted = isInterruptedOnRestart({ status: liveStatus, error: task.error });
  const statusLabel =
    liveStatus === "failed" ? (interrupted ? "已中断" : "失败") : (STATUS_META[liveStatus]?.label ?? liveStatus);
  const statusFull = taskStatusLabel(liveStatus, task.error);
  const statusHint =
    liveStatus === "failed"
      ? interrupted
        ? "服务重启打断了执行，结论未完成；续跑即可，不是 Agent 执行出错"
        : (task.error ?? "执行失败")
      : "";

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
      `状态：${statusFull}`,
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

  // 收藏状态以存储为准：侧栏与工作台共用同一个键，翻转后直接拿返回值 setState，
  // 免得两边各算一遍出现「界面亮着、存储里没有」的不一致
  const toggleStar = () => setStarred(toggleStarred(task.id));

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

  // 切换任务时载入已持久化的核验结果（刷新页面不丢），并清掉进行中的状态
  useEffect(() => {
    let cancelled = false;
    setLinkChecks({});
    setLinkCheckedAt(null);
    setLinkBusy(false);
    setRefChecks({});
    setRefBusy(false);
    setRefPanelOpen(false);
    void api
      .listLinkChecks(task.id)
      .then((res) => {
        if (cancelled) return;
        setLinkChecks(Object.fromEntries(res.results.map((r) => [r.url, r])));
        setLinkCheckedAt(res.checkedAt);
      })
      .catch(() => undefined);
    void api
      .listRefChecks(task.id)
      .then((res) => {
        if (cancelled) return;
        setRefChecks(Object.fromEntries(res.checks.map((c) => [c.key, c])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  /** 核验引用链接可达性：GET + 8 秒超时，只取状态不下载正文（URL 由调用方传入，避免依赖顺序） */
  const checkCitationLinks = (urls: string[]) => {
    const unique = [...new Set(urls)];
    if (unique.length === 0 || linkBusy) return;
    setLinkBusy(true);
    // 服务端单次最多核 LINK_CHECK_BATCH 条，而引用清单已改成全量、条数可能超过它
    //（实测有一个任务 34 条）。不分块就会被服务端静默截断，少核的那几条在界面上永远显示未核验，
    // 而清单标题写着总条数——数字对不上。按批顺序跑：每批都会落库，且接口返回的是该任务
    // 全部已核验记录，所以取最后一批的返回即为全量。
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += LINK_CHECK_BATCH) batches.push(unique.slice(i, i + LINK_CHECK_BATCH));
    void (async () => {
      let last: Awaited<ReturnType<typeof api.checkLinks>> | null = null;
      try {
        for (const b of batches) last = await api.checkLinks(task.id, b);
      } catch {
        // 某一批失败不抹掉已核到的：last 仍是上一批的全量结果，照样落进状态
      } finally {
        if (last !== null) {
          setLinkChecks(Object.fromEntries(last.results.map((r) => [r.url, r])));
          setLinkCheckedAt(last.checkedAt);
        }
        setLinkBusy(false);
      }
    })();
  };

  /**
   * 政策文号联网复查：把「无法从留存数据核验」的文号交给服务端用自建检索通道再查一遍，
   * 判定与证据链接按条落库（刷新不丢），并写入事件留痕（交付包随之变为待重新打包）。
   */
  const runRefCheck = (targets: Array<{ key: string; kind: "docref" | "citation"; text: string; context?: string }>) => {
    if (refBusy || targets.length === 0) return;
    setRefBusy(true);
    void api
      .runRefChecks(
        task.id,
        targets.map((t) => ({ kind: t.kind, text: t.text, context: t.context })),
      )
      .then((res) => {
        setRefChecks(Object.fromEntries(res.checks.map((c) => [c.key, c])));
        setRefPanelOpen(true);
      })
      .catch(() => undefined)
      .finally(() => setRefBusy(false));
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
      if (resumeFiles.length > 0) {
        const split = splitByPolicy(resumeFiles);
        if (split.note) flashUpload(split.note, verdictItems(resumeFiles, split.rejected));
        if (split.accepted.length > 0) await api.uploadFiles(task.id, split.accepted);
      }
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

  // 联网引用：工具留存的来源 + 结论正文里直接引用的地址（政策快照链接、修订后写入的替代来源）
  // 提取口径与交付包 manifest 走查、平台看板共用 search-evidence.ts
  //
  // 两份清单，分工明确：allCitations 不截断，供分级汇总、交付自检、整页 MD、manifest 与链接核验用；
  // citations 按界面清单上限截断，只用于渲染胶囊。度量若跟着截断，结论一变长窗口就整体挪动、
  // 构成凭空涨跌——实测有过一个任务真加了 2 条官方原文，却被算成 official 11 → 10 判为「证据质量退步」。
  const allCitations = useMemo<Citation[]>(
    () =>
      mergeCitations(
        extractCitations(toolCalls, UNCAPPED),
        extractTextCitations(finalResult, UNCAPPED),
        UNCAPPED,
      ).map((c) => {
        const g = gradeCitation(c.url, c.title);
        return { title: c.title, url: c.url, via: c.via, grade: g.grade, gradeReason: g.reason };
      }),
    [toolCalls, finalResult],
  );
  const citations = useMemo<Citation[]>(() => allCitations.slice(0, MERGED_CITATION_LIMIT), [allCitations]);

  // 检索留痕：区分「留下了来源」与「只留下查询元数据」，避免把后者误报成没有联网核验
  const searches = useMemo(() => searchEvidence(toolCalls), [toolCalls]);
  const searchNote = useMemo(() => searchEvidenceNote(searches, allCitations.length), [searches, allCitations.length]);
  // 检索时被过滤掉的条数（落库在工具结果的 details.dropped 里），证据核对表用
  const filtering = useMemo(() => searchFiltering(toolCalls), [toolCalls]);
  // 留存正文的截断量：与检索留痕同一批工具调用，这里算一次，界面与交付 MD 共用同一份数字。
  // 此前 retainedChars / omittedChars 落库了却没有任何消费点，截断这件事没人知道。
  const retention = useMemo(() => retentionStats(toolCalls), [toolCalls]);
  const retentionText = useMemo(() => retentionNote(retention), [retention]);

  // 引用证据力汇总：交付自检、整页 MD 与交付包清单共用同一口径（按全量算，不按界面截断算）
  const citationGrades = useMemo(() => summarizeGrades(allCitations), [allCitations]);
  // 两类弱证据引用不必再催办，判据都得回读正文（分级只看地址与标题）：结论里已写明「仅作背景参考，
  // 不作为政策依据」的，以及只在检索留存里、从未进入结论正文的（不是这份交付材料的依据，也没处补标注）
  // 「已声明为背景参考」这一类同样要有逐条明细：它的判据里有一步是「地址认不出就按标题认」，
  // 那是最容易误判的一步，误判会让欠账静默消失（而且数字是变好看的）。计数由明细派生。
  const weakDisclaimedItems = useMemo(
    () => disclaimedWeakItems(allCitations, finalResult),
    [allCitations, finalResult],
  );
  const weakDisclaimedUrls = useMemo(
    () => new Set(weakDisclaimedItems.map((i) => i.url)),
    [weakDisclaimedItems],
  );
  const weakSettledUrls = useMemo(() => settledWeakUrls(allCitations, finalResult), [allCitations, finalResult]);
  // 「未进结论正文」这一类要有逐条明细：复核人核对判据对不对，得能点开原文看一眼，光有一个
  // 「8 条」的计数等于让人相信一个数。计数由明细派生，不再用 settled.size - disclaimed.size 手算，
  // 否则台账报的数与界面清单里列出的条数是两处各算一遍。
  // 还要扣掉「已在结论里声明为背景参考」的那部分：服务端 stats.ts 算 weakUncited 时就是这么扣的，
  // 两边不扣一致的话，界面清单里列出的条数会与台账那一列对不上。
  const weakUncitedItems = useMemo(
    () => uncitedWeakItems(allCitations, finalResult).filter((i) => !weakDisclaimedUrls.has(i.url)),
    [allCitations, finalResult, weakDisclaimedUrls],
  );
  const weakUncited = weakUncitedItems.length;
  const weakOpen = Math.max(0, citationGrades.weak - weakSettledUrls.size);

  // 步骤时间线：提问 → 工具核验 → 联网检索 → 结论生成 → 交付
  const totalDuration = useMemo(() => {
    const start = timeline.find((t) => t.kind === "run_started")?.at;
    const end = [...timeline].reverse().find((t) => t.kind === "run_completed" || t.kind === "run_failed")?.at;
    if (!start || !end) return "";
    const s = (Date.parse(end) - Date.parse(start)) / 1000;
    return fmtDurationZh(s);
  }, [timeline]);

  const liveElapsed = useMemo(() => {
    const start = timeline.find((t) => t.kind === "run_started")?.at;
    if (!running || !start) return "";
    void tick;
    const s = (Date.now() - Date.parse(start)) / 1000;
    return fmtDurationZh(s, 0);
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
    // 条目顺序与 MarkdownView 的 sec-N 锚点一致（同样只取 h2/h3、同样按出现顺序），跳转不会错位
    () => tocEntries(finalResult),
    [finalResult],
  );

  const summary = useMemo(() => {
    if (!finalResult) return null;
    const firstPara =
      finalResult.split(/\n{2,}/).find((s) => s.trim() && !s.startsWith("#") && !s.startsWith("|") && !s.startsWith("```")) ??
      "";
    return {
      firstPara: plainSnippet(firstPara, 220),
      // 分隔行可能带对齐冒号（|:---|---:|），旧正则一张也数不到，见 md-text.ts 的 countTables
      tables: countTables(finalResult),
      mermaids: (finalResult.match(/```mermaid/g) ?? []).length,
      heads: (finalResult.match(/^#{2,4} /gm) ?? []).length,
    };
  }, [finalResult]);

  // 结论关键词云：领域词表计数 Top8（词表与弱证据引用复查的检索补充词共用 domain-keywords.ts）
  const topWords = useMemo(() => topDomainWords(finalResult, 8), [finalResult]);

  const [kwFilter, setKwFilter] = useState<string | null>(null);
  const kwParas = useMemo(() => {
    if (!kwFilter || !finalResult) return [];
    return finalResult
      .split(/\n{2,}/)
      // 先转纯文本再匹配关键词：否则用户搜「加计扣除」，命中的可能是被 ** 包起来的同一段文字，
      // 而显示出来又带着记号，搜到的和看到的不是一回事
      .map((s) => markdownToPlainText(s))
      .filter((s) => s.includes(kwFilter))
      .slice(0, 6)
      .map((s) => plainSnippet(s, 240));
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

  // 本次修订对证据的影响：与「结论较上次运行变化」同一触发条件（存在上一轮结论）
  const revImpact = useMemo(() => {
    if (!prevConclusion || !finalResult) return null;
    return evidenceDelta(evidenceSnapshot(prevConclusion), evidenceSnapshot(finalResult));
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
      return fmtDurationShort(s);
    };
    const concludedAt = [...timeline].reverse().find((t) => t.kind === "run_completed")?.at;
    const lastEnds = toolCalls.filter((c) => c.endedAt).map((c) => Date.parse(c.endedAt ?? c.at));
    const genSpan =
      concludedAt && lastEnds.length > 0
        ? (() => {
            const s = (Date.parse(concludedAt) - Math.max(...lastEnds)) / 1000;
            return s > 0 ? fmtDurationShort(s) : "";
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
        // OCR / 文档解析结果里的金额是正文字符串，与平台统计、交付包走查同一口径地按正文扫一遍
        toolCalls.filter((c) => c.ok !== false && TEXT_AMOUNT_TOOLS.has(c.toolName)).map((c) => c.result),
      ),
    [finalResult, toolCalls, task.instruction],
  );

  // 待人工确认的金额：已核对的不再计入交付自检提醒
  const amountPending = useMemo(
    () => amountTrace.untraced.filter((u) => !(amountKey(u) in amountChecks)),
    [amountTrace, amountChecks],
  );
  const amountAcked = amountTrace.untraced.length - amountPending.length;

  // 待确认金额按「为什么找不到出处」分两类，口径与服务端 stats.ts 完全一致（同一个 classifyUntraced、
  // 同一批检索类调用的结果）。此前只有台账与看板分得开，复核人在任务页上看到的是一整列混在一起，
  // 分不出哪几处是真要拦的、哪几处只需核对引用抄得准不准——而逐条处置恰恰是在这一页做的。
  const amountSplit = useMemo(
    () =>
      classifyUntraced(
        amountPending,
        // 检索结果池不按 ok 过滤：与服务端 stats.ts 同一口径（那边是 parsedCalls.filter(SEARCH_TOOL_NAMES)）。
        // 两边不一致的话，任务页上的分类就会与台账「其中引自联网正文 / 其中三处均无出处」两列对不上。
        toolCalls.filter((c) => SEARCH_TOOLS.has(c.toolName)).map((c) => c.result),
      ),
    [amountPending, toolCalls],
  );
  /** 每个待确认金额属于哪一类（按 amountKey 查）。查不到时按更严的那一类兜底，不默认成轻的 */
  const amountOrigin = useMemo(() => {
    const m = new Map<string, UntracedOrigin>();
    for (const a of amountSplit.web) m.set(amountKey(a), "web");
    for (const a of amountSplit.unexplained) m.set(amountKey(a), "unexplained");
    return m;
  }, [amountSplit]);

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
              label: `待人工确认：该金额未在本次工具调用结果与客户指令中找到出处 · ${
                UNTRACED_ORIGIN_TEXT[amountOrigin.get(key) ?? "unexplained"]
              }——${UNTRACED_ORIGIN_HINT[amountOrigin.get(key) ?? "unexplained"]} 点击标记为已核对\n上下文：…${
                u.context
              }…`,
            };
      }),
    [amountTrace, amountChecks, amountOrigin],
  );

  // 复核页的金额核对清单：与正文就地标注同源，待确认与已核对分列
  const amountReviewItems = useMemo(() => {
    // 同一金额的多种写法合并成一条（键只由值决定），并统计出现处数
    const pend = new Map<
      string,
      { key: string; raw: string; context: string; occurrences: number; origin: UntracedOrigin }
    >();
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
      else
        pend.set(key, {
          key,
          raw: u.raw,
          context: u.context,
          occurrences: 1,
          origin: amountOrigin.get(key) ?? "unexplained",
        });
    }
    return { pend: [...pend.values()], acked: [...acked.values()] };
  }, [amountTrace, amountChecks, amountOrigin]);

  // 链接核验只看当前引用清单里的地址（判据见 link-check.ts 的 liveLinkChecks）。link_checks 按
  // (task_id, url) upsert、从不删行，结论续跑或回滚之后旧地址的记录仍留在库里；全量使用会把早已
  // 不在清单里的地址算成「失效」，交付自检因此报假警（实测引用提取修好之前，带中文尾巴的假地址
  // 核验必然 404，修好后那些行仍挂在库里）。
  //
  // 这一份过滤结果被三个消费点共用：汇总计数、核对表的失效链接待办、交付 MD 的核验明细行。
  // 此前只有汇总过滤了，另两处直接吃 Object.values(linkChecks)，于是同一张核对表里「引用链接
  // 可达性」一行写着失效 0 条、待办却列出 1 条失效链接；同一份交付 MD 里汇总写「非可访问 4 条」
  // 底下却列了 5 行明细（实测 3 个任务各差 1 行）。
  // 交付包新鲜度那处不过滤是有意的：它问的是「打包之后有没有新动作」，不是「当前交付材料里有什么」。
  const liveChecks = useMemo(
    () => liveLinkChecks(Object.values(linkChecks), allCitations.map((c) => c.url)),
    [linkChecks, allCitations],
  );
  // 汇总：可访问 / 失效 / 拒绝自动访问（反爬）/ 无法核验，四类分开计数
  const linkSummary = useMemo(() => summarizeLinkChecks(liveChecks), [liveChecks]);

  // 上传资料的解析摘要：来自 parse_uploaded_files 的真实返回，按文件名对应
  const fileParsed = useMemo(
    () => parsedByFileName(toolCalls.map((c) => ({ toolName: c.toolName, result: c.result }))),
    [toolCalls],
  );

  // 「重新解析」的本地结果：立刻反映到资料行，App 的轮询随后会用服务端状态覆盖
  const [reparse, setReparse] = useState<
    Record<string, { busy?: boolean; status?: string; summary?: ParseSummary; warning?: string | null }>
  >({});
  const reparseFile = (fileId: string) => {
    if (reparse[fileId]?.busy) return;
    setReparse((prev) => ({ ...prev, [fileId]: { ...prev[fileId], busy: true } }));
    void api
      .reparseFile(task.id, fileId)
      .then((res) => {
        setReparse((prev) => ({
          ...prev,
          [fileId]: {
            busy: false,
            status: res.ok ? "parsed" : "failed",
            summary: res.doc ? summarizeParsed(res.doc as ParsedDoc) : undefined,
            warning: res.warning,
          },
        }));
      })
      .catch(() =>
        setReparse((prev) => ({ ...prev, [fileId]: { busy: false, warning: "重新解析请求失败，请稍后再试" } })),
      );
  };

  // 拖拽上传：把文件拖到工作台任意位置即上传到本任务，资料列表由 App 的 3 秒轮询刷新
  const [dropActive, setDropActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadReport, setUploadReport] = useState<{ title: string; items: UploadItem[] } | null>(null);
  const [uploadPolicy, setUploadPolicy] = useState<UploadPolicy | null>(null);
  useEffect(() => {
    void api
      .uploadPolicy()
      .then(setUploadPolicy)
      .catch(() => undefined);
  }, []);

  const flashUpload = (title: string, items: UploadItem[] = []) => {
    setUploadReport({ title, items });
    window.setTimeout(() => setUploadReport((cur) => (cur && cur.title === title ? null : cur)), 12000);
  };

  /** 按服务端策略预检；策略尚未加载时不拦，交给服务端校验，避免误拒 */
  const splitByPolicy = (files: File[]) => {
    if (!uploadPolicy || files.length === 0) {
      return { accepted: files, rejected: [] as Array<{ name: string; reason: string }>, note: "" };
    }
    const split = partitionFiles(files, uploadPolicy);
    return { ...split, note: policyMessage(split.accepted.length, split.rejected) };
  };

  const hasFiles = (e: DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer.types).includes("Files");
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return; // 内部标签拖拽不触发上传态
    e.preventDefault();
    setDropActive(true);
  };
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropActive(false);
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropActive(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length === 0 || uploading) return;
    const split = splitByPolicy(dropped);
    const items = verdictItems(dropped, split.rejected);
    if (split.accepted.length === 0) {
      flashUpload(split.note || "没有可上传的文件", items);
      return;
    }
    setUploading(true);
    flashUpload(`正在上传 ${split.accepted.length} 份资料…${split.note ? `（${split.note}）` : ""}`, items);
    void api
      .uploadFiles(task.id, split.accepted)
      .then((res) =>
        flashUpload(
          `已上传 ${res.files.length} 份资料${split.note ? `；${split.note}` : ""}。点资料行「重新解析」或在续跑里说明即可让 Agent 使用`,
          items,
        ),
      )
      .catch((err: unknown) => flashUpload(`上传失败：${err instanceof Error ? err.message : String(err)}`, items))
      .finally(() => setUploading(false));
  };

  // 复查记录按类型分开统计：文号复查进「文号溯源」口径，引用复查进「联网引用」口径
  const docRefChecks = useMemo(() => Object.values(refChecks).filter((c) => c.kind === "docref"), [refChecks]);
  const citationCheckList = useMemo(() => Object.values(refChecks).filter((c) => c.kind === "citation"), [refChecks]);
  // 复查判定「找到公开出处」的文号原文：与工具留存结果同等算作有出处（看板、证据表、交付清单同一口径）
  const recheckedDocRefTexts = useMemo(
    () => docRefChecks.filter((c) => c.verdict === "matched").map((c) => c.text),
    [docRefChecks],
  );

  // 政策文号溯源：结论里的文号能否找到出处——工具留存结果或联网复查二者其一即可
  //（只用过「只存元数据」的联网检索、又没有复查记录时才标为无法核验）
  const refTrace = useMemo(
    () =>
      traceDocRefs(
        finalResult,
        toolCalls.filter((c) => c.ok !== false).map((c) => c.result),
        toolCalls.map((c) => c.toolName),
        recheckedDocRefTexts,
      ),
    [finalResult, toolCalls, recheckedDocRefTexts],
  );

  // 待复查的文号（待人工确认 + 无法核验）与已有复查结果的汇总
  // 主题词与批量复查同一套 topicHint：上下文里没有发文机关时用它兜底，两个入口检索词一致
  const refTargets = useMemo(() => refCheckTargets(refTrace, topicHint(finalResult, 2)), [refTrace, finalResult]);
  const refSummary = useMemo(() => summarizeRefChecks(docRefChecks), [docRefChecks]);
  const citationSummary = useMemo(() => summarizeRefChecks(citationCheckList), [citationCheckList]);
  // 复查到出处的已经计入 refTrace.traced，不能再从待复查里扣第二遍
  const refPending = useMemo(() => refTrace.untraced.length + refTrace.unverifiable, [refTrace]);
  // 结论里已标注「未取得公开原文，仅作背景参考，不作为政策依据」的文号：交代过就不是待办，
  // 也不再进修订指令与看板欠账（与弱证据的「已声明」同一条原则、同一份判据）
  const docRefLabeledTexts = useMemo(
    () => labeledDocRefTexts([...refTrace.untraced, ...refTrace.unverifiableRefs], finalResult),
    [refTrace, finalResult],
  );
  const docRefLabeled = useMemo(
    () => ({
      untraced: refTrace.untraced.filter((r) => docRefLabeledTexts.has(r.text)).length,
      unverifiable: refTrace.unverifiableRefs.filter((r) => docRefLabeledTexts.has(r.text)).length,
    }),
    [refTrace, docRefLabeledTexts],
  );
  const docRefLabeledTotal = docRefLabeled.untraced + docRefLabeled.unverifiable;
  const refOpen = Math.max(0, refPending - docRefLabeledTotal);

  // 弱证据引用（门户首页 / 百科词条 / 检索页）找可替换的官方原文
  const weakCitations = useMemo(() => allCitations.filter((c) => c.grade === "weak"), [allCitations]);
  const weakTargets = useMemo(
    // 已声明为背景参考的、以及从未进结论正文的都不进检索清单：前者找不到同主题的官方原文，
    // 后者没处写回，点一次只是白跑一轮联网检索（与服务端 pendingCitationTargets 同一道过滤）
    () =>
      citationTargets(weakCitations, topicHint(finalResult, 2), 10, weakSettledUrls),
    [weakCitations, finalResult, weakSettledUrls],
  );
  // 已经找到官方替代来源的弱证据引用（结论没改之前它仍是弱证据，只用于如实标注补救进度）
  const replacedKeys = useMemo(
    () => new Set(citationCheckList.filter((c) => c.verdict === "matched").map((c) => c.key)),
    [citationCheckList],
  );
  const weakReplaced = useMemo(
    () => weakCitations.filter((c) => replacedKeys.has(refKey("citation", c.url))).length,
    [weakCitations, replacedKeys],
  );
  // 证据核对表的待办清单：还没闭环的具体条目
  const sheetTodos = useMemo(() => {
    const matchedDocs = new Set(docRefChecks.filter((c) => c.verdict === "matched").map((c) => c.key));
    return {
      docRefs: refTargets
        .filter((t) => !matchedDocs.has(t.key))
        .filter((t) => !docRefLabeledTexts.has(t.text))
        .map((t) => {
          const rec = refChecks[t.key];
          return rec ? `${t.text}（已复查：${REF_VERDICT_TEXT[rec.verdict]}）` : `${t.text}（未复查）`;
        }),
      weakCitations: weakCitations
        .filter((c) => !replacedKeys.has(refKey("citation", c.url)))
        .filter((c) => !weakSettledUrls.has(c.url))
        .map((c) => `${c.title} ${c.url}`),
      deadLinks: liveChecks
        .filter((r) => linkVerdict(r) === "dead")
        .map((r) => r.url),
    };
  }, [refTargets, docRefChecks, refChecks, weakCitations, replacedKeys, weakSettledUrls, liveChecks]);

  // 修订素材：只取与当前结论对得上、且还没写回过的复查记录，避免上一版结论留下的记录
  // 与已经交代过的项目反复进指令（实测同一节「仅作背景参考」表格被逐轮重写）
  const revisionItems = useMemo(() => {
    const docKeys = new Set(refTargets.map((t) => t.key));
    const citeKeys = new Set(weakTargets.map((t) => t.key));
    return pendingRevisionItems(
      toRevisionItems(
        Object.values(refChecks).filter((c) => (c.kind === "docref" ? docKeys.has(c.key) : citeKeys.has(c.key))),
      ),
      finalResult,
    );
  }, [refChecks, refTargets, weakTargets, finalResult]);
  // 失效链接也是修订素材：链接腐烂此前只能被交付自检发现，没有修复通道，只能人工去改结论正文
  const revisionDeadLinks = useMemo(
    () => deadLinkTargets(Object.values(linkChecks), allCitations),
    [linkChecks, allCitations],
  );
  const revisionCount = useMemo(
    () => revisionCounts(revisionItems, revisionDeadLinks.length),
    [revisionItems, revisionDeadLinks],
  );
  const revisionTotal = revisionCount.total + revisionCount.deadLinks;

  /** 生成修订指令并填入续跑输入框：平台不自动改写结论，改不改由税务师决定 */
  const fillRevisionInstruction = () => {
    const text = buildRevisionInstruction(revisionItems, revisionDeadLinks);
    if (text === "") return;
    setResumeText(text);
    setResumeOpen(true);
    setRevisionMsg(
      `修订指令已填入「续跑任务」（${revisionTotal} 项：可替换或补出处 ${revisionCount.replace} · 待处置 ${
        revisionCount.unresolved
      }（删泛词条 ${revisionCount.drop}／改引具体页 ${revisionCount.narrow}／标注未取得原文 ${
        revisionCount.mark
      }）${revisionCount.deadLinks > 0 ? ` · 失效链接 ${revisionCount.deadLinks}` : ""}），请核对后提交`,
    );
  };

  /** 为弱证据引用检索官方原文：结果落库，需人工确认后写回结论，平台不改写 Agent 的结论 */
  const runCitationRecheck = () => {
    if (refBusy || weakTargets.length === 0) return;
    setRefBusy(true);
    void api
      .runRefChecks(
        task.id,
        weakTargets.map((t) => ({ kind: "citation" as const, text: t.text, url: t.excludeUrl })),
      )
      .then((res) => setRefChecks(Object.fromEntries(res.checks.map((c) => [c.key, c]))))
      .catch(() => undefined)
      .finally(() => setRefBusy(false));
  };

  // 交付自检输入：结论字数、产物与溯源、工具调用结果、待复核与联网引用
  const deliveryInput = (): CheckInput => ({
    status: reopened ? "waiting_review" : task.status,
    error: task.error,
    resultChars: finalResult.trim().length,
    artifacts: artifacts.length,
    unattributedArtifacts: artifacts.filter((a) => !artSrc.has(a.name)).length,
    toolTotal: toolCalls.length,
    toolFailed: toolCalls.filter((c) => c.ok === false).length,
    toolRunning: toolCalls.filter((c) => c.ok === null).length,
    pendingReview: pendingReviews,
    citations: allCitations.length,
    citationGrades:
      allCitations.length > 0
        ? { ...citationGrades, weakDisclaimed: weakDisclaimedUrls.size, weakUncited: weakUncited }
        : null,
    // 与业务主题无关的泛词条引用：这类引用找不到同主题的官方原文，该删而不是该替换
    offTopicCitations: offTopicCitationTitles(allCitations, finalResult),
    searches: searches.calls > 0 ? searches : null,
    linkCheck: linkCheckedAt ? linkSummary : null,
    linkCheckAgeHours: ageHours(linkCheckedAt),
    amountTotal: amountTrace.total,
    amountUntraced: amountPending.length,
    amountPendingWeb: amountSplit.web.length,
    amountPendingUnexplained: amountSplit.unexplained.length,
    filesTotal: files.length,
    filesFailed: files.filter((f) => (reparse[f.id]?.status ?? f.parseStatus) === "failed").length,
    docRefTotal: refTrace.total,
    docRefTraced: refTrace.traced,
    docRefUnverifiable: refTrace.unverifiable,
    docRefUntraced: refTrace.untraced.length,
    docRefRecheck: refSummary.total > 0 ? refSummary : null,
    docRefPending: refPending,
    docRefLabeled,
    citationRecheck: citationSummary.total > 0 ? citationSummary : null,
    revision: revImpact
      ? {
          citations: revImpact.citations,
          official: revImpact.official,
          weak: revImpact.weak,
          docRefs: revImpact.docRefs,
          improved: revImpact.improved,
          regressed: revImpact.regressed,
        }
      : null,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const delivery = useMemo(
    () => deliveryCheck(deliveryInput()),
    [
      reopened,
      task.status,
      finalResult,
      artifacts,
      artSrc,
      toolCalls,
      pendingReviews,
      allCitations,
      citationGrades,
      searches,
      linkSummary,
      linkCheckedAt,
      files,
      reparse,
      amountTrace,
      amountPending,
      refTrace,
      refSummary,
      refPending,
      docRefLabeledTexts,
      citationSummary,
      revImpact,
    ],
  );

  // 证据核对表输入：与界面、交付自检、整页 MD 同一口径；生成时间取当下，故每次渲染重算
  const sheet: SheetInput = {
    taskTitle: task.title,
    caseId: task.caseId,
    agentName: agent.shortName,
    statusText: statusFull,
    generatedAt: new Date().toISOString(),
    delivery: { verdict: delivery.verdict, blocks: delivery.blocks, warns: delivery.warns, infos: delivery.infos },
    docRefs: {
      total: refTrace.total,
      traced: refTrace.traced,
      unverifiable: refTrace.unverifiable,
      untraced: refTrace.untraced.length,
      pending: refPending,
      labeled: docRefLabeledTotal,
    },
    docRefChecks: refSummary,
    citations: {
      total: citationGrades.total,
      official: citationGrades.official,
      professional: citationGrades.professional,
      weak: citationGrades.weak,
      fromTools: allCitations.filter((c) => c.via !== "conclusion").length,
      fromConclusion: allCitations.filter((c) => c.via === "conclusion").length,
      replaced: weakReplaced,
      disclaimed: weakDisclaimedUrls.size,
      uncited: weakUncited,
    },
    citationChecks: {
      total: citationSummary.total,
      matched: citationSummary.matched,
      candidate: citationSummary.candidate,
      empty: citationSummary.empty,
      error: citationSummary.error,
    },
    linkCheck: linkCheckedAt ? { ...linkSummary, checkedAt: linkCheckedAt } : null,
    searches:
      searches.calls > 0
        ? {
            calls: searches.calls,
            withUrls: searches.withUrls,
            metadataOnly: searches.metadataOnly,
            dropped: filtering.dropped,
          }
        : null,
    amounts: {
      total: amountTrace.total,
      traced: amountTrace.traced,
      fromInput: amountTrace.fromInput,
      pending: amountPending.length,
      acked: amountAcked,
      pendingWeb: amountSplit.web.length,
      pendingUnexplained: amountSplit.unexplained.length,
    },
    revision: revImpact ? { verdict: deltaVerdict(revImpact), detail: deltaDetail(revImpact) } : null,
    todos: sheetTodos,
  };

  // 交付包里的工具调用清单整节搬到 run-tools.ts（那个文件的头注释本来就写着「供整页交付 MD 的
  // 工具调用清单一节使用」，只是拼行那段一直留在这里）：留在闭包里就没法单测，合计行五个数字、
  // 分组表头、每行 6 列、行数合计等于调用总数，此前一条断言都没有。

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
    "## 证据核对表",
    "",
    ...evidenceSheetMarkdown(sheet),
    "",
    "## 目录",
    "",
    ...toc.map((h, i) => `${i + 1}. ${h}`),
    "",
    "## 审查结论",
    "",
    finalResult,
    "",
    // 「联网引用」整节搬到 delivery-cite.ts：留在组件闭包里就没法单测，而它是对外声称数字最密的
    // 一节（证据力分级三类 + 弱证据两类 + 仅元数据检索次数 + 替代来源检索四类 + 链接核验五类）。
    // 链接核验的汇总行与明细行在模块里由同一份 liveChecks 就地算出，两者不可能再各说一套。
    ...citeSection({
      revImpact,
      citations: allCitations,
      grades: citationGrades,
      weakDisclaimed: weakDisclaimedUrls.size,
      weakUncited,
      weakOpen,
      searches: { metadataOnly: searches.metadataOnly, tools: searches.tools },
      emptyNote: searchNote,
      citeSummary: citationSummary,
      citeChecks: citationCheckList,
      linkCheckedAt,
      linkChecks: liveChecks,
      retention,
    }),
    "## 业务资料清单",
    "",
    ...fileTable(files, fileParsed),
    "",
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
    ...toolCallSection(toolCalls, runWins),
    "",
    "## 人工复核记录",
    "",
    ...reviewSection(issues, reviews, reopened ? "waiting_review" : task.status),
    "",
    // 「政策文号溯源」整节搬到 delivery-docref.ts：留在组件闭包里就没法单测，新加的那张
    // 「留存正文出处」表因此一条断言都没有（列数、链接、依据档位全靠肉眼）。
    ...docRefSection({ refTrace, refSummary, refChecks: Object.values(refChecks) }),
    // 「结论金额溯源」整节搬到 delivery-amount.ts：留在组件闭包里就没法单测，待确认金额表的
    // 列数、超出上限有没有如实说明、两类拆分有没有写进去，此前全靠下载下来肉眼扫。
    ...amountSection({
      total: amountTrace.total,
      traced: amountTrace.traced,
      fromInput: amountTrace.fromInput,
      pending: amountPending,
      split: amountSplit,
      ackedCount: amountAcked,
      acked: amountReviewItems.acked,
    }),
  ];

  // 打包下载：整页 MD 交服务端与本任务的产物、上传资料合成 zip；失败时退回单文件 MD，保证材料总能拿到
  const [zipBusy, setZipBusy] = useState(false);
  const [zipNote, setZipNote] = useState("");
  /** 交付包的机器可读清单：与整页 MD 同源，便于归档系统检索与后续自动核对 */
  const buildDeliveryManifest = () => {
    const st = callStats(toolCalls);
    const rc = reviewCounts(issues, reviews);
    return buildManifest({
      task: {
        id: task.id,
        title: task.title,
        caseId: task.caseId,
        agentId: task.agentId,
        status: reopened ? "waiting_review" : task.status,
        createdAt: task.createdAt,
        runCount,
      },
      delivery,
      files: files.map((f) => ({
        name: f.fileName,
        type: f.fileType,
        byteSize: f.byteSize,
        uploadedAt: f.createdAt ?? "",
        parseStatus: parseStatusText(reparse[f.id]?.status ?? f.parseStatus),
        parseDetail: parseDetail(reparse[f.id]?.summary ?? fileParsed.get(f.fileName)),
      })),
      artifacts: artifacts.map((a) => {
        const s = artSrc.get(a.name);
        return {
          name: a.name,
          byteSize: a.byteSize,
          updatedAt: a.updatedAt,
          sourceTool: s?.toolName ?? null,
          sourceRole: s ? s.role : null,
          sourceAt: s?.at ?? null,
          run: runOfArtifact(a.name),
        };
      }),
      tools: { total: st.total, ok: st.ok, failed: st.failed, running: st.running, avgMs: st.avgMs },
      citations: allCitations.map((c) => {
        const chk = linkChecks[c.url];
        return {
          title: c.title,
          url: c.url,
          verdict: chk ? linkVerdict(chk) : "unchecked",
          status: chk?.status ?? null,
          grade: c.grade,
          gradeReason: c.gradeReason,
          via: c.via,
        };
      }),
      citationGrades: citations.length > 0 ? citationGrades : null,
      searches: searches.calls > 0 ? searches : null,
      refChecks: refSummary.total > 0 ? refSummary : null,
      citationChecks: citationSummary.total > 0 ? citationSummary : null,
      revision: revImpact
        ? { before: revImpact.before, after: revImpact.after, verdict: deltaVerdict(revImpact) }
        : null,
      linkCheck: { summary: linkCheckedAt ? linkSummary : null, checkedAt: linkCheckedAt },
      amounts: {
        total: amountTrace.total,
        traced: amountTrace.traced,
        fromInput: amountTrace.fromInput,
        pending: amountPending.length,
        acked: amountAcked,
        pendingWeb: amountSplit.web.length,
        pendingUnexplained: amountSplit.unexplained.length,
      },
      review: { issues: rc.total, done: rc.done, pending: rc.pending, notRequired: rc.notRequired },
    });
  };

  // 交付包新鲜度：打包时间取自打包事件的结构化 payload，变更来源覆盖事件/产物/复核/金额核对/链接核验
  const bundleFresh = useMemo(() => {
    let packedAt: string | null = null;
    for (const t of timeline) {
      const p = t.payload as { bundlePacked?: unknown } | undefined;
      if (p?.bundlePacked) packedAt = t.at;
    }
    const changes: ChangeStamp[] = [];
    const lastEvent = timeline[timeline.length - 1];
    if (lastEvent) changes.push({ at: lastEvent.at, label: `事件「${lastEvent.title}」` });
    for (const a of artifacts) changes.push({ at: a.updatedAt, label: `产物 ${a.name}` });
    for (const r of reviews) changes.push({ at: r.createdAt, label: "复核提交" });
    for (const c of Object.values(amountChecks)) {
      if (c.at) changes.push({ at: c.at, label: "金额核对" });
    }
    for (const l of Object.values(linkChecks)) {
      if (l.checkedAt) changes.push({ at: l.checkedAt, label: `链接核验 ${l.url}` });
    }
    for (const c of Object.values(refChecks)) {
      if (c.checkedAt) changes.push({ at: c.checkedAt, label: `文号复查 ${c.text}` });
    }
    return bundleFreshness(packedAt, changes);
  }, [timeline, artifacts, reviews, amountChecks, linkChecks, refChecks]);

  const exportBundleZip = () => {
    if (zipBusy) return;
    const stamp = dayStamp();
    const md = bundleLines().join("\n");
    setZipBusy(true);
    setZipNote("");
    void api
      .bundleZip(task.id, md, `${task.title}-交付包-${stamp}`, buildDeliveryManifest())
      .then((blob) => {
        downloadBlob(blob, `${task.title}-交付包-${stamp}.zip`);
      })
      .catch((err: unknown) => {
        download(`${task.title}-整页-${stamp}.md`, md);
        setZipNote(`打包失败（${err instanceof Error ? err.message : String(err)}），已改为下载整页 MD`);
      })
      .finally(() => setZipBusy(false));
  };

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
    downloadText(name, content, "text/markdown");
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-glow-400/70 bg-night-950/80">
          <div className="rounded-md border border-glow-500/50 bg-night-900 px-4 py-3 text-[13px] text-glow-200">
            松开即可上传到「{task.title}」
            {uploadPolicy && (
              <span className="mt-1 block text-[11px] text-mist-500">{policyHint(uploadPolicy)}</span>
            )}
          </div>
        </div>
      )}
      {uploadReport && (
        <div className="no-print absolute left-1/2 top-3 z-40 w-[380px] max-w-[92%] -translate-x-1/2 rounded-md border border-line bg-night-850 px-3 py-2 shadow-lg">
          <div className="flex items-start gap-2 text-[11.5px] text-mist-200">
            <span className="min-w-0 flex-1">{uploadReport.title}</span>
            <button
              type="button"
              className="action-btn shrink-0 !px-1"
              title="关闭"
              onClick={() => setUploadReport(null)}
            >
              ✕
            </button>
          </div>
          {uploadReport.items.length > 0 && (
            <ul className="mt-1 max-h-[180px] space-y-0.5 overflow-y-auto">
              {uploadReport.items.map((it, i) => (
                <li key={`${it.name}-${i}`} className="flex items-center gap-1.5 text-[11px]">
                  <span className={it.ok ? "shrink-0 text-jade-400" : "shrink-0 text-rose-300"}>
                    {it.ok ? "✓" : "✗"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-mist-400" title={it.name}>
                    {it.name}
                  </span>
                  {!it.ok && <span className="shrink-0 text-rose-300/90">{it.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
              title={statusHint || undefined}
            >
              {running ? (
                <span className="inline-flex items-center gap-1">
                  <IconSpinner className="h-3 w-3" />
                  {statusLabel}
                </span>
              ) : (
                statusLabel
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
              {/* key 带下标：标签是用户自己起的自由文本，同名标签出现两次就撞 key */}
              {tags.map((t, ti) => (
                <span
                  key={`${ti}-${t}`}
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
                  工具 {fmtSecondsShort(toolTime.total)} · 均 {fmtSecondsShort(toolTime.avg)}
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
          // key 带下标：步骤名是自由文本，同名步骤会撞 key
          <div key={`${i}-${step.label}`} className="flex items-center">
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
              title={`工具调用 ${fmtSecondsShort(timeSplit.toolMs / 1000)}`}
            />
            <span
              className="h-full bg-jade-400"
              style={{ width: `${(timeSplit.genMs / timeSplit.totalMs) * 100}%` }}
              title={`结论生成 ${fmtSecondsShort(timeSplit.genMs / 1000)}`}
            />
            <span
              className="h-full bg-mist-600/60"
              style={{ width: `${(timeSplit.otherMs / timeSplit.totalMs) * 100}%` }}
              title={`等待/其他 ${fmtSecondsShort(timeSplit.otherMs / 1000)}`}
            />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-mist-600">
            {fmtSecondsShort(timeSplit.totalMs / 1000, 0)}
          </span>
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
                {/* 页签角标是计数不是清单，按全量报，与交付自检和整页 MD 同一口径 */}
                {key === "result" && allCitations.length > 0 && (
                  <span className="ml-1.5 rounded bg-glow-500/15 px-1 py-0.5 text-[10px] text-glow-300">
                    {allCitations.length}
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
                searchNote={searchNote}
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
                    {plainSnippet(prevConclusion, 120)}（{prevConclusion.length} 字 · 本次 {finalResult.length} 字）
                  </div>
                )}
                {conclDiff && (
                  <div className="no-print mb-3 rounded-md border border-line bg-night-850 px-3 py-2">
                    <div className="kicker mb-1">结论较上次运行变化</div>
                    {conclDiff.added.length > 0 && (
                      <ul className="space-y-0.5 text-[11.5px] leading-5 text-jade-400">
                        {conclDiff.added.map((s, i) => (
                          <li key={`a${i}`}>+ {plainLine(s)}</li>
                        ))}
                      </ul>
                    )}
                    {conclDiff.removed.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[11.5px] leading-5 text-rose-300">
                        {conclDiff.removed.map((s, i) => (
                          <li key={`r${i}`}>- {plainLine(s)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {revImpact && (
                  <div className="mb-3 rounded-md border border-line bg-night-850 px-3 py-2">
                    <div className="kicker mb-1">本次修订对证据的影响</div>
                    <p
                      className={`text-[11.5px] leading-5 ${
                        revImpact.regressed && !revImpact.improved
                          ? "text-amber-300"
                          : revImpact.improved && !revImpact.regressed
                            ? "text-jade-300"
                            : "text-mist-400"
                      }`}
                    >
                      {deltaText(revImpact)}
                    </p>
                    <p className="mt-1 text-[10.5px] leading-5 text-mist-600">
                      对比口径：只统计结论正文里的引用地址（按证据力分级）与政策文号数；工具留存跨运行累积，不参与对比。
                    </p>
                  </div>
                )}
                <div className="glow-card mb-4 px-4 py-3">
                  <div className="text-[12px] font-semibold text-mist-100 print:text-gray-900">目录</div>
                  <ul className="mt-1 list-decimal pl-5 text-[11px] leading-5 text-mist-400 print:text-gray-700">
                    {toc.map((h, i) => (
                      // key 带上下标：目录文字已剥掉 Markdown 记号，两个不同层级的同名小节会撞 key
                      <li key={`${i}-${h}`}>
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
                        {refTrace.total > 0 && (
                          <button
                            type="button"
                            onClick={() => setRefPanelOpen((v) => !v)}
                            className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
                              refOpen > 0
                                ? "bg-amber-400/15 text-amber-300 hover:bg-amber-400/25"
                                : "bg-jade-400/15 text-jade-300 hover:bg-jade-400/25"
                            }`}
                            title={`政策文号溯源：共 ${refTrace.total} 处，工具结果可溯源 ${refTrace.traced} 处${
                              refTrace.tracedByBody > 0
                                ? `（其中 ${refTrace.tracedByBody} 处仅在留存网页正文中出现，依据弱于结构化字段）`
                                : ""
                            }，无法从留存数据核验 ${
                              refTrace.unverifiable
                            } 处（联网检索扩展只持久化查询元数据），待人工确认 ${refTrace.untraced.length} 处${
                              refTrace.untraced.length > 0
                                ? `\n${refTrace.untraced
                                    .slice(0, 5)
                                    .map((r) => `· ${r.text}：…${r.context}…`)
                                    .join("\n")}`
                                : ""
                            }${
                              refTrace.bodyTracedRefs.length > 0
                                ? `\n仅正文提到：${refTrace.bodyTracedRefs
                                    .slice(0, 3)
                                    .map((r) => r.text)
                                    .join(" · ")}`
                                : ""
                            }${
                              docRefLabeledTotal > 0
                                ? `\n其中 ${docRefLabeledTotal} 处已在结论中标注「未取得公开原文，仅作背景参考」，不再计入待办`
                                : ""
                            }${
                              refSummary.total > 0
                                ? `\n已联网复查 ${refSummary.total} 处：找到公开出处 ${refSummary.matched} · 候选待确认 ${refSummary.candidate} · 未检索到 ${refSummary.empty} · 检索失败 ${refSummary.error}`
                                : ""
                            }\n点击${refPanelOpen ? "收起" : "展开"}复查面板`}
                          >
                            文号溯源 {refTrace.traced}/{refTrace.total}
                            {refTrace.unverifiable > 0 ? ` · 无法核验 ${refTrace.unverifiable}` : ""}
                            {refTrace.untraced.length > 0 ? ` · 待确认 ${refTrace.untraced.length}` : ""}
                            {refSummary.matched > 0 ? ` · 复查到出处 ${refSummary.matched}` : ""}
                          </button>
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
                            // 关键词云的按钮此前完全没写 key：它在每个有结论的任务页都渲染，
                            // 正是控制台那条「unique key」告警每次挂载都出现一次的原因
                            key={`${i}-${x.w}`}
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
                {refPanelOpen && (
                  <div className="mb-4 rounded-md border border-glow-500/35 bg-glow-500/5 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="kicker">政策文号复查</span>
                      <span className="rounded bg-night-700 px-1.5 py-0.5 font-mono text-[10px] text-mist-500">
                        待复查 {refTargets.length}
                      </span>
                      {refSummary.total > 0 && (
                        <span className="text-[10.5px] text-mist-600">
                          已复查 {refSummary.total} · 找到出处 {refSummary.matched} · 候选 {refSummary.candidate} ·
                          未检索到 {refSummary.empty} · 失败 {refSummary.error}
                          {refSummary.checkedAt
                            ? ` · ${new Date(refSummary.checkedAt).toLocaleString("zh-CN", { hour12: false })}`
                            : ""}
                        </span>
                      )}
                      <button
                        type="button"
                        className="action-btn ml-auto disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={refBusy || refTargets.length === 0}
                        onClick={() => runRefCheck(refTargets.slice(0, 10))}
                        title="用自建检索通道（Bing RSS 优先 + 相关度过滤）逐条复查没有出处的文号，判定与证据链接落库留痕并写入事件；一次最多 10 条"
                      >
                        {refBusy ? "复查中…" : `联网复查${refTargets.length > 0 ? `（${Math.min(refTargets.length, 10)} 处）` : ""}`}
                      </button>
                      {revisionItems.length > 0 && (
                        <button
                          type="button"
                          className="action-btn"
                          onClick={fillRevisionInstruction}
                          title="把已找到出处的文号、已找到替代来源的弱证据引用、以及仍未取得原文的项目整理成一条修订指令，填进「续跑任务」输入框；平台不自动改写结论，需人工核对后提交"
                        >
                          生成修订指令（{revisionTotal}）
                        </button>
                      )}
                      <button type="button" className="action-btn" onClick={() => setRefPanelOpen(false)}>
                        收起
                      </button>
                    </div>
                    {revisionMsg && <p className="mt-1.5 text-[11px] leading-5 text-jade-300">{revisionMsg}</p>}
                    {refTargets.length === 0 ? (
                      <p className="mt-1.5 text-[11px] leading-5 text-mist-600">
                        {refSummary.total > 0
                          ? "结论里的文号现在都能在工具结果中找到出处，无需复查。"
                          : "结论里的文号都能在工具结果中找到出处，无需复查。"}
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {refTargets.slice(0, 10).map((t) => {
                          const rec = refChecks[t.key];
                          return (
                            <li key={t.key} className="rounded bg-night-800 px-2 py-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-[11.5px] text-mist-100">{t.text}</span>
                                {rec ? (
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-[10px] ${REF_VERDICT_CLASS[rec.verdict] ?? "bg-night-700 text-mist-500"}`}
                                    title={`${REF_VERDICT_HINT[rec.verdict]}\n检索词：${rec.query}\n判定说明：${rec.note}`}
                                  >
                                    {REF_VERDICT_TEXT[rec.verdict]}
                                  </span>
                                ) : (
                                  <span className="rounded bg-night-700 px-1.5 py-0.5 text-[10px] text-mist-600">
                                    未复查
                                  </span>
                                )}
                                {rec?.evidence && (
                                  <button
                                    type="button"
                                    className="action-btn"
                                    title={`${rec.evidence.title}\n${rec.evidence.url}\n证据力：${rec.evidence.gradeReason || rec.evidence.grade}\n点按在侧边阅读器打开`}
                                    onClick={() => openReader({ kind: "url", url: rec.evidence!.url })}
                                  >
                                    <IconExternal className="h-3 w-3" />
                                    证据
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="action-btn ml-auto disabled:cursor-not-allowed disabled:opacity-40"
                                  disabled={refBusy}
                                  title={rec ? "重新复查这一处文号" : "联网复查这一处文号"}
                                  onClick={() => runRefCheck([t])}
                                >
                                  {rec ? "重新复查" : "复查"}
                                </button>
                              </div>
                              <p className="mt-1 text-[11px] leading-5 text-mist-600">…{t.context}…</p>
                              {rec && rec.note && (
                                <p className="mt-0.5 text-[10.5px] leading-5 text-mist-500">{rec.note}</p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {refTargets.length > 10 && (
                      <p className="mt-1.5 text-[10.5px] text-mist-600">
                        另有 {refTargets.length - 10} 处文号未列出（单次复查上限 10 处），可在整页交付 MD 的「政策文号溯源」节查看完整清单。
                      </p>
                    )}
                    {refTrace.bodyTracedRefs.length > 0 && (
                      <div className="mt-2.5 border-t border-glow-500/25 pt-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="kicker">仅在留存正文中出现</span>
                          <span className="rounded bg-night-700 px-1.5 py-0.5 font-mono text-[10px] text-mist-500">
                            {refTrace.bodyTracedRefs.length} 处
                          </span>
                          <span className="text-[10.5px] leading-5 text-mist-600">
                            这几处有出处，所以不在上面的待复查清单里；依据只在我们抓下来的网页正文里，点「原文」确认它是该页主题还是被顺带提到（档位说明见每条的徽章）
                          </span>
                        </div>
                        <ul className="mt-1.5 space-y-1.5">
                          {refTrace.bodyTracedRefs.slice(0, DOC_REF_TABLE_LIMIT).map((r) => (
                            <li key={r.core} className="rounded bg-night-800 px-2 py-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-[11.5px] text-mist-100">{r.text}</span>
                                <span
                                  className="rounded bg-night-700 px-1.5 py-0.5 text-[10px] text-mist-500"
                                  title={SOURCE_VIA_HINT[r.sourceVia]}
                                >
                                  {SOURCE_VIA_TEXT[r.sourceVia]}
                                </span>
                                {r.sourceUrl !== "" && (
                                  <button
                                    type="button"
                                    className="action-btn"
                                    title={`${r.sourceTitle === "" ? r.sourceUrl : r.sourceTitle}\n${r.sourceUrl}\n点按在侧边阅读器打开原文`}
                                    onClick={() => openReader({ kind: "url", url: r.sourceUrl })}
                                  >
                                    <IconExternal className="h-3 w-3" />
                                    原文
                                  </button>
                                )}
                                {r.sourceCount > 1 && (
                                  <span className="text-[10px] text-mist-600">共 {r.sourceCount} 份留存正文提到</span>
                                )}
                              </div>
                              <p className="mt-1 text-[11px] leading-5 text-mist-600">…{r.context}…</p>
                            </li>
                          ))}
                        </ul>
                        {refTrace.bodyTracedRefs.length > DOC_REF_TABLE_LIMIT && (
                          <p className="mt-1.5 text-[10.5px] text-mist-600">
                            另有 {refTrace.bodyTracedRefs.length - DOC_REF_TABLE_LIMIT} 处未列出，完整清单见整页交付
                            MD 的「政策文号溯源」节。
                          </p>
                        )}
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
                allCitations={allCitations}
                searches={searches}
                searchNote={searchNote}
                retentionText={retentionText}
                citationRecheck={{
                  targets: weakTargets,
                  checks: citationCheckList,
                  summary: citationSummary,
                  busy: refBusy,
                  onRun: runCitationRecheck,
                  composable: revisionTotal,
                  onCompose: fillRevisionInstruction,
                  notice: revisionMsg,
                  uncited: weakUncitedItems,
                  disclaimed: weakDisclaimedItems,
                }}
                sheet={sheet}
                onOpenUrl={openReader}
                linkChecks={linkChecks}
                linkBusy={linkBusy}
                linkCheckedAt={linkCheckedAt}
                linkSummary={linkSummary}
                onCheckLinks={() => checkCitationLinks(allCitations.map((c) => c.url))}
                onDownloadReport={() => download(`${task.title}-审查报告.md`, finalResult)}
                onDownloadSheet={() =>
                  download(`${task.title}-证据核对表.md`, `${evidenceSheetDocument(sheet).join("\n")}\n`)
                }
                onCopySheet={() =>
                  void navigator.clipboard?.writeText(evidenceSheetDocument(sheet).join("\n")).catch(() => undefined)
                }
                onDownloadCitations={() =>
                  download(
                    `${task.title}-引用清单.md`,
                    allCitations.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}`).join("\n") ||
                      "（本次任务无联网引用）",
                  )
                }
                onDownloadBibtex={() =>
                   download(
                     "references.bib",
                    allCitations
                       .map(
                         (c, i) =>
                          `@misc{ref${i + 1},\n  title = {${c.title.replace(/[{}]/g, "")}},\n  howpublished = {\\url{${c.url}}},\n  note = { Accessed: ${dayStamp()} }\n}`,
                      )
                      .join("\n\n") || "% 本次任务无联网引用\n",
                  )
                }
                onCopyBibtex={() =>
                  void navigator.clipboard
                     ?.writeText(
                      allCitations
                         .map(
                           (c, i) =>
                            `@misc{ref${i + 1},\n  title = {${c.title.replace(/[{}]/g, "")}},\n  howpublished = {\\url{${c.url}}},\n  note = { Accessed: ${dayStamp()} }\n}`,
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
                onExportZip={exportBundleZip}
                bundleFresh={bundleFresh}
                zipBusy={zipBusy}
                zipNote={zipNote}
                onExportBundle={() => {
                  const lines = bundleLines();
                  downloadText(
                    `${task.title}-整页-${dayStamp()}.md`,
                    lines.join("\n"),
                    "text/markdown",
                  );
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
                agentId={agent.id}
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
                  <li key={`${i}-${h}`}>
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
          {/* data-keep-raw：这两处是用户输入的逐字回显，有意不剥 Markdown 记号（见 verify-md-text
              最后一条断言）。标出来是为了让界面扫描脚本（scan-ui-markdown）认识它、不当成残留。 */}
          <p
            data-keep-raw="instruction"
            className="mt-1.5 whitespace-pre-wrap rounded-md bg-night-800 px-3 py-2 text-[12.5px] leading-5 text-mist-300"
          >
            {task.instruction}
          </p>

          <div className="mt-5 kicker">业务资料</div>
          {files.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-mist-600">本任务未上传资料</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {files.map((f) => {
                const local = reparse[f.id];
                const p = local?.summary ?? fileParsed.get(f.fileName);
                const status = local?.status ?? f.parseStatus;
                const warning = local?.warning ?? p?.warning ?? "";
                const detail = parseDetail(p);
                return (
                  <li key={f.id} className="flex items-stretch gap-1">
                    <button
                      type="button"
                      onClick={() => openReader({ kind: "file", taskId: task.id, fileId: f.id, name: f.fileName })}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded border border-line bg-night-850 px-2 py-1.5 text-left transition-colors hover:border-glow-500"
                      title={`在侧边阅读器中预览\n解析：${detail}${p?.preview ? `\n摘录：${p.preview}` : ""}`}
                    >
                      <IconFile className="mt-0.5 h-3.5 w-3.5 shrink-0 text-glow-400" />
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] text-mist-300">{f.fileName}</span>
                        <span className="block text-[11px] text-mist-600">
                          {fmtBytes(f.byteSize)} ·{" "}
                          <span
                            className={
                              status === "failed"
                                ? "text-rose-300"
                                : status === "parsed"
                                  ? "text-jade-300"
                                  : "text-mist-500"
                            }
                          >
                            {parseStatusText(status)}
                          </span>
                          {p ? ` · ${detail}` : ""}
                        </span>
                        {warning && (
                          <span className="block truncate text-[10.5px] text-amber-300" title={warning}>
                            提示：{warning}
                          </span>
                        )}
                        {f.businessCategory && (
                          <span className="block truncate text-[10.5px] text-mist-600">
                            分类：{f.businessCategory}
                          </span>
                        )}
                        {f.createdAt && (
                          <span className="block truncate text-[10.5px] text-mist-600">
                            上传于 {new Date(f.createdAt).toLocaleString("zh-CN", { hour12: false })}
                          </span>
                        )}
                        {p?.preview && (
                          <span className="block truncate text-[10.5px] text-mist-600">摘录：{p.preview}</span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="action-btn shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={local?.busy === true}
                      title="重新解析这份资料（与智能体工具同一套 parseOne 逻辑），用于状态卡在待解析或解析失败时"
                      onClick={() => reparseFile(f.id)}
                    >
                      {local?.busy ? "解析中…" : "重新解析"}
                    </button>
                  </li>
                );
              })}
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
  searchNote,
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
  /** 有检索但没留下来源清单时的如实说明；null 表示不需要说明 */
  searchNote: string | null;
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
    downloadText(
      `运行${runIdx}-时间线-${fileStamp()}.md`,
      lines.join("\n"),
      "text/markdown",
    );
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
            downloadText(
              `时间线-${fileStamp()}.md`,
              lines.join("\n"),
              "text/markdown",
            );
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
                ? fmtSecondsShort(Math.max(0, (Date.parse(c.endedAt) - Date.parse(c.at)) / 1000))
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
        <div
          data-keep-raw="instruction"
          className="user-bubble max-w-[78%] whitespace-pre-wrap px-4 py-2.5 text-[13px] leading-6"
        >
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
                        title={`${c.url}\n证据力：${GRADE_TEXT[c.grade]} · ${c.gradeReason}`}
                        className={`inline-flex max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                          c.grade === "weak"
                            ? "border-amber-400/45 bg-amber-400/10 text-amber-200 hover:border-amber-400"
                            : "border-glow-500/40 bg-glow-500/10 text-glow-300 hover:border-glow-400"
                        }`}
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
                    {citations.length > 0
                      ? `${citations.length} 条联网引用`
                      : searchNote
                        ? "联网检索已执行，扩展未留存来源清单"
                        : "无联网引用"}
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
      ? fmtSecondsShort(Math.max(0, (Date.parse(call.endedAt) - Date.parse(call.at)) / 1000))
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
  allCitations,
  searches,
  searchNote,
  retentionText,
  citationRecheck,
  sheet,
  onOpenUrl,
  onDownloadReport,
  onDownloadSheet,
  onCopySheet,
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
  onExportZip,
  bundleFresh,
  zipBusy,
  zipNote,
}: {
  result: string;
  error: string | null;
  status: string;
  citations: Citation[];
  /** 不截断的全量引用清单：分级汇总与「共 N 条」按它算，capsule 列表仍只渲染上面那份截断清单 */
  allCitations: Citation[];
  /** 联网检索留痕汇总（用于「检索过但没留下来源清单」的如实说明） */
  searches: SearchEvidence;
  searchNote: string | null;
  /** 留存正文被截断时的如实说明；null 表示本任务没有截断，整块不显示 */
  retentionText: string | null;
  /** 弱证据引用找官方原文：目标、已有结果、汇总、进行中状态与触发回调 */
  citationRecheck: {
    targets: Array<{ key: string; text: string; excludeUrl?: string }>;
    checks: RefCheckRecord[];
    summary: RefCheckSummary;
    busy: boolean;
    onRun: () => void;
    /** 可写进修订指令的复查结果条数（含文号与引用两类） */
    composable: number;
    /** 生成修订指令并填入「续跑任务」输入框 */
    onCompose: () => void;
    notice: string;
    /** 只在检索留存里、从未进入结论正文的弱证据引用（逐条，可点开原文核对判据） */
    uncited: Array<{ url: string; title: string }>;
    /** 结论里已声明「仅作背景参考，不作为政策依据」的弱证据引用（逐条，可点开原文核对判据） */
    disclaimed: Array<{ url: string; title: string }>;
  };
  /** 证据核对表输入（与整页交付 MD 用的是同一份数据） */
  sheet: SheetInput;
  onOpenUrl: (target: ReaderTarget) => void;
  onDownloadReport: () => void;
  /** 单独下载这一页证据核对表（纸质归档常常只需要这一页） */
  onDownloadSheet: () => void;
  onCopySheet: () => void;
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
  /** 打包下载（zip）：整页 MD + 本任务产物 */
  onExportZip: () => void;
  /** 交付包新鲜度：上次打包时间与打包后的变更 */
  bundleFresh: BundleFreshness;
  zipBusy: boolean;
  zipNote: string;
  /** 引用链接核验：结果、进行中状态、最近核验时间与触发回调 */
  linkChecks: Record<string, LinkCheck>;
  linkBusy: boolean;
  linkCheckedAt: string | null;
  linkSummary: LinkSummary;
  onCheckLinks: () => void;
}) {
  // 引用证据力汇总（与整页 MD、交付自检同一口径）
  // 分级按全量算：界面胶囊只列前若干条，但「官方来源 X 条」不能跟着截断，
  // 否则它与交付自检、整页 MD、平台看板上的同一个数字对不上
  const grades = summarizeGrades(allCitations);
  // 有 error 不等于什么都没有。实测 4bb22d34：error 是「服务重启导致执行中断」，而它已经有
  // 16365 字结论正文、33 次工具调用（其中 6 次被联网工具截断）。此前这里一见 error 就整块
  // return，结果页只剩一行错误——联网引用、检索留痕、留存截断说明、文号 / 金额溯源、交付自检、
  // 下载报告全都不渲染，复核人连原文都点不开。改成：只有「既失败又没有结论」时才整块替换，
  // 否则错误只作横幅，证据区照常渲染（并说清结论可能不完整、必要时续跑）。
  const errorBanner = (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-300">
      <div className="font-medium">执行失败</div>
      <div className="mt-1 break-words">{error}</div>
      {result ? (
        <div className="mt-1.5 text-[11.5px] leading-5 text-rose-300/85">
          本次运行中断前已产出 {result.length} 字结论正文，下面的证据与原文入口照常可用；结论可能不完整，请核对后决定是否续跑。
        </div>
      ) : null}
    </div>
  );
  if (error && !result) return errorBanner;
  if (!result) {
    return (
      <div className="py-10 text-center text-[13px] text-mist-600">
        {status === "processing" ? "Agent 正在执行…" : "暂无执行结论"}
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-5">
      {error ? errorBanner : null}
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
        <button
          type="button"
          className={`action-btn disabled:cursor-not-allowed disabled:opacity-40${
            bundleFresh.stale && !zipBusy ? " action-btn-warn" : ""
          }`}
          onClick={onExportZip}
          disabled={zipBusy}
          title={bundleButtonTitle(
            bundleFresh,
            "把整页交付 MD、本任务全部产物与上传的业务资料打成一个 zip（服务端合包，产物放在「产物/」目录、资料放在「资料/」目录下）",
          )}
        >
          <IconDownload className="h-3.5 w-3.5" />
          {bundleButtonLabel(bundleFresh, zipBusy)}
        </button>
        {zipNote && (
          <span className="text-[10.5px] text-rose-300" title={zipNote}>
            打包失败，已退回 MD
          </span>
        )}
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

      {citations.length === 0 && searchNote && (
        <div>
          <div className="flex items-center gap-2">
            <span className="kicker">联网检索留痕</span>
            <span
              className="rounded bg-night-700 px-1.5 py-0.5 text-[10px] text-mist-500"
              title={`工具：${searches.tools.join(" / ")}${
                searches.providers.length > 0 ? `\nprovider：${searches.providers.join("、")}` : ""
              }`}
            >
              {searches.calls} 次调用 · 未留存来源清单
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-mist-600" style={{ whiteSpace: "pre-line" }}>
            {searchNote}
          </p>
        </div>
      )}

      {retentionText && (
        <div>
          <span className="kicker">留存正文截断</span>
          <p className="mt-1.5 text-[11px] leading-5 text-mist-600">{retentionText}</p>
        </div>
      )}

      {citations.length > 0 && (
        <div>
          <div className="flex items-center gap-2">
            <span className="kicker">联网引用</span>
            <span className="rounded bg-glow-500/15 px-1.5 py-0.5 font-mono text-[10px] text-glow-300">
              {citations.length}
            </span>
            {searches.metadataOnly > 0 && (
              <span
                className="rounded bg-night-700 px-1.5 py-0.5 text-[10px] text-mist-500"
                title={`联网检索留痕：共 ${searches.calls} 次调用（${searches.tools.join(" / ")}）\n留下可引用来源 ${
                  searches.withUrls
                } 次 · 只留查询元数据 ${searches.metadataOnly} 次${
                  searches.reportedResults > 0 ? ` · 扩展自报命中 ${searches.reportedResults} 条` : ""
                }${searches.providers.length > 0 ? `\nprovider：${searches.providers.join("、")}` : ""}${
                  searches.queries.length > 0
                    ? `\n检索词：\n${searches.queries
                        .slice(0, 6)
                        .map((q) => `· ${q}`)
                        .join("\n")}`
                    : ""
                }`}
              >
                检索 {searches.calls} 次 · 仅元数据 {searches.metadataOnly} 次
              </span>
            )}
            <button
              type="button"
              className="action-btn"
              title="复制引用清单（编号+标题+URL）"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(
                    citations
                      .map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}\n   证据力：${GRADE_TEXT[c.grade]}`)
                      .join("\n"),
                  )
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
              {linkBusy ? "核验中…" : linkCheckedAt ? `重新核验（${ageText(linkCheckedAt)}）` : "核验链接"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-mist-600">
            证据力：官方来源 {grades.official} · 专业来源 {grades.professional}
            {allCitations.length > citations.length && (
              <span title="界面只列前若干条，分级与交付自检按全量计算">
                {" "}
                · 共 {allCitations.length} 条，下方列出前 {citations.length} 条
              </span>
            )}
            {grades.weak > 0 ? (
              <span className="text-amber-300" title={GRADE_HINT.weak}>
                {" "}
                · 证据力弱 {grades.weak}（门户首页 / 百科词条 / 检索页，交付前请替换为政策原文）
              </span>
            ) : (
              <span className="text-jade-300"> · 无门户首页或百科类引用</span>
            )}
          </p>
          {linkCheckedAt && (
            <p className="mt-1.5 text-[11px] text-mist-600">
              最近核验 {new Date(linkCheckedAt).toLocaleString("zh-CN", { hour12: false })} · 可访问 {linkSummary.ok}/
              {linkSummary.total}
              {freshness(linkCheckedAt) === "stale" && (
                <span className="text-amber-300"> · 核验已超过 72 小时，建议重新核验</span>
              )}
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
              const weak = c.grade === "weak";
              return (
                <button
                  key={c.url}
                  type="button"
                  onClick={() => onOpenUrl({ kind: "url", url: c.url })}
                  title={`${c.url}\n来源：${c.via === "conclusion" ? "结论正文引用" : `工具留存（${c.via}）`}\n证据力：${GRADE_TEXT[c.grade]} · ${c.gradeReason}${
                    weak ? `\n${GRADE_HINT.weak}` : ""
                  }${
                    chk && verdict
                      ? `\n核验：${
                          verdict === "ok"
                            ? `可访问 HTTP ${chk.status}`
                            : `${VERDICT_TEXT[verdict]}（${chk.status ?? chk.error ?? "无响应"}）· ${VERDICT_HINT[verdict]}`
                        } · ${chk.ms} ms`
                      : ""
                  }`}
                  className={`inline-flex max-w-full items-center gap-1.5 rounded-full border bg-night-850 px-2.5 py-1 text-[11.5px] transition-colors ${
                    verdict === "dead"
                      ? "border-rose-400/50 text-rose-200 hover:border-rose-400"
                      : weak
                        ? "border-amber-400/45 text-amber-100 hover:border-amber-400"
                        : "border-line text-mist-300 hover:border-glow-500 hover:text-glow-300"
                  }`}
                >
                  <IconExternal className={`h-3 w-3 shrink-0 ${weak ? "text-amber-400" : "text-glow-400"}`} />
                  <span className="truncate">{c.title}</span>
                  <span
                    className={`shrink-0 rounded px-1 text-[9.5px] ${
                      c.grade === "official"
                        ? "bg-jade-400/15 text-jade-300"
                        : c.grade === "professional"
                          ? "bg-sky-400/15 text-sky-300"
                          : "bg-amber-400/15 text-amber-300"
                    }`}
                    title={`${GRADE_TEXT[c.grade]}：${c.gradeReason}`}
                  >
                    {GRADE_TEXT[c.grade]}
                  </span>
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
          {citationRecheck.disclaimed.length > 0 && (
            <div className="mt-2 rounded border border-jade-400/25 bg-jade-400/5 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="kicker">已声明为背景参考的弱证据</span>
                <span className="text-[10.5px] leading-5 text-mist-600">
                  {citationRecheck.disclaimed.length} 条已在结论里写明「仅作背景参考，不作为政策依据」，不再催办；点开原文、或在结论里搜这个标题，可核对声明是不是真的写了
                </span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {citationRecheck.disclaimed.slice(0, WEAK_SETTLED_LIST_LIMIT).map((c) => (
                  <li key={c.url} className="flex items-center gap-2 rounded bg-night-800 px-2 py-1">
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-mist-400"
                      title={c.title === "" ? c.url : c.title}
                    >
                      {c.title === "" ? c.url : c.title}
                    </span>
                    <button
                      type="button"
                      className="action-btn shrink-0"
                      title={`${c.title === "" ? c.url : c.title}\n${c.url}\n点按在侧边阅读器打开`}
                      onClick={() => onOpenUrl({ kind: "url", url: c.url })}
                    >
                      <IconExternal className="h-3 w-3" />
                      原文
                    </button>
                  </li>
                ))}
              </ul>
              {citationRecheck.disclaimed.length > WEAK_SETTLED_LIST_LIMIT && (
                <p className="mt-1 text-[10.5px] text-mist-600">
                  另有 {citationRecheck.disclaimed.length - WEAK_SETTLED_LIST_LIMIT} 条未列出
                </p>
              )}
            </div>
          )}
          {citationRecheck.uncited.length > 0 && (
            <div className="mt-2 rounded border border-line bg-night-850 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="kicker">未进结论正文的弱证据</span>
                <span className="text-[10.5px] leading-5 text-mist-600">
                  {citationRecheck.uncited.length} 条只在检索留存里、从未被写进结论，不是这份交付材料的依据，无需替换；点开原文可核对这个判据对不对
                </span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {citationRecheck.uncited.slice(0, WEAK_SETTLED_LIST_LIMIT).map((c) => (
                  <li key={c.url} className="flex items-center gap-2 rounded bg-night-800 px-2 py-1">
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-mist-400"
                      title={c.title === "" ? c.url : c.title}
                    >
                      {c.title === "" ? c.url : c.title}
                    </span>
                    <button
                      type="button"
                      className="action-btn shrink-0"
                      title={`${c.title === "" ? c.url : c.title}\n${c.url}\n点按在侧边阅读器打开`}
                      onClick={() => onOpenUrl({ kind: "url", url: c.url })}
                    >
                      <IconExternal className="h-3 w-3" />
                      原文
                    </button>
                  </li>
                ))}
              </ul>
              {citationRecheck.uncited.length > WEAK_SETTLED_LIST_LIMIT && (
                <p className="mt-1 text-[10.5px] text-mist-600">
                  另有 {citationRecheck.uncited.length - WEAK_SETTLED_LIST_LIMIT} 条未列出
                </p>
              )}
            </div>
          )}
          {citationRecheck.targets.length > 0 && (
            <div className="mt-2 rounded border border-amber-400/30 bg-amber-400/5 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="kicker">弱证据引用找官方原文</span>
                <span className="text-[10.5px] text-mist-600">
                  {citationRecheck.targets.length} 条引用指向门户首页、百科词条或检索页
                  {citationRecheck.summary.total > 0 &&
                    ` · 已找到替代来源 ${citationRecheck.summary.matched} · 候选待确认 ${
                      citationRecheck.summary.candidate
                    } · 未找到 ${citationRecheck.summary.empty + citationRecheck.summary.error}`}
                </span>
                <button
                  type="button"
                  className="action-btn ml-auto disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={citationRecheck.busy}
                  title="用自建检索通道为这些弱证据引用检索官方原文：检索词 = 去掉站点后缀的标题 + 结论里的领域词，并排除引用自身；找到后给出可替换的具体文件页，结果按条落库"
                  onClick={citationRecheck.onRun}
                >
                  {citationRecheck.busy
                    ? "检索中…"
                    : citationRecheck.summary.total > 0
                      ? "重新检索替代来源"
                      : "查找官方原文"}
                </button>
                {citationRecheck.composable > 0 && (
                  <button
                    type="button"
                    className="action-btn"
                    title="把已找到替代来源的引用、已找到出处的文号与仍未取得原文的项目整理成一条修订指令，填进「续跑任务」输入框；平台不自动改写结论，需人工核对后提交"
                    onClick={citationRecheck.onCompose}
                  >
                    生成修订指令（{citationRecheck.composable}）
                  </button>
                )}
              </div>
              {citationRecheck.notice && (
                <div className="mt-1 text-[11px] leading-5 text-jade-300">{citationRecheck.notice}</div>
              )}
              {citationRecheck.checks.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {citationRecheck.checks.map((c) => (
                    <li key={c.key} className="flex flex-wrap items-center gap-2 rounded bg-night-800 px-2 py-1">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                          REF_VERDICT_CLASS[c.verdict] ?? "bg-night-700 text-mist-500"
                        }`}
                        title={`${REF_VERDICT_HINT[c.verdict]}\n检索词：${c.query}\n判定说明：${c.note}`}
                      >
                        {REF_VERDICT_TEXT[c.verdict]}
                      </span>
                      <span className="max-w-[220px] truncate text-[11px] text-mist-500" title={c.text}>
                        {c.text}
                      </span>
                      {c.evidence && (
                        <>
                          <button
                            type="button"
                            className="action-btn"
                            title={`${c.evidence.title}\n${c.evidence.url}\n证据力：${c.evidence.gradeReason || c.evidence.grade}\n点按在侧边阅读器打开`}
                            onClick={() => onOpenUrl({ kind: "url", url: c.evidence!.url })}
                          >
                            <IconExternal className="h-3 w-3" />
                            替代来源
                          </button>
                          <button
                            type="button"
                            className="action-btn"
                            title="复制替换用的引用行（原标题 → 替代来源标题与地址）"
                            onClick={() =>
                              void navigator.clipboard
                                ?.writeText(`${c.text} → ${c.evidence!.title} ${c.evidence!.url}`)
                                .catch(() => undefined)
                            }
                          >
                            <IconCopy className="h-3 w-3" />
                          </button>
                        </>
                      )}
                      <span className="text-[10.5px] text-mist-600">{c.note}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[10.5px] leading-5 text-mist-600">
                替代来源需人工确认后写回结论并重新打包，平台不会自动改写 Agent 的结论。
              </p>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="kicker">交付</div>
        <p className="mt-1 text-[11px] text-mist-600">
          {bundleFresh.lastPackedAt
            ? `最近打包：${new Date(bundleFresh.lastPackedAt).toLocaleString("zh-CN", { hour12: false })}`
            : "尚未打包交付包"}
          {bundleFresh.stale ? (
            <span className="text-amber-300" title={bundleFresh.newer.map((c) => `${c.label}（${c.at}）`).join("\n")}>
              {" "}
              · {freshnessText(bundleFresh)}
            </span>
          ) : bundleFresh.lastPackedAt ? (
            <span className="text-jade-300"> · 交付包仍是最新</span>
          ) : null}
        </p>
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

        <div className="mt-5">
          <div className="flex items-center gap-2">
            <div className="kicker">证据核对表</div>
            <button
              type="button"
              className="action-btn ml-auto"
              onClick={onDownloadSheet}
              title="单独下载这一页核对表（Markdown），可直接打印签字归档；整页交付 MD 里也含同一份内容"
            >
              <IconDownload className="h-3.5 w-3.5" />
              下载核对表
            </button>
            <button
              type="button"
              className="action-btn"
              onClick={onCopySheet}
              title="复制核对表 Markdown 到剪贴板"
            >
              <IconCopy className="h-3.5 w-3.5" />
              复制
            </button>
          </div>
          <table className="mt-2 w-full border-collapse text-[11.5px]">
            <thead>
              <tr className="text-left text-mist-500">
                <th className="w-7 border-b border-line py-1 pr-2 font-normal">#</th>
                <th className="w-[128px] border-b border-line py-1 pr-2 font-normal">核对项</th>
                <th className="w-[140px] border-b border-line py-1 pr-2 font-normal">结论</th>
                <th className="border-b border-line py-1 font-normal">说明</th>
              </tr>
            </thead>
            <tbody>
              {evidenceSheetRows(sheet).map((r, n) => (
                // key 带下标：核对项名来自同一份文案，重复即撞 key（行号本来就在旁边显示）
                <tr key={`${n}-${r.item}`} className="align-top">
                  <td className="border-b border-line/60 py-1 pr-2 font-mono text-[10.5px] text-mist-600">{n + 1}</td>
                  <td className="border-b border-line/60 py-1 pr-2 text-mist-300">{r.item}</td>
                  <td className="border-b border-line/60 py-1 pr-2 text-mist-100">{r.value}</td>
                  <td className="border-b border-line/60 py-1 text-mist-500">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3">
            <div className="kicker mb-1">交付前待办</div>
            {evidenceSheetTodoGroups(sheet).length === 0 ? (
              <p className="text-[11.5px] text-jade-300">{NO_TODO_TEXT}</p>
            ) : (
              <ul className="space-y-1 text-[11.5px] leading-5 text-mist-400">
                {evidenceSheetTodoGroups(sheet).map((g, gi) => (
                  <li key={`${gi}-${g.label}`}>
                    {g.label}（{g.list.length} 项）
                    <ul className="mt-0.5 space-y-0.5 pl-4 text-mist-500">
                      {g.list.slice(0, 8).map((x, k) => (
                        <li key={`${g.label}-${k}`} className="break-all">
                          {x}
                        </li>
                      ))}
                      {g.list.length > 8 && <li>等 {g.list.length} 项，完整清单见上文对应小节</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-3 text-[10.5px] text-mist-600">
            核对人＿＿＿＿＿＿　日期＿＿＿＿＿＿　本表由平台按真实运行数据生成，口径与界面、整页交付 MD 一致。
          </p>
        </div>
      </div>
    </div>
  );
}
