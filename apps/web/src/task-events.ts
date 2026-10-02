/**
 * 任务事件的聚合口径：时间线、工具调用清单、流式正文、运行状态。
 *
 * 为什么单独成一个模块：这段逻辑此前直接写在 `useTaskEvents` 的 SSE 回调里，每来一条事件就
 * `setTimeline((prev) => [...prev, item])` 复制一次整个数组、再触发一次重渲染。回放历史任务时
 * 事件是**一次性灌进来**的，实测 4bb22d34 有 13829 条事件（对照任务 780 / 944 条），光是数组
 * 复制就是二次方级，页面上所有依赖工具结果的模块——联网引用面板、检索留痕、留存截断说明、
 * 工具调用清单——等了 181 秒仍然是空的，而库里和 SSE 流里的数据都是齐的（用 node 按同一套
 * 配对逻辑回放，33 条 tool_end 全部配对成功）。
 *
 * 拆开之后：聚合就地改一个累加器（`applyEvent`，纯函数式口径、可单测），渲染由 hook 按固定
 * 间隔批量刷新（一次刷新只复制一次数组）。判据与口径逐条照搬原来的实现，不改语义。
 */
import type { AgentEvent, EventKind, TaskStatus } from "./types.ts";

export interface TimelineItem {
  id: string;
  kind: EventKind;
  title: string;
  detail?: string;
  at: string;
  seq: number;
  streaming?: boolean;
  payload?: unknown;
}

export interface ToolCallItem {
  /** 工具调用 id（来自事件 payload.callId），用于与时间线事件精确配对 */
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  ok: boolean | null;
  at: string;
  endedAt: string | null;
}

export const STATUS_LABEL: Record<EventKind, string> = {
  task_created: "任务已创建",
  run_started: "开始执行",
  agent_text_delta: "",
  agent_text: "Agent 输出",
  tool_start: "工具调用",
  tool_end: "工具返回",
  agent_status: "运行状态",
  run_completed: "任务完成",
  run_failed: "执行失败",
};

/**
 * 批量刷新的间隔（毫秒）。取 80 是因为流式输出时人眼读不出比每秒 12 次更细的更新，
 * 而回放 1 万多条历史事件时，这个间隔能把上万次重渲染压到几十次。
 */
export const FLUSH_MS = 80;

export interface EventsAcc {
  timeline: TimelineItem[];
  toolCalls: ToolCallItem[];
  stream: string;
  /** 正在流式输出的那条时间线条目 id；agent_text 到来时清掉 */
  streamId: string | null;
  status: TaskStatus;
}

export function createEventsAcc(status: TaskStatus = "created"): EventsAcc {
  return { timeline: [], toolCalls: [], stream: "", streamId: null, status };
}

/**
 * 把一条事件并进累加器（就地改，不复制数组）。
 *
 * 工具调用的配对口径与后端一致：优先按 `callId` 精确落位，历史事件没有 callId 时退回
 * 「同名且未结束」的最近一条。按工具名配对是不成立的——工具可以并发执行，同名工具在上一次
 * 还没结束时再次开始，结果会挂到错误的调用上。
 */
export function applyEvent(acc: EventsAcc, event: AgentEvent): void {
  if (event.kind === "agent_text_delta") {
    if (!acc.streamId) {
      acc.streamId = `stream-${event.seq}`;
      acc.timeline.push({
        id: acc.streamId,
        kind: "agent_text",
        title: "Agent 输出",
        detail: "",
        at: event.at,
        seq: event.seq,
        streaming: true,
      });
    }
    acc.stream += event.message;
    const id = acc.streamId;
    const item = acc.timeline.find((x) => x.id === id);
    if (item) item.detail = (item.detail ?? "") + event.message;
    return;
  }

  if (event.kind === "agent_text") {
    acc.streamId = null;
    for (const item of acc.timeline) if (item.streaming) item.streaming = false;
    return;
  }

  if (event.kind === "tool_start") {
    const payload = event.payload as { toolName?: string; args?: unknown; callId?: string } | undefined;
    const toolName = payload?.toolName ?? "unknown";
    acc.toolCalls.push({
      // 历史事件可能没有 callId，用 seq 兜底保证 id 唯一
      id: payload?.callId ?? `${toolName}#${event.seq}`,
      toolName,
      args: payload?.args,
      result: null,
      ok: null,
      at: event.at,
      endedAt: null,
    });
  }

  if (event.kind === "tool_end") {
    const payload = event.payload as
      | { toolName?: string; ok?: boolean; result?: unknown; callId?: string }
      | undefined;
    let hit = payload?.callId ? acc.toolCalls.findIndex((c) => c.id === payload.callId) : -1;
    if (hit < 0) {
      for (let i = acc.toolCalls.length - 1; i >= 0; i -= 1) {
        const item = acc.toolCalls[i]!;
        if (item.toolName === (payload?.toolName ?? "") && item.ok === null) {
          hit = i;
          break;
        }
      }
    }
    if (hit >= 0) {
      const prev = acc.toolCalls[hit]!;
      acc.toolCalls[hit] = { ...prev, ok: payload?.ok ?? true, result: payload?.result ?? null, endedAt: event.at };
    }
  }

  if (event.kind === "run_started") acc.status = "processing";
  if (event.kind === "run_completed") acc.status = "completed";
  if (event.kind === "run_failed") acc.status = "failed";

  acc.timeline.push({
    id: `${event.seq}-${event.kind}`,
    kind: event.kind,
    title: STATUS_LABEL[event.kind] || event.kind,
    detail: event.kind === "tool_end" ? undefined : event.message,
    at: event.at,
    seq: event.seq,
    payload: event.payload,
  });
}
