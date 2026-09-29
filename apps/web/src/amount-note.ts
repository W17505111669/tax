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

/** 两个作品通用的核对依据；文案与作品口径一致（金额由确定性工具计算、模型零口算） */
const SHARED_TEMPLATES: AmountNoteTemplate[] = [
  { label: "与底稿合计一致", text: "与工作底稿合计数核对一致" },
  { label: "与申报表一致", text: "与申报表相应栏次核对一致" },
  { label: "工具计算已复核", text: "由确定性工具计算，已复核计算过程，无口算" },
  { label: "差异已列待核查", text: "差异已在待核查事项中列示，暂不作为认定依据" },
  { label: "客户已说明", text: "客户已提供书面说明，口径可接受，留存备查" },
];

/** 各作品最常用的一条：研发看辅助账，土增看清算底稿与合同发票台账 */
const AGENT_TEMPLATES: Record<string, AmountNoteTemplate[]> = {
  "rd-audit": [{ label: "与辅助账一致", text: "与研发支出辅助账明细逐笔核对一致" }],
  "land-vat": [{ label: "与清算底稿一致", text: "与土地增值税清算底稿及合同发票台账核对一致" }],
};

/* ===== 自定义模板：内置那几条覆盖不了各所自己的口径，允许按作品自己加，存在本机 ===== */

/** 本地存储键：按作品分组存放，换作品互不影响 */
export const CUSTOM_NOTE_STORE_KEY = "taxai.amountNote.custom.v1";
/** 每个作品最多几条自定义：够放本所常用口径，又不至于把内置模板挤出可视区 */
export const MAX_CUSTOM_TEMPLATES = 8;
/** 标签最长字数：标签是胶囊按钮上的字，太长会把同一行其他模板挤到下一行 */
export const LABEL_MAX = 8;
/** 内容最短字数：与 noteIsMeaningful 的门槛一致，短于此不足以作为核对依据 */
export const TEXT_MIN = 6;

/** 最小存储接口：验证脚本用内存假件即可跑，不依赖浏览器 */
export interface TemplateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CustomTemplateStore = Record<string, AmountNoteTemplate[]>;

/** 一条自定义模板是否还站得住：标签短且不空、内容够长且不含分段符 */
function validTemplate(v: unknown): v is AmountNoteTemplate {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Partial<AmountNoteTemplate>;
  if (typeof t.label !== "string" || typeof t.text !== "string") return false;
  const label = t.label.trim();
  const text = t.text.trim();
  return label !== "" && label.length <= LABEL_MAX && text.length >= TEXT_MIN && !/[；;]/.test(text);
}

function safeGet(storage: TemplateStorage): string | null {
  try {
    return storage.getItem(CUSTOM_NOTE_STORE_KEY);
  } catch {
    return null;
  }
}

/**
 * 解析本地存储：坏 JSON、结构不对、单条不合规都只丢掉那一条，
 * 不能因为一条脏数据让整个模板区消失——备注留痕的入口比某一条模板重要。
 */
export function parseCustomStore(raw: string | null): CustomTemplateStore {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: CustomTemplateStore = {};
  for (const [agentId, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const keep = list
      .filter(validTemplate)
      .slice(0, MAX_CUSTOM_TEMPLATES)
      .map((t) => ({ label: t.label.trim(), text: t.text.trim() }));
    if (keep.length > 0) out[agentId] = keep;
  }
  return out;
}

export function loadCustomTemplates(
  storage: TemplateStorage | undefined,
  agentId: string,
): AmountNoteTemplate[] {
  if (!storage || !agentId) return [];
  return parseCustomStore(safeGet(storage))[agentId] ?? [];
}

/** 写回本地：某作品清空后删掉该键，整份空了就整个键删掉，不在 localStorage 里留空壳 */
export function saveCustomTemplates(
  storage: TemplateStorage | undefined,
  agentId: string,
  list: AmountNoteTemplate[],
): void {
  if (!storage || !agentId) return;
  const store = parseCustomStore(safeGet(storage));
  const clean = list.filter(validTemplate).slice(0, MAX_CUSTOM_TEMPLATES);
  if (clean.length === 0) delete store[agentId];
  else store[agentId] = clean;
  try {
    if (Object.keys(store).length === 0) storage.removeItem(CUSTOM_NOTE_STORE_KEY);
    else storage.setItem(CUSTOM_NOTE_STORE_KEY, JSON.stringify(store));
  } catch {
    // 隐私模式或配额写满：本次会话仍可用，只是刷新后不保留
  }
}

export function removeCustomTemplate(list: AmountNoteTemplate[], label: string): AmountNoteTemplate[] {
  return list.filter((t) => t.label !== label);
}

/**
 * 校验一条待新增的自定义模板，返回能直接给用户看的错误文案，null 表示可用。
 * existing 传合并后的完整清单（连内置一起查重），customCount 传该作品已有的自定义条数。
 */
export function validateCustomTemplate(
  draft: { label: string; text: string },
  existing: AmountNoteTemplate[],
  customCount: number,
): string | null {
  if (customCount >= MAX_CUSTOM_TEMPLATES) {
    return `自定义模板最多 ${MAX_CUSTOM_TEMPLATES} 条，先删掉不用的再加`;
  }
  const label = draft.label.trim();
  const text = draft.text.trim();
  if (label === "") return "给模板起个短标签，方便在胶囊按钮上认出来";
  if (label.length > LABEL_MAX) return `标签最多 ${LABEL_MAX} 个字，太长会把同一行的其他模板挤下去`;
  if (text === "") return "模板内容不能为空：空模板点进去等于没有留痕";
  if (text.length < TEXT_MIN) return `模板内容至少 ${TEXT_MIN} 个字，否则不足以作为核对依据`;
  if (/[；;]/.test(text)) return "模板内容不要带分号：分号是备注的分段符，会把一句话拆成两段";
  if (existing.some((t) => t.label === label)) return `已有同名标签「${label}」，换一个`;
  const same = existing.find((t) => t.text === text);
  if (same) return `已有内容相同的模板「${same.label}」，不必重复添加`;
  return null;
}

/** 作品专属的内置模板（不含通用那几条） */
export function builtinAgentTemplates(agentId: string): AmountNoteTemplate[] {
  return AGENT_TEMPLATES[agentId] ?? [];
}

/** 合并顺序：作品专属内置 → 自定义 → 通用；按标签去重，同名胶囊只出现一次 */
export function mergeTemplates(agentId: string, custom: AmountNoteTemplate[] = []): AmountNoteTemplate[] {
  const merged: AmountNoteTemplate[] = [];
  const seen = new Set<string>();
  const all = [...builtinAgentTemplates(agentId), ...custom.filter(validTemplate), ...SHARED_TEMPLATES];
  for (const t of all) {
    const label = t.label.trim();
    if (label === "" || seen.has(label)) continue;
    seen.add(label);
    merged.push({ label, text: t.text.trim() });
  }
  return merged;
}

/** 按作品给出模板清单（作品专属那条排最前）；未知作品只给通用模板 */
export function amountNoteTemplates(agentId: string): AmountNoteTemplate[] {
  return mergeTemplates(agentId);
}

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
  return parts.some((p) => p.length >= TEXT_MIN);
}
