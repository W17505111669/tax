import path from "node:path";
import { createTaxAgentSession, loadRuntimeConfig, SessionManager, TaskEventBus } from "@tax/agent-core";
import type { NormalizedAgentEvent } from "@tax/agent-core";
import { createDiagramTools, createExtractTools, createTaskDocumentTools, createTemplateTools } from "@tax/document-tools";
import type { AgentId } from "@tax/shared-schemas";
import { dataDir, dirs } from "../config.ts";
import { resolveCommunityExtensions } from "../extensions.ts";
import { getAgent } from "../agents.ts";
import {
  appendEvent,
  finishToolCall,
  getTask,
  listFiles,
  latestToolResult,
  markFilesParsed,
  recordToolCall,
  setTaskStatus,
} from "./task-store.ts";
import { pendingReviewIssues } from "./issues.ts";
import { revisionAllowedTools, revisionBlockedNames } from "../../../web/src/revision-mode.ts";

export const eventBus = new TaskEventBus();

const running = new Set<string>();

function emit(taskId: string, kind: Parameters<typeof appendEvent>[1], message: string, payload?: unknown): void {
  const event = appendEvent(taskId, kind, message, payload);
  eventBus.publish(event);
}

/**
 * 启动一次 Agent 运行。函数不阻塞 HTTP 请求，进度通过 SSE 推送。
 * 任务状态以真实执行事件与持久化状态为准，不依据模型文字判断。
 */
export async function runTask(
  taskId: string,
  instruction: string,
  opts: { resume?: boolean; revisionOnly?: boolean } = {},
): Promise<void> {
  if (running.has(taskId)) return;
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);

  running.add(taskId);
  setTaskStatus(taskId, "processing");
  const agent0 = getAgent(task.agentId as AgentId);
  // 修订模式：把会重写产物、比对记录与测算结果的工具从本轮会话里摘掉，
  // 只留检索与读取类工具。指令里也写了「不要重跑业务工具」，但机制比嘱咐可靠。
  const blocked = opts.revisionOnly ? revisionBlockedNames(agent0.tools) : [];
  const agent = opts.revisionOnly ? { ...agent0, tools: revisionAllowedTools(agent0.tools) } : agent0;
  emit(
    taskId,
    "run_started",
    opts.revisionOnly
      ? `续跑任务（修订模式：只改依据与引用，本轮停用会重写产物与比对记录的工具）：${task.title}`
      : opts.resume
        ? `续跑任务：${task.title}`
        : `开始执行任务：${task.title}`,
  );
  const cfg = loadRuntimeConfig();
  cfg.extensionPaths = [...cfg.extensionPaths, ...resolveCommunityExtensions()];
  const taskCwd = path.join(dirs.uploads, taskId);
  const docCtx = {
    taskId,
    files: listFiles(taskId),
    outputsDir: path.join(dirs.outputs, taskId),
    latestToolResult: (toolName: string) => latestToolResult(taskId, toolName),
  };
  const kits = agent.taskToolKits ?? ["documents"];
  const allTaskTools = [
    ...(kits.includes("documents") ? createTaskDocumentTools(docCtx) : []),
    ...(kits.includes("template") ? createTemplateTools(docCtx) : []),
    ...(kits.includes("extract") ? createExtractTools(docCtx) : []),
    ...(kits.includes("template") ? createDiagramTools(docCtx) : []),
  ];
  const taskTools = opts.revisionOnly ? revisionAllowedTools(allTaskTools) : allTaskTools;
  if (opts.revisionOnly) {
    // 停用了哪些工具进服务端日志：界面上 run_started 事件已经写明本轮是修订模式，
    // 这里留一份完整清单便于事后追查「为什么这一轮没有底稿产物」
    const removed = [...blocked, ...revisionBlockedNames(allTaskTools)];
    if (removed.length > 0) console.log(`[revision] ${taskId} 停用工具：${removed.join("、")}`);
  }

  const pendingToolCalls = new Map<string, string>();
  let session: Awaited<ReturnType<typeof createTaxAgentSession>> | undefined;

  try {
    session = await createTaxAgentSession({
      agent,
      cfg,
      cwd: taskCwd,
      taskTools,
      // 按任务隔离的持久化会话：续跑时恢复完整对话历史
      sessionManager: SessionManager.continueRecent(taskCwd, path.join(dataDir, "sessions", taskId)),
      onEvent: (event: NormalizedAgentEvent) => {
        switch (event.kind) {
          case "agent_text_delta":
            emit(taskId, "agent_text_delta", event.text);
            break;
          case "agent_text":
            emit(taskId, "agent_text", event.text);
            break;
          case "tool_start": {
            const callId = recordToolCall({ taskId, toolName: event.toolName, args: event.args });
            pendingToolCalls.set(event.toolName, callId);
            emit(taskId, "tool_start", `调用工具 ${event.toolName}`, { toolName: event.toolName, args: event.args, callId });
            break;
          }
          case "tool_end": {
            const callId = pendingToolCalls.get(event.toolName);
            if (callId) {
              finishToolCall(callId, event.ok, event.result);
              pendingToolCalls.delete(event.toolName);
            }
            if (event.toolName === "parse_uploaded_files" && event.ok) markFilesParsed(taskId);
            emit(taskId, "tool_end", `工具 ${event.toolName} 执行${event.ok ? "完成" : "失败"}`, {
              toolName: event.toolName,
              ok: event.ok,
              result: event.result,
              callId,
            });
            break;
          }
          case "agent_status":
            emit(taskId, "agent_status", event.status);
            break;
        }
      },
    });

    const files = listFiles(taskId);
    emit(taskId, "agent_status", `已加载智能体「${agent.shortName}」，可用工具：${session.tools.join("、") || "无"}`);
    if (files.length > 0) {
      emit(taskId, "agent_status", `本任务已上传 ${files.length} 份资料：${files.map((f) => f.fileName).join("、")}`);
    }

    const prompt = opts.resume
      ? `【续跑补充】${instruction.trim()}\n\n请结合本任务此前的核查结论与已生成产物继续处理；如补充了新的上传资料，先调用 parse_uploaded_files 解析新增文件。`
      : buildPrompt(instruction, files.map((f) => f.fileName));
    const answer = await session.prompt(prompt);

    setTaskStatus(taskId, "completed", { result: answer });
    emit(taskId, "run_completed", "任务完成", { result: answer });

    // 存在待复核问题时流转为 waiting_review，等待税务师在「人工复核」页签处理
    const pending = pendingReviewIssues(taskId).length;
    if (pending > 0) {
      setTaskStatus(taskId, "waiting_review");
      emit(taskId, "agent_status", `执行完成，${pending} 项问题待税务师复核`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setTaskStatus(taskId, "failed", { error: message });
    emit(taskId, "run_failed", `执行失败：${message}`, { error: message });
  } finally {
    session?.dispose();
    running.delete(taskId);
  }
}

function buildPrompt(instruction: string, fileNames: string[]): string {
  const parts = [instruction.trim()];
  if (fileNames.length > 0) {
    parts.push("", `本任务已上传的资料文件：${fileNames.join("、")}。资料解析能力尚在建设中时，请明确说明哪些结论依赖尚未解析的资料。`);
  }
  return parts.join("\n");
}

export function isRunning(taskId: string): boolean {
  return running.has(taskId);
}
