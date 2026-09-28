import { useEffect, useRef, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

/** mermaid 体积大，按需动态加载，避免拖慢首屏。 */
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      mod.default.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    fontFamily: '"Inter", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
    flowchart: { curve: "basis", htmlLabels: true },
        themeVariables: {
      darkMode: true,
      background: "#04070d",
      primaryColor: "#0d1526",
      primaryTextColor: "#e6edf7",
      primaryBorderColor: "#16283f",
      lineColor: "#22d3ee",
      textColor: "#b7c6da",
      mainBkg: "#0d1526",
      nodeBorder: "#1b2c47",
      clusterBkg: "rgba(18, 32, 54, 0.6)",
      edgeLabelBackground: "#060b16",
        },
      });
      return mod.default;
    });
  }
  return mermaidPromise;
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
  for (const node of nodes) {
    const code = fences[Number(node.getAttribute("data-mermaid"))] ?? "";
    node.removeAttribute("data-mermaid");
    node.classList.add("mermaid");
    node.textContent = code;
  }
  void loadMermaid()
    .then((mermaid) =>
      mermaid.run({ nodes, suppressErrors: true }).then(() => {
        // 渲染完成后为每张图注入「下载 SVG」工具条
        for (const node of nodes) {
          const svg = node.querySelector("svg");
          if (!svg || node.querySelector(".mermaid-tools")) continue;
          const bar = document.createElement("div");
          bar.className = "mermaid-tools";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "action-btn";
          btn.title = "下载 SVG";
          btn.textContent = "下载 SVG";
          btn.addEventListener("click", () => {
            const clone = svg.cloneNode(true) as SVGSVGElement;
            clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            const blob = new Blob([clone.outerHTML], { type: "image/svg+xml;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "diagram.svg";
            a.click();
            URL.revokeObjectURL(url);
          });
          bar.appendChild(btn);
          node.appendChild(bar);
        }
      }),
    )
    .catch(() => {
      // 单个图语法错误不影响其余内容渲染
    });
}

interface Props {
  text: string;
  /** 流式输出期间为 true：延迟渲染且不执行 mermaid，避免半成品图报错。 */
  live?: boolean;
  className?: string;
  /** 点击外部链接时回调（用于侧边阅读器），不设置则保持默认跳转。 */
  onOpenUrl?: (url: string) => void;
  /** 为 h2/h3 生成 sec-N 锚点 id（供目录跳转）。 */
  headingIds?: boolean;
}

export function MarkdownView({ text, live = false, className = "", onOpenUrl, headingIds = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      renderMarkdown(el, text, live);
      if (headingIds && !live) {
        el.querySelectorAll("h2, h3").forEach((h, i) => {
          h.id = `sec-${i}`;
        });
      }
    }, live ? 90 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, live]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onOpenUrl) return;
    const anchor = (event.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    onOpenUrl(href);
  };

  return <div ref={ref} onClick={handleClick} className={`md-body ${className}`} />;
}
