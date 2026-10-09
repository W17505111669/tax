/**
 * mermaid 图导出的纯逻辑（文件名 / 导出用配置指令 / SVG 尺寸解析 / 交付件脱敏）。
 *
 * 只放不碰 DOM 的部分，便于 apps/api/scripts/verify-diaexport.ts 直接校验；
 * 真正栅格化的那一步在 diagram-download.ts。
 */

/** 导出背景色：与 mermaid 主题的 background 一致，暗色图放白底会看不见文字 */
export const DIAGRAM_BACKGROUND = "#0a0b0d";

/** PNG 放大倍数：2 倍够插进 PPT 与 Word，再大文件就没必要了 */
export const PNG_SCALE = 2;

/**
 * 导出必需的配置项（对象形态）：EXPORT_INIT 由它生成，合并作者配置时也用它，同一件事不写两遍。
 *
 * `htmlLabels` 顶层与 `flowchart.htmlLabels` 两处都写：mermaid 各版本认的位置不一样（v11 实测
 * 只关 flowchart 那一级，导出的 SVG 里节点标签仍然落在 foreignObject 里），多写一处对不认它的
 * 版本无害，少写一处就会导出插进 Office 没有文字的图。
 */
const EXPORT_CONFIG: Record<string, unknown> = {
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  sequence: { useMaxWidth: false },
};

/**
 * 导出专用的 mermaid 配置指令。
 * 页面上的图用 htmlLabels（标签是 foreignObject 里的 HTML），栅格化到 canvas 时
 * 不继承页面样式，标签容易掉字号甚至不显示；导出这份改用纯 text 元素，画进 PNG 才稳。
 * useMaxWidth 关掉是为了让时序图按自然宽度出图，而不是被压到容器宽度。
 */
export const EXPORT_INIT = `%%{init: ${JSON.stringify(EXPORT_CONFIG)}}%%`;

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

/**
 * 给导出用的代码前置配置指令。
 *
 * 原文没带 init 时直接前置 EXPORT_INIT。原文已带 init 时是**合并**而不是原样返回：尊重作者写的
 * 主题与配色，但 `htmlLabels` 必须关掉——导出件的目标是「能插进 Office」，而 Office 与 WPS 不渲染
 * foreignObject，标签会整片空白。实测就是这么翻的车：一张自带 `%%{init: {"theme":...}}%%` 的流程图，
 * 导出的 SVG 有 18KB、`<path>` 与 `<rect>` 齐全，12 处文字却全在 foreignObject 里，插进 Office
 * 就是一张只有框没有字的图。此前的行为是「原文已带 init 就原样返回，尊重作者配置」——那个取舍在
 * 页面上成立，在导出件上不成立。
 *
 * 作者的 init 解析不出来时不猜（mermaid 容忍比 JSON 宽松的写法），整条换成导出配置。
 */
export function withExportInit(code: string): string {
  // 捕获组必须贪婪：init 的 JSON 自己就以 } 结尾，写成非贪婪会在第一个 `}%%` 处截断，
  // 把 `{"theme":"neutral"}` 捕成 `{"theme":"neutral"`，JSON.parse 失败 → 作者配置被整条丢掉。
  const m = /^\s*%%\{\s*init\s*:([\s\S]*)\}%%/.exec(code);
  if (!m) return `${EXPORT_INIT}\n${code.trim()}`;
  const rest = code.slice((m.index ?? 0) + m[0].length).trim();
  return `%%{init: ${mergeExportConfig(m[1] ?? "")}}%%\n${rest}`;
}

/** 把作者写的 init 配置与导出必需项合并：作者的其它配置优先，`htmlLabels` 一律关掉 */
function mergeExportConfig(raw: string): string {
  let author: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return JSON.stringify(EXPORT_CONFIG);
    author = parsed as Record<string, unknown>;
  } catch {
    return JSON.stringify(EXPORT_CONFIG);
  }
  const out: Record<string, unknown> = { ...author };
  for (const [k, v] of Object.entries(EXPORT_CONFIG)) {
    const a = author[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && a && typeof a === "object" && !Array.isArray(a)
        ? { ...(a as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
  }
  // htmlLabels 是导出件的硬要求：作者显式写了 true 也覆盖，取舍写在上面的注释里
  const fc = out.flowchart;
  out.flowchart =
    fc && typeof fc === "object" && !Array.isArray(fc)
      ? { ...(fc as Record<string, unknown>), htmlLabels: false }
      : { htmlLabels: false };
  return JSON.stringify(out);
}

/**
 * 给导出的 SVG 补上 xmlns 命名空间声明。
 *
 * mermaid 渲染出的 svg 字符串不一定带 xmlns：留在页面 DOM 里无所谓（HTML 解析器认），一旦存成
 * 独立 .svg 文件，Office、WPS 与不少图片编辑器就按「不是 SVG」处理，插入后是空白或报错。
 * 此前 SVG 导出走的是 clone 页面节点再 setAttribute("xmlns", …)，改成与 PNG 同源的重新渲染之后
 * 拿到的是字符串，命名空间得在字符串上补。
 */
export function withXmlns(svg: string): string {
  if (/<svg[^>]*\sxmlns\s*=/.test(svg)) return svg;
  return svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
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
