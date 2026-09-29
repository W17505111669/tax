import fs from "node:fs";
import path from "node:path";
import { db } from "../db.ts";
import { dirs } from "../config.ts";
import { pendingReviewCount } from "./issues.ts";
import { filterSearchResults, minRelevanceScore, type WebSearchResult } from "@tax/business-tools";
// 证据口径必须与界面完全一致，因此直接复用前端那套纯函数，不在服务端另写一份
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  searchEvidence,
  searchFiltering,
} from "../../../web/src/search-evidence.ts";
import { gradeCitation, summarizeGrades } from "../../../web/src/citation-grade.ts";
import { traceDocRefs } from "../../../web/src/policy-trace.ts";
import { summarizeRefChecks, type RefCheckVerdict } from "../../../web/src/ref-check.ts";
import { refKey } from "../../../web/src/ref-check.ts";
import { traceAmounts, amountKey } from "../../../web/src/amount-trace.ts";
import { deltaVerdict, evidenceDelta, evidenceSnapshot } from "../../../web/src/revision-impact.ts";
import { ledgerSort, type LedgerRow } from "../../../web/src/evidence-ledger.ts";
import { listAmountChecks } from "./amount-checks.ts";
import { listConclusions } from "./task-store.ts";

export interface AgentStats {
  agentId: string;
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
}

/** 证据可信度：联网检索与引用的质量口径，全部来自真实运行记录 */
export interface EvidenceStats {
  /** 联网检索/读取类工具调用次数 */
  searchCalls: number;
  /** 其中只留下查询元数据、无法生成引用清单的次数 */
  searchMetadataOnly: number;
  /** 其中留下了可引用 URL 的次数（与 searchMetadataOnly 之和等于 searchCalls） */
  searchWithUrls: number;
  /** 检索留下并可引用的来源条数 */
  searchKept: number;
  /** 检索时被过滤掉的无关结果与门户首页条数 */
  searchDropped: number;
  /**
   * 历史检索记录按现行相关度规则回算会被拦下的条数。
   * 过滤规则上线前的记录没有落库 dropped，回算才能说明「同样的检索结果，现在会拦下多少」。
   */
  searchDroppedReplay: number;
  /** 联网引用总数与分级 */
  citations: number;
  officialCitations: number;
  weakCitations: number;
  /** 引用来源拆分：工具留存 / 结论正文（两者之和等于 citations） */
  citationsFromTools: number;
  citationsFromConclusion: number;
  /** 弱证据引用中已经检索到官方替代来源、只等人工写回结论的条数 */
  weakWithReplacement: number;
  /** 政策文号：总数 / 有出处（工具留存或联网复查）/ 仍无出处 / 复查判定 matched */
  docRefs: number;
  docRefTraced: number;
  /** 有出处的文号里，靠联网复查取得出处的条数（看板据此说明两个来源各占多少） */
  docRefTracedByRecheck: number;
  docRefPending: number;
  docRefMatched: number;
  /** 仍有证据缺口的任务（存在弱证据引用或待复查文号） */
  gaps: Array<{ id: string; title: string; agentId: string; weakCitations: number; docRefPending: number }>;
  /** 全平台证据核对台账：每任务一行，按欠账倒序，可直接导出归档 */
  ledger: LedgerRow[];
}

export interface PlatformStats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  /** 记录级比对的累计口径：每个任务只取最近一次记录级比对，再把 matched/compared 合计 */
  compareMatched: number;
  compareCompared: number;
  compareAccuracyOverall: number | null;
  /** 「最近一次」的判定依据：记录级比对的最晚开始时间 */
  compareLatestAt: string;
  ocrRuns: number;
  ocrAvgConfidence: number | null;
  perAgent: AgentStats[];
  perTool: Array<{ name: string; calls: number; ok: number }>;
  /** 全平台待复核问题总数（含 waiting_review 任务在内的未复核项） */
  reviewPendingIssues: number;
  /** 复核闭环缺口：已标记完成但仍有待复核问题的任务，可在复核页一键转为待复核 */
  reviewBacklog: Array<{ id: string; title: string; agentId: string; pending: number }>;
  /** 证据可信度缺口：弱证据引用与待复查文号，可在结果页一键复查或替换 */
  evidence: EvidenceStats;
}

/** 平台级应用效果统计：全部来自数据库真实运行记录。 */
export function computePlatformStats(): PlatformStats {
  const tasks = db.prepare(`SELECT id, agent_id, status, title, result, instruction FROM tasks`).all() as unknown as Array<{
    id: string;
    agent_id: string;
    status: string;
    title: string;
    result: string | null;
    instruction: string | null;
  }>;

  const perAgentMap = new Map<string, AgentStats>();
  const perToolMap = new Map<string, { name: string; calls: number; ok: number }>();
  let toolCalls = 0;
  let toolOk = 0;
  let artifacts = 0;
  let compareAccuracy: number | null = null;
  let compareRuns = 0;
  let compareLatestAt = "";
  let compareMatched = 0;
  let compareCompared = 0;
  let ocrConfSum = 0;
  let ocrRuns = 0;
  let reviewPendingIssues = 0;
  const reviewBacklog: Array<{ id: string; title: string; agentId: string; pending: number }> = [];
  // 台账行单独收集，返回时排序后并入
  const evidence: Omit<EvidenceStats, "ledger"> = {
    searchCalls: 0,
    searchMetadataOnly: 0,
    searchWithUrls: 0,
    searchKept: 0,
    searchDropped: 0,
    searchDroppedReplay: 0,
    citations: 0,
    officialCitations: 0,
    weakCitations: 0,
    citationsFromTools: 0,
    citationsFromConclusion: 0,
    weakWithReplacement: 0,
    docRefs: 0,
    docRefTraced: 0,
    docRefTracedByRecheck: 0,
    docRefPending: 0,
    docRefMatched: 0,
    gaps: [],
  };
  const ledger: LedgerRow[] = [];

  for (const task of tasks) {
    let agent = perAgentMap.get(task.agent_id);
    if (!agent) {
      agent = { agentId: task.agent_id, tasks: 0, completed: 0, toolCalls: 0, toolOk: 0, artifacts: 0 };
      perAgentMap.set(task.agent_id, agent);
    }
    agent.tasks += 1;
    if (task.status === "completed") agent.completed += 1;

    const calls = db
      .prepare(`SELECT ok, tool_name, result, started_at FROM tool_calls WHERE task_id = ?`)
      .all(task.id) as unknown as Array<{
      ok: number | null;
      tool_name: string;
      result: string | null;
      started_at: string | null;
    }>;
    agent.toolCalls += calls.length;
    toolCalls += calls.length;
    const okCount = calls.filter((c) => c.ok === 1).length;
    agent.toolOk += okCount;
    toolOk += okCount;
    // 记录级比对的累计口径按「每个任务最近一次」合计：同一任务反复比对时只有最近一次
    // 代表当前状态，把历史每一次都加进去会让一次失败的重复比对永久拉低准确率
    let taskCompareAt = "";
    let taskCompareFound = false;
    let taskCompared = 0;
    let taskMatched = 0;
    for (const call of calls) {
      let bucket = perToolMap.get(call.tool_name);
      if (!bucket) {
        bucket = { name: call.tool_name, calls: 0, ok: 0 };
        perToolMap.set(call.tool_name, bucket);
      }
      bucket.calls += 1;
      if (call.ok === 1) bucket.ok += 1;
    }

    const dir = path.join(dirs.outputs, task.id);
    if (fs.existsSync(dir)) {
      const n = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length;
      agent.artifacts += n;
      artifacts += n;
    }

    // 复核闭环：待复核问题数走缓存（签名失效），列表与统计共用同一口径
    const pending = pendingReviewCount(task.id);
    reviewPendingIssues += pending;
    if (task.status === "completed" && pending > 0) {
      reviewBacklog.push({
        id: task.id,
        title: String(task.title ?? task.id),
        agentId: task.agent_id,
        pending,
      });
    }

    // 证据可信度：引用分级 + 检索过滤 + 文号复查，口径与任务结果页完全一致
    const parsedCalls = calls.map((c) => {
      let result: unknown = null;
      try {
        result = c.result ? JSON.parse(c.result) : null;
      } catch {
        result = null;
      }
      return { toolName: c.tool_name, result };
    });
    // 引用清单与任务结果页同口径：工具留存 + 结论正文里直接引用的地址
    const cites = mergeCitations(extractCitations(parsedCalls), extractTextCitations(String(task.result ?? "")));
    const grades = summarizeGrades(cites);
    const se = searchEvidence(parsedCalls);
    const sf = searchFiltering(parsedCalls);
    // 旧记录（没有落库 dropped）按现行规则回算一遍，新记录直接用落库值，避免重复计数
    for (const c of parsedCalls) {
      if (c.toolName !== "search_public_cases") continue;
      const r = c.result as { query?: string; results?: WebSearchResult[]; dropped?: number } | null;
      if (!r || typeof r.query !== "string" || !Array.isArray(r.results)) continue;
      if (typeof r.dropped === "number") continue;
      evidence.searchDroppedReplay += filterSearchResults(r.query, r.results, minRelevanceScore()).dropped.length;
    }
    const okResults = calls
      .filter((c) => c.ok !== 0)
      .map((c) => {
        try {
          return c.result ? JSON.parse(c.result) : null;
        } catch {
          return null;
        }
      });
    const rcRows = db
      .prepare(`SELECT ref_key, kind, text, verdict, checked_at FROM ref_checks WHERE task_id = ?`)
      .all(task.id) as unknown as Array<{
      ref_key: string;
      kind: string;
      text: string;
      verdict: string;
      checked_at: string;
    }>;
    // 复查判定为「找到公开出处」的文号原文：与工具留存结果同等算作有出处
    const recheckedDocRefs = rcRows.filter((r) => r.kind === "docref" && r.verdict === "matched").map((r) => r.text);
    const tr = traceDocRefs(
      String(task.result ?? ""),
      okResults,
      calls.map((c) => c.tool_name),
      recheckedDocRefs,
    );
    const rc = summarizeRefChecks(
      rcRows
        .filter((r) => r.kind !== "citation")
        .map((r) => ({ verdict: r.verdict as RefCheckVerdict, checkedAt: r.checked_at })),
    );
    // 已经找到官方替代来源的弱证据引用：结论没改之前它仍然是弱证据，但要让看板看得出「补救已就绪」
    const replaced = new Set(
      rcRows.filter((r) => r.kind === "citation" && r.verdict === "matched").map((r) => r.ref_key),
    );
    // 待复查就是「仍然没有出处」的那些：复查到出处的已经计入 traced，不再从这里扣一遍
    // 没有结论就没有可交付物。结论里的文号与金额本来就都是 0，但引用是从工具留存结果提取的，
    // 失败任务照样会算出一堆「弱证据引用」（实测 060b4eea「映射模式填列验证」status=failed、
    // result 为空，却带着 5 条引用、4 条弱证据进了台账与缺口清单）。这些引用从未进入任何结论，
    // 既不该算证据欠账，也不该占批量复查预算——没有结论就没有主题，替代来源永远判不出 matched。
    // 检索活动本身照实计入：那是真实发生过的调用，与有没有结论无关。
    const hasConclusion = String(task.result ?? "").trim() !== "";
    const docRefPending = tr.untraced.length + tr.unverifiable;
    evidence.searchCalls += se.calls;
    evidence.searchMetadataOnly += se.metadataOnly;
    evidence.searchWithUrls += se.withUrls;
    evidence.searchKept += sf.kept;
    evidence.searchDropped += sf.dropped;
    if (hasConclusion) {
      evidence.citations += grades.total;
      evidence.officialCitations += grades.official;
      evidence.weakCitations += grades.weak;
      evidence.citationsFromTools += cites.filter((c) => c.via !== "conclusion").length;
      evidence.citationsFromConclusion += cites.filter((c) => c.via === "conclusion").length;
    }
    const replacedCount = cites.filter(
      (c) => gradeCitation(c.url, c.title).grade === "weak" && replaced.has(refKey("citation", c.url)),
    ).length;
    evidence.weakWithReplacement += hasConclusion ? replacedCount : 0;
    evidence.docRefs += tr.total;
    evidence.docRefTraced += tr.traced;
    evidence.docRefTracedByRecheck += tr.tracedByRecheck;
    evidence.docRefPending += docRefPending;
    evidence.docRefMatched += rc.matched;
    if (hasConclusion && (grades.weak > 0 || docRefPending > 0)) {
      evidence.gaps.push({
        id: task.id,
        title: String(task.title ?? task.id),
        agentId: task.agent_id,
        weakCitations: grades.weak,
        docRefPending,
      });
    }

    // 台账行：金额与修订影响在这里一并算，导出时不必再走一遍全库
    const acked = new Set(listAmountChecks(task.id).map((c) => c.key));
    const amounts = traceAmounts(
      String(task.result ?? ""),
      parsedCalls.map((c) => c.result),
      String(task.instruction ?? ""),
    );
    const amountPending = amounts.untraced.filter((u) => !acked.has(amountKey(u))).length;
    const conclusions = listConclusions(task.id);
    const revision =
      conclusions.length >= 2
        ? deltaVerdict(
            evidenceDelta(
              evidenceSnapshot(conclusions[conclusions.length - 2]!),
              evidenceSnapshot(conclusions[conclusions.length - 1]!),
            ),
          )
        : null;
    ledger.push({
      taskId: task.id,
      title: String(task.title ?? task.id),
      agentId: task.agent_id,
      status: task.status,
      docRefTotal: tr.total,
      docRefTraced: tr.traced,
      docRefPending,
      docRefMatched: rc.matched,
      docRefTracedByRecheck: tr.tracedByRecheck,
      // 与上面的累加同一口径：没有结论的任务不计引用，台账欠账（弱证据 + 待复查）因此为 0，
      // 不会和缺口清单相互矛盾（两者的一致性是 verify:ledger 的断言项）
      citations: hasConclusion ? grades.total : 0,
      official: hasConclusion ? grades.official : 0,
      weak: hasConclusion ? grades.weak : 0,
      replaced: hasConclusion ? replacedCount : 0,
      searchCalls: se.calls,
      searchMetadataOnly: se.metadataOnly,
      searchDropped: sf.dropped,
      amountTotal: amounts.total,
      amountPending,
      revision,
    });

    for (const call of calls) {
      if (call.tool_name === "parse_uploaded_files" && call.ok === 1 && call.result) {
        try {
          const parsed = JSON.parse(call.result) as { parsed?: Array<{ ocrConfidence?: number }> };
          for (const doc of parsed.parsed ?? []) {
            if (typeof doc.ocrConfidence === "number") {
              ocrRuns += 1;
              ocrConfSum += doc.ocrConfidence;
            }
          }
        } catch {
          // 忽略坏记录
        }
      }
      if (call.tool_name !== "compare_workpapers" || call.ok !== 1 || !call.result) continue;
      try {
        const parsed = JSON.parse(call.result) as {
          sheets?: Array<{ mode?: string }>;
          totals?: { accuracyPercent?: number; compared?: number; matched?: number };
        };
        if (parsed.sheets?.[0]?.mode === "record" && parsed.totals?.accuracyPercent !== undefined) {
          compareRuns += 1;
          // 「最近一次」按调用开始时间判定，与任务在表中的顺序无关
          const at = String(call.started_at ?? "");
          if (at >= compareLatestAt) {
            compareLatestAt = at;
            compareAccuracy = parsed.totals.accuracyPercent;
          }
          if (!taskCompareFound || at >= taskCompareAt) {
            taskCompareFound = true;
            taskCompareAt = at;
            taskCompared = typeof parsed.totals.compared === "number" ? parsed.totals.compared : 0;
            taskMatched = typeof parsed.totals.matched === "number" ? parsed.totals.matched : 0;
          }
        }
      } catch {
        // 忽略坏记录
      }
    }
    if (taskCompareFound) {
      compareCompared += taskCompared;
      compareMatched += taskMatched;
    }
  }

  return {
    tasks: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    toolCalls,
    toolOk,
    artifacts,
    compareAccuracy,
    compareRuns,
    compareMatched,
    compareCompared,
    compareAccuracyOverall:
      compareCompared > 0 ? Math.round((compareMatched / compareCompared) * 10000) / 100 : null,
    compareLatestAt,
    ocrRuns,
    ocrAvgConfidence: ocrRuns > 0 ? Math.round((ocrConfSum / ocrRuns) * 100) / 100 : null,
    perAgent: [...perAgentMap.values()],
    perTool: [...perToolMap.values()].sort((a, b) => b.calls - a.calls),
    reviewPendingIssues,
    reviewBacklog: reviewBacklog.sort((a, b) => b.pending - a.pending),
    evidence: {
      ...evidence,
      gaps: evidence.gaps.sort((a, b) => b.weakCitations + b.docRefPending - (a.weakCitations + a.docRefPending)),
      ledger: ledgerSort(ledger),
    },
  };
}
