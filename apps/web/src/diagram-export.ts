/**
 * mermaid 图导出的纯逻辑（文件名 / 导出用配置指令 / SVG 尺寸解析 / 交付件脱敏）。
 *
 * 只放不碰 DOM 的部分，便于 apps/api/scripts/verify-diaexport.ts 直接校验；
 * 真正栅格化的那一步在 diagram-download.ts。
 */

/** 导出背景色：与 mermaid 主题的 background 一致，暗色图放白底会看不见文字 */
export const DIAGRAM_BACKGROUND = "#04070d";

/** PNG 放大倍数：2 倍够插进 PPT 与 Word，再大文件就没必要了 */
export const PNG_SCALE = 2;

/**
 * 导出专用的 mermaid 配置指令。
 * 页面上的图用 htmlLabels（标签是 foreignObject 里的 HTML），栅格化到 canvas 时
 * 不继承页面样式，标签容易掉字号甚至不显示；导出这份改用纯 text 元素，画进 PNG 才稳。
 * useMaxWidth 关掉是为了让时序图按自然宽度出图，而不是被压到容器宽度。
 */
export const EXPORT_INIT = `%%{init: {"flowchart":{"htmlLabels":false},"sequence":{"useMaxWidth":false}}}%%`;

const KINDS: Array<[RegExp, string]> = [
  [/^(flowchart|graph)\b/, "流程图"],
  [/^sequenceDiagram\b/, "时序图"],
  [/^classDiagram\b/, "类图"],
  [/^stateDiagram\b/, "状态图"],
  [/^erDiagram\b/, "实体关系图"],
  [/^gantt\b/, "甘特图"],
  [/^pie\b/, "饼图"],
  [/^journey\b/, "用户旅程图"],
  [/^gitGraph\b/, "分支图"],
  [/^mindmap\b/, "思维导图"],
  [/^timeline\b/, "时间线"],
  [/^quadrantChart\b/, "象限图"],
  [/^xychart-beta\b/, "柱线图"],
  [/^sankey-beta\b/, "桑基图"],
];

/** 去掉开头的 init 指令与空行，取到真正决定图类型的那一行 */
function headOf(code: string): string {
  return code
    .replace(/^\s*%%\{[\s\S]*?\}%%\s*/, "")
    .replace(/^\s*---[\s\S]*?---\s*/, "")
    .trim();
}

/** 图类型的中文名，用于文件名；认不出来就只叫「图表」，不猜 */
export function diagramKind(code: string): string {
  const head = headOf(code);
  return KINDS.find(([re]) => re.test(head))?.[1] ?? "图表";
}

/** 文件名：同一段结论里往往有好几张图，都叫 diagram.svg 会互相覆盖 */
export function diagramFilename(code: string, index: number, ext: "svg" | "png"): string {
  const n = Math.max(1, Math.trunc(Number.isFinite(index) ? index : 0) + 1);
  return `图${n}-${diagramKind(code)}.${ext}`;
}

/** 给导出用的代码前置配置指令；原文已带 init 指令时原样返回，尊重作者写的配置 */
export function withExportInit(code: string): string {
  if (/^\s*%%\{[\s\S]*?\}%%/.test(code)) return code;
  return `${EXPORT_INIT}\n${code.trim()}`;
}

/** 从 viewBox 或 width/height 取尺寸；mermaid 的 SVG 通常写 width="100%"，只能靠 viewBox */
export function svgSize(svg: string): { width: number; height: number } | null {
  const vb = svg.match(/viewBox\s*=\s*"([^"]+)"/i)?.[1];
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every((n) => Number.isFinite(n)) && p[2]! > 0 && p[3]! > 0) {
      return { width: p[2]!, height: p[3]! };
    }
  }
  // 必须是纯数字（可带 px）：width="100%" 这种拿不到像素尺寸，宁可如实返回 null 让调用方兜底
  const w = Number(svg.match(/\swidth\s*=\s*"(\d+(?:\.\d+)?)(?:px)?"/i)?.[1]);
  const h = Number(svg.match(/\sheight\s*=\s*"(\d+(?:\.\d+)?)(?:px)?"/i)?.[1]);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  return null;
}

/**
 * 导出的 SVG 会离开平台、进客户的 PPT 与底稿，里面不能带可执行内容：
 * 去掉 script 标签、on* 事件属性与 javascript: 链接。
 */
export function sanitizeSvgForExport(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\son[a-z-]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z-]+\s*=\s*'[^']*'/gi, "")
    .replace(/(href|xlink:href)\s*=\s*"javascript:[^"]*"/gi, "");
}

/** SVG 文本 → data URL（不走 Blob URL，画进 canvas 时不会被当成跨源而污染画布） */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
