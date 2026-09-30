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
  /** 持久化会话管理器；缺省为内存会话。续跑场景传入 continueRecent 实例以恢复历史。 */
  sessionManager?: SessionManager;
  /** 任务级工具（如文档解析、底稿生成），由调用方按任务上下文构造。 */
  taskTools?: ToolDefinition[];
  /** 归一化后的事件回调，由调用方转发到 SSE / 数据库。 */
  onEvent: (event: NormalizedAgentEvent) => void;
}

export type NormalizedAgentEvent =
  | { kind: "agent_text_delta"; text: string }
  | { kind: "agent_text"; text: string }
  | { kind: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "tool_end"; toolCallId: string; toolName: string; ok: boolean; result: unknown }
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
    sessionManager: input.sessionManager ?? SessionManager.inMemory(),
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
      const e = event as unknown as { toolCallId?: string; toolName?: string; args?: unknown };
      onEvent({
        kind: "tool_start",
        toolCallId: e.toolCallId ?? "",
        toolName: e.toolName ?? "(unknown)",
        args: e.args,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const e = event as unknown as {
        toolCallId?: string;
        toolName?: string;
        /** SDK 的 ToolExecutionEndEvent 把 isError 放在事件顶层，不在 result 里 */
        isError?: boolean;
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
      // ok 的判据此前只读 `e.result?.isError`，而 SDK 把 isError 放在**事件顶层**：于是 270 次
      // tool_end 全部记成 ok=true，平台从来没有能力记录一次工具失败（看板上的「失败 0」是这么来的）。
      // 顶层与 result 两处都认，缺一个就会漏。
      const flaggedError = e.isError === true || e.result?.isError === true;
      // 社区联网类工具把失败写在 details.error 里、并不置 isError（实测 HTTP 404 / HTTP 412 /
      // "No query specified" / "Only HTTP and HTTPS URLs can be fetched remotely" 共 7 条都记成
      // ok=1）。取不到内容就是没成功，这类同样算失败——否则成功率会把抓不到页面算成正常。
      const details = e.result?.details;
      const detailsError =
        typeof details === "object" &&
        details !== null &&
        typeof (details as { error?: unknown }).error === "string" &&
        String((details as { error?: unknown }).error).trim() !== "";
      onEvent({
        kind: "tool_end",
        toolCallId: e.toolCallId ?? "",
        toolName: e.toolName ?? "(unknown)",
        ok: !flaggedError && !detailsError,
        result: details ?? (errorText ? { error: errorText } : null),
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
