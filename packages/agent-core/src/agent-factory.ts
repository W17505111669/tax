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

/**
 * 需要留存正文的工具：联网检索与网页读取类。
 *
 * 只存 `details` 的话，网页正文一个字都留不下来——实测 51 条 `get_search_content` 结果里最长的
 * 字符串字段只有 110 字、22 条 `fetch_public_document` 只有 93 字（就是 URL 本身），全是元数据。
 * 模型确实读到了正文（正文在 `content` 块里交给它），也确实把政策原文摘引进了结论，但平台没有
 * 留存任何可核对的原文：结论里那些「90 万元 / 21.11 万元」既证明不了是忠实引用，也证明不了是
 * 编造。对一个以「有据可查」为卖点的平台，这是证据链上的洞。
 *
 * 这份名单与 apps/web/src/search-evidence.ts 的 SEARCH_TOOL_NAMES 必须一致（那边用于引用提取与
 * 检索统计，这边用于决定留存正文）；agent-core 不能反向依赖 apps，所以在这里各存一份，由
 * verify:agents 断言两者相同，避免漂移。
 */
export const TEXT_EVIDENCE_TOOLS = new Set([
  "web_search",
  "search_public_cases",
  "fetch_content",
  "fetch_public_document",
  "get_search_content",
]);

/**
 * 单次调用留存的正文上限（字符）。够覆盖政策解读页与法规原文页的正文（实测 charCount 多在
 * 3,000～8,000），又不至于让库无限膨胀；截断量单独记在 omittedChars 里，不假装存全了。
 */
export const MAX_RETAINED_TEXT = 20000;

/** 把工具结果的文本块拼成一段正文 */
function joinTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * 给联网类工具的结果补上有上限的正文留存，返回真正要落库的 result。
 * 非联网工具原样返回，不做任何改动（它们的正文本来就是自己拼的摘要，另存一份只是浪费空间）。
 */
export function withRetainedText(toolName: string, stored: unknown, body: string): unknown {
  if (!TEXT_EVIDENCE_TOOLS.has(toolName) || body === "") return stored;
  const truncated = body.length > MAX_RETAINED_TEXT;
  const retained = truncated ? `${body.slice(0, MAX_RETAINED_TEXT)}…` : body;
  // retainedChars 记的是真正留住的原文字符数，不含结尾那个省略号；omittedChars 是被截掉的准确字数，
  // 两个数都不含糊，读的人能判断「这条引用有没有可能落在没存下来的那一段里」
  const extra = {
    retainedText: retained,
    retainedChars: truncated ? MAX_RETAINED_TEXT : body.length,
    omittedChars: truncated ? body.length - MAX_RETAINED_TEXT : 0,
  };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) return { ...stored, ...extra };
  return stored === null || stored === undefined ? extra : { value: stored, ...extra };
}
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
        // 联网类工具额外留存正文（有上限），否则结论里摘引的政策原文无从核对
        result: withRetainedText(
          e.toolName ?? "(unknown)",
          details ?? (errorText ? { error: errorText } : null),
          joinTextContent(e.result?.content),
        ),
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
