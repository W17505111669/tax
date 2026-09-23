import type { AgentEvent, AgentInfo, FileInfo, TaskInfo, ToolCall } from "./types.ts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败 ${res.status}`);
  return data;
}

export const api = {
  listAgents: () => request<{ agents: AgentInfo[] }>("/api/agents").then((r) => r.agents),

  listTasks: (agentId?: string) =>
    request<{ tasks: TaskInfo[] }>(`/api/tasks${agentId ? `?agentId=${agentId}` : ""}`).then((r) => r.tasks),

  createTask: (input: { agentId: string; caseId: string; title?: string; instruction: string }) =>
    request<{ task: TaskInfo }>("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => r.task),

  getTask: (id: string) =>
    request<{ task: TaskInfo; files: FileInfo[]; toolCalls: ToolCall[] }>(`/api/tasks/${id}`),

  runTask: (id: string, instruction?: string) =>
    request<{ taskId: string; status: string }>(`/api/tasks/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    }),

  uploadFiles: async (taskId: string, files: File[], businessCategory?: string) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    if (businessCategory) form.append("businessCategory", businessCategory);
    return request<{ files: FileInfo[] }>(`/api/tasks/${taskId}/files`, { method: "POST", body: form });
  },

  getResults: (id: string) =>
    request<{ task: TaskInfo; toolCalls: ToolCall[]; events: AgentEvent[]; files: FileInfo[] }>(
      `/api/tasks/${id}/results`,
    ),
};

export function openEventStream(taskId: string, onEvent: (event: AgentEvent) => void): () => void {
  const source = new EventSource(`/api/tasks/${taskId}/events`);
  source.onmessage = (message) => {
    if (!message.data) return;
    try {
      onEvent(JSON.parse(message.data) as AgentEvent);
    } catch {
      // 忽略无法解析的心跳或分片
    }
  };
  return () => source.close();
}
