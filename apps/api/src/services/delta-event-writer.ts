import type { AgentEvent } from "@tax/shared-schemas";

export const DELTA_FLUSH_CHARS = 1024;

export interface DeltaEventWriterDeps {
  appendEvent: (taskId: string, kind: "agent_text_delta", message: string) => AgentEvent;
  updateEventMessage: (taskId: string, seq: number, message: string) => number;
  publish: (event: AgentEvent) => void;
}

/**
 * 流式正文的持久化缓冲：SSE 每片照发，events 表同一段只留一行。
 *
 * 首片先落库拿到真实 seq；后续片段用同一个 seq 广播，前端按“delta 累积”照常拼接。
 * 持久化行保存累计正文，达到阈值或收口时写回，历史回放与实时流式得到同一段全文。
 */
export class DeltaEventWriter {
  private event: AgentEvent | undefined;
  private text = "";
  private persistedChars = 0;

  constructor(private readonly deps: DeltaEventWriterDeps) {}

  push(taskId: string, text: string): void {
    if (!this.event) {
      this.event = this.deps.appendEvent(taskId, "agent_text_delta", text);
      this.text = text;
      this.persistedChars = text.length;
      this.deps.publish(this.event);
      this.flush();
      return;
    }

    this.text += text;
    this.deps.publish({ ...this.event, message: text });
    if (this.text.length - this.persistedChars >= DELTA_FLUSH_CHARS) this.flush();
  }

  close(): void {
    this.flush();
    this.event = undefined;
    this.text = "";
    this.persistedChars = 0;
  }

  private flush(): void {
    if (!this.event || this.text.length === this.persistedChars) return;
    this.deps.updateEventMessage(this.event.taskId, this.event.seq, this.text);
    this.persistedChars = this.text.length;
  }
}
