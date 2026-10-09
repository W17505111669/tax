import type { FastifyInstance } from "fastify";
import { listAgents } from "../agents.ts";
import { platformStatsCached } from "../services/stats.ts";

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agents", async () => ({ agents: listAgents() }));

  /** 平台应用效果统计（真实运行数据），供首页看板与答辩投屏使用。 */
  app.get("/api/stats", async () => platformStatsCached());
}
