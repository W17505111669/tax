/**
 * 交付包机器可读清单（manifest.json）：把整页 MD 里的结论性数据同时以结构化形式放进 zip，
 * 便于归档系统检索、后续自动核对，以及交付后追溯「当时到底自检出了什么」。
 * buildManifest 只做组装，manifestIssues 做内部一致性自校验，两者都是纯函数。
 */
import type { CheckResult } from "./delivery-check.ts";
import type { LinkSummary } from "./link-check.ts";

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
  }>;
  /** 联网引用证据力分级汇总；本次任务没有联网引用时为 null */
  citationGrades: { total: number; official: number; professional: number; weak: number } | null;
  linkCheck: { summary: LinkSummary | null; checkedAt: string | null };
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
