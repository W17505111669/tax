export type AgentId = "rd-audit" | "land-vat";

export interface AgentToolInfo {
  name: string;
  label: string;
  description: string;
}

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  shortName: string;
  description: string;
  capabilities: string[];
  accent: string;
  /** 运行模型标识（来自网关配置） */
  model?: string;
  tools: AgentToolInfo[];
  samplePrompts: string[];
  recommendedCards?: Array<{ label: string; hint: string; prompt: string }>;
}

export type TaskStatus = "created" | "processing" | "waiting_review" | "completed" | "failed";

export interface TaskInfo {
  id: string;
  agentId: AgentId;
  caseId: string;
  title: string;
  status: TaskStatus;
  instruction: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** 执行步骤进度 0-5（列表接口附带） */
  progress?: number;
  /** 运行次数（列表接口附带） */
  runCount?: number;
  /** 这个 failed 是服务重启打断的（续跑即可），不是 Agent 执行出错（列表接口附带） */
  interrupted?: boolean;
  /** 工具调用次数（列表接口附带） */
  toolCount?: number;
  /** 待复核问题数（列表接口附带）；completed 且 >0 时需要重新打开复核 */
  reviewPending?: number;
}

export interface FileInfo {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  byteSize: number;
  businessCategory?: string;
  parseStatus: string;
  /** 上传时间（ISO） */
  createdAt?: string;
}

export type EventKind =
  | "task_created"
  | "run_started"
  | "agent_text_delta"
  | "agent_text"
  | "tool_start"
  | "tool_end"
  | "agent_status"
  | "run_completed"
  | "run_failed";

export interface AgentEvent {
  seq: number;
  taskId: string;
  kind: EventKind;
  message: string;
  payload?: unknown;
  at: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface ReaderResult {
  url: string;
  title: string;
  excerpt: string;
  markdown: string;
  retrievedAt: string;
  contentType?: string;
}

export interface ArtifactInfo {
  name: string;
  byteSize: number;
  updatedAt: string;
}

/** 引用链接可达性核验结果 */
export interface LinkCheck {
  url: string;
  ok: boolean;
  status: number | null;
  finalUrl: string;
  ms: number;
  error?: string;
  /** 核验时间（服务端持久化，刷新后可恢复） */
  checkedAt?: string;
}

/** 政策文号联网复查：证据条目（标题、地址、摘要与证据力分级） */
export interface RefCheckEvidence {
  title: string;
  url: string;
  snippet: string;
  grade: string;
  gradeReason: string;
}

/** 政策文号联网复查记录（服务端持久化，刷新后可恢复） */
export interface RefCheckRecord {
  key: string;
  kind: "docref" | "citation";
  text: string;
  /** 实际发出的检索词 */
  query: string;
  verdict: import("./ref-check.ts").RefCheckVerdict;
  note: string;
  evidence: RefCheckEvidence | null;
  /** 复查对象的原始地址：引用类复查为被替换的弱证据地址，文号类为空串 */
  subjectUrl: string;
  /** 逐引擎尝试过程（取数方式、状态、条数与原因） */
  attempts: unknown[];
  checkedAt: string;
}

export interface SheetPreview {
  name: string;
  headers: string[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
}

export interface CompareDiff {
  address: string;
  a: string | number | null;
  b: string | number | null;
  kind: "mismatch" | "only_a" | "only_b";
}

export interface CompareSheet {
  sheetA: string;
  sheetB: string;
  mode: "record" | "address";
  compared: number;
  matched: number;
  mismatched: number;
  onlyA: number;
  onlyB: number;
  skippedFormulas: number;
  accuracyPercent: number;
  diffs: CompareDiff[];
}

export interface CompareResult {
  sheets: CompareSheet[];
  unmatchedSheetsA: string[];
  unmatchedSheetsB: string[];
  a?: CompareRef;
  b?: CompareRef;
  totals: {
    compared: number;
    matched: number;
    mismatched: number;
    onlyA: number;
    onlyB: number;
    accuracyPercent: number;
  };
}

export interface CompareRecord {
  id: string;
  at: string | null;
  result: CompareResult;
}

export interface CompareRef {
  kind: "upload" | "artifact";
  name: string;
  highlight?: string;
  /** 该侧的期望值（差异行的 A/B 值），供阅读器表格定位做值校验 */
  highlightValue?: string | number | null;
}

export interface PlatformStats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  /** 记录级比对的累计口径（各任务最近一次记录级比对的 一致项/比对项 合计） */
  compareMatched: number;
  compareCompared: number;
  compareAccuracyOverall: number | null;
  /** 累计口径的构成：填错与「只有一侧有」分开摆，免得一个准确率把两类问题互相掩盖 */
  compareMismatched: number;
    compareOnlyA: number;
    /**
     * 「已填列底稿 vs 它自己的原始模板」核对：次数 / 填列新增的单元格数 / 与模板既有内容冲突的单元格数。
     * 这一类不进一致率与覆盖率——模板本来是空的，只有一侧有的格子正是填进去的值
     */
    compareTemplateRuns: number;
    compareFilledCells: number;
    compareTemplateMismatched: number;
  compareOnlyB: number;
  /** 累计一致率 = 一致 /（一致 + 填错）：只看两边都有的项，回答「填得对不对」 */
  compareMatchRateOverall: number | null;
  /** 累计覆盖率 = 一致 /（一致 + 仅人工底稿有）：回答「填得全不全」 */
  compareCoverageOverall: number | null;
  /** 最近一次记录级比对的一致率与覆盖率（旧记录按现行规则回算） */
  compareMatchRate: number | null;
  compareCoverage: number | null;
  compareLatestAt: string;
  ocrRuns: number;
  ocrAvgConfidence: number | null;
  /** 全平台待复核问题总数 */
  reviewPendingIssues: number;
  /** 已完成但仍有待复核问题的任务（复核闭环缺口） */
  reviewBacklog: Array<{ id: string; title: string; agentId: string; pending: number }>;
  /** 证据可信度：联网检索与引用的质量口径（与任务结果页同一套纯函数算出） */
  evidence: {
    searchCalls: number;
    searchMetadataOnly: number;
    /** 留下了可引用 URL 的检索次数（与 searchMetadataOnly 之和等于 searchCalls） */
    searchWithUrls: number;
    searchKept: number;
    searchDropped: number;
    /** 历史记录按现行相关度规则回算会被拦下的条数（过滤规则上线前的记录没有落库 dropped） */
    searchDroppedReplay: number;
    citations: number;
    officialCitations: number;
    weakCitations: number;
    /** weakCitations 中已在结论里声明「仅作背景参考，不作为政策依据」的条数，不算待处置欠账 */
    weakDisclaimed: number;
    /** weakCitations 中只在检索留存里、从未进入结论正文的条数，不算待处置欠账 */
    weakUncited: number;
    /** 弱证据引用中已检索到官方替代来源、只等人工写回结论的条数 */
    weakWithReplacement: number;
    /** 引用来源拆分：工具留存 / 结论正文（两者之和等于 citations） */
    citationsFromTools: number;
    citationsFromConclusion: number;
    docRefs: number;
    docRefTraced: number;
    /** 有出处的文号里靠联网复查取得的条数 */
    docRefTracedByRecheck: number;
    docRefPending: number;
    /** docRefPending 中已在结论里标注「未取得公开原文，仅作背景参考」的处数，不算待复查欠账 */
    docRefLabeled: number;
    docRefMatched: number;
    /** 仍有证据缺口的任务：存在弱证据引用或待复查文号 */
    gaps: Array<{
      id: string;
      title: string;
      agentId: string;
      weakCitations: number;
      weakDisclaimed: number;
      weakUncited: number;
      docRefPending: number;
      docRefLabeled: number;
    }>;
    /** 全平台证据核对台账：每任务一行，按欠账倒序，可直接导出 MD / CSV 归档 */
    ledger: import("./evidence-ledger.ts").LedgerRow[];
  };
  perAgent: Array<{
    agentId: string;
    tasks: number;
    completed: number;
    toolCalls: number;
    toolOk: number;
    artifacts: number;
  }>;
  perTool: Array<{ name: string; calls: number; ok: number }>;
}

export interface TaskIssue {
  id: string;
  source: string;
  issueType: string;
  description: string;
  evidence: string[];
  requiresReview: boolean;
}

export interface ReviewRecord {
  issueId: string;
  decision: "confirm" | "dismiss";
  comment: string;
  createdAt: string;
}
