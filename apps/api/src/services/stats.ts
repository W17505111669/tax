import fs from "node:fs";
import path from "node:path";
import { db } from "../db.ts";
import { dirs } from "../config.ts";
import { pendingReviewCount } from "./issues.ts";
import { filterSearchResults, minRelevanceScore, type WebSearchResult } from "@tax/business-tools";
// 证据口径必须与界面完全一致，因此直接复用前端那套纯函数，不在服务端另写一份
import { extractCitations, searchEvidence, searchFiltering } from "../../../web/src/search-evidence.ts";
import { summarizeGrades } from "../../../web/src/citation-grade.ts";
import { traceDocRefs } from "../../../web/src/policy-trace.ts";
import { pendingAfterRecheck, summarizeRefChecks, type RefCheckVerdict } from "../../../web/src/ref-check.ts";

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
  /** 政策文号：总数 / 工具结果可溯源 / 复查后仍无出处 / 已复查到公开出处 */
  docRefs: number;
  docRefTraced: number;
  docRefPending: number;
  docRefMatched: number;
  /** 仍有证据缺口的任务（存在弱证据引用或待复查文号） */
  gaps: Array<{ id: string; title: string; agentId: string; weakCitations: number; docRefPending: number }>;
}

export interface PlatformStats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  /** 记录级比对的累计口径：全部记录级比对的 matched/compared 合计与百分比 */
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
  const tasks = db.prepare(`SELECT id, agent_id, status, title, result FROM tasks`).all() as unknown as Array<{
    id: string;
    agent_id: string;
    status: string;
    title: string;
    result: string | null;
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
  const evidence: EvidenceStats = {
    searchCalls: 0,
    searchMetadataOnly: 0,
    searchWithUrls: 0,
    searchKept: 0,
    searchDropped: 0,
    searchDroppedReplay: 0,
    citations: 0,
    officialCitations: 0,
    weakCitations: 0,
    docRefs: 0,
    docRefTraced: 0,
    docRefPending: 0,
    docRefMatched: 0,
    gaps: [],
  };

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
    const cites = extractCitations(parsedCalls);
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
    const tr = traceDocRefs(String(task.result ?? ""), okResults, calls.map((c) => c.tool_name));
    const rcRows = db
      .prepare(`SELECT verdict, checked_at FROM ref_checks WHERE task_id = ?`)
      .all(task.id) as unknown as Array<{ verdict: string; checked_at: string }>;
    const rc = summarizeRefChecks(
      rcRows.map((r) => ({ verdict: r.verdict as RefCheckVerdict, checkedAt: r.checked_at })),
    );
    const docRefPending = pendingAfterRecheck(tr.untraced.length + tr.unverifiable, rc);
    evidence.searchCalls += se.calls;
    evidence.searchMetadataOnly += se.metadataOnly;
    evidence.searchWithUrls += se.withUrls;
    evidence.searchKept += sf.kept;
    evidence.searchDropped += sf.dropped;
    evidence.citations += grades.total;
    evidence.officialCitations += grades.official;
    evidence.weakCitations += grades.weak;
    evidence.docRefs += tr.total;
    evidence.docRefTraced += tr.traced;
    evidence.docRefPending += docRefPending;
    evidence.docRefMatched += rc.matched;
    if (grades.weak > 0 || docRefPending > 0) {
      evidence.gaps.push({
        id: task.id,
        title: String(task.title ?? task.id),
        agentId: task.agent_id,
        weakCitations: grades.weak,
        docRefPending,
      });
    }

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
          compareCompared += typeof parsed.totals.compared === "number" ? parsed.totals.compared : 0;
          compareMatched += typeof parsed.totals.matched === "number" ? parsed.totals.matched : 0;
        }
      } catch {
        // 忽略坏记录
      }
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
    },
  };
}
