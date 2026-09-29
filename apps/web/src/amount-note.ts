/**
 * 金额核对备注的快捷模板。
 *
 * 复核页里「结论金额核对」要逐处填写核对依据，实际写来写去就是那几句
 * （与辅助账核对一致、与申报表相应栏次一致、由工具计算已复核…）。
 * 给一组常用模板点一下填进输入框：既省时间，也不会因为懒得写而留下空备注——
 * 备注是要进整页交付 MD 与交付包的留痕，空着等于没有核对依据。
 *
 * 纯函数，便于 apps/api/scripts/verify-amount-note.ts 直接校验。
 */

export type AmountNoteTemplate = { label: string; text: string };

/** 常用核对依据；文案与作品口径一致（金额由确定性工具计算、模型零口算） */
export const AMOUNT_NOTE_TEMPLATES: AmountNoteTemplate[] = [
  { label: "与辅助账一致", text: "与研发支出辅助账明细逐笔核对一致" },
  { label: "与底稿合计一致", text: "与工作底稿合计数核对一致" },
  { label: "与申报表一致", text: "与申报表相应栏次核对一致" },
  { label: "工具计算已复核", text: "由确定性工具计算，已复核计算过程，无口算" },
  { label: "差异已列待核查", text: "差异已在待核查事项中列示，暂不作为认定依据" },
  { label: "客户已说明", text: "客户已提供书面说明，口径可接受，留存备查" },
];

/** 备注分段符：中文分号，与人工书写习惯一致 */
export const NOTE_SEP = "；";

function segments(note: string): string[] {
  return note
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 点模板填入备注：空备注直接填入；已有内容按分号追加；
 * 同一条已在备注里就不重复追加（反复点不会堆出同一句话）。
 */
export function composeNote(current: string, text: string): string {
  const add = text.trim();
  const parts = segments(current);
  if (add === "") return parts.join(NOTE_SEP);
  if (parts.length === 0) return add;
  if (parts.includes(add)) return parts.join(NOTE_SEP);
  return [...parts, add].join(NOTE_SEP);
}

/** 删掉最近一段：点错模板时不用手工删字 */
export function dropLastNoteSegment(current: string): string {
  return segments(current)
    .slice(0, -1)
    .join(NOTE_SEP);
}

/** 备注是否足以作为核对依据留痕：非空且不只是模板标签 */
export function noteIsMeaningful(note: string): boolean {
  const parts = segments(note);
  if (parts.length === 0) return false;
  return parts.some((p) => p.length >= 6);
}
