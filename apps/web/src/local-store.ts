/**
 * 本地存储的唯一入口。
 *
 * 之前 8 个文件里有 32 处直接读写 localStorage：taxai-starred 这一个键被侧栏与工作台
 * 各写一遍（各自 JSON.parse + Set + 序列化），taxai-tags 也是两处；读取大多没有校验，
 * 脏数据轻则收藏与标签悄悄消失，重则在 render 里抛错整页白屏——答辩现场最不想看到的那种。
 *
 * 这里收成一份：键集中登记，读取一律带校验与兜底，写入一律不抛错，
 * 存储不可用（隐私模式、配额满、无 DOM 的验证环境）时降级到内存，本次会话行为仍然一致。
 *
 * 只碰 localStorage，不碰其他浏览器 API，因此在 Node 里也能直接 import 验证。
 */
import { CUSTOM_NOTE_STORE_KEY } from "./amount-note.ts";

/** 所有本地键集中登记：新增键先来这里占位，避免两处写同一个键却各自解析 */
export const KEYS = {
  /** 收藏（星标）任务 id：侧栏与工作台共用 */
  starred: "taxai-starred",
  /** 任务自定义标签：taskId → 标签数组 */
  tags: "taxai-tags",
  /** 侧栏手动排序（拖拽置顶） */
  taskOrder: "taxai-task-order",
  /** 侧栏分组折叠状态 */
  sidebarGroups: "taxai-sidebar-groups",
  /** 底稿比对的差异类型筛选 */
  compareKind: "taxai-compare-kind",
  /** 结论正文字号 */
  resultFontSize: "taxai-result-fs",
  /** 阅读器：冻结首行首列 */
  readerFreeze: "taxai-reader-freeze",
  /** 阅读器：来源别名 */
  readerAliases: "taxai-reader-aliases",
  /** 阅读器：各表排序状态 */
  readerSort: "taxai-reader-sort",
  /** 阅读器：引用/生成分组 */
  readerGroup: "taxai-reader-group",
  /** 平台指标每日快照（周环比用） */
  snapshots: "taxai-stats-snapshots",
  /** 报告版式主题 */
  paperTheme: "tax-paper-theme",
  /** 金额核对备注的自定义模板（键名以 amount-note.ts 为准，这里只登记不另写一份） */
  customNoteTemplates: CUSTOM_NOTE_STORE_KEY,
} as const;

/** 存储不可用时的内存兜底 */
const memory = new Map<string, string>();

/**
 * 只用到三个方法，不引 DOM 的 Storage 类型：apps/api 的 tsconfig 没有 DOM lib，
 * 而验证脚本要直接 import 本模块。同理取值走 globalThis，不写裸 localStorage。
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function backing(): WebStorageLike | null {
  try {
    return (globalThis as { localStorage?: WebStorageLike }).localStorage ?? null;
  } catch {
    // 某些隐私模式下取 localStorage 这个属性本身就会抛
    return null;
  }
}

export function readRaw(key: string): string | null {
  const s = backing();
  if (!s) return memory.get(key) ?? null;
  try {
    return s.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writeRaw(key: string, value: string): void {
  memory.set(key, value);
  try {
    backing()?.setItem(key, value);
  } catch {
    // 隐私模式或配额写满：内存里已经存了，本次会话仍可用
  }
}

export function removeRaw(key: string): void {
  memory.delete(key);
  try {
    backing()?.removeItem(key);
  } catch {
    // 同上
  }
}

export function readText(key: string, fallback = ""): string {
  return readRaw(key) ?? fallback;
}

/** 只接受白名单里的值，其余一律回落；避免旧版本或脏值把联合类型撑破 */
export function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = readRaw(key);
  return v !== null && allowed.includes(v as T) ? (v as T) : fallback;
}

/** JSON 读取：解析失败或形状不对都回落，绝不把异常抛给调用方（尤其是 render 里） */
export function readJson<T>(key: string, revive: (v: unknown) => T | null, fallback: T): T {
  const raw = readRaw(key);
  if (raw === null || raw === "") return fallback;
  try {
    const got = revive(JSON.parse(raw));
    return got === null ? fallback : got;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    // 循环引用一类：写不进去不影响界面
  }
}

/* ===== 形状校验：脏数据只丢不合规的部分，认不出来就整体回落 ===== */

export function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

export function asStringRecord(v: unknown): Record<string, string> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function asBoolRecord(v: unknown): Record<string, boolean> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

export function asStringArrayRecord(v: unknown): Record<string, string[]> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const arr = asStringArray(val);
    if (arr) out[k] = arr;
  }
  return out;
}

/** 阅读器排序状态：列名必须是字符串，方向只认 1 与 -1 */
export function asSortRecord(v: unknown): Record<string, { col: string; dir: 1 | -1 }> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, { col: string; dir: 1 | -1 }> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null) continue;
    const { col, dir } = val as { col?: unknown; dir?: unknown };
    if (typeof col === "string" && (dir === 1 || dir === -1)) out[k] = { col, dir };
  }
  return out;
}

/** 指标每日快照：日期 → 指标名 → 数值 */
export function asSnapshotRecord(v: unknown): Record<string, Record<string, number>> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, Record<string, number>> = {};
  for (const [day, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
    const values: Record<string, number> = {};
    for (const [k, n] of Object.entries(val as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n)) values[k] = n;
    }
    out[day] = values;
  }
  return out;
}

/* ===== 跨组件共享的键：必须同一份实现，否则一边写一边读会互相抹掉 ===== */

/** 收藏集合（侧栏与工作台共用） */
export function readStarred(): Set<string> {
  return new Set(readJson(KEYS.starred, asStringArray, []));
}

export function writeStarred(ids: Iterable<string>): void {
  writeJson(KEYS.starred, [...new Set(ids)]);
}

export function isStarred(id: string): boolean {
  return readStarred().has(id);
}

/** 翻转某个任务的收藏状态，返回翻转后的值（调用方直接拿去 setState，不再自己算） */
export function toggleStarred(id: string): boolean {
  const set = readStarred();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  writeStarred(set);
  return set.has(id);
}

export function clearStarred(): void {
  writeStarred([]);
}

/** 手动排序：清空时用 remove 而不是写空数组，不在存储里留空壳 */
export function readTaskOrder(): string[] {
  return readJson(KEYS.taskOrder, asStringArray, []);
}

export function writeTaskOrder(ids: string[]): void {
  if (ids.length === 0) removeRaw(KEYS.taskOrder);
  else writeJson(KEYS.taskOrder, ids);
}

/* ===== 复位：界面偏好与用户数据分开，不能一键把人家写的东西也清掉 ===== */

/** 界面偏好：清掉只是回到默认外观与筛选，不丢任何人工写下的内容 */
export const UI_PREFERENCE_KEYS = [
  KEYS.taskOrder,
  KEYS.sidebarGroups,
  KEYS.compareKind,
  KEYS.resultFontSize,
  KEYS.readerFreeze,
  KEYS.readerAliases,
  KEYS.readerSort,
  KEYS.readerGroup,
  KEYS.paperTheme,
] as const;

/** 用户数据：收藏、标签、自定义备注模板与指标快照，清了不可恢复 */
export const USER_DATA_KEYS = [
  KEYS.starred,
  KEYS.tags,
  KEYS.customNoteTemplates,
  KEYS.snapshots,
] as const;

/** 复位界面偏好，返回实际清掉的键（就地回报清了什么，不让人猜） */
export function resetUiPreferences(): string[] {
  const cleared: string[] = [];
  for (const k of UI_PREFERENCE_KEYS) {
    if (readRaw(k) !== null) cleared.push(k);
    removeRaw(k);
  }
  return cleared;
}

/** 连用户数据一起清；返回清掉的键 */
export function resetAllLocal(): string[] {
  const cleared = resetUiPreferences();
  for (const k of USER_DATA_KEYS) {
    if (readRaw(k) !== null) cleared.push(k);
    removeRaw(k);
  }
  return cleared;
}

/** 本机存了多少：给复位入口报规模，字节数按字符串长度估算（够用来提示量级） */
export function localFootprint(): { keys: number; bytes: number; ui: number; data: number } {
  let bytes = 0;
  let ui = 0;
  let data = 0;
  for (const k of UI_PREFERENCE_KEYS) {
    const v = readRaw(k);
    if (v !== null) {
      ui += 1;
      bytes += v.length;
    }
  }
  for (const k of USER_DATA_KEYS) {
    const v = readRaw(k);
    if (v !== null) {
      data += 1;
      bytes += v.length;
    }
  }
  return { keys: ui + data, bytes, ui, data };
}
