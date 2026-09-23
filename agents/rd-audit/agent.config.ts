import fs from "node:fs";
import type { TaxAgentConfig } from "@tax/agent-core";
import { rdTools } from "./tools/rd-tools.ts";

const systemPrompt = fs.readFileSync(new URL("./system-prompt.md", import.meta.url), "utf8");

export const rdAuditAgent: TaxAgentConfig = {
  id: "rd-audit",
  displayName: "智研税审——研发费用加计扣除专项审查",
  shortName: "智研税审",
  description:
    "面向研发费用加计扣除专项审查：解析研发项目资料与费用辅助账，关联财务明细，匹配适用政策，识别归集差异与资料缺失，辅助生成专项审查底稿。",
  capabilities: [
    "研发项目资料理解与信息提取",
    "研发费用六大类归集核查",
    "辅助账与财务明细账关联比对",
    "其他相关费用限额确定性测算",
    "异常事项与待复核清单输出",
  ],
  accent: "#0f766e",
  systemPrompt,
  tools: rdTools,
  samplePrompts: [
    "某制造业企业 2025 年度研发项目「高精度数控主轴研发」，辅助账归集如下：人员人工 860000 元、直接投入 420000 元、折旧 150000 元、无形资产摊销 60000 元、新产品设计费 90000 元、其他相关费用 180000 元。请按 100% 比例测算可加计扣除金额，并说明其他相关费用是否存在超限。",
    "请核查项目「智能检测算法研发」的费用归集：辅助账为人员人工 500000 元、直接投入 200000 元、其他相关费用 30000 元；财务明细账为人员人工 500000 元、直接投入 260000 元、其他相关费用 30000 元。留存备查资料中立项决议已取得、研发人员名单未取得。请列出全部差异与缺失事项。",
  ],
};

export default rdAuditAgent;
