import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { apiHost, apiPort, maxUploadBytes } from "./config.ts";
import { agentsRoutes } from "./routes/agents.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { readerRoutes } from "./routes/reader.ts";

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

try {
  await app.listen({ port: apiPort, host: apiHost });
  app.log.info(`API 已启动: http://${apiHost}:${apiPort}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
