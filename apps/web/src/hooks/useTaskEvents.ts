import { useEffect, useRef, useState } from "react";
import { openEventStream } from "../api.ts";
import type { AgentEvent, EventKind, TaskStatus } from "../types.ts";

export interface TimelineItem {
  id: string;
  kind: EventKind;
  title: string;
  detail?: string;
  at: string;
  streaming?: boolean;
  payload?: unknown;
}

export interface ToolCallItem {
  toolName: string;
  args: unknown;
  result: unknown;
  ok: boolean | null;
  at: string;
}

const STATUS_LABEL: Record<EventKind, string> = {
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
 * 订阅任务 SSE 事件，聚合成时间线、工具调用列表与流式文本。
 * 任务状态以后端真实事件为准，不依赖模型文字判断。
 */
export function useTaskEvents(taskId: string | null) {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [stream, setStream] = useState("");
  const [status, setStatus] = useState<TaskStatus>("created");
  const [connected, setConnected] = useState(false);
  const streamIdRef = useRef<string | null>(null);

  useEffect(() => {
    setTimeline([]);
    setToolCalls([]);
    setStream("");
    setStatus("created");
    streamIdRef.current = null;
    if (!taskId) return;

    const close = openEventStream(taskId, (event: AgentEvent) => {
      if (event.kind === "agent_text_delta") {
        if (!streamIdRef.current) {
          streamIdRef.current = `stream-${event.seq}`;
          const id = streamIdRef.current;
          setTimeline((prev) => [
            ...prev,
            { id, kind: "agent_text", title: "Agent 输出", detail: "", at: event.at, streaming: true },
          ]);
        }
        setStream((prev) => prev + event.message);
        const id = streamIdRef.current;
        setTimeline((prev) => prev.map((item) => (item.id === id ? { ...item, detail: (item.detail ?? "") + event.message } : item)));
        return;
      }

      if (event.kind === "agent_text") {
        streamIdRef.current = null;
        setTimeline((prev) => prev.map((item) => (item.streaming ? { ...item, streaming: false } : item)));
        return;
      }

      if (event.kind === "tool_start") {
        const payload = event.payload as { toolName?: string; args?: unknown } | undefined;
        setToolCalls((prev) => [
          ...prev,
          { toolName: payload?.toolName ?? "unknown", args: payload?.args, result: null, ok: null, at: event.at },
        ]);
      }

      if (event.kind === "tool_end") {
        const payload = event.payload as { toolName?: string; ok?: boolean; result?: unknown } | undefined;
        setToolCalls((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const item = next[i]!;
            if (item.toolName === (payload?.toolName ?? "") && item.ok === null) {
              next[i] = { ...item, ok: payload?.ok ?? true, result: payload?.result ?? null };
              break;
            }
          }
          return next;
        });
      }

      if (event.kind === "run_started") setStatus("processing");
      if (event.kind === "run_completed") setStatus("completed");
      if (event.kind === "run_failed") setStatus("failed");

      setTimeline((prev) => [
        ...prev,
        {
          id: `${event.seq}-${event.kind}`,
          kind: event.kind,
          title: STATUS_LABEL[event.kind] || event.kind,
          detail: event.kind === "tool_end" ? undefined : event.message,
          at: event.at,
          payload: event.payload,
        },
      ]);
    });

    setConnected(true);
    return () => {
      close();
      setConnected(false);
    };
  }, [taskId]);

  return { timeline, toolCalls, stream, status, connected };
}
