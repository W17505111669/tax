import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentId, BusinessFile, TaxTask, TaskStatus } from "@tax/shared-schemas";
import { db, nowIso } from "../db.ts";
import { pendingReviewCount } from "./issues.ts";

export function createTask(input: {
  agentId: AgentId;
  caseId: string;
  title: string;
  instruction: string;
}): TaxTask {
  const at = nowIso();
  const task: TaxTask = {
    id: randomUUID(),
    agentId: input.agentId,
    caseId: input.caseId,
    title: input.title,
    status: "created",
    createdAt: at,
    updatedAt: at,
  };
  db.prepare(
    `INSERT INTO tasks (id, agent_id, case_id, title, status, instruction, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(task.id, task.agentId, task.caseId, task.title, task.status, input.instruction, at, at);
  return task;
}

export function getTask(id: string): (TaxTask & { instruction: string; result: string | null; error: string | null }) | undefined {
  const row = db
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    agentId: row.agent_id as AgentId,
    caseId: String(row.case_id),
    title: String(row.title),
    status: row.status as TaskStatus,
    instruction: String(row.instruction ?? ""),
    result: (row.result as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listTasks(agentId?: AgentId): TaxTask[] {
  const rows = (
    agentId
      ? db.prepare(`SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC`).all(agentId)
      : db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all()
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    agentId: row.agent_id as AgentId,
    caseId: String(row.case_id),
    title: String(row.title),
    status: row.status as TaskStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    instruction: String(row.instruction ?? ""),
    progress: computeProgress(String(row.id), row.status as string),
    runCount: runCountOf(String(row.id)),
    toolCount: toolCountOf(String(row.id)),
    reviewPending: pendingReviewCount(String(row.id)),
  }));
}

export function setTaskStatus(id: string, status: TaskStatus, extra?: { result?: string; error?: string }): void {
  db.prepare(`UPDATE tasks SET status = ?, updated_at = ?, result = COALESCE(?, result), error = COALESCE(?, error) WHERE id = ?`).run(
    status,
    nowIso(),
    extra?.result ?? null,
    extra?.error ?? null,
    id,
  );
}

export function appendEvent(taskId: string, kind: AgentEvent["kind"], message: string, payload?: unknown): AgentEvent {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events WHERE task_id = ?`).get(taskId) as { maxSeq: number };
  const event: AgentEvent = {
    seq: row.maxSeq + 1,
    taskId,
    kind,
    message,
    at: nowIso(),
    ...(payload === undefined ? {} : { payload }),
  };
  db.prepare(
    `INSERT INTO events (task_id, seq, kind, message, payload, at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, event.seq, kind, message, payload === undefined ? null : JSON.stringify(payload), event.at);
  return event;
}

export function listEvents(taskId: string): AgentEvent[] {
  const rows = db.prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC`).all(taskId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    seq: Number(row.seq),
    taskId: String(row.task_id),
    kind: row.kind as AgentEvent["kind"],
    message: String(row.message),
    at: String(row.at),
    payload: row.payload ? JSON.parse(String(row.payload)) : undefined,
  }));
}

/**
 * 按运行重组每次的完整结论。
 *
 * 事件表里 `agent_text` 存的是过程播报（「我先解析上传资料…」一类），真正的结论正文
 * 在 `agent_text_delta` 里分片存放；重组规则与前端 useTaskEvents 一致：
 * delta 累积，遇到 agent_text 收口。跨运行对比（修订前后证据影响、按次导出）都要用它，
 * 直接读 agent_text.message 会拿到过程播报而不是结论。
 *
 * 返回值是「每次运行一条结论」：一次运行里往往有多段 agent_text（过程播报 + 最终结论），
 * 只有该运行最后一段才是结论。不按运行分组就会把同一次运行里的过程播报当成「上一轮结论」，
 * 实测因此把「官方引用 3 → 0」判成了「证据质量持平」——比对基线是空快照，怎么比都是持平。
 */
export function listConclusions(taskId: string): string[] {
  const rows = db
    .prepare(`SELECT kind, message FROM events WHERE task_id = ? ORDER BY seq ASC`)
    .all(taskId) as unknown as Array<{ kind: string; message: string | null }>;
  const out: string[] = [];
  let segments: string[] = [];
  let buf = "";
  const closeSegment = (): void => {
    if (buf.trim() !== "") segments.push(buf);
    buf = "";
  };
  const flushRun = (): void => {
    closeSegment();
    const last = segments[segments.length - 1];
    if (last !== undefined) out.push(last);
    segments = [];
  };
  for (const r of rows) {
    if (r.kind === "run_started") flushRun();
    else if (r.kind === "agent_text_delta") buf += r.message ?? "";
    else if (r.kind === "agent_text") closeSegment();
  }
  flushRun();
  return out;
}

export function insertFile(
  input: Omit<BusinessFile, "parseStatus" | "createdAt"> & {
    parseStatus?: BusinessFile["parseStatus"];
    createdAt?: string;
  },
): BusinessFile {
  const at = input.createdAt ?? nowIso();
  const file: BusinessFile = { ...input, parseStatus: input.parseStatus ?? "pending", createdAt: at };
  db.prepare(
    `INSERT INTO files (id, task_id, file_name, file_type, storage_path, byte_size, business_category, parse_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    file.id,
    file.taskId,
    file.fileName,
    file.fileType,
    file.storagePath,
    file.byteSize,
    file.businessCategory ?? null,
    file.parseStatus,
    at,
  );
  return file;
}

export function listFiles(taskId: string): BusinessFile[] {
  const rows = db.prepare(`SELECT * FROM files WHERE task_id = ? ORDER BY rowid ASC`).all(taskId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    taskId: String(row.task_id),
    fileName: String(row.file_name),
    fileType: String(row.file_type),
    storagePath: String(row.storage_path),
    byteSize: Number(row.byte_size),
    businessCategory: (row.business_category as string | null) ?? undefined,
    parseStatus: row.parse_status as BusinessFile["parseStatus"],
    createdAt: String(row.created_at ?? ""),
  }));
}

export function recordToolCall(input: {
  taskId: string;
  toolName: string;
  args?: unknown;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tool_calls (id, task_id, tool_name, args, started_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.taskId, input.toolName, JSON.stringify(input.args ?? null), nowIso());
  return id;
}

export function finishToolCall(id: string, ok: boolean, result: unknown): void {
  db.prepare(`UPDATE tool_calls SET ok = ?, result = ?, ended_at = ? WHERE id = ?`).run(
    ok ? 1 : 0,
    JSON.stringify(result ?? null),
    nowIso(),
    id,
  );
}

export function listToolCalls(taskId: string) {
  return db.prepare(`SELECT * FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`).all(taskId) as Array<Record<string, unknown>>;
}

/** 解析工具成功后，把任务资料标记为已解析，前端资料栏同步显示。 */
export function markFilesParsed(taskId: string): void {
  db.prepare(`UPDATE files SET parse_status = 'parsed' WHERE task_id = ? AND parse_status = 'pending'`).run(taskId);
}

/** 单份资料的解析状态（「重新解析」入口用，不影响同任务的其他资料） */
export function setFileParseStatus(fileId: string, status: BusinessFile["parseStatus"]): void {
  db.prepare(`UPDATE files SET parse_status = ? WHERE id = ?`).run(status, fileId);
}

/** 取本任务某工具最近一次成功执行的结果 details。 */
export function latestToolResult(taskId: string, toolName: string): unknown | null {
  const row = db
    .prepare(
      `SELECT result FROM tool_calls WHERE task_id = ? AND tool_name = ? AND ok = 1 AND result IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId, toolName) as { result: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result);
  } catch {
    return null;
  }
}
const PROGRESS_SEARCH_TOOLS = new Set([
  "web_search",
  "search_public_cases",
  "fetch_content",
  "fetch_public_document",
  "get_search_content",
]);

function runCountOf(taskId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'run_started'`)
    .get(taskId) as { n: number };
  return row.n;
}

function toolCountOf(taskId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE task_id = ?`).get(taskId) as { n: number };
  return row.n;
}

/** 执行步骤进度 0-5：提问→工具核验→联网检索→结论生成→交付，由事件与工具调用推导。 */
function computeProgress(taskId: string, status: string): number {
  if (status === "completed") return 5;
  if (status !== "processing") return 0;
  const kinds = db.prepare(`SELECT DISTINCT kind AS kind FROM events WHERE task_id = ?`).all(taskId) as Array<{
    kind: string;
  }>;
  const set = new Set(kinds.map((k) => k.kind));
  const tools = db.prepare(`SELECT tool_name, ok FROM tool_calls WHERE task_id = ?`).all(taskId) as Array<{
    tool_name: string;
    ok: number | null;
  }>;
  let p = set.has("run_started") ? 1 : 0;
  if (tools.some((t) => !PROGRESS_SEARCH_TOOLS.has(t.tool_name) && t.ok !== null)) p = Math.max(p, 2);
  if (tools.some((t) => PROGRESS_SEARCH_TOOLS.has(t.tool_name) && t.ok !== null)) p = Math.max(p, 3);
  if (set.has("agent_text")) p = Math.max(p, 4);
  return p;
}
