import { ToolRegistry } from "@tax/agent-core";
import type { TaxAgentConfig } from "@tax/agent-core";
import type { AgentId } from "@tax/shared-schemas";
import rdAuditAgent from "@tax/agent-rd-audit";
import landVatAgent from "@tax/agent-land-vat";

/**
 * Agent Factory 的注册入口：按 agentId 取到独立配置。
 * 两个 Agent 各自拥有独立系统提示词与独立工具集，通过 ToolRegistry 校验重名。
 */
function buildRegistry(agent: TaxAgentConfig): TaxAgentConfig {
  const registry = new ToolRegistry().registerAll(agent.tools);
  return { ...agent, tools: registry.list() };
}

export const agents: Record<AgentId, TaxAgentConfig> = {
  "rd-audit": buildRegistry(rdAuditAgent),
  "land-vat": buildRegistry(landVatAgent),
};

export function getAgent(agentId: AgentId): TaxAgentConfig {
  const agent = agents[agentId];
  if (!agent) throw new Error(`未知的智能体: ${agentId}`);
  return agent;
}

export function listAgents() {
  return Object.values(agents).map((a) => ({
    id: a.id,
    displayName: a.displayName,
    shortName: a.shortName,
    description: a.description,
    capabilities: a.capabilities,
    accent: a.accent,
    tools: a.tools.map((t) => ({ name: t.name, label: t.label, description: t.description })),
    samplePrompts: a.samplePrompts,
  }));
}
