import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentId } from "@tax/shared-schemas";
import type { RuntimeConfig } from "./config.ts";
import { getModelRuntime } from "./pi-runtime.ts";
import type { TaxAgentConfig } from "./types.ts";

export interface CreateAgentSessionInput {
  agent: TaxAgentConfig;
  cfg: RuntimeConfig;
  /** 任务工作目录，用于文件类工具的作用域隔离。 */
  cwd: string;
  /** 任务级工具（如文档解析、底稿生成），由调用方按任务上下文构造。 */
  taskTools?: ToolDefinition[];
  /** 归一化后的事件回调，由调用方转发到 SSE / 数据库。 */
  onEvent: (event: NormalizedAgentEvent) => void;
}

export type NormalizedAgentEvent =
  | { kind: "agent_text_delta"; text: string }
  | { kind: "agent_text"; text: string }
  | { kind: "tool_start"; toolName: string; args: unknown }
  | { kind: "tool_end"; toolName: string; ok: boolean; result: unknown }
  | { kind: "agent_status"; status: string };

export interface TaxAgentSession {
  agentId: AgentId;
  tools: string[];
  prompt(text: string): Promise<string>;
  dispose(): void;
}

/**
 * Agent Factory：按 agentId 创建相互独立的 Pi 会话。
 * 独立性来自：不同 systemPrompt + 不同 customTools + 独立 SessionManager。
 */
export async function createTaxAgentSession(input: CreateAgentSessionInput): Promise<TaxAgentSession> {
  const { agent, cfg, cwd, onEvent } = input;
  const { runtime, model } = await getModelRuntime(cfg);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cfg.agentDir,
    additionalExtensionPaths: cfg.extensionPaths,
    systemPromptOverride: () => agent.systemPrompt,
    // 禁止从用户全局目录追加提示词，保证参赛作品行为可复现。
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: cfg.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: cfg.thinkingLevel,
    // "builtin" = 关闭 Pi 的 read/bash/edit/write，只保留业务自定义工具。
    noTools: "builtin",
    customTools: [...(agent.sharedTools ?? []), ...agent.tools, ...(input.taskTools ?? [])],
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") onEvent({ kind: "agent_text_delta", text: inner.delta });
      return;
    }
    if (event.type === "message_end") {
      const msg = event.message as { role?: string; content?: Array<{ type: string; text?: string }> };
      if (msg.role === "assistant") {
        const text = (msg.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("");
        if (text.trim()) onEvent({ kind: "agent_text", text });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const e = event as unknown as { toolName?: string; args?: unknown };
      onEvent({ kind: "tool_start", toolName: e.toolName ?? "(unknown)", args: e.args });
      return;
    }
    if (event.type === "tool_execution_end") {
      const e = event as unknown as {
        toolName?: string;
        result?: {
          isError?: boolean;
          details?: unknown;
          content?: Array<{ type: string; text?: string }>;
        };
      };
      const errorText = e.result?.isError
        ? (e.result.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join(" ")
        : undefined;
      onEvent({
        kind: "tool_end",
        toolName: e.toolName ?? "(unknown)",
        ok: e.result?.isError !== true,
        result: e.result?.details ?? (errorText ? { error: errorText } : null),
      });
    }
  });

  return {
    agentId: agent.id,
    tools: session.getActiveToolNames(),
    async prompt(text: string) {
      await session.prompt(text);
      return session.getLastAssistantText() ?? "";
    },
    dispose() {
      unsubscribe();
      session.dispose();
    },
  };
}
