/**
 * 阅读器「查找」的纯逻辑：命中区间、计数、高亮分段、环形序号。
 *
 * 之前三份口径互不一致：计数用 `String.split`、文本高亮用 `RegExp split`、
 * markdown 的 DOM 包裹用 `indexOf` 且只标每个文本节点的第一处——于是一段里出现三次
 * 只高亮一次，计数器却写着 3，「下一处」按 3 取模在 1 个 mark 上跳，看起来就是点不动。
 * 这里统一成一份区间扫描，文本渲染与 DOM 后处理共用。
 *
 * 大小写不敏感的做法是拿小写副本定位、再用同一下标切原文；对「土耳其语 İ」一类
 * 小写后长度会变的字符可能有偏差，业务文本（中文、数字、ASCII）不受影响。
 */

export type FindRange = { start: number; end: number };

/** 查找命中区间：大小写不敏感、不重叠、按出现顺序；空查询或查不到返回空数组 */
export function findRanges(text: string, query: string): FindRange[] {
  const q = query.trim();
  if (!text || q === "") return [];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: FindRange[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
  return out;
}

export function countMatches(text: string, query: string): number {
  return findRanges(text, query).length;
}

/** 高亮分段：渲染层据此决定哪一段包 mark，命中段保留原文大小写 */
export function splitForHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const ranges = findRanges(text, query);
  if (ranges.length === 0) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: false } | { text: string; hit: true }> = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), hit: false });
    out.push({ text: text.slice(r.start, r.end), hit: true });
    cursor = r.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

/** 环形序号：把任意整数折回 [0, len)；len<=0 或非有限数一律给 0，不产出 NaN 或负下标 */
export function wrapIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || !Number.isFinite(len) || len <= 0) return 0;
  return ((Math.trunc(i) % len) + len) % len;
}

/** 上一处 / 下一处：delta 为负也能正确回绕 */
export function stepIndex(current: number, delta: number, len: number): number {
  return wrapIndex(current + delta, len);
}

/** 命中计数文案：没有命中如实写「0 处」，不写「1/0」 */
export function matchLabel(current: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0 处";
  return `${wrapIndex(current, total) + 1}/${total}`;
}
