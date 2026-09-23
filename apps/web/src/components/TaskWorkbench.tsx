import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import type { AgentInfo, ArtifactInfo, FileInfo, TaskInfo } from "../types.ts";
import { useTaskEvents } from "../hooks/useTaskEvents.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { SideReader, type ReaderTarget } from "./SideReader.tsx";
import { IconAlert, IconCheck, IconFile, IconPanel, IconPlay, IconSpinner, IconTool } from "./Icons.tsx";

interface Props {
  agent: AgentInfo;
  task: TaskInfo;
  files: FileInfo[];
  onRerun: () => void;
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  created: { label: "待执行", className: "border-ink-200 bg-ink-100 text-ink-600" },
  processing: { label: "执行中", className: "border-amber-200 bg-amber-50 text-amber-700" },
  waiting_review: { label: "待复核", className: "border-sky-200 bg-sky-50 text-sky-700" },
  completed: { label: "已完成", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  failed: { label: "执行失败", className: "border-rose-200 bg-rose-50 text-rose-700" },
};

export function TaskWorkbench({ agent, task, files, onRerun }: Props) {
  const { timeline, toolCalls, status } = useTaskEvents(task.id);
  const [tab, setTab] = useState<"timeline" | "tools" | "result">("timeline");
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerTarget, setReaderTarget] = useState<ReaderTarget | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const openReader = (target: ReaderTarget) => {
    setReaderTarget(target);
    setReaderOpen(true);
  };

  // 产物清单：进入任务与任务结束时刷新
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api.listArtifacts(task.id).then((list) => {
        if (!cancelled) setArtifacts(list);
      }).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task.id, task.status]);

  const liveStatus = status === "created" ? task.status : status;
  const meta = STATUS_META[liveStatus] ?? STATUS_META.created!;
  const running = liveStatus === "processing";

  const finalResult = useMemo(() => {
    const last = [...timeline].reverse().find((t) => t.kind === "agent_text" && t.detail);
    return task.result ?? last?.detail ?? "";
  }, [timeline, task.result]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && tab === "timeline") el.scrollTop = el.scrollHeight;
  }, [timeline, tab]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-200 bg-white px-8 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-ink-900">{task.title}</h2>
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
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-500">
            <span style={{ color: agent.accent }}>{agent.shortName}</span>
            <span className="text-ink-300">|</span>
            <span>案例 {task.caseId}</span>
            <span className="text-ink-300">|</span>
            <span>工具调用 {toolCalls.length} 次</span>
            <span className="text-ink-300">|</span>
            <span>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setReaderOpen((v) => !v)}
          title={readerOpen ? "收起侧边阅读器" : "展开侧边阅读器"}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] transition-colors ${
            readerOpen
              ? "border-ink-400 bg-ink-100 text-ink-900"
              : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50"
          }`}
        >
          <IconPanel className="h-3.5 w-3.5" />
          阅读器
        </button>
        <button
          type="button"
          onClick={onRerun}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-white px-3 py-1.5 text-[12.5px] text-ink-700 transition-colors hover:border-ink-300 hover:bg-ink-50 disabled:opacity-40"
        >
          <IconPlay className="h-3 w-3" />
          重新执行
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-ink-200 bg-white px-8">
            {(
              [
                ["timeline", "执行时间线"],
                ["tools", `工具调用 (${toolCalls.length})`],
                ["result", "执行结论"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-3 py-2.5 text-[12.5px] transition-colors ${
                  tab === key
                    ? "border-ink-800 font-medium text-ink-900"
                    : "border-transparent text-ink-500 hover:text-ink-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
            {tab === "timeline" && <TimelineView items={timeline} accent={agent.accent} onOpenUrl={openReader} />}
            {tab === "tools" && <ToolView calls={toolCalls} />}
            {tab === "result" && (
              <ResultView result={finalResult} error={task.error} status={liveStatus} onOpenUrl={openReader} />
            )}
          </div>
        </div>

        <aside
          className={`w-[280px] shrink-0 overflow-y-auto border-l border-ink-200 bg-white px-5 py-5 ${
            readerOpen ? "hidden" : "hidden xl:block"
          }`}
        >
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">任务指令</div>
          <p className="mt-1.5 whitespace-pre-wrap rounded-md bg-ink-50 px-3 py-2 text-[12.5px] leading-5 text-ink-700">
            {task.instruction}
          </p>

          <div className="mt-5 text-[11px] font-medium uppercase tracking-wider text-ink-400">业务资料</div>
          {files.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-ink-400">本任务未上传资料</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => openReader({ kind: "file", taskId: task.id, fileId: f.id, name: f.fileName })}
                    className="flex w-full items-start gap-2 rounded border border-ink-100 px-2 py-1.5 text-left transition-colors hover:border-ink-300 hover:bg-ink-50"
                    title="在侧边阅读器中预览"
                  >
                    <IconFile className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-ink-700">{f.fileName}</span>
                      <span className="block text-[11px] text-ink-400">
                        {(f.byteSize / 1024).toFixed(1)} KB · {f.parseStatus}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 text-[11px] font-medium uppercase tracking-wider text-ink-400">生成产物</div>
          {artifacts.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-ink-400">暂无产物（底稿导出后在此预览）</p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {artifacts.map((a) => (
                <li key={a.name}>
                  <button
                    type="button"
                    onClick={() => openReader({ kind: "artifact", taskId: task.id, name: a.name })}
                    className="flex w-full items-start gap-2 rounded border border-ink-100 px-2 py-1.5 text-left transition-colors hover:border-ink-300 hover:bg-ink-50"
                    title="在侧边阅读器中预览"
                  >
                    <IconFile className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-ink-700">{a.name}</span>
                      <span className="block text-[11px] text-ink-400">{(a.byteSize / 1024).toFixed(1)} KB</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 text-[11px] font-medium uppercase tracking-wider text-ink-400">可用工具</div>
          <ul className="mt-1.5 space-y-1">
            {agent.tools.map((t) => (
              <li key={t.name} className="font-mono text-[11.5px] text-ink-600">
                {t.name}
              </li>
            ))}
          </ul>
        </aside>

        {readerOpen && <SideReader target={readerTarget} onClose={() => setReaderOpen(false)} />}
      </div>
    </div>
  );
}

function TimelineView({
  items,
  accent,
  onOpenUrl,
}: {
  items: ReturnType<typeof useTaskEvents>["timeline"];
  accent: string;
  onOpenUrl: (target: ReaderTarget) => void;
}) {
  if (items.length === 0) {
    return <div className="py-10 text-center text-[13px] text-ink-400">等待执行事件…</div>;
  }
  return (
    <ol className="relative space-y-0 border-l border-ink-200 pl-5">
      {items.map((item) => {
        const isTool = item.kind === "tool_start";
        const isFail = item.kind === "run_failed";
        const isDone = item.kind === "run_completed";
        const isText = item.kind === "agent_text";
        return (
          <li key={item.id} className="relative pb-4">
            <span
              className="absolute -left-[25px] top-1 flex h-3 w-3 items-center justify-center rounded-full border-2 border-white"
              style={{ backgroundColor: isFail ? "#e11d48" : isDone ? "#059669" : isTool ? accent : "#b6bcc9" }}
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[12.5px] font-medium text-ink-800">{item.title}</span>
              <span className="font-mono text-[11px] text-ink-400">
                {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>
              {isTool && item.payload != null && (
                <span className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">
                  <IconTool className="h-3 w-3" />
                  {String((item.payload as { toolName?: string }).toolName ?? "")}
                </span>
              )}
            </div>
            {item.detail && !isText && <p className="mt-1 text-[12.5px] leading-5 text-ink-600">{item.detail}</p>}
            {isText && (
              <div className="mt-2 rounded-md border border-ink-100 bg-white px-4 py-3">
                <MarkdownView
                  text={item.detail ?? ""}
                  live={item.streaming}
                  onOpenUrl={(url) => onOpenUrl({ kind: "url", url })}
                />
                {item.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ink-400 align-middle" />}
              </div>
            )}
            {isDone && (
              <span className="mt-1 inline-flex items-center gap-1 text-[12px] text-emerald-600">
                <IconCheck className="h-3.5 w-3.5" />
                本次运行已结束
              </span>
            )}
            {isFail && (
              <span className="mt-1 inline-flex items-center gap-1 text-[12px] text-rose-600">
                <IconAlert className="h-3.5 w-3.5" />
                运行异常终止
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ToolView({ calls }: { calls: ReturnType<typeof useTaskEvents>["toolCalls"] }) {
  if (calls.length === 0) {
    return <div className="py-10 text-center text-[13px] text-ink-400">尚无工具调用记录</div>;
  }
  return (
    <ul className="space-y-3">
      {calls.map((call, i) => (
        <li key={`${call.toolName}-${i}`} className="rounded-md border border-ink-200 bg-white">
          <div className="flex items-center gap-2 border-b border-ink-100 px-3.5 py-2">
            <IconTool className="h-3.5 w-3.5 text-ink-500" />
            <span className="font-mono text-[12.5px] text-ink-900">{call.toolName}</span>
            <span className="ml-auto text-[11.5px]">
              {call.ok === null ? (
                <span className="inline-flex items-center gap-1 text-amber-600">
                  <IconSpinner className="h-3 w-3" />
                  执行中
                </span>
              ) : call.ok ? (
                <span className="inline-flex items-center gap-1 text-emerald-600">
                  <IconCheck className="h-3 w-3" />
                  成功
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-rose-600">
                  <IconAlert className="h-3 w-3" />
                  失败
                </span>
              )}
            </span>
          </div>
          <div className="grid gap-3 px-3.5 py-2.5 md:grid-cols-2">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">入参</div>
              <pre className="mt-1 max-h-52 overflow-auto rounded bg-ink-50 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-ink-700">
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">返回</div>
              <pre className="mt-1 max-h-52 overflow-auto rounded bg-ink-50 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-ink-700">
                {call.ok === null ? "—" : JSON.stringify(call.result, null, 2)}
              </pre>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ResultView({
  result,
  error,
  status,
  onOpenUrl,
}: {
  result: string;
  error: string | null;
  status: string;
  onOpenUrl: (target: ReaderTarget) => void;
}) {
  if (error) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
        <div className="font-medium">执行失败</div>
        <div className="mt-1 break-words">{error}</div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="py-10 text-center text-[13px] text-ink-400">
        {status === "processing" ? "Agent 正在执行…" : "暂无执行结论"}
      </div>
    );
  }
  return (
    <article className="max-w-4xl rounded-md border border-ink-200 bg-white px-6 py-5">
      <MarkdownView text={result} onOpenUrl={(url) => onOpenUrl({ kind: "url", url })} />
    </article>
  );
}
