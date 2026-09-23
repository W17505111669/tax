/**
 * Phase 1 验证脚本：确认两个 Agent 真正独立。
 * 检查项：系统提示词不同、工具集不重叠、会话中实际启用的工具与配置一致。
 * 运行：pnpm verify:agents
 */
import { loadRuntimeConfig, createTaxAgentSession } from "@tax/agent-core";
import rdAuditAgent from "@tax/agent-rd-audit";
import landVatAgent from "@tax/agent-land-vat";

const cfg = loadRuntimeConfig();
const agents = [rdAuditAgent, landVatAgent];

// 业务工具必须互不重叠；sharedTools 属共用基础设施，允许同时出现在两个 Agent 中
const rdTools = new Set(rdAuditAgent.tools.map((t) => t.name));
const lvTools = new Set(landVatAgent.tools.map((t) => t.name));
const sharedNames = new Set((rdAuditAgent.sharedTools ?? []).map((t) => t.name));
const overlap = [...rdTools].filter((n) => lvTools.has(n));

console.log("[verify] 智研税审工具:", [...rdTools].join(", "));
console.log("[verify] 土增智填工具:", [...lvTools].join(", "));
console.log("[verify] 工具集重叠:", overlap.length === 0 ? "无（符合独立性要求）" : overlap.join(", "));
console.log("[verify] 系统提示词是否不同:", rdAuditAgent.systemPrompt !== landVatAgent.systemPrompt);

let pass = overlap.length === 0 && rdAuditAgent.systemPrompt !== landVatAgent.systemPrompt;

for (const agent of agents) {
  const expected = [...(agent.sharedTools ?? []), ...agent.tools].map((t) => t.name).sort();
  const session = await createTaxAgentSession({
    agent,
    cfg,
    cwd: process.cwd(),
    onEvent: () => {},
  });
  const active = session.tools;
  const actual = [...active].sort();
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  const noBuiltin = !actual.some((n) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(n));
  console.log(`[verify] ${agent.shortName} 会话工具: ${actual.join(", ") || "(无)"} | 与配置一致=${same} | 已禁用内置编码工具=${noBuiltin} | 共用工具=${[...sharedNames].join(",")}`);
  pass = pass && same && noBuiltin;
  session.dispose();
}

console.log(pass ? "\n[PASS] 两个 Agent 相互独立，且未启用 Pi 内置系统操作工具。" : "\n[FAIL] Agent 独立性验证未通过。");
process.exitCode = pass ? 0 : 1;
