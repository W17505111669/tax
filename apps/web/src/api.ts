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

  /** 上传策略（扩展名白名单与大小上限），供前端预检使用 */
  uploadPolicy: () =>
    request<{ allowedExtensions: string[]; maxUploadBytes: number }>("/api/upload-policy"),

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

  /** 已持久化的政策文号复查结果 */
  listRefChecks: (taskId: string) =>
    request<{ checks: import("./types.ts").RefCheckRecord[]; checkedAt: string | null }>(
      `/api/tasks/${taskId}/ref-checks`,
    ),

  /** 触发政策文号联网复查（自建检索通道，结果落库并写入事件留痕） */
  runRefChecks: (
    taskId: string,
    targets: Array<{
      kind?: "docref" | "citation";
      text: string;
      context?: string;
      /** 引用复查时传原地址：服务端用它做主键，并把它排除在替代来源之外 */
      url?: string;
    }>,
  ) =>
    request<{
      checks: import("./types.ts").RefCheckRecord[];
      checkedAt: string | null;
      ran: number;
      matched: number;
    }>(`/api/tasks/${taskId}/ref-checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    }),

  /** 跨任务批量复查政策文号（平台看板证据缺口条一键处理，条数受服务端预算限制） */
  batchRefChecks: (ids?: string[], kinds?: Array<"docref" | "citation">) =>
    request<{
      tasks: number;
      ran: number;
      matched: number;
      budget: number;
      kinds: string[];
      perTask: Array<{
        id: string;
        title: string;
        ran: number;
        matched: number;
        candidate: number;
        empty: number;
        error: number;
      }>;
    }>(`/api/tasks/ref-checks-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, kinds }),
    }),

  /** 打包交付：把整页 MD 交给服务端与本任务产物合成 zip（二进制，故不走 request） */
  bundleZip: async (taskId: string, markdown: string, fileName?: string, manifest?: unknown): Promise<Blob> => {
    const res = await fetch(`/api/tasks/${taskId}/bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, fileName, manifest }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text ? text.slice(0, 200) : `打包失败 HTTP ${res.status}`);
    }
    return res.blob();
  },

  /** 重新解析单份上传资料（状态卡在待解析或解析失败时的补救入口） */
  reparseFile: (taskId: string, fileId: string) =>
    request<{ ok: boolean; warning: string | null; doc: unknown }>(
      `/api/tasks/${taskId}/files/${fileId}/reparse`,
      { method: "POST" },
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
    request<{
      compares: import("./types.ts").CompareRecord[];
      unusable: import("./types.ts").UnusableCompare[];
    }>(`/api/tasks/${taskId}/compares`),

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

  /** 跨任务批量处置同一类待复核问题；服务端会重新核对每条是否仍待复核 */
  reviewBatch: (items: Array<{ taskId: string; issueId: string }>, decision: "confirm" | "dismiss", comment: string) =>
    request<{
      total: number;
      perTask: Array<{ id: string; title: string; saved: number; pending: number; completed: boolean }>;
      skipped: Array<{ taskId: string; issueId: string; reason: string }>;
    }>(`/api/tasks/reviews-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, decision, comment }),
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
