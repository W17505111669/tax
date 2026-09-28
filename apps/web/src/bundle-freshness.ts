/**
 * 交付包新鲜度：判断「上次打包之后任务是否又变过」，避免把过期的交付包发出去。
 * 变更来源包括新事件、产物更新、复核提交、金额核对与链接核验。
 * 纯函数，便于 apps/api/scripts/verify-bundle-freshness.ts 直接校验。
 */

export type ChangeStamp = { at: string; label: string };

export type BundleFreshness = {
  /** 最近一次打包时间；null 表示从未打包 */
  lastPackedAt: string | null;
  /** 打包之后的变更，按时间倒序 */
  newer: ChangeStamp[];
  /** 是否已过期（打包后仍有变更） */
  stale: boolean;
  /** 全部变更里最新的一条，用于提示「最近变更是什么」 */
  latest: ChangeStamp | null;
};

function ts(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function bundleFreshness(lastPackedAt: string | null, changes: ChangeStamp[]): BundleFreshness {
  const valid = changes
    .map((c) => ({ ...c, t: ts(c.at) }))
    .filter((c): c is ChangeStamp & { t: number } => c.t !== null)
    .sort((a, b) => b.t - a.t);
  const packed = ts(lastPackedAt);
  const latest = valid.length > 0 ? { at: valid[0]!.at, label: valid[0]!.label } : null;
  if (packed === null) return { lastPackedAt: null, newer: [], stale: false, latest };
  // 严格晚于打包时间才算变更；同一时刻（同一次操作触发）不视为过期
  const newer = valid.filter((c) => c.t > packed).map((c) => ({ at: c.at, label: c.label }));
  return { lastPackedAt, newer, stale: newer.length > 0, latest };
}

/** 提示文案：未打包 / 已过期（含最近一条变更）/ 仍是最新 */
export function freshnessText(f: BundleFreshness): string {
  if (f.lastPackedAt === null) return "尚未打包";
  if (f.stale) {
    const first = f.newer[0];
    return `打包后又有 ${f.newer.length} 处变更${first ? `（最近：${first.label}）` : ""}，建议重新打包`;
  }
  return "交付包仍是最新";
}

/** 打包按钮文案：打包后又有变更时改口「重新打包」，避免按钮看起来仍是最新 */
export function bundleButtonLabel(f: BundleFreshness, busy = false): string {
  if (busy) return "打包中…";
  return f.stale ? "重新打包" : "打包下载";
}

/** 打包按钮提示：过期时把打包后的变更按类型合并计数列出来 */
export function bundleButtonTitle(f: BundleFreshness, base: string): string {
  if (!f.stale || f.newer.length === 0) return base;
  const counts = new Map<string, number>();
  for (const c of f.newer) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  const parts = [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  return `${base}\n上次打包后又有 ${f.newer.length} 处变更（${parts.join("、")}），交付包已过期，请重新打包`;
}
