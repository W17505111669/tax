import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SheetPreview } from "../types.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { usePaperTheme } from "../hooks/usePaperTheme.ts";
import { IconAlert, IconExternal, IconFile, IconSpinner, IconX } from "./Icons.tsx";

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
  onClose: () => void;
}

/** 侧边可折叠阅读器：支持多文档标签页，网页阅读模式、任务资料与生成产物统一预览。 */
export function SideReader({ tabs, activeIndex, onSelect, onCloseTab, onClose }: Props) {
  const [states, setStates] = useState<Record<string, ReaderState>>({});
  const { theme } = usePaperTheme();
  const active = tabs[activeIndex] ?? null;
  const activeKey = active ? readerKey(active) : "";
  const state = states[activeKey] ?? INITIAL;

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
  }, [activeKey]);

  return (
    <aside className="no-print flex w-[440px] shrink-0 flex-col border-l border-line bg-night-950">
      <header className="flex items-stretch gap-0 border-b border-line">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((tab, i) => {
            const key = readerKey(tab);
            const tabState = states[key];
            const label = tabState?.title || fallbackTitle(tab);
            const isActive = i === activeIndex;
            return (
              <div
                key={key}
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
                  <IconFile className="h-3.5 w-3.5 shrink-0 text-glow-400" />
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
        </div>
        <button
          type="button"
          onClick={onClose}
          title="收起阅读器"
          className="shrink-0 px-3 text-mist-600 hover:bg-night-900 hover:text-mist-100"
        >
          <IconX className="h-3.5 w-3.5" />
        </button>
      </header>

      {(state.kind === "markdown" || state.kind === "text") && !state.loading && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-1.5">
          <span className="kicker">版式</span>
          <ThemeSwitch />
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {state.loading && (
          <div className="flex items-center gap-2 py-8 text-[12.5px] text-mist-600">
            <IconSpinner className="h-4 w-4" />
            正在读取内容…
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
          </div>
        )}
        {!state.loading && !state.error && (state.kind === "markdown" || state.kind === "text") && (
          <div className={`paper-sheet theme-${theme} px-6 py-5`}>
            {state.kind === "markdown" ? (
              <MarkdownView text={state.markdown} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-gray-700">
                {state.text}
              </pre>
            )}
          </div>
        )}
        {!state.loading && !state.error && state.kind === "image" && (
          <img src={state.src} alt={state.title} className="mx-auto max-w-full rounded-md border border-line" />
        )}
        {!state.loading && !state.error && state.kind === "pdf" && (
          <iframe src={state.src} title={state.title} className="h-[70vh] w-full rounded-md border border-line bg-white" />
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
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[11.5px]">
                    <thead>
                      <tr>
                        {s.headers.map((h) => (
                          <th
                            key={h}
                            className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-800"
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
