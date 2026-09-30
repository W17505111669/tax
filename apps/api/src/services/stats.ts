import fs from "node:fs";
import path from "node:path";
import { db } from "../db.ts";
import { dirs } from "../config.ts";
import { pendingReviewCount, pendingReviewIssues } from "./issues.ts";
import { groupPendingIssues, type PendingIssueRow } from "../../../web/src/review-queue.ts";
import { filterSearchResults, minRelevanceScore, type WebSearchResult } from "@tax/business-tools";
import { compareRates } from "@tax/document-tools";
// 证据口径必须与界面完全一致，因此直接复用前端那套纯函数，不在服务端另写一份
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  searchEvidence,
  searchFiltering,
  UNCAPPED,
} from "../../../web/src/search-evidence.ts";
import { gradeCitation, summarizeGrades } from "../../../web/src/citation-grade.ts";
import { traceDocRefs } from "../../../web/src/policy-trace.ts";
import {
  disclaimedWeakUrls,
  labeledDocRefTexts,
  summarizeRefChecks,
  uncitedWeakUrls,
  type RefCheckVerdict,
} from "../../../web/src/ref-check.ts";
import { refKey } from "../../../web/src/ref-check.ts";
import { traceAmounts, amountKey, TEXT_AMOUNT_TOOLS } from "../../../web/src/amount-trace.ts";
import { deltaVerdict, evidenceDelta, evidenceSnapshot } from "../../../web/src/revision-impact.ts";
import { ledgerSort, type LedgerRow } from "../../../web/src/evidence-ledger.ts";
import { listAmountChecks } from "./amount-checks.ts";
import { aggregatePeerCompares, summarizeTaskCompares, type PeerCompare } from "./compare-stats.ts";
import { listConclusions } from "./task-store.ts";

/** 落库记录里的计数可能缺字段（比率拆分上线前的旧记录），一律按 0 处理，不让 undefined 参与运算 */
function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface AgentStats {
  agentId: string;
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  /** ok=0：工具确实返回了错误 */
  toolFailed: number;
  /** ok IS NULL：调用发起了但从未返回（服务重启打断），既不是成功也不是失败 */
  toolUnfinished: number;
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
  /** weakCitations 中已在结论里声明「仅作背景参考，不作为政策依据」的条数：交代过就不算欠账 */
  weakDisclaimed: number;
  /** weakCitations 中只在检索留存里、从未进入结论正文的条数：不是交付依据，也不算欠账 */
  weakUncited: number;
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
  /** docRefPending 中已在结论里标注「未取得公开原文，仅作背景参考」的处数：标注过就不算欠账 */
  docRefLabeled: number;
  docRefMatched: number;
  /** 仍有证据缺口的任务（存在待处置的弱证据引用或待复查文号；已声明为背景参考的、未进结论正文的不算） */
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
  /** 全平台证据核对台账：每任务一行，按欠账倒序，可直接导出归档 */
  ledger: LedgerRow[];
}

export interface PlatformStats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  /** ok=0：工具确实返回了错误 */
  toolFailed: number;
  /**
   * ok IS NULL：调用行在工具发起时落了库，但 result 与 ended_at 都是空——进程在工具返回前就没了。
   * 实测 37 次全是这一类，且集中在联网类慢工具上（get_search_content 15 · fetch_public_document 9 ·
   * search_public_cases 6），慢调用最容易被重启撞个正着。这批孤儿行来自早先被打断的那一轮，任务
   * 往往在后续某一轮跑完了，状态上看不出中断。此前被 `toolCalls - toolOk` 一律算成「失败」，把
   * 「没有结果」和「结果是错误」混成一个数：成功率被低估（86.3% 对 100%），性质也标错了。
   * 口径见 web/src/tool-outcome.ts，任务页的 callStats 一直是三态，平台侧此前没接上。
   */
  toolUnfinished: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  /** 记录级比对的累计口径：每个任务只取最近一次记录级比对，再把 matched/compared 合计 */
  compareMatched: number;
  compareCompared: number;
  compareAccuracyOverall: number | null;
  /** 累计口径的构成：填错与「只有一侧有」分开摆，免得一个准确率把两类问题互相掩盖 */
  compareMismatched: number;
  compareOnlyA: number;
  compareOnlyB: number;
  /**
   * 「填列产物 vs 它自己的原始模板」这类比对的次数。模板本来是空的，只有一侧有的格子正是填进去的
   * 值，把它算成覆盖缺口就等于把「填了多少」记成「漏了多少」（实测 ff4c9a3c 一次比对贡献了全平台
   * 12 处 onlyA，累计覆盖率因此从 100% 掉到 36.84%）。按产物溯源识别，单独统计、不进一致率与覆盖率。
   */
  compareTemplateRuns: number;
  /** 这类比对里只在填列产物一侧出现的单元格数，也就是本次填列新增的值 */
  compareFilledCells: number;
  /** 这类比对里与模板既有内容不一致的单元格数：填列改坏了模板原有内容才算问题 */
  compareTemplateMismatched: number;
  /** 累计一致率 = 一致 /（一致 + 填错）：只看两边都有的项，回答「填得对不对」 */
  compareMatchRateOverall: number | null;
  /** 累计覆盖率 = 一致 /（一致 + 仅人工底稿有）：回答「人工底稿有的项自动填到了多少」 */
  compareCoverageOverall: number | null;
  /** 最近一次记录级比对的一致率与覆盖率（旧记录没有这两个字段时按现行规则回算） */
  compareMatchRate: number | null;
  compareCoverage: number | null;
  /** 「最近一次」的判定依据：记录级比对的最晚开始时间 */
  compareLatestAt: string;
  ocrRuns: number;
  ocrAvgConfidence: number | null;
  perAgent: AgentStats[];
  perTool: Array<{ name: string; calls: number; ok: number }>;
  /** 全平台待复核问题总数（含 waiting_review 任务在内的未复核项） */
  reviewPendingIssues: number;
  /**
   * 待复核问题按「类型 + 描述原文」跨任务分组，出现次数多的在前。
   * 同一件事在多个任务里各出现一次时，复核的人一次看清、一次处置，不必逐任务点六遍「全部确认」。
   */
  reviewGroups: import("../../../web/src/review-queue.ts").IssueGroup[];
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
  let toolFailed = 0;
  let toolUnfinished = 0;
  let artifacts = 0;
  let compareAccuracy: number | null = null;
  let compareRuns = 0;
  let compareLatestAt = "";
  // 每个任务最近一次「同行评审」比对（与人工参考底稿比），跨任务合计；与自己的原始模板核对另算
  const taskPeers: PeerCompare[] = [];
  let compareMatched = 0;
  let compareCompared = 0;
  let compareMismatched = 0;
  let compareOnlyA = 0;
  let compareOnlyB = 0;
  let compareTemplateRuns = 0;
  let compareFilledCells = 0;
  let compareTemplateMismatched = 0;
  let compareMatchRate: number | null = null;
  let compareCoverage: number | null = null;
  let ocrConfSum = 0;
  let ocrRuns = 0;
  let reviewPendingIssues = 0;
  const reviewBacklog: Array<{ id: string; title: string; agentId: string; pending: number }> = [];
  const reviewRows: PendingIssueRow[] = [];
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
    weakDisclaimed: 0,
    weakUncited: 0,
    citationsFromTools: 0,
    citationsFromConclusion: 0,
    weakWithReplacement: 0,
    docRefs: 0,
    docRefTraced: 0,
    docRefTracedByRecheck: 0,
    docRefPending: 0,
    docRefLabeled: 0,
    docRefMatched: 0,
    gaps: [],
  };
  const ledger: LedgerRow[] = [];

  for (const task of tasks) {
    let agent = perAgentMap.get(task.agent_id);
    if (!agent) {
      agent = {
        agentId: task.agent_id,
        tasks: 0,
        completed: 0,
        toolCalls: 0,
        toolOk: 0,
        toolFailed: 0,
        toolUnfinished: 0,
        artifacts: 0,
      };
      perAgentMap.set(task.agent_id, agent);
    }
    agent.tasks += 1;
    if (task.status === "completed") agent.completed += 1;

    const calls = db
      .prepare(`SELECT ok, tool_name, args, result, started_at FROM tool_calls WHERE task_id = ?`)
      .all(task.id) as unknown as Array<{
      ok: number | null;
      tool_name: string;
      args: string | null;
      result: string | null;
      started_at: string | null;
    }>;
    agent.toolCalls += calls.length;
    toolCalls += calls.length;
    const okCount = calls.filter((c) => c.ok === 1).length;
    const failedCount = calls.filter((c) => c.ok === 0).length;
    // 三态互斥且穷尽：ok=1 成功、ok=0 失败、ok IS NULL 未返回。不能用 calls.length - okCount 当失败数
    const unfinishedCount = calls.length - okCount - failedCount;
    agent.toolOk += okCount;
    agent.toolFailed += failedCount;
    agent.toolUnfinished += unfinishedCount;
    toolOk += okCount;
    toolFailed += failedCount;
    toolUnfinished += unfinishedCount;
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
    if (pending > 0) {
      for (const i of pendingReviewIssues(task.id)) {
        reviewRows.push({
          taskId: task.id,
          taskTitle: String(task.title ?? task.id),
          agentId: task.agent_id,
          issueId: i.id,
          issueType: i.issueType,
          description: i.description,
        });
      }
    }
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
    // 引用清单与任务结果页同口径：工具留存 + 结论正文里直接引用的地址。
    // 统计按全量算，不套用界面清单上限——上限是胶囊列表的显示需要，度量跟着截断的话，
    // 结论一变长窗口就整体挪动，官方与弱证据条数会凭空涨跌（实测有过真加了 2 条官方原文
    // 却被算成 official 11 → 10、判为「证据质量退步」）。界面另有一份截断清单并注明总条数。
    const cites = mergeCitations(
      extractCitations(parsedCalls, UNCAPPED),
      extractTextCitations(String(task.result ?? ""), UNCAPPED),
      UNCAPPED,
    );
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
    const resultText = String(task.result ?? "");
    const docRefPending = tr.untraced.length + tr.unverifiable;
    // 已在结论里标注「未取得公开原文，仅作背景参考，不作为政策依据」的文号不算欠账：查不到公开原文
    // 时设计好的收口就是如实标注，标注完还算待复查，认真照做的任务就永远出不了缺口清单
    //（实测 aabd138a 三处已全部标注，缺口清单仍挂着它）。判据与弱证据侧共用 isDisclaimedInConclusion
    const pendingRefs = [...tr.untraced, ...tr.unverifiableRefs];
    const labeledTexts = labeledDocRefTexts(pendingRefs, resultText);
    const docRefLabeled = pendingRefs.filter((r) => labeledTexts.has(r.text)).length;
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
    // 两类弱证据不算欠账，都得回读正文才判得出来（分级只看地址与标题）：已在结论里交代过「不作为
    // 政策依据」的，以及只在检索留存里、从未进入结论正文的。与任务结果页、交付自检、台账、批量复查
    // 候选清单共用同一份实现，避免各处口径漂移。uncited 要扣掉与 disclaimed 重叠的部分，三个数才
    // 刚好加回弱证据总数（按标题认出的交代，地址可能并不在正文里）
    const disclaimedUrls = hasConclusion ? disclaimedWeakUrls(cites, resultText) : new Set<string>();
    const disclaimedCount = disclaimedUrls.size;
    const uncitedCount = hasConclusion
      ? [...uncitedWeakUrls(cites, resultText)].filter((u) => !disclaimedUrls.has(u)).length
      : 0;
    evidence.weakWithReplacement += hasConclusion ? replacedCount : 0;
    evidence.weakDisclaimed += disclaimedCount;
    evidence.weakUncited += uncitedCount;
    evidence.docRefs += tr.total;
    evidence.docRefTraced += tr.traced;
    evidence.docRefTracedByRecheck += tr.tracedByRecheck;
    evidence.docRefPending += docRefPending;
    evidence.docRefLabeled += docRefLabeled;
    evidence.docRefMatched += rc.matched;
    if (
      hasConclusion &&
      (grades.weak - disclaimedCount - uncitedCount > 0 || docRefPending - docRefLabeled > 0)
    ) {
      evidence.gaps.push({
        id: task.id,
        title: String(task.title ?? task.id),
        agentId: task.agent_id,
        weakCitations: grades.weak,
        weakDisclaimed: disclaimedCount,
        weakUncited: uncitedCount,
        docRefPending,
        docRefLabeled,
      });
    }

    // 台账行：金额与修订影响在这里一并算，导出时不必再走一遍全库
    const acked = new Set(listAmountChecks(task.id).map((c) => c.key));
    const amounts = traceAmounts(
      String(task.result ?? ""),
      parsedCalls.map((c) => c.result),
      String(task.instruction ?? ""),
      // OCR / 文档解析的结果里，金额藏在识别出的正文字符串里，只按 JSON 数值收会一条也收不到
      parsedCalls.filter((c) => TEXT_AMOUNT_TOOLS.has(c.toolName)).map((c) => c.result),
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
      docRefLabeled,
      docRefMatched: rc.matched,
      docRefTracedByRecheck: tr.tracedByRecheck,
      // 与上面的累加同一口径：没有结论的任务不计引用，台账欠账（弱证据 + 待复查）因此为 0，
      // 不会和缺口清单相互矛盾（两者的一致性是 verify:ledger 的断言项）
      citations: hasConclusion ? grades.total : 0,
      official: hasConclusion ? grades.official : 0,
      weak: hasConclusion ? grades.weak : 0,
      replaced: hasConclusion ? replacedCount : 0,
      weakDisclaimed: disclaimedCount,
      weakUncited: uncitedCount,
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
    }
    // 记录级比对：口径与作品说明、测试报告共用 compare-stats.ts 那一份实现。
    // 累计口径按「每个任务最近一次」合计：同一任务反复比对时只有最近一次代表当前状态，
    // 把历史每一次都加进去会让一次失败的重复比对永久拉低准确率
    const cmp = summarizeTaskCompares(calls);
    compareRuns += cmp.peerRuns;
    compareTemplateRuns += cmp.template.runs;
    compareFilledCells += cmp.template.filledCells;
    compareTemplateMismatched += cmp.template.mismatched;
    if (cmp.peer !== null) {
      taskPeers.push(cmp.peer);
      if (cmp.peer.at >= compareLatestAt) {
        compareLatestAt = cmp.peer.at;
        compareAccuracy = cmp.peer.accuracyPercent;
        // 比率一律用原始计数现算，不读记录里的字段：旧记录没有这两个字段，
        // 而「过滤规则上线前的历史记录按现行规则回算」是本看板既定的口径
        const latest = compareRates(cmp.peer.matched, cmp.peer.mismatched, cmp.peer.onlyA);
        compareMatchRate = latest.matchRatePercent;
        compareCoverage = latest.coveragePercent;
      }
    }
  }

  const peerAgg = aggregatePeerCompares(taskPeers);
  compareCompared = peerAgg.compared;
  compareMatched = peerAgg.matched;
  compareMismatched = peerAgg.mismatched;
  compareOnlyA = peerAgg.onlyA;
  compareOnlyB = peerAgg.onlyB;
  const overallRates = compareRates(compareMatched, compareMismatched, compareOnlyA);
  return {
    tasks: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    toolCalls,
    toolOk,
    toolFailed,
    toolUnfinished,
    artifacts,
    compareAccuracy,
    compareRuns,
    compareMatched,
    compareCompared,
    compareAccuracyOverall:
      compareCompared > 0 ? Math.round((compareMatched / compareCompared) * 10000) / 100 : null,
    compareMismatched,
    compareOnlyA,
    compareOnlyB,
    compareTemplateRuns,
    compareFilledCells,
    compareTemplateMismatched,
    compareMatchRateOverall: overallRates.matchRatePercent,
    compareCoverageOverall: overallRates.coveragePercent,
    compareMatchRate,
    compareCoverage,
    compareLatestAt,
    ocrRuns,
    ocrAvgConfidence: ocrRuns > 0 ? Math.round((ocrConfSum / ocrRuns) * 100) / 100 : null,
    perAgent: [...perAgentMap.values()],
    perTool: [...perToolMap.values()].sort((a, b) => b.calls - a.calls),
    reviewPendingIssues,
    reviewGroups: groupPendingIssues(reviewRows),
    reviewBacklog: reviewBacklog.sort((a, b) => b.pending - a.pending),
    evidence: {
      ...evidence,
      gaps: evidence.gaps.sort((a, b) => b.weakCitations + b.docRefPending - (a.weakCitations + a.docRefPending)),
      ledger: ledgerSort(ledger),
    },
  };
}
