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

  // 按 SDK 的 toolCallId 配对开始与结束事件。此前按**工具名**配对：同名工具在上一次还没结束就
  // 再次开始时，后一次的行 id 会覆盖前一次，于是前一行永远停在 ok IS NULL、result 为空，而结束时
  // 取到的又是另一次的行 id——结果被挂到错误的调用上。实测 270 次 tool_start / 270 次 tool_end
  // 一一成对，却只有 233 行写了结果，丢掉的 37 行恰好等于「同名工具未结束就再次开始」的次数 37。
  // 工具可以并发执行（ToolDefinition.executionMode 支持 "parallel"），按名配对根本站不住。
  const pendingToolCalls = new Map<string, string>();
  /** 兜底：SDK 没给 toolCallId 时才退回按工具名配对 */
  const pendingByName = new Map<string, string>();
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
            if (event.toolCallId) pendingToolCalls.set(event.toolCallId, callId);
            else pendingByName.set(event.toolName, callId);
            emit(taskId, "tool_start", `调用工具 ${event.toolName}`, { toolName: event.toolName, args: event.args, callId });
            break;
          }
          case "tool_end": {
            const callId =
              (event.toolCallId ? pendingToolCalls.get(event.toolCallId) : undefined) ??
              pendingByName.get(event.toolName);
            if (callId) {
              finishToolCall(callId, event.ok, event.result);
              if (event.toolCallId) pendingToolCalls.delete(event.toolCallId);
              if (pendingByName.get(event.toolName) === callId) pendingByName.delete(event.toolName);
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

    // 续跑不能指望会话历史一定还在。会话目录按任务存，早期任务没有留存——实测 c2dda328 的
    // 目录里只有修订这一轮的 jsonl，原始那轮没留下，continueRecent 找不到历史就开了新会话。
    // 模型于是拿不到上一轮结论正文，只能交回一份「本轮做了什么」的说明，而那段文本会整体成为
    // 新的结论：1895 字的「一、测算结论」被换成 3881 字的改动日志，文号 5 处掉到 2 处、
    // 金额溯源项少 22 个。所以续跑一律把上一轮结论原文带进提示词，不依赖会话恢复。
    const prevResult = (task.result ?? "").trim();
    const prompt = opts.resume
      ? [
          `【续跑补充】${instruction.trim()}`,
          "",
          prevResult === ""
            ? "【上一轮结论正文】本任务此前没有结论正文（上一轮未产出或被中断），请按上面的要求直接产出完整结论。"
            : `【上一轮结论正文（必须在它的基础上改，改完交回完整正文，不要只交改动说明）】\n${prevResult}`,
          "",
          "请结合本任务此前的核查结论与已生成产物继续处理；如补充了新的上传资料，先调用 parse_uploaded_files 解析新增文件。",
        ].join("\n")
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
