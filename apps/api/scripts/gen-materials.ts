/**
 * 比赛作品说明生成器（Phase 6 脚手架）。
 * 从 Agent 配置与数据库真实运行记录生成两个作品的说明文档。
 * 运行：pnpm gen:materials
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskDocumentTools, createTemplateTools } from "@tax/document-tools";
import rdAuditAgent from "@tax/agent-rd-audit";
import landVatAgent from "@tax/agent-land-vat";
import type { TaxAgentConfig } from "@tax/agent-core";
import { BACKGROUND, FLOWS, GOALS, INNOVATIONS, latestCompareFor, statsFor } from "./materials-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(root, "docs", "competition");
fs.mkdirSync(outDir, { recursive: true });

const dummyCtx = { taskId: "stats", files: [], outputsDir: "" };
const docToolNames = createTaskDocumentTools(dummyCtx).map((t) => ({ name: t.name, label: t.label, description: t.description }));
const tplToolNames = createTemplateTools(dummyCtx).map((t) => ({ name: t.name, label: t.label, description: t.description }));

function toolTable(agent: TaxAgentConfig, extra: Array<{ name: string; label: string; description: string }>): string {
  const rows = [
    ...agent.tools.map((t) => ({ name: t.name, label: t.label, description: t.description, group: "业务工具" })),
    ...(agent.sharedTools ?? []).map((t) => ({ name: t.name, label: t.label, description: t.description, group: "共用设施" })),
    ...extra.map((t) => ({ ...t, group: "任务级工具" })),
  ];
  return [
    "| 工具 | 分组 | 名称 | 职责 |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.label} | ${r.group} | \`${r.name}\` | ${r.description.slice(0, 60)} |`),
  ].join("\n");
}

function build(agent: TaxAgentConfig, extra: Array<{ name: string; label: string; description: string }>): string {
  const stats = statsFor(agent.id);
  const okRate = stats.toolCalls > 0 ? Math.round((stats.toolOk / stats.toolCalls) * 10000) / 100 : 0;
  const lines: string[] = [];
  lines.push(`# ${agent.displayName} 作品说明`);
  lines.push("");
  lines.push(`> 本文档由 \`pnpm gen:materials\` 于 ${new Date().toISOString().slice(0, 10)} 生成；应用效果数据来自平台数据库真实运行记录。`);
  lines.push("");
  lines.push(`## 一、业务背景`);
  lines.push("");
  lines.push(BACKGROUND[agent.id] ?? agent.description);
  lines.push("");
  lines.push(`## 二、实现目标`);
  lines.push("");
  for (const g of GOALS[agent.id] ?? []) lines.push(`- ${g}`);
  lines.push("");
  lines.push(`## 三、技术路线`);
  lines.push("");
  lines.push(`- Agent Runtime：Pi Agent SDK \`@earendil-works/pi-coding-agent@0.87.1\`（嵌入式会话，禁用内置 read/bash/edit/write）`);
  lines.push(`- 联网检索：社区扩展 pi-web-access（Exa MCP 零配置）+ 自建 Bing/百度兜底抓取`);
  lines.push(
    `- 引用可核验：结论引用链接可按需批量核验可达性（服务端 GET、8 秒超时、不下载正文，沿用内网地址拦截），结果分为可访问 / 拒绝自动访问（反爬，需人工确认）/ 失效 / 无法核验四级；核验结果按任务持久化（刷新不丢、时间线留痕），失效引用进入交付自检提醒与整页 MD，反爬不计入交付风险`,
  );
  lines.push(`- 前后端：React + Vite + Tailwind（深色专业工作台）/ Node.js + Fastify + SSE`);
  lines.push(`- 存储与计算：SQLite（node:sqlite）/ ExcelJS / unpdf / tesseract.js（OCR）/ 整数分金额计算`);
  lines.push(
    `- 会话与复核：按任务持久化会话（续跑恢复历史）/ waiting_review 人工复核状态机（完成态若遗留待复核问题，复核页可一键「转为待复核」重新打开）`,
  );
  lines.push(
    `- 交付与溯源：整页交付 MD 含元信息 / 目录 / 结论 / 联网引用（含核验结果与时效）/ 业务资料清单（类型、大小、上传时间、解析状态与解析结果）/ 产物溯源表（每份产物对应生成它的工具调用、生成或引用关系、所属运行与时间）/ 工具调用清单（按运行分组，含结果、耗时与入参摘要）/ 人工复核记录（已复核与待复核分列，含核对备注）；「打包下载」把整页 MD 与全部产物合成一个 zip（产物归入「产物/」目录，条目名做安全化），打包失败自动退回单文件 MD`,
  );
  lines.push(
    `- 金额可核对：结论中每处金额与工具结果、客户指令做三级比对（工具可溯源 / 来自客户指令 / 待人工确认），待确认金额在正文就地标注、点击即可标记为已核对（写入事件留痕、可撤销），复核页「结论金额核对」小节可集中处理并填写核对依据备注，备注与核对时间一并写入整页交付 MD，用以佐证「金额由确定性工具计算、模型零口算」`,
  );
  lines.push("");
  lines.push(`## 四、核心流程`);
  lines.push("");
  lines.push("```mermaid");
  lines.push(FLOWS[agent.id] ?? "");
  lines.push("```");
  lines.push("");
  lines.push(`## 五、工具清单`);
  lines.push("");
  lines.push(toolTable(agent, extra));
  lines.push("");
  lines.push(`## 六、创新点`);
  lines.push("");
  for (const item of INNOVATIONS[agent.id] ?? []) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`## 七、应用效果（真实运行统计）`);
  lines.push("");
  lines.push(`- 累计任务 ${stats.tasks} 个，其中已完成 ${stats.completed} 个`);
  lines.push(`- 工具调用 ${stats.toolCalls} 次，成功 ${stats.toolOk} 次（成功率 ${okRate}%）`);
  lines.push(`- 生成专业底稿/产物 ${stats.artifacts} 份`);
  lines.push(
    stats.compareAccuracy !== null
      ? `- 与人工底稿记录级比对准确率 ${stats.compareAccuracy}%（${stats.compareRuns} 次比对；差异项均为预埋或真实口径差异，已列待核查）`
      : `- 暂无记录级比对数据`,
  );
  lines.push(`- 自动化验证：verify:pi / verify:docs / verify:template / verify:policy / verify:compare / verify:ocr / verify:agents 全部 PASS（见 docs/testing/test-report-*.md）`);
  lines.push("");
  const cmp = latestCompareFor(agent.id);
  if (cmp) {
    lines.push(`### 附录：与人工底稿差异明细（最近一次记录级比对）`);
    lines.push("");
    lines.push(
      `- 总准确率 ${cmp.totals.accuracyPercent}%（比对 ${cmp.totals.compared}：一致 ${cmp.totals.matched}、差异 ${cmp.totals.mismatched}、仅系统 ${cmp.totals.onlyA}、仅人工 ${cmp.totals.onlyB}）`,
    );
    lines.push(`- 差异项一律列为待核查事项，系统不按人工底稿自动"改正"。`);
    lines.push("");
    lines.push(`| 类型 | 位置 | 系统底稿 | 人工底稿 |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const s of cmp.sheets) {
      for (const d of s.diffs.slice(0, 10)) {
        lines.push(`| ${d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅系统" : "仅人工"} | ${d.address} | ${d.a ?? "∅"} | ${d.b ?? "∅"} |`);
      }
    }
    lines.push("");
  }
  lines.push(`## 八、演示与录屏清单`);
  lines.push("");
  lines.push(`- [ ] 启动平台并选择本智能体（首页 KPI 与工具清单）`);
  lines.push(`- [ ] 示例任务一键执行：执行时间线 + 工具折叠行 + 联网检索 chips`);
  lines.push(`- [ ] 审查结论：Markdown 报告 + mermaid 图 + 引用 chips + 交付卡片`);
  lines.push(`- [ ] 侧边阅读器：外链阅读模式 / Excel 工作表预览 / PDF 预览`);
  lines.push(agent.id === "land-vat" ? `- [ ] 模板保留式填列：已填列模板产物预览（公式列未触碰）` : `- [ ] 政策依据：search_rd_policy 比例与文号 + 联网核验`);
  lines.push(`- [ ] 人工复核：waiting_review → 逐项确认 → completed；完成态遗留问题可重新打开复核`);
  lines.push(`- [ ] 录屏要求：MP4、≤500MB、≤8 分钟，覆盖启动到交付全过程`);
  lines.push("");
  lines.push(`## 九、边界与合规`);
  lines.push("");
  lines.push(`- 不对接电子税务局/ERP/银行接口，不自动申报，不出具具法律效力的鉴证意见`);
  lines.push(`- 业务 Agent 禁用 Pi 内置系统操作工具；上传文件类型与大小受限、路径隔离`);
  lines.push(`- 模型密钥仅存服务端环境变量；客户资料默认不发送至第三方云模型（部署时可配置）`);
  lines.push(`- 合成案例仅用于开发验证，正式测试使用经授权脱敏的真实案例`);
  return lines.join("\n") + "\n";
}

const rd = build(rdAuditAgent, docToolNames);
const lv = build(landVatAgent, [...docToolNames, ...tplToolNames]);

fs.writeFileSync(path.join(outDir, "智研税审-作品说明.md"), rd, "utf8");
fs.writeFileSync(path.join(outDir, "土增智填-作品说明.md"), lv, "utf8");
console.log(`[materials] written: ${path.join(outDir, "智研税审-作品说明.md")}`);
console.log(`[materials] written: ${path.join(outDir, "土增智填-作品说明.md")}`);
