export type AgentId = "rd-audit" | "land-vat";

export interface AgentToolInfo {
  name: string;
  label: string;
  description: string;
}

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  shortName: string;
  description: string;
  capabilities: string[];
  accent: string;
  tools: AgentToolInfo[];
  samplePrompts: string[];
}

export type TaskStatus = "created" | "processing" | "waiting_review" | "completed" | "failed";

export interface TaskInfo {
  id: string;
  agentId: AgentId;
  caseId: string;
  title: string;
  status: TaskStatus;
  instruction: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileInfo {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  byteSize: number;
  businessCategory?: string;
  parseStatus: string;
}

export type EventKind =
  | "task_created"
  | "run_started"
  | "agent_text_delta"
  | "agent_text"
  | "tool_start"
  | "tool_end"
  | "agent_status"
  | "run_completed"
  | "run_failed";

export interface AgentEvent {
  seq: number;
  taskId: string;
  kind: EventKind;
  message: string;
  payload?: unknown;
  at: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface ReaderResult {
  url: string;
  title: string;
  excerpt: string;
  markdown: string;
  retrievedAt: string;
  contentType?: string;
}

export interface ArtifactInfo {
  name: string;
  byteSize: number;
  updatedAt: string;
}

export interface SheetPreview {
  name: string;
  headers: string[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
}
