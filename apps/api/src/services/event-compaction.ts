import type { AgentEvent } from "@tax/shared-schemas";

/**
 * 历史回放专用：把连续的 agent_text_delta 合并成一条，减少 SSE 初始回放事件数。
 *
 * 实时流不合并；历史回放与前端 applyEvent 的“delta 累积、agent_text 收口”语义一致。
 */
export function compactEvents(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  let buffer: AgentEvent[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) out.push(buffer[0]!);
    else {
      const first = buffer[0]!;
      out.push({ ...first, message: buffer.map((event) => event.message).join("") });
    }
    buffer = [];
  };
  for (const event of events) {
    if (event.kind === "agent_text_delta") buffer.push(event);
    else {
      flush();
      out.push(event);
    }
  }
  flush();
  return out;
}
