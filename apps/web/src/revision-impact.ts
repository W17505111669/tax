/**
 * 修订前后的证据对比：续跑改完结论之后，用同一套口径重算一遍证据指标，
 * 让「这次修订到底有没有把证据质量改好」变成可核对的数字，而不是靠读两遍结论。
 *
 * 口径只取结论正文里能确定的部分——引用地址（按证据力分级）与政策文号数。
 * 工具留存是跨运行累积的（后一次运行会看到前一次的工具结果），拿它对比会把累积当成改善，
 * 而结论正文才是修订真正改动的对象。
 *
 * 纯函数，便于 apps/api/scripts/verify-revision-impact.ts 直接校验。
 */

import { gradeCitation } from "./citation-grade.ts";
import { extractDocRefs } from "./policy-trace.ts";
import { extractTextCitations } from "./search-evidence.ts";

export type EvidenceSnapshot = {
  /** 结论正文里引用的地址数（去重，受引用清单上限约束） */
  citations: number;
  official: number;
  professional: number;
  weak: number;
  /** 结论正文里出现的政策文号数（按核心去重） */
  docRefs: number;
};

/** 从一段结论文本算出证据快照 */
export function evidenceSnapshot(text: string): EvidenceSnapshot {
  const cites = extractTextCitations(text);
  const out: EvidenceSnapshot = { citations: cites.length, official: 0, professional: 0, weak: 0, docRefs: 0 };
  for (const c of cites) out[gradeCitation(c.url, c.title).grade] += 1;
  out.docRefs = extractDocRefs(text).length;
  return out;
}

export type EvidenceDelta = {
  before: EvidenceSnapshot;
  after: EvidenceSnapshot;
  citations: number;
  official: number;
  weak: number;
  docRefs: number;
  /** 至少一项改善：弱证据减少、官方原文增加或政策文号出处增加 */
  improved: boolean;
  /** 出现退步：弱证据增加、官方原文减少或政策文号出处减少 */
  regressed: boolean;
  /** 证据质量持平：三项都没变（引用合计的变化仍会在明细里给出） */
  unchanged: boolean;
};

/** 两个快照的差值与总体判断 */
export function evidenceDelta(before: EvidenceSnapshot, after: EvidenceSnapshot): EvidenceDelta {
  const citations = after.citations - before.citations;
  const official = after.official - before.official;
  const weak = after.weak - before.weak;
  const docRefs = after.docRefs - before.docRefs;
  // 判断看证据质量与可溯源性：弱证据减少、官方原文增加、政策文号出处增加都算改善；
  // 反过来弱证据增加、官方原文减少、文号出处减少都算退步。引用总条数本身不计入——
  // 「多引了几条同样强度的来源」不是质量变化，计入反而会让三种判断出现都不成立的空档。
  const improved = weak < 0 || official > 0 || docRefs > 0;
  const regressed = weak > 0 || official < 0 || docRefs < 0;
  return {
    before,
    after,
    citations,
    official,
    weak,
    docRefs,
    improved,
    regressed,
    unchanged: !improved && !regressed,
  };
}

/** 带符号的数字，0 就是 0（不加正号，避免看起来像改善） */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** 总体判断文案：改善 / 退步 / 有增有减 / 无变化 */
export function deltaVerdict(d: EvidenceDelta): string {
  if (d.improved && !d.regressed) return "证据质量改善";
  if (d.regressed && !d.improved) return "证据质量退步，请核对本次修订";
  if (d.unchanged) return "证据质量持平（弱证据与官方原文条数未变）";
  return "证据质量有增有减，请核对本次修订";
}

/** 四项指标的前后值与差值（不含总体判断），供证据核对表等需要分开展示的场合使用 */
export function deltaDetail(d: EvidenceDelta): string {
  return [
    `弱证据引用 ${d.before.weak} → ${d.after.weak}（${signed(d.weak)}）`,
    `官方原文 ${d.before.official} → ${d.after.official}（${signed(d.official)}）`,
    `引用合计 ${d.before.citations} → ${d.after.citations}（${signed(d.citations)}）`,
    `政策文号 ${d.before.docRefs} → ${d.after.docRefs}（${signed(d.docRefs)}）`,
  ].join(" · ");
}

/** 一行人类可读的对比结论（界面提示与整页交付 MD 共用） */
export function deltaText(d: EvidenceDelta): string {
  return `${deltaVerdict(d)}：${deltaDetail(d)}`;
}
