import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentId, BusinessFile, TaxTask, TaskStatus } from "@tax/shared-schemas";
import { db, nowIso } from "../db.ts";

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

export function insertFile(input: Omit<BusinessFile, "parseStatus"> & { parseStatus?: BusinessFile["parseStatus"] }): BusinessFile {
  const file: BusinessFile = { ...input, parseStatus: input.parseStatus ?? "pending" };
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
    nowIso(),
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
