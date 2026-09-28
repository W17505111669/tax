import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import type { AgentInfo, ArtifactInfo, CompareRecord, FileInfo, ReviewRecord, TaskInfo, TaskIssue } from "../types.ts";
import { useTaskEvents } from "../hooks/useTaskEvents.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { readerKey, SideReader, type ReaderTarget } from "./SideReader.tsx";
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

export function TaskWorkbench({ agent, task, files, tab, onTabChange, onRerun }: Props) {
  const { timeline, toolCalls, status, connected } = useTaskEvents(task.id);
  const [compares, setCompares] = useState<CompareRecord[]>([]);
  const [issues, setIssues] = useState<TaskIssue[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [pendingReviews, setPendingReviews] = useState(0);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerTabs, setReaderTabs] = useState<ReaderTarget[]>([]);
  const [readerActive, setReaderActive] = useState(0);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeText, setResumeText] = useState("");
  const [resumeFiles, setResumeFiles] = useState<File[]>([]);
  const [resumeBusy, setResumeBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const liveStatus = status === "created" ? task.status : status;
  const meta = STATUS_META[liveStatus] ?? STATUS_META.created!;
  const running = liveStatus === "processing";

  const openReader = (target: ReaderTarget) => {
    const key = readerKey(target);
    const idx = readerTabs.findIndex((t) => readerKey(t) === key);
    if (idx >= 0) {
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

  const openCompareTarget = (ref: { kind: "upload" | "artifact"; name: string; highlight?: string }) => {
    if (ref.kind === "artifact") {
      openReader({ kind: "artifact", taskId: task.id, name: ref.name, highlight: ref.highlight });
      return;
    }
    const file = files.find((f) => f.fileName === ref.name);
    if (file) openReader({ kind: "file", taskId: task.id, fileId: file.id, name: file.fileName, highlight: ref.highlight });
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
  const steps = useMemo(() => {
    const hasRun = timeline.some((t) => t.kind === "run_started");
    const toolDone = toolCalls.some((c) => !SEARCH_TOOLS.has(c.toolName) && c.ok !== null);
    const searchDone = toolCalls.some((c) => SEARCH_TOOLS.has(c.toolName) && c.ok !== null);
    const concluded = timeline.some((t) => t.kind === "agent_text");
    const delivered = liveStatus === "completed";
    const done = [hasRun, toolDone, searchDone, delivered, delivered];
    const labels = ["提问", "工具核验", "联网检索", "结论生成", "交付"];
    const activeIdx = running ? done.findIndex((d) => !d) : -1;
    return labels.map((label, i) => ({
      label,
      state: done[i] ? "done" : i === activeIdx ? "active" : concluded && i === 3 && running ? "active" : "pending",
    }));
  }, [timeline, toolCalls, liveStatus, running]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && tab === "timeline") el.scrollTop = el.scrollHeight;
  }, [timeline, tab]);

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
            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${meta.className}`}>
              {running ? (
                <span className="inline-flex items-center gap-1">
                  <IconSpinner className="h-3 w-3" />
                  {meta.label}
                </span>
              ) : (
                meta.label
              )}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mist-600">
            <span className="text-glow-300">{agent.shortName}</span>
            <span className="text-line">|</span>
            <span>案例 {task.caseId}</span>
            <span className="text-line">|</span>
            <span>工具调用 {toolCalls.length} 次</span>
            <span className="text-line">|</span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-jade-400" : "bg-amber-400"}`}
                title={connected ? "SSE 事件流已连接" : "SSE 事件流断开，自动重连中"}
              />
              {connected ? "事件流已连接" : "事件流重连中"}
            </span>
            <span className="text-line">|</span>
            <span>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
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
          onClick={() => setReaderOpen((v) => !v)}
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
              <span className="text-[11px] text-mist-600">续跑会恢复本任务完整会话历史，Agent 结合此前结论继续处理</span>
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
            <div className="flex items-center gap-2">
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
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="no-print flex justify-center border-b border-line bg-night-950 py-2">
            <div className="seg-tabs">
            {(
              [
                ["timeline", "执行过程"],
                ["result", "审查结论"],
                ["compare", "底稿比对"],
                ["review", "人工复核"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onTabChange(key)}
                className="seg-tab"
                data-on={tab === key}
              >
                {label}
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

          <div ref={scrollRef} className="print-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="chat-col mx-auto">
            {tab === "timeline" && (
              <TimelineView
                instruction={task.instruction}
                items={timeline}
                toolCalls={toolCalls}
                citations={citations}
                onOpenUrl={openReader}
                onRerun={onRerun}
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
                </div>
              <ResultView
                result={finalResult}
                error={task.error}
                status={liveStatus}
                citations={citations}
                onOpenUrl={openReader}
                onDownloadReport={() => download(`${task.title}-审查报告.md`, finalResult)}
                onDownloadCitations={() =>
                  download(
                    `${task.title}-引用清单.md`,
                    citations.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}`).join("\n") || "（本次任务无联网引用）",
                  )
                }
                onPrint={() => window.print()}
              />
              </>
            )}
            {tab === "compare" && <CompareView compares={compares} onOpenTarget={openCompareTarget} />}
            {tab === "review" && (
              <ReviewView issues={issues} reviews={reviews} pending={pendingReviews} onReview={handleReview} />
            )}
            </div>
          </div>
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
              {artifacts.map((a) => (
                <li key={a.name}>
                  <button
                    type="button"
                    onClick={() => openReader({ kind: "artifact", taskId: task.id, name: a.name })}
                    className="flex w-full items-start gap-2 rounded border border-line bg-night-850 px-2 py-1.5 text-left transition-colors hover:border-glow-500"
                    title="在侧边阅读器中预览"
                  >
                    <IconFile className="mt-0.5 h-3.5 w-3.5 shrink-0 text-glow-400" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-mist-300">{a.name}</span>
                      <span className="block text-[11px] text-mist-600">{(a.byteSize / 1024).toFixed(1)} KB</span>
                    </span>
                  </button>
                </li>
              ))}
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
            activeIndex={readerActive}
            onSelect={setReaderActive}
            onCloseTab={closeTab}
            onClose={() => setReaderOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function TimelineView({
  instruction,
  items,
  toolCalls,
  citations,
  onOpenUrl,
  onRerun,
}: {
  instruction: string;
  items: ReturnType<typeof useTaskEvents>["timeline"];
  toolCalls: ReturnType<typeof useTaskEvents>["toolCalls"];
  citations: Citation[];
  onOpenUrl: (target: ReaderTarget) => void;
  onRerun: () => void;
}) {
  const counters = useRef<Record<string, number>>({});
  counters.current = {};
  const lastTextId = [...items].reverse().find((t) => t.kind === "agent_text" && t.detail)?.id;

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  if (items.length === 0) {
    return <div className="py-10 text-center text-[13px] text-mist-600">等待执行事件…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <div className="user-bubble max-w-[78%] whitespace-pre-wrap px-4 py-2.5 text-[13px] leading-6">
          {instruction}
        </div>
      </div>

      {items.map((item) => {
        if (item.kind === "tool_start") {
          const name = String((item.payload as { toolName?: string } | undefined)?.toolName ?? "");
          const idx = counters.current[name] ?? 0;
          counters.current[name] = idx + 1;
          const call = toolCalls.filter((c) => c.toolName === name)[idx];
          return <ToolRow key={item.id} name={name} call={call} />;
        }
        if (item.kind === "tool_end") return null;

        const isFail = item.kind === "run_failed";
        const isDone = item.kind === "run_completed";
        const isText = item.kind === "agent_text";

        if (!isText && !isFail && !isDone && item.kind !== "agent_status" && item.kind !== "run_started") {
          return null;
        }

        if (item.kind === "agent_status" || item.kind === "run_started") {
          return (
            <div key={item.id} className="flex items-center gap-2 text-[11.5px] text-mist-600">
              <span className="h-1 w-1 rounded-full bg-glow-500" />
              {item.detail ?? item.title}
            </div>
          );
        }

        return (
          <div key={item.id} className="glow-card px-4 py-3">
            {isText && (
              <MarkdownView
                text={item.detail ?? ""}
                live={item.streaming}
                onOpenUrl={(url) => onOpenUrl({ kind: "url", url })}
              />
            )}
            {isText && item.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-glow-400 align-middle" />
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

function ToolRow({ name, call }: { name: string; call: { args: unknown; result: unknown; ok: boolean | null } | undefined }) {
  const isSearch = SEARCH_TOOLS.has(name);
  return (
    <details className="tool-row glow-card">
      <summary className="flex items-center gap-2 px-3.5 py-2">
        <IconTool className="h-3.5 w-3.5 text-glow-400" />
        <span className="font-mono text-[12px] text-mist-100">{name}</span>
        {isSearch && (
          <span className="rounded border border-glow-500/40 bg-glow-500/10 px-1.5 py-0.5 text-[10px] text-glow-300">
            联网
          </span>
        )}
        <span className="ml-auto text-[11px]">
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
        <span className="chev ml-1 text-[10px] text-glow-400">▶</span>
      </summary>
      <div className="grid gap-3 border-t border-line px-3.5 py-2.5 md:grid-cols-2">
        <div>
          <div className="kicker">入参</div>
          <pre className="mt-1 max-h-52 overflow-auto rounded bg-night-950 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-mist-300">
            {JSON.stringify(call?.args ?? null, null, 2)}
          </pre>
        </div>
        <div>
          <div className="kicker">返回</div>
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
  onPrint,
}: {
  result: string;
  error: string | null;
  status: string;
  citations: Citation[];
  onOpenUrl: (target: ReaderTarget) => void;
  onDownloadReport: () => void;
  onDownloadCitations: () => void;
  onPrint: () => void;
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
        <MarkdownView text={result} onOpenUrl={(url) => onOpenUrl({ kind: "url", url })} />
      </article>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className="action-btn"
          onClick={() => void navigator.clipboard?.writeText(result).catch(() => undefined)}
        >
          <IconCopy className="h-3.5 w-3.5" />
          复制全文
        </button>
        <button type="button" className="action-btn" onClick={onPrint}>
          <IconPrint className="h-3.5 w-3.5" />
          打印 / PDF
        </button>
        <button type="button" className="action-btn" onClick={onDownloadReport}>
          <IconDownload className="h-3.5 w-3.5" />
          下载报告
        </button>
      </div>

      {citations.length > 0 && (
        <div>
          <div className="kicker">联网引用</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {citations.map((c) => (
              <button
                key={c.url}
                type="button"
                onClick={() => onOpenUrl({ kind: "url", url: c.url })}
                title={c.url}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-night-850 px-2.5 py-1 text-[11.5px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
              >
                <IconExternal className="h-3 w-3 shrink-0 text-glow-400" />
                <span className="truncate">{c.title}</span>
              </button>
            ))}
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
        </div>
      </div>
    </div>
  );
}
