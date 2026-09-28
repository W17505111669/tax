import type { AgentEvent, AgentInfo, ArtifactInfo, FileInfo, ReaderResult, TaskInfo, ToolCall } from "./types.ts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败 ${res.status}`);
  return data;
}

export const api = {
  listAgents: () => request<{ agents: AgentInfo[] }>("/api/agents").then((r) => r.agents),

  getStats: () => request<import("./types.ts").PlatformStats>("/api/stats"),

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

  resumeTask: (id: string, instruction: string) =>
    request<{ taskId: string; status: string; resume: boolean }>(`/api/tasks/${id}/resume`, {
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

  readUrl: (url: string) => request<ReaderResult>(`/api/reader?url=${encodeURIComponent(url)}`),

  /** 触发链接核验并落库；返回该任务已持久化的全部核验结果 */
  checkLinks: (taskId: string, urls: string[]) =>
    request<{ checkedAt: string; total: number; ok: number; results: import("./types.ts").LinkCheck[] }>(
      `/api/tasks/${taskId}/check-links`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      },
    ),

  listLinkChecks: (taskId: string) =>
    request<{ results: import("./types.ts").LinkCheck[]; checkedAt: string | null }>(
      `/api/tasks/${taskId}/link-checks`,
    ),

  listArtifacts: (taskId: string) =>
    request<{ artifacts: ArtifactInfo[] }>(`/api/tasks/${taskId}/artifacts`).then((r) => r.artifacts),

  fileContentUrl: (taskId: string, fileId: string) => `/api/tasks/${taskId}/files/${fileId}/content`,

  fileSheetsUrl: (taskId: string, fileId: string) => `/api/tasks/${taskId}/files/${fileId}/sheets`,

  artifactSheetsUrl: (taskId: string, name: string) =>
    `/api/tasks/${taskId}/artifacts/${encodeURIComponent(name)}/sheets`,

  readSheets: (url: string) =>
    request<{ sheets: import("./types.ts").SheetPreview[] }>(url).then((r) => r.sheets),

  listCompares: (taskId: string) =>
    request<{ compares: import("./types.ts").CompareRecord[] }>(`/api/tasks/${taskId}/compares`).then(
      (r) => r.compares,
    ),

  listIssues: (taskId: string) =>
    request<{
      issues: import("./types.ts").TaskIssue[];
      reviews: import("./types.ts").ReviewRecord[];
      pending: number;
    }>(`/api/tasks/${taskId}/issues`),

  submitReview: (taskId: string, body: { issueId: string; decision: "confirm" | "dismiss"; comment: string }) =>
    request<{ review: import("./types.ts").ReviewRecord; pending: number }>(`/api/tasks/${taskId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  reopenReview: (taskId: string) =>
    request<{ status: string; pending: number }>(`/api/tasks/${taskId}/reopen-review`, { method: "POST" }),

  reopenReviewBatch: (ids?: string[]) =>
    request<{
      total: number;
      reopened: Array<{ id: string; title: string; pending: number }>;
      skipped: Array<{ id: string; reason: string }>;
    }>(`/api/tasks/reopen-review-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),

  listAmountChecks: (taskId: string) =>
    request<{ checks: Array<{ key: string; note: string; createdAt: string }> }>(
      `/api/tasks/${taskId}/amount-checks`,
    ).then((r) => r.checks),

  toggleAmountCheck: (taskId: string, key: string, checked: boolean, note?: string) =>
    request<{ checks: Array<{ key: string; note: string; createdAt: string }> }>(
      `/api/tasks/${taskId}/amount-checks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, checked, note }),
      },
    ).then((r) => r.checks),

  artifactContentUrl: (taskId: string, name: string) =>
    `/api/tasks/${taskId}/artifacts/${encodeURIComponent(name)}/content`,
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
