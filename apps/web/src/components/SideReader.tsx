import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import type { SheetPreview } from "../types.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { usePaperTheme } from "../hooks/usePaperTheme.ts";
import { IconAlert, IconExternal, IconFile, IconRefresh, IconX } from "./Icons.tsx";

export type ReaderTarget =
  | { kind: "url"; url: string }
  | { kind: "file"; taskId: string; fileId: string; name: string; highlight?: string }
  | { kind: "artifact"; taskId: string; name: string; highlight?: string };

export function readerKey(target: ReaderTarget): string {
  if (target.kind === "url") return `url:${target.url}`;
  if (target.kind === "file") return `file:${target.taskId}:${target.fileId}`;
  return `artifact:${target.taskId}:${target.name}`;
}

type PreviewKind = "markdown" | "text" | "pdf" | "image" | "binary" | "sheets";

interface ReaderState {
  loading: boolean;
  error: string | null;
  kind: PreviewKind;
  title: string;
  markdown: string;
  text: string;
  src: string;
  sheets?: SheetPreview[];
}

const INITIAL: ReaderState = {
  loading: false,
  error: null,
  kind: "text",
  title: "",
  markdown: "",
  text: "",
  src: "",
  sheets: [],
};

function previewKind(headerKind: string | null, name: string): PreviewKind {
  if (headerKind === "pdf") return "pdf";
  if (headerKind === "image") return "image";
  if (headerKind === "text") return name.toLowerCase().endsWith(".md") ? "markdown" : "text";
  return "binary";
}

function fallbackTitle(target: ReaderTarget): string {
  if (target.kind === "url") {
    try {
      return new URL(target.url).hostname;
    } catch {
      return target.url;
    }
  }
  return target.name;
}

interface Props {
  tabs: ReaderTarget[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onCloseTab: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onClose: () => void;
}

/** 侧边可折叠阅读器：支持多文档标签页，网页阅读模式、任务资料与生成产物统一预览。 */
export function SideReader({ tabs, activeIndex, onSelect, onCloseTab, onReorder, onClose }: Props) {
  const [states, setStates] = useState<Record<string, ReaderState>>({});
  const { theme } = usePaperTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showLines, setShowLines] = useState(false);
  const active = tabs[activeIndex] ?? null;
  const activeKey = active ? readerKey(active) : "";
  const state = states[activeKey] ?? INITIAL;
  const [group, setGroup] = useState<"refs" | "gens">(() =>
    localStorage.getItem("taxai-reader-group") === "gens" ? "gens" : "refs",
  );
  const chooseGroup = (g: "refs" | "gens") => {
    setGroup(g);
    localStorage.setItem("taxai-reader-group", g);
  };
  const indexed = tabs.map((t, i) => ({ t, i }));
  const refs = indexed.filter((x) => x.t.kind !== "artifact");
  const gens = indexed.filter((x) => x.t.kind === "artifact");
  const visible = group === "refs" ? refs : gens;

  // 活动标签切换时自动归入对应分组
  useEffect(() => {
    if (!active) return;
    chooseGroup(active.kind === "artifact" ? "gens" : "refs");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // 表格预览加载完成后，把比对定位的高亮行滚到视口中央
  useEffect(() => {
    if (state.loading || state.kind !== "sheets") return;
    const el = scrollRef.current?.querySelector(".row-hl");
    el?.scrollIntoView({ block: "center" });
  }, [state.loading, state.kind, activeKey]);

  // 切换标签时重置缩放
  useEffect(() => {
    setZoom(1);
    setShowLines(false);
  }, [activeKey]);

  useEffect(() => {
    if (!active) return;
    const key = readerKey(active);
    if (states[key]) return;
    let cancelled = false;
    setStates((prev) => ({ ...prev, [key]: { ...INITIAL, loading: true } }));

    void (async () => {
      try {
        if (active.kind === "url") {
          const result = await api.readUrl(active.url);
          if (cancelled) return;
          if ((result.contentType ?? "").includes("application/pdf")) {
            setStates((prev) => ({
              ...prev,
              [key]: {
                loading: false,
                error: null,
                kind: "pdf",
                title: result.title || active.url,
                markdown: "",
                text: "",
                src: active.url,
              },
            }));
            return;
          }
          setStates((prev) => ({
            ...prev,
            [key]: {
              loading: false,
              error: null,
              kind: "markdown",
              title: result.title || active.url,
              markdown: result.markdown || result.excerpt || "（该网页未提取到正文）",
              text: "",
              src: active.url,
            },
          }));
          return;
        }

        const url =
          active.kind === "file"
            ? api.fileContentUrl(active.taskId, active.fileId)
            : api.artifactContentUrl(active.taskId, active.name);
        // Excel 优先走工作表结构化预览
        if (/\.xlsx?$/i.test(active.name)) {
          try {
            const sheetsUrl =
              active.kind === "file"
                ? api.fileSheetsUrl(active.taskId, active.fileId)
                : api.artifactSheetsUrl(active.taskId, active.name);
            const sheets = await api.readSheets(sheetsUrl);
            if (!cancelled) {
              setStates((prev) => ({
                ...prev,
                [key]: {
                  loading: false,
                  error: null,
                  kind: "sheets",
                  title: active.name,
                  markdown: "",
                  text: "",
                  src: "",
                  sheets,
                },
              }));
            }
            return;
          } catch {
            // 回退到二进制预览
          }
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
        const kind = previewKind(res.headers.get("X-Preview-Kind"), active.name);
        if (kind === "text" || kind === "markdown") {
          const text = await res.text();
          if (cancelled) return;
          setStates((prev) => ({
            ...prev,
            [key]: { loading: false, error: null, kind, title: active.name, markdown: text, text, src: url },
          }));
        } else {
          if (cancelled) return;
          setStates((prev) => ({
            ...prev,
            [key]: { loading: false, error: null, kind, title: active.name, markdown: "", text: "", src: url },
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setStates((prev) => ({
            ...prev,
            [key]: { ...INITIAL, error: err instanceof Error ? err.message : "读取失败" },
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, reload]);

  return (
    <aside className="no-print flex w-[440px] shrink-0 flex-col border-l border-line bg-night-950">
      <header className="border-b border-line">
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="seg-tabs">
            <button type="button" className="seg-tab" data-on={group === "refs"} onClick={() => chooseGroup("refs")}>
              引用文件{refs.length > 0 ? ` ${refs.length}` : ""}
            </button>
            <button type="button" className="seg-tab" data-on={group === "gens"} onClick={() => chooseGroup("gens")}>
              文件生成{gens.length > 0 ? ` ${gens.length}` : ""}
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="收起阅读器"
            className="ml-auto rounded p-1 text-mist-600 hover:bg-night-900 hover:text-mist-100"
          >
            <IconX className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex min-w-0 items-stretch overflow-x-auto">
          {visible.map(({ t: tab, i }) => {
            const key = readerKey(tab);
            const tabState = states[key];
            const label = tabState?.title || fallbackTitle(tab);
            const isActive = i === activeIndex;
            return (
              <div
                key={key}
                draggable
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i);
                  setDragIdx(null);
                }}
                onDragEnd={() => setDragIdx(null)}
                className={`group flex shrink-0 items-center gap-1.5 border-r border-line px-3 py-2 ${
                  isActive ? "bg-night-800 text-mist-100" : "text-mist-600 hover:bg-night-900 hover:text-mist-300"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  className="flex min-w-0 items-center gap-1.5 text-[12px]"
                  title={label}
                >
                  {tab.kind === "url" ? (
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-glow-500/20 text-[8px] font-bold text-glow-300">
                      {(fallbackTitle(tab).slice(0, 1) || "?").toUpperCase()}
                    </span>
                  ) : tab.kind === "artifact" ? (
                    <IconFile className="h-3.5 w-3.5 shrink-0 text-jade-400" />
                  ) : (
                    <IconFile className="h-3.5 w-3.5 shrink-0 text-glow-400" />
                  )}
                  <span className="max-w-[140px] truncate">{label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onCloseTab(i)}
                  title="关闭标签"
                  className="rounded p-0.5 text-mist-600 opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
                >
                  <IconX className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {visible.length === 0 && (
            <span className="px-3 py-2 text-[11.5px] text-mist-600">
              {group === "refs" ? "暂无引用网页或任务资料" : "暂无生成产物"}
            </span>
          )}
        </div>
      </header>

      {(state.kind === "markdown" || state.kind === "text") && !state.loading && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-1.5">
          <span className="kicker">版式</span>
          <ThemeSwitch />
          {state.kind === "text" && (
            <button
              type="button"
              className="action-btn ml-auto"
              data-on={showLines}
              onClick={() => setShowLines((v) => !v)}
              title="切换行号显示"
            >
              行号
            </button>
          )}
        </div>
      )}

      {active?.kind === "url" && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-600">{active.url}</span>
          <a
            href={active.url}
            target="_blank"
            rel="noreferrer"
            title="在新标签页打开原文"
            className="shrink-0 rounded p-1 text-mist-600 hover:bg-night-800 hover:text-glow-300"
          >
            <IconExternal className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {!state.loading && !state.error && (state.kind === "image" || state.kind === "pdf") && (
        <div className="flex items-center gap-1 border-b border-line px-4 py-1.5">
          <span className="kicker mr-1">缩放</span>
          <button type="button" className="action-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} title="缩小">
            −
          </button>
          <span className="min-w-[42px] text-center font-mono text-[11px] text-mist-300">{Math.round(zoom * 100)}%</span>
          <button type="button" className="action-btn" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} title="放大">
            ＋
          </button>
          <button type="button" className="action-btn" onClick={() => setZoom(1)} title="重置缩放">
            重置
          </button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {state.loading && (
          <div className="flex flex-col items-center gap-4 py-14">
            <div className="dot-grid" aria-hidden>
              {Array.from({ length: 25 }, (_, i) => (
                <span
                  key={i}
                  style={{ animationDelay: `${(i % 5) * 0.12 + Math.floor(i / 5) * 0.12}s` }}
                />
              ))}
            </div>
            <span className="text-[12px] text-mist-600">正在读取内容…</span>
          </div>
        )}
        {state.error && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-300">
            <div className="flex items-start gap-2">
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {state.error}
            </div>
            {active?.kind === "url" && (
              <a
                href={active.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-night-800 px-2.5 py-1 text-[12px] text-mist-100 hover:border-glow-500"
              >
                <IconExternal className="h-3 w-3" />
                目标站拒绝抓取时，可在新标签页打开原文
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                const key = activeKey;
                setStates((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                });
                setReload((r) => r + 1);
              }}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-night-800 px-2.5 py-1 text-[12px] text-mist-100 hover:border-glow-500"
            >
              <IconRefresh className="h-3 w-3" />
              重试读取
            </button>
          </div>
        )}
        {!state.loading && !state.error && (state.kind === "markdown" || state.kind === "text") && (
          <div className={`paper-sheet theme-${theme} px-6 py-5`}>
            {state.kind === "markdown" ? (
              <MarkdownView text={state.markdown} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-gray-700">
                {showLines
                  ? state.text.split("\n").map((ln, i) => (
                      <div key={i} className="grid grid-cols-[3ch_1fr] gap-2">
                        <span className="select-none text-right text-gray-400">{i + 1}</span>
                        <span className="whitespace-pre-wrap">{ln}</span>
                      </div>
                    ))
                  : state.text}
              </pre>
            )}
          </div>
        )}
        {!state.loading && !state.error && state.kind === "image" && (
          <img
            src={state.src}
            alt={state.title}
            style={{ width: `${zoom * 100}%` }}
            className="mx-auto max-w-none rounded-md border border-line"
          />
        )}
        {!state.loading && !state.error && state.kind === "pdf" && (
          <iframe
            src={state.src}
            title={state.title}
            style={{ height: `${70 * zoom}vh` }}
            className="w-full rounded-md border border-line bg-white"
          />
        )}
        {!state.loading && !state.error && state.kind === "binary" && (
          <div className="glow-card px-4 py-6 text-center">
            <p className="text-[12.5px] text-mist-500">该文件类型暂不支持在线预览</p>
            <a
              href={state.src}
              download={state.title}
              className="mt-2 inline-block rounded-md border border-line bg-night-800 px-3 py-1.5 text-[12.5px] text-mist-100 hover:border-glow-500"
            >
              下载文件
            </a>
          </div>
        )}
        {!state.loading && !state.error && state.kind === "sheets" && (
          <div className="paper-sheet px-5 py-4">
            {(state.sheets ?? []).map((s) => (
              <section key={s.name} className="mb-5 last:mb-0">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-gray-900">{s.name}</span>
                  <span className="text-[11px] text-gray-500">{s.rowCount} 行</span>
                  {active && "highlight" in active && active.highlight && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10.5px] text-amber-700">
                      定位：{active.highlight}
                    </span>
                  )}
                </div>
                <div className="max-h-[62vh] overflow-auto">
                  <table className="w-full border-collapse text-[11.5px]">
                    <thead>
                      <tr>
                        {s.headers.map((h) => (
                          <th
                            key={h}
                            className="sticky top-0 z-10 border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-800"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.slice(0, 100).map((row, i) => (
                        <tr
                          key={i}
                          className={
                            active &&
                            "highlight" in active &&
                            active.highlight &&
                            String(row[s.headers[0] ?? ""]) === active.highlight
                              ? "row-hl"
                              : undefined
                          }
                        >
                          {s.headers.map((h) => (
                            <td key={h} className="border border-gray-200 px-2 py-1 align-top text-gray-700">
                              {row[h] === null || row[h] === undefined ? "" : String(row[h])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
        {!state.loading && !state.error && active?.kind === "url" && (
          <p className="mt-4 border-t border-line pt-3 text-[11px] text-mist-600">
            阅读模式正文由服务端 Readability 提取，仅供参考；原文以
            <a href={active.url} target="_blank" rel="noreferrer" className="ml-1 underline">
              来源链接
            </a>
            为准。
          </p>
        )}
      </div>
    </aside>
  );
}
