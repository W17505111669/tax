import fs from "node:fs";
import type { TaxAgentConfig } from "@tax/agent-core";
import { landVatTools } from "./tools/lv-tools.ts";

const systemPrompt = fs.readFileSync(new URL("./system-prompt.md", import.meta.url), "utf8");

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
  accent: "#9a3412",
  systemPrompt,
  tools: landVatTools,
  samplePrompts: [
    "某房地产开发项目「云璟花园」一期建安工程，合同 3 份：HT-001 总承包合同 12,000,000 元；HT-002 桩基工程合同 3,500,000 元；HT-003 幕墙工程合同 6,800,000 元。取得发票 5 张：FP-001 关联 HT-001 金额 5,000,000 元；FP-002 关联 HT-001 金额 6,900,000 元；FP-003 关联 HT-002 金额 3,500,000 元；FP-004 关联 HT-003 金额 4,800,000 元；FP-005 未注明合同编号金额 200,000 元。请完成合同发票关联，列出全部差异与待核查事项。",
    "有发票 3 张：FP-101 金额 1,000,000 元；FP-102 金额 500,000 元；FP-103 金额 250,000 元。账面记录 4 笔：PZ-01 注明发票号 FP-101 金额 600,000 元；PZ-02 注明发票号 FP-101 金额 400,000 元；PZ-03 未注明发票号金额 500,000 元；PZ-04 未注明发票号金额 180,000 元。请完成发票与账面记录匹配，并说明哪些需要人工确认。",
  ],
};

export default landVatAgent;
