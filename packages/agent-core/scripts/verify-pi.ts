/**
 * Phase 0 验证脚本（交付物 P0-4）。
 * 验证：SDK 安装 → 模型连接 → 自定义 TypeScript Tool 注册 → 工具执行事件。
 * 运行：pnpm verify:pi
 */
import { Type } from "typebox";
import { loadRuntimeConfig, getModelRuntime, createTaxAgentSession } from "../src/index.ts";
import type { TaxAgentConfig } from "../src/index.ts";

const cfg = loadRuntimeConfig();
console.log("[verify] 模型端点:", cfg.baseUrl, "模型:", cfg.modelId, "api:", cfg.api);

const { model } = await getModelRuntime(cfg);
console.log("[verify] 模型解析成功:", `${model.provider}/${model.id}`);

const probeTool = {
  name: "probe_echo",
  label: "验证工具",
  description: "把输入文本转成大写并返回。用户要求 echo 时必须调用本工具。",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id: string, params: { text: string }) => {
    const out = String(params.text).toUpperCase();
    console.log("[verify] 工具已执行 ->", out);
    return { content: [{ type: "text" as const, text: out }], details: { echoed: out } };
  },
};

const agent: TaxAgentConfig = {
  id: "rd-audit",
  displayName: "验证用 Agent",
  shortName: "verify",
  description: "Phase 0 连通性验证",
  capabilities: ["工具调用验证"],
  accent: "#0f766e",
  systemPrompt: "你是一个验证脚本使用的助手。必须通过工具完成任务，不得凭空编造工具结果。",
  tools: [probeTool],
  samplePrompts: [],
};

const events: string[] = [];
const session = await createTaxAgentSession({
  agent,
  cfg,
  cwd: process.cwd(),
  onEvent: (e) => {
    if (e.kind === "tool_start") events.push(`tool_start:${e.toolName}`);
    if (e.kind === "tool_end") events.push(`tool_end:${e.toolName}:${e.ok ? "ok" : "error"}`);
  },
});

console.log("[verify] 会话已创建，可用工具:", session.tools.join(", ") || "(无)");

try {
  const answer = await session.prompt("请调用 probe_echo 工具，参数 text 为 'tax agent'，然后用一句中文说明工具返回了什么。");
  console.log("[verify] Agent 回复:", answer);
  console.log("[verify] 工具事件:", events.join(" | ") || "(未捕获)");
  const ok = events.some((e) => e.startsWith("tool_end:probe_echo:ok"));
  console.log(ok ? "\n[PASS] Pi SDK 已可调用自定义工具并回传执行事件。" : "\n[FAIL] 未捕获到成功的工具执行事件。");
  process.exitCode = ok ? 0 : 1;
} finally {
  session.dispose();
}
