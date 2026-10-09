import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentId, BusinessFile, TaxTask, TaskStatus } from "@tax/shared-schemas";
import { isInterruptedOnRestart } from "../../../web/src/task-status.ts";
import { db, nowIso } from "../db.ts";
import { pendingReviewCount } from "./issues.ts";
import { summarizeTaskCompares, type CompareCall } from "./compare-stats.ts";
import { compareRates } from "@tax/document-tools";
import { extractTextCitations, UNCAPPED } from "../../../web/src/search-evidence.ts";

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

const getTaskStmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);

export function getTask(id: string): (TaxTask & { instruction: string; result: string | null; error: string | null }) | undefined {
  const row = getTaskStmt.get(id) as Record<string, unknown> | undefined;
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

const listTasksStmt = db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`);
const listTasksByAgentStmt = db.prepare(`SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC`);

// 单任务最近一次同行评审比对的比率：与 stats.ts 同一份 summarizeTaskCompares + compareRates 口径，
// 列表页与平台聚合不可能各说一套；无 compare_workpapers 调用时返回 undefined（前端显示「—」）
const compareCallsStmt = db.prepare(
  `SELECT task_id, tool_name, ok, args, result, started_at FROM tool_calls
   WHERE tool_name = 'compare_workpapers' ORDER BY task_id, started_at DESC`,
);
/** 全任务比对比率一次查询：按任务分组（组内已按时间倒序），口径与 stats.ts 同一份 summarizeTaskCompares */
function compareRatesByTask(): Map<string, { match: number | null; coverage: number | null }> {
  const rows = compareCallsStmt.all() as Array<CompareCall & { task_id: string }>;
  const byTask = new Map<string, CompareCall[]>();
  for (const r of rows) {
    const { task_id, ...call } = r;
    const list = byTask.get(task_id);
    if (list) list.push(call);
    else byTask.set(task_id, [call]);
  }
  const out = new Map<string, { match: number | null; coverage: number | null }>();
  for (const [taskId, calls] of byTask) {
    const summary = summarizeTaskCompares(calls);
    if (!summary.peer) continue;
    const rates = compareRates(summary.peer.matched, summary.peer.mismatched, summary.peer.onlyA);
    out.set(taskId, { match: rates.matchRatePercent, coverage: rates.coveragePercent });
  }
  return out;
}

/** 引用数缓存：签名 updatedAt，任务变更即失效（结论正文上万字，避免列表每次请求重解析） */
const citeCache = new Map<string, { at: string; n: number }>();

export function listTasks(agentId?: AgentId): TaxTask[] {
  // 引用数（结论正文口径）：与平台总引用同一份 extractTextCitations；平台总引用另含工具留存，界面注解说明
  const citeCount = (taskId: string, updatedAt: string, result: string | null) => {
    const hit = citeCache.get(taskId);
    if (hit && hit.at === updatedAt) return hit.n;
    const n = result ? extractTextCitations(result, UNCAPPED).length : 0;
    citeCache.set(taskId, { at: updatedAt, n });
    return n;
  };
  const rows = (
    agentId ? listTasksByAgentStmt.all(agentId) : listTasksStmt.all()
  ) as Array<Record<string, unknown>>;
    const runCounts = runCountsByTask();
    const toolCounts = toolCountsByTask();
    const compareMap = compareRatesByTask();
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
    runCount: runCounts.get(String(row.id)) ?? 0,
    toolCount: toolCounts.get(String(row.id)) ?? 0,
      reviewPending: pendingReviewCount(String(row.id)),
      compareMatchRate: compareMap.get(String(row.id))?.match,
      compareCoverage: compareMap.get(String(row.id))?.coverage,
      citationCount: citeCount(String(row.id), String(row.updated_at), (row.result as string | null) ?? null),
    // 列表不带 error 全文，所以在这里判好：前端只需要知道「这个 failed 能不能续跑」
    interrupted: isInterruptedOnRestart({
      status: String(row.status),
      error: (row.error as string | null) ?? null,
    }),
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

/** 只允许流式缓冲更新自己创建的 delta 行，避免把其他事件当成可变正文。 */
export function updateEventMessage(taskId: string, seq: number, message: string): number {
  return Number(db
    .prepare(`UPDATE events SET message = ? WHERE task_id = ? AND seq = ? AND kind = 'agent_text_delta'`)
    .run(message, taskId, seq).changes);
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

const listFilesStmt = db.prepare(`SELECT * FROM files WHERE task_id = ? ORDER BY rowid ASC`);

export function listFiles(taskId: string): BusinessFile[] {
  const rows = listFilesStmt.all(taskId) as Array<Record<string, unknown>>;
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

const listToolCallsStmt = db.prepare(
  `SELECT * FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`,
);

export function listToolCalls(taskId: string) {
  return listToolCallsStmt.all(taskId) as Array<Record<string, unknown>>;
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

const runCountsStmt = db.prepare(
  `SELECT task_id, COUNT(*) AS n FROM events WHERE kind = 'run_started' GROUP BY task_id`,
);
const toolCountsStmt = db.prepare(`SELECT task_id, COUNT(*) AS n FROM tool_calls GROUP BY task_id`);

function runCountsByTask(): Map<string, number> {
  const rows = runCountsStmt.all() as Array<{ task_id: string; n: number }>;
  return new Map(rows.map((r) => [r.task_id, r.n]));
}

function toolCountsByTask(): Map<string, number> {
  const rows = toolCountsStmt.all() as Array<{ task_id: string; n: number }>;
  return new Map(rows.map((r) => [r.task_id, r.n]));
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
