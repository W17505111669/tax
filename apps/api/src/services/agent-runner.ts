import path from "node:path";
import { createTaxAgentSession, loadRuntimeConfig, TaskEventBus } from "@tax/agent-core";
import type { NormalizedAgentEvent } from "@tax/agent-core";
import { createTaskDocumentTools, createTemplateTools } from "@tax/document-tools";
import type { AgentId } from "@tax/shared-schemas";
import { dirs } from "../config.ts";
import { resolveCommunityExtensions } from "../extensions.ts";
import { getAgent } from "../agents.ts";
import {
  appendEvent,
  finishToolCall,
  getTask,
  listFiles,
  markFilesParsed,
  recordToolCall,
  setTaskStatus,
} from "./task-store.ts";

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
export async function runTask(taskId: string, instruction: string): Promise<void> {
  if (running.has(taskId)) return;
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);

  running.add(taskId);
  setTaskStatus(taskId, "processing");
  emit(taskId, "run_started", `开始执行任务：${task.title}`);

  const agent = getAgent(task.agentId as AgentId);
  const cfg = loadRuntimeConfig();
  cfg.extensionPaths = [...cfg.extensionPaths, ...resolveCommunityExtensions()];
  const taskCwd = path.join(dirs.uploads, taskId);
  const docCtx = { taskId, files: listFiles(taskId), outputsDir: path.join(dirs.outputs, taskId) };
  const kits = agent.taskToolKits ?? ["documents"];
  const taskTools = [
    ...(kits.includes("documents") ? createTaskDocumentTools(docCtx) : []),
    ...(kits.includes("template") ? createTemplateTools(docCtx) : []),
  ];

  const pendingToolCalls = new Map<string, string>();
  let session: Awaited<ReturnType<typeof createTaxAgentSession>> | undefined;

  try {
    session = await createTaxAgentSession({
      agent,
      cfg,
      cwd: taskCwd,
      taskTools,
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

    const prompt = buildPrompt(instruction, files.map((f) => f.fileName));
    const answer = await session.prompt(prompt);

    setTaskStatus(taskId, "completed", { result: answer });
    emit(taskId, "run_completed", "任务完成", { result: answer });
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
