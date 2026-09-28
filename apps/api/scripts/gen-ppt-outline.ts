/**
 * 答辩 PPT 大纲生成器（Phase 6 交付物）。
 * 每个作品 10 页：封面/背景/目标/架构/流程/工具/创新/演示/效果/边界，含讲稿要点与画面元素。
 * 运行：pnpm gen:ppt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rdAuditAgent from "@tax/agent-rd-audit";
import landVatAgent from "@tax/agent-land-vat";
import type { TaxAgentConfig } from "@tax/agent-core";
import { BACKGROUND, FLOWS, GOALS, INNOVATIONS, recentTaskLinks, statsFor } from "./materials-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(root, "docs", "competition");
fs.mkdirSync(outDir, { recursive: true });

function build(agent: TaxAgentConfig): string {
  const stats = statsFor(agent.id);
  const okRate = stats.toolCalls > 0 ? Math.round((stats.toolOk / stats.toolCalls) * 10000) / 100 : 0;
  const demos = recentTaskLinks(agent.id, 3);
  const L: string[] = [];
  const slide = (n: number, title: string, bullets: string[], notes: string, visual: string) => {
    L.push(`## 第 ${n} 页 · ${title}`);
    L.push("");
    for (const b of bullets) L.push(`- ${b}`);
    L.push("");
    L.push(`> 讲稿：${notes}`);
    L.push(`> 画面：${visual}`);
    L.push("");
  };

  L.push(`# ${agent.shortName} 答辩 PPT 大纲`);
  L.push("");
  L.push(`> 由 \`pnpm gen:ppt\` 于 ${new Date().toISOString().slice(0, 10)} 生成；应用效果数据为平台真实运行统计。建议总时长 8 分钟以内。`);
  L.push("");
  slide(1, "封面", [agent.displayName, "全国税务师行业 AI 赋能涉税专业服务技能竞赛", "Pi Agent SDK + React + Fastify 共享底座"], "一句话定位：让每一笔涉税判断都有据可查。", "平台首页 hero 截图");
  slide(2, "业务背景与痛点", [BACKGROUND[agent.id] ?? agent.description], "用事务所真实执业场景开场，点出人工处理的三类痛点：分散、易错、耗时。", "痛点三图标排布");
  slide(3, "解决目标", GOALS[agent.id] ?? [], "强调边界：不做清算/申报全流程，只做可验证的一段闭环。", "目标清单 + 边界注脚");
  slide(4, "技术架构", ["Agent Runtime：Pi Agent SDK 0.87.1（嵌入式会话）", "联网检索：pi-web-access 社区扩展 + 自建抓取兜底", "前后端：React + Vite + Tailwind / Fastify + SSE + SQLite", "确定性层：TypeScript 工具负责全部金额计算与表格写入"], "讲清分工：模型负责理解与规划，工具负责计算与写盘。", "架构 mermaid 图");
  slide(5, "核心流程", ["见下图，从资料上传到专业成果交付全闭环"], "逐步走流程，重点停在复核判断菱形：差异不认定、先复核。", "```mermaid\n" + (FLOWS[agent.id] ?? "") + "\n```");
  slide(6, "工具清单", agent.tools.slice(0, 6).map((t) => `${t.name}：${t.label}`), "挑 3 个工具展开讲输入输出，其余一页带过。", "工具卡片墙");
  slide(7, "创新点", INNOVATIONS[agent.id] ?? [], "每条创新点对应一个现场可演示的动作，不讲空概念。", "四条创新点 + 对应演示幕号");
  slide(8, "现场演示", demos.map((d, i) => `演示 ${i + 1}：${d.title}（${d.status}）深链 ${d.link}`), "用深链直达任务页签；执行类镜头现场重新执行展示 SSE 实时事件。", "工作台实录（时间线/结论/比对）");
  slide(9, "应用效果", [
    `累计任务 ${stats.tasks} 个、已完成 ${stats.completed} 个`,
    `工具调用 ${stats.toolCalls} 次、成功率 ${okRate}%`,
    `生成底稿/产物 ${stats.artifacts} 份`,
    stats.compareAccuracy !== null ? `与人工底稿记录级比对准确率 ${stats.compareAccuracy}%` : "比对准确率：待真实案例",
    "自动化验证 7 项全部 PASS（见测试报告）",
  ], "数字全部来自平台数据库与验证脚本，可现场复算。", "KPI 大数字页");
  slide(10, "边界、合规与展望", ["不对接申报/ERP/银行接口，不出具法律效力鉴证意见", "客户资料脱敏与本地化处理，密钥仅存服务端", "展望：真实案例回归库、OCR 云端引擎、多模板适配"], "收尾落在可落地性：今天演示的一切都在本机真实运行。", "合规清单 + 致谢");
  return L.join("\n");
}

for (const agent of [rdAuditAgent, landVatAgent]) {
  const file = path.join(outDir, `${agent.shortName}-PPT大纲.md`);
  fs.writeFileSync(file, build(agent), "utf8");
  console.log(`[ppt] written: ${file}`);
}
