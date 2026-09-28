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
  recommendedCards?: Array<{ label: string; hint: string; prompt: string }>;
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
  /** 执行步骤进度 0-5（列表接口附带） */
  progress?: number;
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

export interface CompareDiff {
  address: string;
  a: string | number | null;
  b: string | number | null;
  kind: "mismatch" | "only_a" | "only_b";
}

export interface CompareSheet {
  sheetA: string;
  sheetB: string;
  mode: "record" | "address";
  compared: number;
  matched: number;
  mismatched: number;
  onlyA: number;
  onlyB: number;
  skippedFormulas: number;
  accuracyPercent: number;
  diffs: CompareDiff[];
}

export interface CompareResult {
  sheets: CompareSheet[];
  unmatchedSheetsA: string[];
  unmatchedSheetsB: string[];
  a?: CompareRef;
  b?: CompareRef;
  totals: {
    compared: number;
    matched: number;
    mismatched: number;
    onlyA: number;
    onlyB: number;
    accuracyPercent: number;
  };
}

export interface CompareRecord {
  id: string;
  at: string | null;
  result: CompareResult;
}

export interface CompareRef {
  kind: "upload" | "artifact";
  name: string;
  highlight?: string;
}

export interface PlatformStats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  ocrRuns: number;
  ocrAvgConfidence: number | null;
  perAgent: Array<{
    agentId: string;
    tasks: number;
    completed: number;
    toolCalls: number;
    toolOk: number;
    artifacts: number;
  }>;
  perTool: Array<{ name: string; calls: number; ok: number }>;
}

export interface TaskIssue {
  id: string;
  source: string;
  issueType: string;
  description: string;
  evidence: string[];
  requiresReview: boolean;
}

export interface ReviewRecord {
  issueId: string;
  decision: "confirm" | "dismiss";
  comment: string;
  createdAt: string;
}
