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
