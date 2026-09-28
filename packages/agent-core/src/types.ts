import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentId } from "@tax/shared-schemas";

/** 一个业务智能体的完整配置。两个作品各自提供一份。 */
export interface TaxAgentConfig {
  id: AgentId;
  displayName: string;
  shortName: string;
  description: string;
  /** 业务场景说明，用于前端首页展示。 */
  capabilities: string[];
  /** 前端主题色，用于区分两个作品。 */
  accent: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** 两个作品共用的基础设施工具（联网检索等），不计入业务工具独立性校验。 */
  sharedTools?: ToolDefinition[];
  /** 任务级工具包：documents=解析与底稿生成，template=模板检查与保留式填列，extract=合同/发票字段抽取。 */
  taskToolKits?: Array<"documents" | "template" | "extract">;
  /** 建议的示例任务，方便评委一键体验。 */
  samplePrompts: string[];
}
