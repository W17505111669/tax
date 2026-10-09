import { z } from "zod";

export * from "./money.ts";

export const AGENT_IDS = ["rd-audit", "land-vat"] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const TaskStatusSchema = z.enum([
  "created",
  "processing",
  "waiting_review",
  "completed",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export interface TaxTask {
  id: string;
  agentId: AgentId;
  caseId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** 列表接口附带指令全文，供前端全文搜索。 */
  instruction?: string;
  /** 执行步骤进度 0-5（由事件与工具调用推导，仅列表接口附带）。 */
  progress?: number;
  /** 运行次数（run_started 事件计数，仅列表接口附带）。 */
  runCount?: number;
  /** 工具调用次数（仅列表接口附带）。 */
  toolCount?: number;
  /** 待复核问题数（仅列表接口附带）；completed 且 >0 表示需要重新打开复核。 */
  reviewPending?: number;
  /**
   * 这个 failed 是服务重启打断的（续跑即可），不是 Agent 执行出错（仅列表接口附带）。
   * 列表接口不带 error 全文，因此由服务端判好再给一个布尔，前端不必猜错误串。
   */
  interrupted?: boolean;
  /** 本任务最近一次同行评审记录级比对一致率（百分数；仅列表接口附带，null=有比对但算不出，undefined=无比对记录） */
  compareMatchRate?: number | null;
  /** 本任务最近一次同行评审记录级比对覆盖率（口径同上） */
  compareCoverage?: number | null;
  /** 结论正文引用条数（仅列表接口附带；平台总引用另含工具留存部分） */
  citationCount?: number;
}

export interface BusinessFile {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  storagePath: string;
  byteSize: number;
  businessCategory?: string;
  parseStatus: "pending" | "parsed" | "failed";
  /** 上传时间（ISO），资料行显示与交付核对用 */
  createdAt: string;
}

export interface AuditIssue {
  id: string;
  taskId: string;
  issueType: string;
  description: string;
  evidenceIds: string[];
  requiresReview: boolean;
}

/** Agent 执行事件（SSE 推送给前端的统一结构）。 */
export const AgentEventSchema = z.object({
  seq: z.number().int(),
  taskId: z.string(),
  kind: z.enum([
    "task_created",
    "run_started",
    "agent_text_delta",
    "agent_text",
    "tool_start",
    "tool_end",
    "agent_status",
    "run_completed",
    "run_failed",
  ]),
  message: z.string(),
  payload: z.unknown().optional(),
  at: z.string(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const CreateTaskInputSchema = z.object({
  agentId: AgentIdSchema,
  caseId: z.string().min(1).default("DEMO-001"),
  title: z.string().min(1).optional(),
  instruction: z.string().min(1),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
