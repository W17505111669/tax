import type { TaxAgentConfig } from "@tax/agent-core";
import { readPromptFile } from "@tax/agent-core";
import { sharedWebTools } from "@tax/business-tools";
import { landVatTools } from "./tools/lv-tools.ts";

const systemPromptFile = new URL("./system-prompt.md", import.meta.url);

export const landVatAgent: TaxAgentConfig = {
  id: "land-vat",
  displayName: "土增智填——合同发票账簿智能核验填表",
  shortName: "土增智填",
  description:
    "面向土地增值税清算专项底稿填列：解析工程合同与发票，关联账面记录，核验金额一致性，识别异常并请求人工确认，按事务所原始模板自动填列指定工作底稿。",
  capabilities: [
    "工程合同关键条款与字段提取",
    "发票识别、去重与合同归属关联",
    "发票与账面记录一对多匹配",
    "金额差异核验与待核查清单",
    "原始 Excel 底稿模板保留式填列",
  ],
  accent: "#b0713f",
  // 惰性读取，不在模块顶层 readFileSync：改完 system-prompt.md 下一个任务就生效，不必重启 API。
  // agent-factory 里是 `systemPromptOverride: () => agent.systemPrompt`，每次建会话都会重新取值。
  get systemPrompt() {
    return readPromptFile(systemPromptFile);
  },
  tools: landVatTools,
  sharedTools: sharedWebTools,
  taskToolKits: ["documents", "template", "extract"],
  samplePrompts: [
    "某房地产开发项目「云璟花园」一期建安工程，合同 3 份：HT-001 总承包合同 12,000,000 元；HT-002 桩基工程合同 3,500,000 元；HT-003 幕墙工程合同 6,800,000 元。取得发票 5 张：FP-001 关联 HT-001 金额 5,000,000 元；FP-002 关联 HT-001 金额 6,900,000 元；FP-003 关联 HT-002 金额 3,500,000 元；FP-004 关联 HT-003 金额 4,800,000 元；FP-005 未注明合同编号金额 200,000 元。请完成合同发票关联，列出全部差异与待核查事项。",
    "有发票 3 张：FP-101 金额 1,000,000 元；FP-102 金额 500,000 元；FP-103 金额 250,000 元。账面记录 4 笔：PZ-01 注明发票号 FP-101 金额 600,000 元；PZ-02 注明发票号 FP-101 金额 400,000 元；PZ-03 未注明发票号金额 500,000 元；PZ-04 未注明发票号金额 180,000 元。请完成发票与账面记录匹配，并说明哪些需要人工确认。",
  ],
  recommendedCards: [
    {
      label: "合同发票关联",
      hint: "一对多汇总、差异与未匹配识别",
      prompt:
        "某房地产开发项目「云璟花园」一期建安工程，合同 3 份：HT-001 总承包合同 12,000,000 元；HT-002 桩基工程合同 3,500,000 元；HT-003 幕墙工程合同 6,800,000 元。取得发票 5 张：FP-001 关联 HT-001 金额 5,000,000 元；FP-002 关联 HT-001 金额 6,900,000 元；FP-003 关联 HT-002 金额 3,500,000 元；FP-004 关联 HT-003 金额 4,800,000 元；FP-005 未注明合同编号金额 200,000 元。请完成合同发票关联，列出全部差异与待核查事项。",
    },
    {
      label: "发票账簿匹配",
      hint: "精确匹配 + 金额候选待人工确认",
      prompt:
        "有发票 3 张：FP-101 金额 1,000,000 元；FP-102 金额 500,000 元；FP-103 金额 250,000 元。账面记录 4 笔：PZ-01 注明发票号 FP-101 金额 600,000 元；PZ-02 注明发票号 FP-101 金额 400,000 元；PZ-03 未注明发票号金额 500,000 元；PZ-04 未注明发票号金额 180,000 元。请完成发票与账面记录匹配，并说明哪些需要人工确认。",
    },
    {
      label: "模板填列 + 关系图",
      hint: "需先上传原始模板；映射填列并嵌入关系图",
      prompt:
        "本任务已上传事务所原始底稿模板。请先 inspect_workpaper_template 检查模板，完成合同发票关联后以映射模式调用 fill_land_vat_workpaper 填列数据区，并调用 render_matching_diagram 将工具返回的 mermaid 关系图原样嵌入结论。",
    },
  ],
};

export default landVatAgent;
