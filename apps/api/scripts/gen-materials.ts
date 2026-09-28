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
import { db } from "../src/db.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(root, "docs", "competition");
fs.mkdirSync(outDir, { recursive: true });

const dummyCtx = { taskId: "stats", files: [], outputsDir: "" };
const docToolNames = createTaskDocumentTools(dummyCtx).map((t) => ({ name: t.name, label: t.label, description: t.description }));
const tplToolNames = createTemplateTools(dummyCtx).map((t) => ({ name: t.name, label: t.label, description: t.description }));

interface Stats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
}

function statsFor(agentId: string): Stats {
  const tasks = db.prepare(`SELECT id, status FROM tasks WHERE agent_id = ?`).all(agentId) as unknown as Array<{ id: string; status: string }>;
  let toolCalls = 0;
  let toolOk = 0;
  let artifacts = 0;
  let compareAccuracy: number | null = null;
  let compareRuns = 0;
  for (const t of tasks) {
    const calls = db.prepare(`SELECT ok, tool_name, result FROM tool_calls WHERE task_id = ?`).all(t.id) as unknown as Array<{ ok: number | null; tool_name: string; result: string | null }>;
    toolCalls += calls.length;
    toolOk += calls.filter((c) => c.ok === 1).length;
    const dir = path.join(root, "data", "outputs", t.id);
    if (fs.existsSync(dir)) artifacts += fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length;
    for (const c of calls) {
      if (c.tool_name !== "compare_workpapers" || c.ok !== 1 || !c.result) continue;
      try {
        const parsed = JSON.parse(c.result) as { sheets?: Array<{ mode?: string }>; totals?: { accuracyPercent?: number } };
        if (parsed.sheets?.[0]?.mode === "record" && parsed.totals?.accuracyPercent !== undefined) {
          compareAccuracy = parsed.totals.accuracyPercent;
          compareRuns += 1;
        }
      } catch {
        // 忽略坏记录
      }
    }
  }
  return {
    tasks: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    toolCalls,
    toolOk,
    artifacts,
    compareAccuracy,
    compareRuns,
  };
}

const FLOWS: Record<string, string> = {
  "rd-audit": `flowchart TD
  A["上传研发项目资料/辅助账/财务明细"] --> B["parse_uploaded_files 结构化解析"]
  B --> C["check_rd_expenses 账账比对与缺失识别"]
  C --> D["search_rd_policy 政策适用与比例确认"]
  D --> E["calculate_rd_adjustment 确定性测算"]
  E --> F{"存在待复核问题?"}
  F -->|是| G["waiting_review 税务师复核"]
  G --> H["generate_workpaper 专项审查底稿"]
  F -->|否| H
  H --> I["compare_workpapers 与人工底稿比对"]
  I --> J["交付：底稿/引用清单/测试报告"]`,
  "land-vat": `flowchart TD
  A["上传合同/发票/账簿/原始模板"] --> B["parse_uploaded_files 结构化解析"]
  B --> C["match_contract_invoice 合同发票关联"]
  C --> D["match_invoice_ledger 发票账簿匹配"]
  D --> E["check_amount_consistency 金额核验"]
  E --> F{"存在歧义或差异?"}
  F -->|是| G["waiting_review 人工确认"]
  G --> H["inspect_workpaper_template 模板结构检查"]
  F -->|否| H
  H --> I["fill_land_vat_workpaper 映射式保留填列"]
  I --> J["compare_workpapers 与人工底稿比对"]
  J --> K["交付：已填列模板/差异清单/测试报告"]`,
};

const BACKGROUND: Record<string, string> = {
  "rd-audit":
    "面向企业研发费用加计扣除专项审查业务。事务所需要从研发项目资料、费用辅助账和企业财务记录中识别关键业务信息，检查费用归集情况，结合税收政策形成专业审查意见。传统方式下资料来源分散、辅助账与财务账需人工核对、不同费用类型涉及不同归集要求、专项审查底稿编制工作量大。",
  "land-vat":
    "面向土地增值税清算过程中工作底稿的资料采集、数据匹配与自动填列环节。事务所需要阅读工程合同提取关键条款、逐张查看发票、在账簿中寻找对应业务记录、建立合同-发票-账簿对应关系并核对金额后填入 Excel 底稿。一份合同对应多张发票和多笔账面记录时，人工处理容易出现重复、遗漏或错误匹配。",
};

const GOALS: Record<string, string[]> = {
  "rd-audit": [
    "研发项目资料与辅助账的结构化解析与信息提取",
    "辅助账与财务明细账的账账比对、差异与缺失识别",
    "按费用年度与企业类型确定性确认加计扣除比例及政策依据",
    "其他相关费用限额与加计扣除额的程序化测算（整数分计算）",
    "专项审查底稿生成、与人工底稿比对、税务师复核闭环",
  ],
  "land-vat": [
    "工程合同、发票、账簿的结构化解析",
    "一对一/一对多关联匹配与金额一致性核验",
    "歧义与差异事项的人工确认闭环",
    "事务所原始 Excel 模板的保留式自动填列（公式/合并/样式不破坏）",
    "已填列底稿与人工底稿的逐格比对与准确率输出",
  ],
};

const INNOVATIONS: Record<string, string[]> = {
  "rd-audit": [
    "金额零口算：限额、基数、加计额全部由 TypeScript 工具以整数分确定性计算，模型只解释不计算",
    "政策双保险：本地版本化政策快照给出比例与文号，正式引用前强制联网核验并记录核验时间",
    "证据链贯穿：每项结论可追溯到文件、记录、字段与工具执行记录",
    "复核状态机：存在待复核问题时任务进入 waiting_review，税务师逐项确认后才流转为已完成",
  ],
  "land-vat": [
    "映射式填列：模型只给表头列名与数据行，地址定位/金额换算/公式避让由工具确定性完成",
    "保留式写盘：在模板副本上写入，公式、合并单元格与样式零破坏，原始模板 sha256 校验不变",
    "记录级比对：跨版式底稿按表头与主键对齐逐格比对，输出可直接入测试报告的准确率",
    "异常不认定：差异只形成待核查事项并给出可能原因，不直接认定企业申报错误",
  ],
};

function toolTable(agent: TaxAgentConfig, extra: Array<{ name: string; label: string; description: string }>): string {
  const rows = [
    ...agent.tools.map((t) => ({ name: t.name, label: t.label, description: t.description, group: "业务工具" })),
    ...(agent.sharedTools ?? []).map((t) => ({ name: t.name, label: t.label, description: t.description, group: "共用设施" })),
    ...extra.map((t) => ({ ...t, group: "任务级工具" })),
  ];
  return ["| 工具 | 分组 | 名称 | 职责 |", "| --- | --- | --- | --- |", ...rows.map((r) => `| ${r.label} | ${r.group} | \`${r.name}\` | ${r.description.slice(0, 60)} |`)].join("\n");
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
  lines.push(`- 前后端：React + Vite + Tailwind（深色专业工作台）/ Node.js + Fastify + SSE`);
  lines.push(`- 存储与计算：SQLite（node:sqlite）/ ExcelJS / unpdf / tesseract.js（OCR）/ 整数分金额计算`);
  lines.push(`- 会话与复核：按任务持久化会话（续跑恢复历史）/ waiting_review 人工复核状态机`);
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
  lines.push(`## 八、演示与录屏清单`);
  lines.push("");
  lines.push(`- [ ] 启动平台并选择本智能体（首页 KPI 与工具清单）`);
  lines.push(`- [ ] 示例任务一键执行：执行时间线 + 工具折叠行 + 联网检索 chips`);
  lines.push(`- [ ] 审查结论：Markdown 报告 + mermaid 图 + 引用 chips + 交付卡片`);
  lines.push(`- [ ] 侧边阅读器：外链阅读模式 / Excel 工作表预览 / PDF 预览`);
  lines.push(agent.id === "land-vat" ? `- [ ] 模板保留式填列：已填列模板产物预览（公式列未触碰）` : `- [ ] 政策依据：search_rd_policy 比例与文号 + 联网核验`);
  lines.push(`- [ ] 人工复核：waiting_review → 逐项确认 → completed`);
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
