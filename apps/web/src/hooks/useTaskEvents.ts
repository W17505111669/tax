import { useCallback, useEffect, useRef, useState } from "react";
import { openEventStream } from "../api.ts";
import type { AgentEvent, TaskStatus } from "../types.ts";
import {
  applyEvent,
  createEventsAcc,
  FLUSH_MS,
  type EventsAcc,
  type TimelineItem,
  type ToolCallItem,
} from "../task-events.ts";

export type { TimelineItem, ToolCallItem };

/**
 * 订阅任务 SSE 事件，聚合成时间线、工具调用列表与流式文本。
 * 任务状态以后端真实事件为准，不依赖模型文字判断。
 *
 * 聚合口径在 `task-events.ts`（纯函数、可单测），这里只负责订阅与**批量刷新**：事件先并进
 * 累加器，每 `FLUSH_MS` 毫秒把累加器快照进 state 一次。此前每条事件都 setState 一次，回放
 * 上万条历史事件时页面几分钟都出不来工具结果（缘由见 task-events.ts 的头注释）。
 */
export function useTaskEvents(taskId: string | null) {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [stream, setStream] = useState("");
  const [status, setStatus] = useState<TaskStatus>("created");
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);
  const accRef = useRef<EventsAcc>(createEventsAcc());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const acc = createEventsAcc();
    accRef.current = acc;
    setTimeline([]);
    setToolCalls([]);
    setStream("");
    setStatus("created");
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!taskId) return;

    const flush = () => {
      timerRef.current = null;
      setTimeline([...acc.timeline]);
      setToolCalls([...acc.toolCalls]);
      setStream(acc.stream);
      setStatus(acc.status);
    };

    const close = openEventStream(taskId, (event: AgentEvent) => {
      applyEvent(acc, event);
      // 一次刷新只排一个定时器：事件成批到达时不会退化成「每条一次重渲染」
      if (timerRef.current === null) timerRef.current = window.setTimeout(flush, FLUSH_MS);
    });

    setConnected(true);
    return () => {
      close();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setConnected(false);
    };
  }, [taskId, nonce]);

  // 手动重连：重置状态并重放持久化事件
  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  return { timeline, toolCalls, stream, status, connected, reconnect };
}
