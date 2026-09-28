import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { IconAlert, IconExternal, IconFile, IconSpinner, IconX } from "./Icons.tsx";

export type ReaderTarget =
  | { kind: "url"; url: string }
  | { kind: "file"; taskId: string; fileId: string; name: string }
  | { kind: "artifact"; taskId: string; name: string };

type PreviewKind = "markdown" | "text" | "pdf" | "image" | "binary";

interface ReaderState {
  loading: boolean;
  error: string | null;
  kind: PreviewKind;
  title: string;
  markdown: string;
  text: string;
  src: string;
}

const INITIAL: ReaderState = {
  loading: false,
  error: null,
  kind: "text",
  title: "",
  markdown: "",
  text: "",
  src: "",
};

function previewKind(headerKind: string | null, name: string): PreviewKind {
  if (headerKind === "pdf") return "pdf";
  if (headerKind === "image") return "image";
  if (headerKind === "text") return name.toLowerCase().endsWith(".md") ? "markdown" : "text";
  return "binary";
}

/** 侧边可折叠阅读器：网页阅读模式、任务资料与生成产物的统一预览入口。 */
export function SideReader({ target, onClose }: { target: ReaderTarget | null; onClose: () => void }) {
  const [state, setState] = useState<ReaderState>(INITIAL);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setState({ ...INITIAL, loading: true });

    void (async () => {
      try {
        if (target.kind === "url") {
          const result = await api.readUrl(target.url);
          if (cancelled) return;
          if ((result.contentType ?? "").includes("application/pdf")) {
            setState({
              loading: false,
              error: null,
              kind: "pdf",
              title: result.title || target.url,
              markdown: "",
              text: "",
              src: target.url,
            });
            return;
          }
          setState({
            loading: false,
            error: null,
            kind: "markdown",
            title: result.title || target.url,
            markdown: result.markdown || result.excerpt || "（该网页未提取到正文）",
            text: "",
            src: target.url,
          });
          return;
        }

        const url =
          target.kind === "file"
            ? api.fileContentUrl(target.taskId, target.fileId)
            : api.artifactContentUrl(target.taskId, target.name);
        const name = target.name;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
        const kind = previewKind(res.headers.get("X-Preview-Kind"), name);
        if (kind === "text" || kind === "markdown") {
          const text = await res.text();
          if (cancelled) return;
          setState({ loading: false, error: null, kind, title: name, markdown: text, text, src: url });
        } else {
          if (cancelled) return;
          setState({ loading: false, error: null, kind, title: name, markdown: "", text: "", src: url });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ ...INITIAL, error: err instanceof Error ? err.message : "读取失败" });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-night-950">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <IconFile className="h-4 w-4 shrink-0 text-glow-400" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-mist-100" title={state.title}>
          {state.title || "阅读器"}
        </span>
        {target?.kind === "url" && (
          <a
            href={target.url}
            target="_blank"
            rel="noreferrer"
            title="在新标签页打开原文"
            className="shrink-0 rounded p-1 text-mist-600 hover:bg-night-800 hover:text-glow-300"
          >
            <IconExternal className="h-3.5 w-3.5" />
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          title="收起阅读器"
          className="shrink-0 rounded p-1 text-mist-600 hover:bg-night-800 hover:text-mist-100"
        >
          <IconX className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {state.loading && (
          <div className="flex items-center gap-2 py-8 text-[12.5px] text-mist-600">
            <IconSpinner className="h-4 w-4" />
            正在读取内容…
          </div>
        )}
        {state.error && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-300">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.error}
          </div>
        )}
        {!state.loading && !state.error && (state.kind === "markdown" || state.kind === "text") && (
          <div className="paper-sheet px-6 py-5">
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
        {!state.loading && !state.error && target?.kind === "url" && (
          <p className="mt-4 border-t border-line pt-3 text-[11px] text-mist-600">
            阅读模式正文由服务端 Readability 提取，仅供参考；原文以
            <a href={target.url} target="_blank" rel="noreferrer" className="ml-1 underline">
              来源链接
            </a>
            为准。
          </p>
        )}
      </div>
    </aside>
  );
}
