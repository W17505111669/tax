import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import mermaid from "mermaid";

let mermaidInitialized = false;

function ensureMermaid(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    fontFamily: '"Inter", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
    flowchart: { curve: "basis", htmlLabels: true },
  });
  mermaidInitialized = true;
}

/** 把 mermaid 代码块抽成占位节点，避免被 marked 当成普通代码块转义。 */
function extractMermaid(text: string): { prepared: string; fences: string[] } {
  const fences: string[] = [];
  const prepared = text.replace(/```mermaid[ \t]*\r?\n([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(code.trim());
    return `\n<div data-mermaid="${fences.length - 1}"></div>\n`;
  });
  return { prepared, fences };
}

function renderMarkdown(el: HTMLElement, text: string, live: boolean): void {
  const { prepared, fences } = extractMermaid(text);
  const raw = marked.parse(prepared, { gfm: true, breaks: true }) as string;
  el.innerHTML = DOMPurify.sanitize(raw, { ADD_ATTR: ["data-mermaid"] });

  if (live) return;
  const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-mermaid]"));
  if (nodes.length === 0) return;
  ensureMermaid();
  for (const node of nodes) {
    const code = fences[Number(node.getAttribute("data-mermaid"))] ?? "";
    node.removeAttribute("data-mermaid");
    node.classList.add("mermaid");
    node.textContent = code;
  }
  void mermaid.run({ nodes, suppressErrors: true }).catch(() => {
    // 单个图语法错误不影响其余内容渲染
  });
}

interface Props {
  text: string;
  /** 流式输出期间为 true：延迟渲染且不执行 mermaid，避免半成品图报错。 */
  live?: boolean;
  className?: string;
}

export function MarkdownView({ text, live = false, className = "" }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      renderMarkdown(el, text, live);
    }, live ? 90 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, live]);

  return <div ref={ref} className={`md-body ${className}`} />;
}
