/**
 * 验证脚本：mermaid 图导出的纯逻辑（图类型识别 / 文件名 / 导出配置指令 / SVG 尺寸 / 交付件脱敏）
 * 并用比赛材料里的真实 mermaid 块走查一遍。
 * 运行：pnpm verify:diaexport
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIAGRAM_BACKGROUND,
  diagramFilename,
  diagramKind,
  EXPORT_INIT,
  PNG_SCALE,
  sanitizeSvgForExport,
  svgSize,
  svgToDataUrl,
  withExportInit,
} from "../../web/src/diagram-export.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

// 1) 图类型识别
const FLOW = "flowchart TD\n  A[上传资料] --> B{复核判断}\n  B -->|通过| C[归档]";
expect("flowchart 认成流程图", diagramKind(FLOW), "流程图");
expect("graph 也认成流程图", diagramKind("graph LR\n A-->B"), "流程图");
expect("时序图", diagramKind("sequenceDiagram\n A->>B: 核对"), "时序图");
expect("类图", diagramKind("classDiagram\n class A {}"), "类图");
expect("状态图", diagramKind("stateDiagram-v2\n [*] --> 待复核"), "状态图");
expect("实体关系图", diagramKind("erDiagram\n A ||--o{ B : has"), "实体关系图");
expect("甘特图", diagramKind("gantt\n title 排期"), "甘特图");
expect("饼图", diagramKind("pie title 占比\n \"A\" : 60"), "饼图");
expect("用户旅程图", diagramKind("journey\n title 流程"), "用户旅程图");
expect("分支图", diagramKind("gitGraph\n commit"), "分支图");
expect("思维导图", diagramKind("mindmap\n root((主题))"), "思维导图");
expect("时间线", diagramKind("timeline\n title 阶段"), "时间线");
expect("象限图", diagramKind("quadrantChart\n title 优先级"), "象限图");
expect("柱线图", diagramKind("xychart-beta\n title 趋势"), "柱线图");
expect("桑基图", diagramKind("sankey-beta\n a,b,10"), "桑基图");
expect("认不出来只叫图表，不猜", diagramKind("unknownDiagram\n x"), "图表");
expect("空代码只叫图表", diagramKind(""), "图表");
expect("大写关键字不硬认（如实兜底）", diagramKind("FLOWCHART TD\n A-->B"), "图表");
expect("前置空行不影响识别", diagramKind(`\n\n  ${FLOW}`), "流程图");
expect("带 init 指令仍能识别", diagramKind(`%%{init: {"theme":"dark"}}%%\n${FLOW}`), "流程图");
expect("带 frontmatter 仍能识别", diagramKind(`---\ntitle: 流程\n---\n${FLOW}`), "流程图");

// 2) 文件名：同一段结论里多张图不能互相覆盖
expect("第 1 张图", diagramFilename(FLOW, 0, "png"), "图1-流程图.png");
expect("第 3 张图", diagramFilename(FLOW, 2, "png"), "图3-流程图.png");
expect("SVG 扩展名", diagramFilename("sequenceDiagram\n A->>B: x", 1, "svg"), "图2-时序图.svg");
expect("负序号兜到 1", diagramFilename(FLOW, -5, "png"), "图1-流程图.png");
expect("NaN 序号兜到 1", diagramFilename(FLOW, Number.NaN, "png"), "图1-流程图.png");
expect("小数序号取整", diagramFilename(FLOW, 1.7, "png"), "图2-流程图.png");
expect(
  "同一份材料里三张图名字各不相同",
  new Set([
    diagramFilename(FLOW, 0, "png"),
    diagramFilename("sequenceDiagram\n A->>B: x", 1, "png"),
    diagramFilename("gantt\n title 排期", 2, "png"),
  ]).size,
  3,
);
expect("文件名不带路径分隔符", /[\\/]/.test(diagramFilename(FLOW, 0, "png")), false);
expect("加了导出指令后文件名不变", diagramFilename(withExportInit(FLOW), 0, "png"), diagramFilename(FLOW, 0, "png"));

// 3) 导出配置指令
expect("普通代码前置导出指令", withExportInit(FLOW).startsWith(EXPORT_INIT), true);
expect("原文完整保留", withExportInit(FLOW).endsWith(FLOW), true);
expect("已有 init 指令时原样返回", withExportInit(`%%{init: {"theme":"neutral"}}%%\n${FLOW}`), `%%{init: {"theme":"neutral"}}%%\n${FLOW}`);
expect("前面有空格的 init 指令也认", withExportInit(`  %%{init: {"theme":"neutral"}}%%\n${FLOW}`).startsWith("  %%{init"), true);
expect("导出指令关掉 htmlLabels", EXPORT_INIT.includes('"htmlLabels":false'), true);
expect("导出指令关掉 maxWidth 拉伸", EXPORT_INIT.includes('"useMaxWidth":false'), true);
const initJson = EXPORT_INIT.replace(/^%%\{init:\s*/, "").replace(/\}%%$/, "");
let parsed: unknown = null;
try {
  parsed = JSON.parse(initJson);
} catch {
  parsed = null;
}
ok("导出指令里是合法 JSON", parsed !== null && typeof parsed === "object", initJson);
expect("重复调用不会叠加指令", withExportInit(withExportInit(FLOW)), withExportInit(FLOW));

// 4) SVG 尺寸：mermaid 通常写 width="100%"，只能靠 viewBox
expect("从 viewBox 取尺寸", svgSize(`<svg viewBox="0 0 640 480" width="100%"></svg>`), { width: 640, height: 480 });
expect("viewBox 带负偏移取宽高", svgSize(`<svg viewBox="-10 -20 300 200"></svg>`), { width: 300, height: 200 });
expect("viewBox 逗号分隔也能读", svgSize(`<svg viewBox="0,0,120,80"></svg>`), { width: 120, height: 80 });
expect("viewBox 是小数也能读", svgSize(`<svg viewBox="0 0 634.667 412.5"></svg>`), { width: 634.667, height: 412.5 });
expect("没有 viewBox 时用 width/height", svgSize(`<svg width="300" height="150"></svg>`), { width: 300, height: 150 });
expect("百分比宽度且无 viewBox 时如实返回 null", svgSize(`<svg width="100%" height="100%"></svg>`), null);
expect("viewBox 宽高为 0 时不返回 0 尺寸", svgSize(`<svg viewBox="0 0 0 0" width="200" height="100"></svg>`), { width: 200, height: 100 });
expect("空串返回 null", svgSize(""), null);
expect("不是 SVG 返回 null", svgSize("<div>x</div>"), null);

// 5) 交付件脱敏：导出的图会进客户 PPT，不能带可执行内容
const dirty = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onclick="alert(1)" ONMOUSEOVER='x()'><script>alert(2)</script><a href="javascript:alert(3)"><rect width="4" height="4" fill="#0d1526" stroke-width="1" class="node" data-id="a"/></a><text>正常文字</text></svg>`;
const clean = sanitizeSvgForExport(dirty);
expect("去掉 script 标签", clean.includes("<script"), false);
expect("去掉 script 里的内容", clean.includes("alert(2)"), false);
expect("去掉双引号事件属性", clean.includes("onclick"), false);
expect("去掉大写与单引号事件属性", /onmouseover/i.test(clean), false);
expect("去掉 javascript: 链接", clean.includes("javascript:"), false);
expect("保留 xmlns", clean.includes('xmlns="http://www.w3.org/2000/svg"'), true);
expect("保留 viewBox", clean.includes('viewBox="0 0 10 10"'), true);
expect("保留样式属性", clean.includes('fill="#0d1526"') && clean.includes('stroke-width="1"'), true);
expect("保留 class 与 data 属性", clean.includes('class="node"') && clean.includes('data-id="a"'), true);
expect("保留可见文字", clean.includes("正常文字"), true);
expect("干净 SVG 原样返回", sanitizeSvgForExport(`<svg viewBox="0 0 1 1"><text>甲</text></svg>`), `<svg viewBox="0 0 1 1"><text>甲</text></svg>`);
expect("脱敏后仍是合法尺寸可解析", svgSize(clean), { width: 10, height: 10 });

// 6) data URL 与常量
const url = svgToDataUrl(`<svg><text>甲乙</text></svg>`);
expect("data URL 前缀正确", url.startsWith("data:image/svg+xml;charset=utf-8,"), true);
expect("中文被百分号编码", url.includes("甲"), false);
expect("不含裸尖括号", url.includes("<"), false);
expect("不含井号（会被当成 fragment 截断）", url.includes("#"), false);
expect("PNG 放大 2 倍", PNG_SCALE, 2);
expect("背景色是六位十六进制", /^#[0-9a-f]{6}$/.test(DIAGRAM_BACKGROUND), true);

// 7) 调用方与真实材料走查
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const md = fs.readFileSync(path.join(root, "apps", "web", "src", "components", "MarkdownView.tsx"), "utf8");
ok("视图引入导出纯逻辑", md.includes('from "../diagram-export.ts"'));
ok("视图引入栅格化模块", md.includes('from "../diagram-download.ts"'));
ok("不再有写死的 diagram.svg", !md.includes('"diagram.svg"'));
ok("PNG 与 SVG 两个入口都在", md.includes("下载 PNG") && md.includes("下载 SVG"));
ok("PNG 失败会就地提示而不是静默", md.includes("PNG 导出失败"));
const dl = fs.readFileSync(path.join(root, "apps", "web", "src", "diagram-download.ts"), "utf8");
ok("栅格化走共享下载助手", dl.includes('from "./download.ts"') && dl.includes("downloadBlob("));
ok("栅格化失败抛错给调用方", dl.includes("throw new Error"));

const docsDir = path.join(root, "docs", "competition");
const fences: string[] = [];
for (const f of fs.readdirSync(docsDir).filter((n) => n.endsWith(".md"))) {
  const text = fs.readFileSync(path.join(docsDir, f), "utf8");
  for (const m of text.matchAll(/```mermaid[ \t]*\r?\n([\s\S]*?)```/g)) fences.push(m[1]!.trim());
}
ok("比赛材料里确实有 mermaid 图可走查", fences.length > 0, `找到 ${fences.length} 个`);
expect("真实图全部能认出类型（不该落到「图表」）", fences.filter((c) => diagramKind(c) === "图表").length, 0);
expect("真实图导出指令后类型不变", fences.every((c) => diagramKind(withExportInit(c)) === diagramKind(c)), true);
expect("真实图文件名两两不同（按序号）", new Set(fences.map((c, i) => diagramFilename(c, i, "png"))).size, fences.length);
expect("真实图文件名都不含路径分隔符", fences.every((c, i) => !/[\\/]/.test(diagramFilename(c, i, "png"))), true);

console.log(`[verify] 图表导出检查项=${checks} 失败=${failures.length}（真实 mermaid 块 ${fences.length} 个）`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 图表导出口径不符");
  process.exit(1);
}
console.log("[PASS] 图表导出正确（类型识别 / 文件名不覆盖 / 导出指令 / SVG 尺寸 / 交付件脱敏 / 真实材料走查）");
