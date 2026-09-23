import type { AgentEvent } from "@tax/shared-schemas";

type Listener = (event: AgentEvent) => void;

/**
 * 任务事件总线：Agent 运行事件先落库，再实时推给 SSE 订阅者。
 * 保留环形缓冲，使晚到的前端也能回放本次任务已发生的事件。
 */
export class TaskEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly seq = new Map<string, number>();

  nextSeq(taskId: string): number {
    const next = (this.seq.get(taskId) ?? 0) + 1;
    this.seq.set(taskId, next);
    return next;
  }

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(taskId);
    };
  }

  publish(event: AgentEvent): void {
    const set = this.listeners.get(event.taskId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不能影响 Agent 运行
      }
    }
  }
}
