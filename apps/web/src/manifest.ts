/**
 * 交付包机器可读清单（manifest.json）：把整页 MD 里的结论性数据同时以结构化形式放进 zip，
 * 便于归档系统检索、后续自动核对，以及交付后追溯「当时到底自检出了什么」。
 * buildManifest 只做组装，manifestIssues 做内部一致性自校验，两者都是纯函数。
 */
import type { CheckResult } from "./delivery-check.ts";
import type { LinkSummary } from "./link-check.ts";
import { deltaVerdict, evidenceDelta, type EvidenceSnapshot } from "./revision-impact.ts";

export const MANIFEST_SCHEMA = "tax-agent-delivery-manifest";
export const MANIFEST_VERSION = 1;

export type ManifestInput = {
  task: {
    id: string;
    title: string;
    caseId: string;
    agentId: string;
    status: string;
    createdAt: string;
    runCount: number;
  };
  delivery: CheckResult;
  files: Array<{
    name: string;
    type: string;
    byteSize: number;
    uploadedAt: string;
    parseStatus: string;
    parseDetail: string;
  }>;
  artifacts: Array<{
    name: string;
    byteSize: number;
    updatedAt: string;
    sourceTool: string | null;
    sourceRole: "producer" | "ref" | null;
    sourceAt: string | null;
    run: number | null;
  }>;
  tools: { total: number; ok: number; failed: number; running: number; avgMs: number | null };
  citations: Array<{
    title: string;
    url: string;
    verdict: string;
    status: number | null;
    /** 证据力分级：official 官方原文 / professional 专业来源 / weak 门户首页、百科或检索页 */
    grade: string;
    gradeReason: string;
    /** 留下这条来源的工具名 */
    via: string;
  }>;
  /** 联网引用证据力分级汇总；本次任务没有联网引用时为 null */
  citationGrades: { total: number; official: number; professional: number; weak: number } | null;
  /** 联网检索留痕；本次任务没有任何联网检索类调用时为 null */
  searches: {
    calls: number;
    withUrls: number;
    metadataOnly: number;
    reportedResults: number;
    queries: string[];
    providers: string[];
    tools: string[];
  } | null;
  linkCheck: { summary: LinkSummary | null; checkedAt: string | null };
  /** 政策文号联网复查汇总；从未复查时为 null */
  refChecks: {
    total: number;
    matched: number;
    candidate: number;
    empty: number;
    error: number;
    checkedAt: string | null;
  } | null;
  /** 弱证据引用的替代来源检索汇总；从未检索时为 null */
  citationChecks: {
    total: number;
    matched: number;
    candidate: number;
    empty: number;
    error: number;
    checkedAt: string | null;
  } | null;
  /** 本次修订对证据的影响（前后快照与总体判断）；没有可对比的上一轮结论时为 null */
  revision: { before: EvidenceSnapshot; after: EvidenceSnapshot; verdict: string } | null;
  amounts: { total: number; traced: number; fromInput: number; pending: number; acked: number };
  review: { issues: number; done: number; pending: number; notRequired: number };
  generatedAt?: string;
};

export type BundleManifest = ManifestInput & {
  schema: typeof MANIFEST_SCHEMA;
  version: typeof MANIFEST_VERSION;
  generatedAt: string;
};

export function buildManifest(input: ManifestInput): BundleManifest {
  return {
    ...input,
    schema: MANIFEST_SCHEMA,
    version: MANIFEST_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/**
 * 清单内部一致性自校验：返回问题列表，空数组表示自洽。
 * 这些不变量保证 MD 与 JSON 说的是同一件事，也保证归档后仍可被机器复核。
 */
export function manifestIssues(m: BundleManifest): string[] {
  const out: string[] = [];
  const count = (level: string) => m.delivery.items.filter((x) => x.level === level).length;
  if (m.delivery.blocks !== count("block")) out.push("阻断项计数与明细不符");
  if (m.delivery.warns !== count("warn")) out.push("提醒项计数与明细不符");
  if (m.delivery.infos !== count("info")) out.push("说明项计数与明细不符");
  const wantVerdict =
    m.delivery.blocks > 0 ? "不建议直接交付" : m.delivery.warns > 0 ? "谨慎交付" : "可交付";
  if (m.delivery.verdict !== wantVerdict) out.push(`交付结论 ${m.delivery.verdict} 与分级数量推得的 ${wantVerdict} 不符`);

  const a = m.amounts;
  if (a.total !== a.traced + a.fromInput + a.pending + a.acked) out.push("金额溯源四项之和不等于总数");
  if (a.pending < 0 || a.acked < 0) out.push("金额计数出现负数");

  const t = m.tools;
  if (t.total !== t.ok + t.failed + t.running) out.push("工具调用四类之和不等于总数");

  const r = m.review;
  if (r.issues !== r.done + r.pending + r.notRequired) out.push("复核问题四项之和不等于总数");

  const s = m.linkCheck.summary;
  if (s) {
    if (s.total !== s.ok + s.blocked + s.dead + s.unreachable) out.push("链接核验四类之和不等于总数");
    if (s.total > m.citations.length) out.push("链接核验条数多于引用条数");
  }

  const g = m.citationGrades;
  if (g) {
    if (g.total !== g.official + g.professional + g.weak) out.push("引用证据力分级四类之和不等于总数");
    if (g.total !== m.citations.length) out.push("引用证据力分级总数与引用条数不符");
  } else if (m.citations.length > 0) {
    out.push("有联网引用却缺少证据力分级汇总");
  }
  for (const c of m.citations) {
    if (!c.grade) out.push(`引用 ${c.url.slice(0, 60)} 缺少证据力分级`);
    if (c.grade !== "official" && c.grade !== "professional" && c.grade !== "weak") {
      out.push(`引用 ${c.url.slice(0, 60)} 的证据力分级取值非法：${c.grade}`);
    }
    if (!c.via) out.push(`引用 ${c.url.slice(0, 60)} 缺少来源工具`);
  }

  const se = m.searches;
  if (se) {
    if (se.calls !== se.withUrls + se.metadataOnly) out.push("联网检索留痕两类之和不等于调用数");
    if (se.calls > 0 && se.tools.length === 0) out.push("有联网检索却没有工具名");
    // 结论正文里的地址也算引用，因此只有「工具留存的引用」才要求存在留下来源的检索调用
    if (se.withUrls === 0 && m.citations.some((c) => c.via !== "conclusion")) {
      out.push("有工具留存的引用却没有任何留下来源的检索调用");
    }
    if (se.reportedResults < 0) out.push("检索自报命中数为负");
  } else if (m.citations.some((c) => c.via !== "conclusion")) {
    out.push("有工具留存的引用却缺少检索留痕汇总");
  }

  const rc = m.refChecks;
  if (rc) {
    if (rc.total !== rc.matched + rc.candidate + rc.empty + rc.error) {
      out.push("文号复查四类之和不等于复查总数");
    }
    if (rc.total > 0 && rc.checkedAt === null) out.push("有复查记录却没有复查时间");
  }

  const cc = m.citationChecks;
  if (cc) {
    if (cc.total !== cc.matched + cc.candidate + cc.empty + cc.error) {
      out.push("弱证据引用检索四类之和不等于总数");
    }
    if (cc.total > 0 && cc.checkedAt === null) out.push("有弱证据引用检索记录却没有时间");
  }

  // 修订影响的判断必须能由前后快照重新推出来，否则交付包里就是两句互相矛盾的话
  const rv = m.revision;
  if (rv) {
    const want = deltaVerdict(evidenceDelta(rv.before, rv.after));
    if (rv.verdict !== want) out.push(`修订影响判断「${rv.verdict}」与前后数值推得的「${want}」不符`);
    const snaps: Array<[string, EvidenceSnapshot]> = [
      ["修订前", rv.before],
      ["修订后", rv.after],
    ];
    for (const [label, s] of snaps) {
      if (s.official + s.professional + s.weak !== s.citations) out.push(`${label}快照分级之和不等于引用数`);
      if (s.citations < 0 || s.docRefs < 0 || s.weak < 0 || s.official < 0) out.push(`${label}快照计数出现负数`);
    }
  }

  for (const f of m.files) {
    if (!f.name) out.push("存在没有文件名的资料");
    if (f.byteSize < 0) out.push(`资料 ${f.name} 大小为负`);
  }
  for (const art of m.artifacts) {
    if (!art.name) out.push("存在没有文件名的产物");
    if (art.byteSize < 0) out.push(`产物 ${art.name} 大小为负`);
    if (art.sourceRole !== null && art.sourceTool === null) out.push(`产物 ${art.name} 有来源类型却没有来源工具`);
  }
  if (!m.task.id) out.push("缺少任务 ID");
  return out;
}
