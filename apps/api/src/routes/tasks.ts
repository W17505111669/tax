import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateTaskInputSchema } from "@tax/shared-schemas";
import { allowedExtensions, dirs, maxUploadBytes } from "../config.ts";
import { getAgent } from "../agents.ts";
import { eventBus, isRunning, runTask } from "../services/agent-runner.ts";
import {
  extractIssues,
  listReviews,
  needsReopenReview,
  pendingReviewIssues,
  pendingReviewCount,
  saveReview,
  selectReopenTargets,
} from "../services/issues.ts";
import {
  appendEvent,
  createTask,
  getTask,
  insertFile,
  listEvents,
  listFiles,
  listTasks,
  listToolCalls,
  setTaskStatus,
} from "../services/task-store.ts";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks", async (req) => {
    const agentId = (req.query as { agentId?: string }).agentId;
    return { tasks: listTasks(agentId as never) };
  });

  app.post("/api/tasks", async (req, reply) => {
    const parsed = CreateTaskInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    const input = parsed.data;
    const agent = getAgent(input.agentId);
    const task = createTask({
      agentId: input.agentId,
      caseId: input.caseId,
      title: input.title?.trim() || `${agent.shortName}任务 ${new Date().toLocaleString("zh-CN")}`,
      instruction: input.instruction,
    });
    fs.mkdirSync(path.join(dirs.uploads, task.id), { recursive: true });
    appendEvent(task.id, "task_created", `任务已创建，智能体：${agent.displayName}`);
    return reply.code(201).send({ task });
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return { task, files: listFiles(id), toolCalls: listToolCalls(id) };
  });

  app.post("/api/tasks/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { instruction?: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const instruction = body.instruction?.trim() || task.instruction;
    void runTask(id, instruction);
    return reply.code(202).send({ taskId: id, status: "processing" });
  });

  /** 补充资料/补充意见后续跑同一任务（恢复会话历史）。 */
  app.post("/api/tasks/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { instruction?: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (isRunning(id)) return reply.code(409).send({ error: "任务正在执行中" });
    const instruction = body.instruction?.trim();
    if (!instruction) return reply.code(400).send({ error: "续跑需要补充说明 instruction" });
    void runTask(id, instruction, { resume: true });
    return reply.code(202).send({ taskId: id, status: "processing", resume: true });
  });

  /** 下载本任务最新的专业工作底稿（交接文档 6.3 的 export 接口）。 */
  app.get("/api/tasks/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dir = path.join(dirs.outputs, id);
    if (!fs.existsSync(dir)) return reply.code(404).send({ error: "本任务暂无可导出的底稿" });
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => /\.(xlsx|xls)$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    const latest = candidates[0];
    if (!latest) return reply.code(404).send({ error: "本任务暂无 Excel 底稿" });
    const file = path.join(dir, latest.f);
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(latest.f)}"`);
    return reply.send(fs.createReadStream(file));
  });

  app.post("/api/tasks/:id/files", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });

    const parts = req.parts();
    const saved: unknown[] = [];
    for await (const part of parts) {
      if (part.type !== "file") continue;
      const ext = path.extname(part.filename).toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        await part.toBuffer();
        return reply.code(400).send({ error: `不支持的文件类型: ${ext || part.filename}` });
      }
      const buffer = await part.toBuffer();
      if (buffer.byteLength > maxUploadBytes) {
        return reply.code(413).send({ error: `文件超过大小限制 ${Math.round(maxUploadBytes / 1024 / 1024)}MB` });
      }
      const taskDir = path.join(dirs.uploads, id);
      fs.mkdirSync(taskDir, { recursive: true });
      const storagePath = path.join(taskDir, `${randomUUID()}${ext}`);
      fs.writeFileSync(storagePath, buffer);
      const category = (part.fields.businessCategory as { value?: string } | undefined)?.value;
      saved.push(
        insertFile({
          id: randomUUID(),
          taskId: id,
          fileName: part.filename,
          fileType: ext.replace(".", "") || "unknown",
          storagePath,
          byteSize: buffer.byteLength,
          ...(category ? { businessCategory: category } : {}),
        }),
      );
      appendEvent(id, "agent_status", `资料已上传：${part.filename}`);
    }
    return reply.code(201).send({ files: saved });
  });

  app.get("/api/tasks/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    return { files: listFiles(id) };
  });

  app.get("/api/tasks/:id/events", (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });

    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    stream.write(": connected\n\n");

    const send = (data: unknown) => {
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    for (const event of listEvents(id)) send(event);

    const unsubscribe = eventBus.subscribe(id, send);
    const heartbeat = setInterval(() => stream.write(": ping\n\n"), 15000);

    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/tasks/:id/results", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const toolCalls = listToolCalls(id).map((row) => ({
      id: String(row.id),
      toolName: String(row.tool_name),
      args: row.args ? JSON.parse(String(row.args)) : null,
      result: row.result ? JSON.parse(String(row.result)) : null,
      ok: row.ok === 1,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : null,
    }));
    return {
      task,
      toolCalls,
      events: listEvents(id).filter((e) => e.kind !== "agent_text_delta"),
      files: listFiles(id),
    };
  });

  /** 待复核问题清单（从工具结果与比对差异中提取）与人工复核记录。 */
  app.get("/api/tasks/:id/issues", async (req) => {
    const { id } = req.params as { id: string };
    return { issues: extractIssues(id), reviews: listReviews(id), pending: pendingReviewIssues(id).length };
  });

  /** 提交人工复核意见；全部复核完成后任务从 waiting_review 流转为 completed。 */
  app.post("/api/tasks/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { issueId?: string; decision?: string; comment?: string };
    if (!body.issueId || (body.decision !== "confirm" && body.decision !== "dismiss")) {
      return reply.code(400).send({ error: "需要 issueId 与 decision(confirm|dismiss)" });
    }
    const record = saveReview(id, body.issueId, body.decision, body.comment ?? "");
    const task = getTask(id);
    const pending = pendingReviewIssues(id).length;
    if (task && task.status === "waiting_review" && pending === 0) {
      setTaskStatus(id, "completed");
      appendEvent(id, "agent_status", "人工复核完成，任务流转为已完成");
    } else {
      appendEvent(id, "agent_status", `人工复核已提交：${body.decision === "confirm" ? "确认列入底稿" : "判定无需处理"}（剩余待复核 ${pending} 项）`);
    }
    return { review: record, pending };
  });

  /** 已完成但仍挂着待复核问题时，把任务重新流转为 waiting_review（税务师发现遗漏时的补救入口）。 */
  app.post("/api/tasks/:id/reopen-review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const pending = pendingReviewIssues(id).length;
    if (!needsReopenReview(task.status, pending)) {
      return reply.code(409).send({
        error: pending === 0 ? "没有待复核问题，无需重新打开复核" : `当前状态（${task.status}）无需重新打开复核`,
      });
    }
    setTaskStatus(id, "waiting_review");
    appendEvent(id, "agent_status", `复核重新打开：${pending} 项问题待税务师复核`);
    return { status: "waiting_review", pending };
  });

  /**
   * 批量重开复核：把「已完成但仍有待复核问题」的任务改回 waiting_review。
   * body.ids 缺省时处理全部符合条件的任务；不符合条件的任务在 skipped 中说明原因。
   */
  app.post("/api/tasks/reopen-review-batch", async (req) => {
    const body = (req.body ?? {}) as { ids?: string[] };
    const wanted = Array.isArray(body.ids) && body.ids.length > 0 ? new Set(body.ids) : null;
    const scoped = listTasks()
      .filter((t) => !wanted || wanted.has(t.id))
      .map((t) => ({ id: t.id, title: t.title, status: t.status as string, pending: pendingReviewCount(t.id) }));
    const targets = new Set(selectReopenTargets(scoped));
    const reopened: Array<{ id: string; title: string; pending: number }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const t of scoped) {
      if (targets.has(t.id)) {
        setTaskStatus(t.id, "waiting_review");
        appendEvent(t.id, "agent_status", `复核重新打开：${t.pending} 项问题待税务师复核（批量处理）`);
        reopened.push({ id: t.id, title: t.title, pending: t.pending });
        continue;
      }
      if (wanted) {
        skipped.push({ id: t.id, reason: t.pending === 0 ? "没有待复核问题" : `当前状态 ${t.status} 无需重开` });
      }
    }
    return { total: reopened.length, reopened, skipped };
  });

  /** 底稿比对记录：从工具调用历史中提取 compare_workpapers 的结构化结果，供前端比对视图使用。 */
  app.get("/api/tasks/:id/compares", async (req) => {
    const { id } = req.params as { id: string };
    const rows = listToolCalls(id).filter(
      (r) => String(r.tool_name) === "compare_workpapers" && r.ok === 1 && r.result,
    );
    const compares = rows.map((r) => ({
      id: String(r.id),
      at: r.ended_at ? String(r.ended_at) : null,
      result: JSON.parse(String(r.result)) as unknown,
    }));
    return { compares };
  });
}
