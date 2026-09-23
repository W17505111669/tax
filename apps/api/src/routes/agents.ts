import type { FastifyInstance } from "fastify";
import { listAgents } from "../agents.ts";

export async function agentsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agents", async () => ({ agents: listAgents() }));
}
