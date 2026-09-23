import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateTaskInputSchema } from "@tax/shared-schemas";
import { allowedExtensions, dirs, maxUploadBytes } from "../config.ts";
import { getAgent } from "../agents.ts";
import { eventBus, runTask } from "../services/agent-runner.ts";
import {
  appendEvent,
  createTask,
  getTask,
  insertFile,
  listEvents,
  listFiles,
  listTasks,
  listToolCalls,
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
}
