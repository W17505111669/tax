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
 * 订阅任务 SSE 事件，聚合成时间线、工具调用列表与任务状态。
 * 任务状态以后端真实事件为准，不依赖模型文字判断。
 *
 * 聚合口径在 `task-events.ts`（纯函数、可单测），这里只负责订阅与**批量刷新**：事件先并进
 * 累加器，每 `FLUSH_MS` 毫秒把累加器快照进 state 一次。此前每条事件都 setState 一次，回放
 * 上万条历史事件时页面几分钟都出不来工具结果（缘由见 task-events.ts 的头注释）。
 *
 * 累加器里的 `stream`（本次连接累计到的全文）**刻意不往外暴露**：流式回显用的是时间线条目的
 * `detail`（每次运行一段、带 `streaming` 标记），`stream` 是聚合器内部与 `detail` 互为校验的
 * 那一份（verify:tlcalls 钉住了两者同源、以及它不随 agent_text 收口清空）。此前它被 useState
 * 镜像了一份、每批 flush 都写一次，而唯一的消费者 TaskWorkbench 从来没解构过它——一个只写不读
 * 的死字段，还按全任务所有轮次累积（实测单任务最多 24717 行 delta、平均每行约 6.7 字）。
 */
export function useTaskEvents(taskId: string | null) {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
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

  return { timeline, toolCalls, status, connected, reconnect };
}
