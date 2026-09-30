import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { apiHost, apiPort, maxUploadBytes } from "./config.ts";
import { db } from "./db.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { readerRoutes } from "./routes/reader.ts";
// 中断标记串与前端共用一个定义：前端靠它把「服务重启打断」与「执行真的失败」分开说
import { INTERRUPTED_ON_RESTART } from "../../web/src/task-status.ts";

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 20 } });

app.get("/api/health", async () => ({
  ok: true,
  service: "tax-agent-competition api",
  node: process.version,
  time: new Date().toISOString(),
}));

await app.register(agentsRoutes);
await app.register(taskRoutes);
await app.register(readerRoutes);

app.setErrorHandler((error: FastifyError, _req, reply) => {
  app.log.error(error);
  reply.code(error.statusCode && error.statusCode >= 400 ? error.statusCode : 500).send({
    error: error.message,
  });
});

// 服务重启后不可能还有正在运行的 Agent，把残留的 processing 任务标记为中断，避免前端永远转圈
const stale = db
  .prepare(`UPDATE tasks SET status = 'failed', error = COALESCE(error, ?), updated_at = ? WHERE status = 'processing'`)
  .run(INTERRUPTED_ON_RESTART, new Date().toISOString());
if (Number(stale.changes) > 0) {
  // 这类任务不是执行失败，续跑即可；日志要说清，免得排查时当成 Agent 出错去查提示词
  app.log.warn(`已将 ${stale.changes} 个残留 processing 任务标记为中断（${INTERRUPTED_ON_RESTART}，可续跑）`);
}

try {
  await app.listen({ port: apiPort, host: apiHost });
  app.log.info(`API 已启动: http://${apiHost}:${apiPort}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
