import { useEffect, useRef, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { downloadText } from "../download.ts";
import { downloadDiagramPng } from "../diagram-download.ts";
import { diagramFilename, sanitizeSvgForExport, withExportInit } from "../diagram-export.ts";

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
  // 原文要留着：导出 PNG 时重新渲一份纯 text 标签的图，文件名也要靠它认图类型
  const codes = nodes.map((node) => fences[Number(node.getAttribute("data-mermaid"))] ?? "");
  nodes.forEach((node, i) => {
    node.removeAttribute("data-mermaid");
    node.classList.add("mermaid");
    node.textContent = codes[i] ?? "";
  });
  void loadMermaid()
    .then((mermaid) =>
      mermaid.run({ nodes, suppressErrors: true }).then(() => {
        // 渲染完成后为每张图注入「下载 PNG / 下载 SVG」工具条
        nodes.forEach((node, i) => {
          const svg = node.querySelector("svg");
          if (!svg || node.querySelector(".mermaid-tools")) return;
          const code = codes[i] ?? "";
          const bar = document.createElement("div");
          bar.className = "mermaid-tools";
          const mkBtn = (label: string, title: string, run: (btn: HTMLButtonElement) => void) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "action-btn";
            btn.title = title;
            btn.textContent = label;
            btn.addEventListener("click", () => run(btn));
            bar.appendChild(btn);
          };
          const flash = (btn: HTMLButtonElement, label: string, msg: string) => {
            btn.textContent = msg;
            window.setTimeout(() => {
              btn.textContent = label;
            }, 3000);
          };
          mkBtn("下载 PNG", "导出 2 倍分辨率 PNG（带背景色，Office 与 WPS 直接插得进）", (btn) => {
            void (async () => {
              try {
                const mm = await loadMermaid();
                const rendered = await mm.render(`dia-export-${i}-${Date.now()}`, withExportInit(code));
                await downloadDiagramPng(
                  diagramFilename(code, i, "png"),
                  sanitizeSvgForExport(rendered.svg),
                );
              } catch {
                flash(btn, "下载 PNG", "PNG 导出失败，请改用 SVG");
              }
            })();
          });
          mkBtn("下载 SVG", "导出矢量图（放大不糊，需要较新的 Office 或浏览器打开）", () => {
            const clone = svg.cloneNode(true) as SVGSVGElement;
            clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            downloadText(diagramFilename(code, i, "svg"), sanitizeSvgForExport(clone.outerHTML), "image/svg+xml");
          });
          node.appendChild(bar);
        });
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
  /** 就地标注：把正文里出现的这些原文片段包成带说明的标记（例如待人工确认的金额） */
  annotations?: Annotation[];
  /** 点击带 key 的标注时回调（用于「标记为已核对」一类可闭环动作） */
  onAnnotateClick?: (key: string) => void;
}

export type Annotation = { text: string; label: string; className?: string; key?: string };

/**
 * 在已渲染的正文里就地标注指定片段：跳过代码块、行内代码与 mermaid 容器，
 * 同一文本节点内按位置从前往后切分，重叠命中只保留先出现的那个。
 */
function annotate(el: HTMLElement, items: Annotation[]): void {
  const SKIP_TAGS = new Set(["PRE", "CODE", "SCRIPT", "STYLE", "SVG"]);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".mermaid") || parent.closest(".md-annot")) return NodeFilter.FILTER_REJECT;
      for (let e: HTMLElement | null = parent; e && e !== el; e = e.parentElement) {
        if (SKIP_TAGS.has(e.tagName)) return NodeFilter.FILTER_REJECT;
      }
      return (node.nodeValue ?? "").trim() === "" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);

  for (const node of nodes) {
    const value = node.nodeValue ?? "";
    const hits: Array<{ start: number; end: number; item: Annotation }> = [];
    for (const item of items) {
      if (!item.text) continue;
      let from = 0;
      for (;;) {
        const at = value.indexOf(item.text, from);
        if (at < 0) break;
        hits.push({ start: at, end: at + item.text.length, item });
        from = at + item.text.length;
      }
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const h of hits) {
      if (h.start < cursor) continue;
      if (h.start > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, h.start)));
      // 带 key 的标注渲染成 button：可点击、可键盘聚焦，点击由容器统一委派处理
      const mark = document.createElement(h.item.key ? "button" : "span");
      if (h.item.key) {
        (mark as HTMLButtonElement).type = "button";
        mark.setAttribute("data-annot-key", h.item.key);
      }
      mark.className = `md-annot ${h.item.className ?? ""}`.trim();
      mark.title = h.item.label;
      mark.textContent = value.slice(h.start, h.end);
      frag.appendChild(mark);
      cursor = h.end;
    }
    if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
    node.replaceWith(frag);
  }
}

export function MarkdownView({
  text,
  live = false,
  className = "",
  onOpenUrl,
  headingIds = false,
  annotations,
  onAnnotateClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // 标注数组每次渲染都是新对象，用内容指纹参与依赖，避免无意义的重复渲染
  const annotationsKey = (annotations ?? []).map((a) => `${a.text}:${a.label}`).join("\u0000");

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
      if (!live && annotations && annotations.length > 0) annotate(el, annotations);
    }, live ? 90 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, live, annotationsKey]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const annot = target.closest<HTMLElement>("[data-annot-key]");
    if (annot && onAnnotateClick) {
      event.preventDefault();
      onAnnotateClick(annot.dataset.annotKey ?? "");
      return;
    }
    if (!onOpenUrl) return;
    const anchor = target.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    onOpenUrl(href);
  };

  return <div ref={ref} onClick={handleClick} className={`md-body ${className}`} />;
}
