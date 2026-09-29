/**
 * 政策文号联网复查：把「无法从留存数据核验」的文号用自建检索通道再查一遍，
 * 判定结果按条落库（刷新不丢、可进交付包与整页 MD）。
 *
 * 判定口径不在这里重写：服务端只负责发请求与存取，四级判定与检索词构造共用
 * apps/web/src/ref-check.ts 的纯函数，与前端界面、验证脚本同一份实现。
 */
import {
  describeAttempts,
  isLibraryDocUrl,
  matchPolicyDocNum,
  searchPolicyLibrary,
  searchWebDetailed,
  type DetailedSearch,
  type PolicyLibraryResult,
  type SearchAttempt,
} from "@tax/business-tools";
import { db, nowIso } from "../db.ts";
import { gradeCitation } from "../../../web/src/citation-grade.ts";
import {
  buildRefQuery,
  citationTargets,
  evidenceCanReplace,
  gradeRefCheck,
  keptBetterNote,
  matchedStillValid,
  preservedNote,
  refPrefix,
  refKey,
  refCheckTargets,
  refQueryVariants,
  reusableDocNum,
  shouldOverwrite,
  unresolvedTargets,
  type RefCheckEvidence,
  type RefCheckKind,
  type RefCheckResult,
  type RefCheckTarget,
  type RefCheckVerdict,
} from "../../../web/src/ref-check.ts";
import { extractDocRefs, normalizeRef, traceDocRefs } from "../../../web/src/policy-trace.ts";
import { extractCitations } from "../../../web/src/search-evidence.ts";
import { topicHint } from "../../../web/src/domain-keywords.ts";
import { getTask } from "./task-store.ts";

/** 检索实现可注入，验证脚本用假检索器离线跑通全链路 */
export type Searcher = (query: string, signal?: AbortSignal) => Promise<DetailedSearch>;

/** 政策法规库检索实现同样可注入，验证脚本用假数据离线跑通「精确命中」与「未命中退回」两条路径 */
export type PolicySearcher = (query: string, signal?: AbortSignal) => Promise<PolicyLibraryResult>;

/**
 * 文号在官方政策法规库里的检索词，同时用作发文字号匹配基准：发文机关 + 文号（紧凑写法）。
 * 机关取自结论上下文；上下文里没有机关时返回空串，这一路直接跳过——
 * 机关不明就不该猜是哪一份文件，光杆「2022年第28号」在库里有成千上万条同名词条。
 */
export function policyDocNumQuery(t: RefCheckTarget): string {
  if (t.kind !== "docref") return "";
  const prefix = refPrefix(t.context ?? "", t.text);
  if (prefix === "") return "";
  return `${prefix}${t.text.replace(/\s+/g, "")}`.trim();
}
export interface RefCheckRecord {
  key: string;
  kind: RefCheckKind;
  text: string;
  query: string;
  verdict: RefCheckVerdict;
  note: string;
  evidence: RefCheckEvidence | null;
  /** 复查对象的原始地址：引用类复查必填（主键按它算），文号类为空串 */
  subjectUrl: string;
  attempts: SearchAttempt[];
  checkedAt: string;
}

/** 单次复查条数上限：联网检索是慢操作，一次点按最多处理这么多条 */
export const MAX_REF_CHECKS = 10;

/** 单条检索超时（毫秒）：RSS 通道实测数百毫秒，给足冗余但不让界面长时间挂住 */
export const REF_CHECK_TIMEOUT_MS = 12000;

/** 批量复查的默认预算与硬上限：联网检索是慢操作，一次点按不能无限制地跑下去 */
export const BATCH_REF_BUDGET = 12;
export const BATCH_REF_MAX = 30;

/**
 * 某任务当前待复查的文号（与结果页复查面板同一口径：待人工确认 + 无法从留存数据核验）。
 * 服务端独立算一遍，批量入口不依赖前端传清单。
 */
export function pendingRefTargets(taskId: string): RefCheckTarget[] {
  const text = getTask(taskId)?.result ?? "";
  if (!text.trim()) return [];
  const rows = db
    .prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`)
    .all(taskId) as unknown as Array<{ tool_name: string; result: string | null; ok: number | null }>;
  const parsed = rows
    .filter((r) => r.ok !== 0)
    .map((r) => {
      try {
        return r.result ? JSON.parse(r.result) : null;
      } catch {
        return null;
      }
    });
  const checks = listRefChecks(taskId);
  // 复查判定为「找到公开出处」的文号已经算有出处，既不进待复查清单，也不占批量预算
  const rechecked = checks.filter((c) => c.kind === "docref" && c.verdict === "matched").map((c) => c.text);
  return unresolvedTargets(
    // 主题词兜底：与引用复查同一套 topicHint，供上下文里没有发文机关的文号使用
    refCheckTargets(traceDocRefs(text, parsed, rows.map((r) => r.tool_name), rechecked), topicHint(text, 2)),
    checks,
    (c) => matchedStillValid(c.kind ?? "docref", c.evidence, gradeCitation),
  );
}

/**
 * 证据升级候选：已 matched 但证据不是官方站点的文号。
 *
 * 政策法规库接入后这些记录有机会换成官方原文页——实测库里 23 条 matched 的文号证据中，
 * 13 条来自 shui5.cn、ohmi.net.cn 一类商业或第三方站点，只有 10 条是官方。
 * 批量复查把未解决项排在前面、升级项排在最后：预算先补欠账，有余力再提升已有证据的质量。
 *
 * 只放行能构造出完整发文字号的（上下文里有发文机关）——机关不明就不该猜是哪一份文件。
 * 升级失败也不会丢证据：saveRefCheck 的不降级护栏与证据力闸门都会保留原记录，并把这次尝试追加进留痕。
 */
export function upgradeRefTargets(taskId: string): RefCheckTarget[] {
  const text = getTask(taskId)?.result ?? "";
  if (!text.trim()) return [];
  const stale = new Set(
    listRefChecks(taskId)
      .filter(
        (c) =>
          c.kind === "docref" &&
          c.verdict === "matched" &&
          c.evidence !== null &&
          gradeCitation(c.evidence.url, c.evidence.title).grade !== "official",
      )
      .map((c) => c.key),
  );
  if (stale.size === 0) return [];
  const hint = topicHint(text, 2);
  return extractDocRefs(text)
    .map((r) => ({
      key: refKey("docref", r.text),
      kind: "docref" as const,
      text: r.text,
      context: r.context,
      hint,
    }))
    .filter((t) => stale.has(t.key) && policyDocNumQuery(t) !== "");
}

/** 索引值：可直接复用的官方原文证据，以及它最初是在哪个任务里核实到的 */
export type VerifiedOfficialDoc = { evidence: RefCheckEvidence; taskId: string };

/**
 * 全平台已核实的官方原文索引：完整发文字号（归一化）→ 证据。
 *
 * 同一份政策文件会被多个任务引用，而检索接口很慢（实测单次响应可达 7 秒以上）且全文排序有波动：
 * 《财政部 税务总局 科技部公告2022年第28号》确实在库里，用完整字号查却排不上来。已经精确命中并
 * 落库为官方原文的记录，本身就是一份核实过的事实，跨任务复用比每次重新检索更准也更省。
 *
 * 只收「文号类 + matched + 按当前分级规则仍是官方站点 + 能取出完整发文字号」的记录；
 * 复用键是带机关的完整字号，因此机关不明的光杆文号永远查不到，不会猜。
 */
export function verifiedOfficialDocs(): Map<string, VerifiedOfficialDoc> {
  const rows = db
    .prepare(
      `SELECT task_id, kind, text, query, verdict, evidence_title, evidence_url, evidence_grade, evidence_snippet
         FROM ref_checks`,
    )
    .all() as unknown as Array<{
  task_id: string;
  kind: string;
  text: string;
  query: string | null;
  verdict: string;
    evidence_title: string | null;
    evidence_url: string | null;
    evidence_grade: string | null;
    evidence_snippet: string | null;
  }>;
  const out = new Map<string, VerifiedOfficialDoc>();
  for (const r of rows) {
    if (r.kind !== "docref" || r.verdict !== "matched") continue;
    const url = r.evidence_url ?? "";
    const title = r.evidence_title ?? "";
    if (url === "") continue;
    // 只收政策法规库文档树里的原文页：主站解读频道页也会出现该字号，但它只是链接到原文。
    // 实测有过一条《关于〈…归集范围有关问题的公告〉的解读》被当成 2017年第40号 的原文收进索引。
    if (!isLibraryDocUrl(url)) continue;
    // 按当前分级规则重算，规则收紧后旧记录不会把误判带进索引
    const grade = gradeCitation(url, title);
    if (grade.grade !== "official") continue;
    // snippet 存的是页面正文时（通用检索命中），退回用当时的检索词取完整发文字号
    const key = reusableDocNum(r.text ?? "", r.evidence_snippet ?? "", r.query ?? "");
    if (key === "" || out.has(key)) continue;
    out.set(key, {
      taskId: r.task_id,
      evidence: {
        title,
        url,
        snippet: r.evidence_snippet ?? "",
        grade: grade.grade,
        gradeReason: grade.reason,
      },
    });
  }
  return out;
}

/**
 * 某任务当前需要找替代来源的弱证据引用（门户首页 / 百科词条 / 检索页）。
 * 与结果页同一口径：引用提取走 search-evidence、分级走 citation-grade、检索补充词从结论里取领域词，
 * 批量入口因此不依赖前端传清单。
 */
export function pendingCitationTargets(taskId: string, limit: number = MAX_REF_CHECKS): RefCheckTarget[] {
  const rows = db
    .prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`)
    .all(taskId) as unknown as Array<{ tool_name: string; result: string | null }>;
  if (rows.length === 0) return [];
  const parsed = rows.map((r) => {
    try {
      return { toolName: r.tool_name, result: r.result ? JSON.parse(r.result) : null };
    } catch {
      return { toolName: r.tool_name, result: null };
    }
  });
  const cites = extractCitations(parsed).map((c) => ({ ...c, grade: gradeCitation(c.url, c.title).grade }));
  return unresolvedTargets(
    citationTargets(cites, topicHint(getTask(taskId)?.result ?? "", 2), limit),
    listRefChecks(taskId),
    (c) => matchedStillValid(c.kind ?? "citation", c.evidence, gradeCitation),
  );
}

export type BatchPlanItem = { id: string; title: string; targets: RefCheckTarget[] };

/**
 * 批量复查计划：按候选顺序取每个任务的待复查文号，直到用完预算。
 * 没有待复查文号的任务不进计划也不占预算；待办多的任务优先由调用方排序。
 * 纯函数（待办清单由参数注入），便于离线校验预算切分。
 */
export function planBatchRefChecks(
  candidates: Array<{ id: string; title: string }>,
  pendingOf: (id: string) => RefCheckTarget[],
  budget: number = BATCH_REF_BUDGET,
): BatchPlanItem[] {
  let left = Math.max(0, Math.min(budget, BATCH_REF_MAX));
  const out: BatchPlanItem[] = [];
  for (const c of candidates) {
    if (left <= 0) break;
    const targets = pendingOf(c.id).slice(0, left);
    if (targets.length === 0) continue;
    out.push({ id: c.id, title: c.title, targets });
    left -= targets.length;
  }
  return out;
}

/**
 * 把请求体里的条目规范化成复查目标（主键由服务端算，不信任客户端传入）。
 * hint 为任务级检索补充词（由路由从结论里取领域词算出），弱证据引用的标题过短时用它兜底。
 */
export function toTargets(items: unknown, hint = ""): RefCheckTarget[] {
  if (!Array.isArray(items)) return [];
  const out: RefCheckTarget[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (text === "") continue;
    const kind: RefCheckKind = o.kind === "citation" ? "citation" : "docref";
    const url = typeof o.url === "string" && /^https?:\/\//i.test(o.url) ? o.url : "";
    const target: RefCheckTarget = {
      // 引用的身份是地址而不是标题：同一页面换个标题也只留一条记录
      key: refKey(kind, kind === "citation" && url !== "" ? url : text),
      kind,
      text,
      context: typeof o.context === "string" ? o.context : undefined,
    };
    if (kind === "citation") {
      const own = typeof o.hint === "string" ? o.hint.trim() : "";
      target.hint = own !== "" ? own : hint;
      if (url !== "") target.excludeUrl = url;
    }
    out.push(target);
    if (out.length >= MAX_REF_CHECKS) break;
  }
  // 同一文号只查一次
  return out.filter((t, i) => out.findIndex((x) => x.key === t.key) === i);
}

/** 逐条复查并落库；返回本批记录（含判定、证据与逐引擎尝试过程） */
export async function runRefChecks(
  taskId: string,
  targets: RefCheckTarget[],
  searcher: Searcher = searchWebDetailed,
  policySearcher: PolicySearcher = searchPolicyLibrary,
  verified?: Map<string, VerifiedOfficialDoc>,
): Promise<RefCheckRecord[]> {
  const at = nowIso();
  const out: RefCheckRecord[] = [];
  // 整批共用一份索引：同一批里若有多个任务引用同一份文件，只查一次表。
  // 可注入是为了让验证脚本能隔离复用路径——否则上一节刚存下的官方原文会被下一节直接复用，
  // 测不到「不降级护栏」与「证据力闸门」。
  const verifiedDocs = verified ?? verifiedOfficialDocs();
  for (const t of targets.slice(0, MAX_REF_CHECKS)) {
    // 依次尝试检索词候选：拿到「找到出处」或「有候选页」就收手，只有空手而归才换一种写法再查
    const variants = refQueryVariants(t);
    const attempts: SearchAttempt[] = [];
    // 政策文号先走官方政策法规库：按发文字号精确命中就是权威原文页，比通用检索可靠得多。
    // 通用搜索引擎对中文长查询已退化（Bing 忽略 site: 运算符、长查询只命中「国家」二字就返回
    // 百科词条，百度持续安全验证），因此未命中不代表文件不公开，照旧退回通用检索。
    const want = policyDocNumQuery(t);
    // 已核实的官方原文优先复用，命中就不发任何网络请求：同一发文字号在别的任务里已经精确命中
    // 政策法规库并落库为官方原文，那是核实过的事实，比再检索一次更准（接口全文排序有波动）也更省。
    // 索引键是归一化后的字号（括号统一成半角），查询侧必须同样归一化，否则六角括号写法永远查不到
    const reused = want === "" ? undefined : verifiedDocs.get(normalizeRef(want));
    if (reused !== undefined) {
      attempts.push({
        engine: "fgk",
        via: "JSON",
        fetched: 0,
        kept: 1,
        dropped: 0,
        httpStatus: null,
        status: "ok",
        note: `复用本平台已核实的官方原文（任务 ${reused.taskId.slice(0, 8)} 已按发文字号精确命中政策法规库），本次未发起检索`,
      });
      const reuseRec: RefCheckRecord = {
        key: t.key,
        kind: t.kind,
        text: t.text,
        query: want,
        verdict: "matched",
        note: "复用本平台其他任务已核实的政策法规库官方原文（同一发文字号），链接为官方原文页",
        evidence: reused.evidence,
        subjectUrl: t.excludeUrl ?? "",
        attempts,
        checkedAt: at,
      };
      saveRefCheck(taskId, reuseRec);
      out.push(reuseRec);
      continue;
    }
    if (want !== "") {
      const lib = await policySearcher(want, AbortSignal.timeout(REF_CHECK_TIMEOUT_MS));
      const hit = lib.error === null ? matchPolicyDocNum(want, lib.hits) : null;
      attempts.push({
        engine: "fgk",
        via: "JSON",
        fetched: lib.hits.length,
        kept: hit === null ? 0 : 1,
        dropped: Math.max(0, lib.hits.length - (hit === null ? 0 : 1)),
        httpStatus: lib.status,
        status: hit === null ? (lib.error === null ? "irrelevant" : "error") : "ok",
        note:
          lib.error ??
          (hit === null
            // 不能写成「库内未收录」：实测《财政部 税务总局 科技部公告2022年第28号》就在库里
            //（zcfgk/c102416/c5202002），只是全文检索没把它排上来。把接口排序问题说成事实不存在是错的。
            ? `返回 ${lib.total} 条，无发文字号完全相符的（检索接口未返回该字号，库内可能确有此文）`
            : `按发文字号「${hit.docNum}」精确命中官方原文页`),
      });
      if (hit !== null) {
        const libGrade = gradeCitation(hit.url, hit.title);
        const libRec: RefCheckRecord = {
          key: t.key,
          kind: t.kind,
          text: t.text,
          query: want,
          verdict: "matched",
          note: "国家税务总局政策法规库按发文字号精确命中，链接为官方原文页",
          evidence: {
            title: hit.title,
            url: hit.url,
            snippet: hit.docNum,
            grade: libGrade.grade,
            gradeReason: libGrade.reason,
          },
          subjectUrl: t.excludeUrl ?? "",
          attempts,
          checkedAt: at,
        };
        saveRefCheck(taskId, libRec);
        out.push(libRec);
        continue;
      }
    }
    let graded: RefCheckResult | null = null;
    // 记录的是「得出结论所用」的检索词：换写法才查到时就记换后的，全都没查到时记最初那条最具体的
    let usedQuery = variants[0] ?? t.text;
    let tried = 0;
    let failure: string | null = null;
    for (const q of variants) {
      tried += 1;
      let found: DetailedSearch;
      try {
        found = await searcher(q, AbortSignal.timeout(REF_CHECK_TIMEOUT_MS));
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        continue;
      }
      attempts.push(...found.attempts);
      const g = gradeRefCheck(t, {
        hits: found.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, relevance: r.relevance })),
        note: describeAttempts(found.attempts),
        // 全部引擎都是请求失败才算「检索失败」；引擎正常但结果无关属于「未检索到」
        failed: found.attempts.length > 0 && found.attempts.every((a) => a.status === "error"),
      });
      if (graded === null) graded = g;
      if (g.verdict === "matched" || g.verdict === "candidate") {
        graded = g;
        usedQuery = q;
        break;
      }
    }
    const rec: RefCheckRecord = {
      key: t.key,
      kind: t.kind,
      text: t.text,
      query: usedQuery,
      verdict: graded?.verdict ?? "error",
      note: graded
        ? tried > 1 && graded.verdict !== "matched" && graded.verdict !== "candidate"
          ? `${graded.note}（另试 ${tried - 1} 种检索词，均无可用结果）`
          : graded.note
        : (failure ?? "检索请求失败"),
      evidence: graded?.evidence ?? null,
      subjectUrl: t.excludeUrl ?? "",
      attempts,
      checkedAt: at,
    };
    saveRefCheck(taskId, rec);
    out.push(rec);
  }
  return out;
}

/**
 * 写入一条复查结果（同一 key 覆盖为最新一次）。
 * 例外：旧结果已经找到公开出处而这次没找到时不降级——检索通道有波动，
 * 「曾经检索到公开出处」是既成事实，不能因为一次空结果就把证据抹掉。
 * 重试过程照样完整留痕（attempts 追加、note 说明、checkedAt 更新到最新）。
 */
export function saveRefCheck(taskId: string, rec: RefCheckRecord): void {
  const prev = db
    .prepare(
      `SELECT kind, verdict, note, evidence_title, evidence_url, evidence_grade, evidence_snippet, attempts
         FROM ref_checks WHERE task_id = ? AND ref_key = ?`,
    )
    .get(taskId, rec.key) as
    | {
        kind: string;
        verdict: string;
        note: string | null;
        evidence_title: string | null;
        evidence_url: string | null;
        evidence_grade: string | null;
        evidence_snippet: string | null;
        attempts: string | null;
      }
    | undefined;
  let out = rec;
  // 旧证据按当前分级规则仍算官方原文才享受不降级保护；规则收紧后误判的 matched 可以被纠正
  const prevStillValid = matchedStillValid(
    (prev?.kind ?? rec.kind) as RefCheckKind,
    { url: prev?.evidence_url ?? "", title: prev?.evidence_title ?? "" },
    gradeCitation,
  );
  // 官方原文不被商业站点顶掉：升级通道让重跑已 matched 的记录变多，反向替换必须挡住
  const notBetter =
    prev !== undefined &&
    prev.verdict === "matched" &&
    rec.verdict === "matched" &&
    !evidenceCanReplace(rec.kind, prev.evidence_grade, rec.evidence?.grade ?? null);
  if (prev && (!shouldOverwrite(prev.verdict as RefCheckVerdict, rec.verdict, prevStillValid) || notBetter)) {
    let prevAttempts: SearchAttempt[] = [];
    try {
      prevAttempts = JSON.parse(prev.attempts ?? "[]") as SearchAttempt[];
    } catch {
      prevAttempts = [];
    }
    out = {
      ...rec,
      verdict: "matched",
      // 两种保留原因要分开说清：一种是这次没查到，一种是查到了但证据力不及已留存的官方原文
      note: notBetter
        ? keptBetterNote(prev.note ?? "", rec.evidence?.grade ?? "", rec.checkedAt)
        : preservedNote(prev.note ?? "", rec.verdict, rec.checkedAt),
      evidence: {
        title: prev.evidence_title ?? "",
        url: prev.evidence_url ?? "",
        snippet: prev.evidence_snippet ?? "",
        grade: prev.evidence_grade ?? "official",
        gradeReason: "",
      },
      attempts: [...prevAttempts, ...rec.attempts],
    };
  }
  db.prepare(
    `INSERT INTO ref_checks
       (task_id, ref_key, kind, text, query, verdict, note, evidence_title, evidence_url, evidence_grade, evidence_snippet, subject_url, attempts, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, ref_key) DO UPDATE SET
       kind = excluded.kind, text = excluded.text, query = excluded.query, verdict = excluded.verdict,
       note = excluded.note, evidence_title = excluded.evidence_title, evidence_url = excluded.evidence_url,
       evidence_grade = excluded.evidence_grade, evidence_snippet = excluded.evidence_snippet,
       subject_url = excluded.subject_url, attempts = excluded.attempts, checked_at = excluded.checked_at`,
  ).run(
    taskId,
    out.key,
    out.kind,
    out.text,
    out.query,
    out.verdict,
    out.note,
    out.evidence?.title ?? null,
    out.evidence?.url ?? null,
    out.evidence?.grade ?? null,
    out.evidence?.snippet ?? null,
    out.subjectUrl,
    JSON.stringify(out.attempts),
    out.checkedAt,
  );
}

type Row = {
  ref_key: string;
  kind: string;
  text: string;
  query: string;
  verdict: string;
  note: string | null;
  evidence_title: string | null;
  evidence_url: string | null;
  evidence_grade: string | null;
  evidence_snippet: string | null;
  subject_url: string | null;
  attempts: string | null;
  checked_at: string;
};

const VERDICTS = new Set<RefCheckVerdict>(["matched", "candidate", "empty", "error"]);

/** 读取某任务已持久化的复查结果（按文号原文排序，保证列表稳定） */
export function listRefChecks(taskId: string): RefCheckRecord[] {
  const rows = db
    .prepare(`SELECT * FROM ref_checks WHERE task_id = ? ORDER BY text ASC`)
    .all(taskId) as unknown as Row[];
  return rows.map((r) => {
    let attempts: SearchAttempt[] = [];
    try {
      const parsed = JSON.parse(r.attempts ?? "[]") as unknown;
      if (Array.isArray(parsed)) attempts = parsed as SearchAttempt[];
    } catch {
      attempts = [];
    }
    const verdict: RefCheckVerdict = VERDICTS.has(r.verdict as RefCheckVerdict)
      ? (r.verdict as RefCheckVerdict)
      : "error";
    return {
      key: r.ref_key,
      kind: r.kind === "citation" ? "citation" : "docref",
      text: r.text,
      query: r.query,
      verdict,
      note: r.note ?? "",
      subjectUrl: r.subject_url ?? "",
      evidence:
        r.evidence_url === null
          ? null
          : {
              title: r.evidence_title ?? r.evidence_url,
              url: r.evidence_url,
              snippet: r.evidence_snippet ?? "",
              grade: r.evidence_grade ?? "professional",
              // 判定理由不入库，读取时按同一口径重算，避免存两份可能不一致的文案
              gradeReason: gradeCitation(r.evidence_url, r.evidence_title ?? "").reason,
            },
      attempts,
      checkedAt: r.checked_at,
    };
  });
}
