/**
 * 交付 MD 的「联网引用」节。
 *
 * 与 `delivery-docref.ts` / `delivery-amount.ts` 同一套路：这一节此前写在 TaskWorkbench 的
 * `bundleLines()` 里，是组件内闭包，任何单测都碰不到它。而它恰恰是对外声称数字最密的一节——
 * 证据力分级三类、弱证据两类「不必再催办」的条数、只留元数据的检索次数、替代来源检索四类、
 * 链接核验五类，全在这一节里，此前一条断言都没有（`verify:manifest` 只交叉核对了文号节与金额节）。
 *
 * 链接核验的汇总行与明细行由**同一份**已过滤的核验行就地算出：此前汇总走 `linkSummary`（按当前
 * 引用清单过滤）、明细走全量 `linkChecks`，于是同一份 MD 里出现「非可访问 4 条」底下列 5 行的
 * 自相矛盾（实测 3 个任务）。放进同一个函数之后两者不可能再各说一套。
 */
import { GRADE_TEXT, type CitationGrade, type GradeSummary } from "./citation-grade.ts";
import { linkVerdict, summarizeLinkChecks, VERDICT_TEXT, type LinkCheckLike } from "./link-check.ts";
import { REF_VERDICT_TEXT, type RefCheckSummary } from "./ref-check.ts";
import { deltaText, type EvidenceDelta } from "./revision-impact.ts";
import { mdCell } from "./run-tools.ts";
import { retentionNote, type RetentionStats } from "./search-evidence.ts";
import type { RefCheckRecord } from "./types.ts";
import { dateTimeStamp } from "./time-format.ts";

/** 一行链接核验记录（link_checks 的行形状），必须已按 liveLinkChecks 过滤 */
export type CiteLinkRow = LinkCheckLike & { url: string; status: number | null; ms: number; error?: string };

export interface CiteSectionInput {
  /** 本次修订对证据的影响；null 表示没有上一轮结论可对比，那两行整块不写 */
  revImpact: EvidenceDelta | null;
  /** 全量联网引用（不按界面清单上限截断，与分级汇总、manifest 同一口径） */
  citations: Array<{ title: string; url: string; grade: CitationGrade; gradeReason: string }>;
  grades: GradeSummary;
  /** 弱证据中已在结论里声明「仅作背景参考」的条数 */
  weakDisclaimed: number;
  /** 弱证据中只在检索留存里、从未进入结论正文的条数 */
  weakUncited: number;
  /** 仍待处置的弱证据条数；大于 0 才写那句「请替换为具体文件页」 */
  weakOpen: number;
  /** 联网检索留痕：只留查询元数据的次数与涉及的工具名 */
  searches: { metadataOnly: number; tools: string[] };
  /** 一条引用都没有时的说明（检索留痕说明）；null 时写固定兜底文案 */
  emptyNote: string | null;
  /** 弱证据替代来源检索汇总（只含引用类复查） */
  citeSummary: RefCheckSummary;
  /** 引用类复查明细，逐条列进替代来源表 */
  citeChecks: RefCheckRecord[];
  /** 最近链接核验时间；null 表示从未核验，核验那一块整段不写 */
  linkCheckedAt: string | null;
  /** 已过滤的核验行；汇总就地由它算出，不接受外部传入的汇总 */
  linkChecks: CiteLinkRow[];
  /** 留存正文规模与截断量；有截断才在这一节写一行说明（口径见 search-evidence.ts 的 retentionNote） */
  retention: RetentionStats;
}

const CITE_TABLE_HEADER = "| # | 原弱证据引用 | 判定 | 替代来源 |";

/** 交付 MD「联网引用」一节的行（末尾自带一个空行收尾，不和后一节粘在一起） */
export function citeSection(input: CiteSectionInput): string[] {
  const {
    revImpact,
    citations,
    grades,
    weakDisclaimed,
    weakUncited,
    weakOpen,
    searches,
    emptyNote,
    citeSummary,
    citeChecks,
    linkCheckedAt,
    linkChecks,
    retention,
  } = input;
  const out: string[] = ["## 联网引用", ""];
  if (revImpact) {
    out.push(
      `- 本次修订对证据的影响：${deltaText(revImpact)}`,
      `- 对比口径：只统计结论正文里的引用地址（按证据力分级）与政策文号数；工具留存跨运行累积，不参与对比`,
      "",
    );
  }
  if (citations.length > 0) {
    out.push(
      `- 证据力分级：官方来源 ${grades.official} 条 · 专业来源 ${grades.professional} 条 · 证据力弱 ${
        grades.weak
      } 条${weakDisclaimed > 0 ? `（其中 ${weakDisclaimed} 条已在结论中声明为背景参考）` : ""}${
        weakUncited > 0 ? `（${weakUncited} 条只在检索留存里、未进入结论正文）` : ""
      }`,
    );
    if (weakOpen > 0) {
      out.push("- 证据力弱的引用指向门户首页、百科词条或检索结果页，不能替代政策原文，交付前请替换为具体文件页");
    }
    if (searches.metadataOnly > 0) {
      out.push(
        `- 另有 ${searches.metadataOnly} 次联网检索只留存查询元数据（${searches.tools.join(
          " / ",
        )}），未留存标题与 URL，未计入上方清单`,
      );
    }
    out.push("");
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i]!;
      out.push(`${i + 1}. ${c.title}\n   ${c.url}\n   证据力：${GRADE_TEXT[c.grade]}（${c.gradeReason}）`);
    }
    if (citeSummary.total > 0) {
      out.push(
        "",
        `- 弱证据引用替代来源检索：已检索 ${citeSummary.total} 条 · 找到官方原文 ${citeSummary.matched} 条 · 候选待确认 ${
          citeSummary.candidate
        } 条 · 未找到 ${citeSummary.empty + citeSummary.error} 条（替代来源需人工确认后写回结论并重新打包）`,
        "",
        CITE_TABLE_HEADER,
        "| --- | --- | --- | --- |",
      );
      citeChecks.forEach((c, i) => {
        out.push(
          `| ${i + 1} | ${mdCell(c.text)}${c.subjectUrl ? `<br>${mdCell(c.subjectUrl)}` : ""} | ${
            REF_VERDICT_TEXT[c.verdict]
          } | ${c.evidence ? `[${mdCell(c.evidence.title)}](${c.evidence.url})` : "—"} |`,
        );
      });
    }
  } else {
    out.push(emptyNote ?? "（本次任务无联网引用）");
  }
  // 截断说明放在引用清单之外：没有引用清单的任务同样可能截断了正文，而那一节恰恰是
  // 「无出处」判定最容易被误读成「平台核对过全部原文」的地方。
  const rNote = retentionNote(retention);
  if (rNote) out.push(`- ${rNote}`);
  out.push("");
  if (linkCheckedAt) {
    // 汇总就地算，不接受外部传入：明细行与汇总行必须由同一份列表推出来
    const s = summarizeLinkChecks(linkChecks);
    out.push(
      // 走共享的 dateTimeStamp：此前这里内联 toLocaleString 且没有兜底，linkCheckedAt 为空时
      // 会把 "Invalid Date" 直接写进交付 MD 的联网引用节
      `- 链接核验：${dateTimeStamp(linkCheckedAt)} · 可访问 ${s.ok}/${
        s.total
      } · 失效 ${s.dead} · 拒绝自动访问 ${s.blocked} · 无法核验 ${s.unreachable}`,
    );
    for (const r of linkChecks) {
      const v = linkVerdict(r);
      if (v === "ok") continue;
      out.push(`  - ${VERDICT_TEXT[v]}：${r.url}（${r.status ?? r.error ?? "无响应"}，耗时 ${r.ms} ms）`);
    }
    out.push("");
  }
  return out;
}

/** 替代来源表的表头，供验证脚本按列位置断言（不依赖文案常量） */
export const CITE_TABLE_HEAD = CITE_TABLE_HEADER;
