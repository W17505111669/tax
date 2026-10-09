import type { AgentEvent } from "@tax/shared-schemas";

export interface EventReplayDeps {
  listEvents: (taskId: string) => AgentEvent[];
  subscribe: (taskId: string, listener: (event: AgentEvent) => void) => () => void;
}

/**
 * 先订阅、再读库，最后按序回放历史并去重，避免 SSE 在读库与订阅之间漏事件。
 */
export function replayEvents(taskId: string, send: (event: AgentEvent) => void, deps: EventReplayDeps): () => void {
  const buffered: AgentEvent[] = [];
  let live = false;
  const listener = (event: AgentEvent): void => {
    if (!live) buffered.push(event);
    else send(event);
  };
  const unsubscribe = deps.subscribe(taskId, listener);
  const history = deps.listEvents(taskId);
  for (const event of history) send(event);
  const historySeqs = new Set(history.map((event) => event.seq));
  let pending = buffered;
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    for (const event of batch) {
      if (!historySeqs.has(event.seq)) send(event);
    }
  }
  live = true;
  return unsubscribe;
}
