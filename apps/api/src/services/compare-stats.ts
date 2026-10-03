/**
 * 记录级底稿比对的统计口径：一份实现，平台看板、作品说明与测试报告共用。
 *
 * 此前这三处各写了一遍「取每个任务最近一次记录级比对、再合计」，口径改一次就要同步改三处
 *（历史上已经因此出现过报告 60% 对看板 33.33% 的分歧）。这次要把两类比对分开，更不能各写一份。
 *
 * 两类比对必须分开，否则一个数字里混着两种完全不同的事：
 * 1. **同行评审**：自动生成的底稿 vs 人工参考底稿。一致率回答「填得对不对」，覆盖率回答「填得全不全」。
 * 2. **与自己的原始模板核对**：填列产物 vs 它由之生成的那份空白模板。模板本来是空的，只有一侧有的
 *    格子正是填进去的值——算成覆盖缺口就等于把「填了多少」记成「漏了多少」（实测 ff4c9a3c 一次
 *    这样的比对贡献了全平台 12 处 onlyA，累计覆盖率从 100% 掉到 36.84%）。
 *
 * 分类靠产物溯源（填列/生成类调用的 outputName ← fileName）精确判定，不按 kind 或文件名前缀猜：
 * 实测「artifact vs upload」两种情况都出现过，另一种的 upload 是人工参考底稿，属同行评审。
 */
import { compareRates, rateText } from "@tax/document-tools";
// 模式判据与界面、测试报告共用一份：三处各写一遍时对同一批记录给出过三个不同答案
import { compareModeOf } from "../../../web/src/compare-mode.ts";

export type CompareCall = {
  tool_name: string;
  ok: number | null;
  args: string | null;
  result: string | null;
  started_at: string | null;
};

/** 落库记录里的计数可能缺字段（比率拆分上线前的旧记录），一律按 0 处理 */
function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 产物溯源表：outputName ← fileName */
export function buildDerivedFrom(calls: Array<{ args: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const call of calls) {
    if (!call.args) continue;
    try {
      const a = JSON.parse(call.args) as { fileName?: unknown; outputName?: unknown };
      if (typeof a.outputName === "string" && typeof a.fileName === "string") out.set(a.outputName, a.fileName);
    } catch {
      // 忽略坏入参
    }
  }
  return out;
}

/** 这次比对是不是「填列产物 vs 它自己的原始模板」 */
export function isTemplateCompare(args: string | null, derivedFrom: Map<string, string>): boolean {
  if (!args || derivedFrom.size === 0) return false;
  try {
    const parsed = JSON.parse(args) as { a?: { name?: unknown }; b?: { name?: unknown } };
    const a = parsed.a?.name;
    const b = parsed.b?.name;
    return typeof a === "string" && typeof b === "string" && derivedFrom.get(a) === b;
  } catch {
    return false;
  }
}

export type PeerCompare = {
  /** 该任务最近一次同行评审比对的时间（空串表示没有） */
  at: string;
  compared: number;
  matched: number;
  mismatched: number;
  onlyA: number;
  onlyB: number;
  accuracyPercent: number | null;
};

export type TemplateCompare = {
  runs: number;
  /** 只在填列产物一侧出现的单元格数，即本次填列新增的值 */
  filledCells: number;
  /** 与模板既有内容不一致的单元格数：填列改坏了模板原有内容才算问题 */
  mismatched: number;
  at: string;
};

export type TaskCompareSummary = {
  peer: PeerCompare | null;
  /** 该任务同行评审比对的总次数（含被后来那次取代的），用于如实报「共比对几次」 */
  peerRuns: number;
  template: TemplateCompare;
};

/**
 * 单个任务的比对汇总：同行评审只取**最近一次**（同一任务反复比对时，早先的结果已被后来那轮取代），
 * 模板核对逐次累加。「最近一次」按调用开始时间判定，不按遍历顺序——早先按顺序取最后一条，
 * 实测取到过 09-28 的旧比对而不是 09-29 的最新一次。
 */
export function summarizeTaskCompares(calls: CompareCall[]): TaskCompareSummary {
  const derivedFrom = buildDerivedFrom(calls);
  const template: TemplateCompare = { runs: 0, filledCells: 0, mismatched: 0, at: "" };
  let peer: PeerCompare | null = null;
  let peerRuns = 0;
  for (const call of calls) {
    if (call.tool_name !== "compare_workpapers" || call.ok !== 1 || !call.result) continue;
    let parsed: {
      sheets?: Array<{ mode?: string }>;
      totals?: {
        accuracyPercent?: number;
        compared?: number;
        matched?: number;
        mismatched?: number;
        onlyA?: number;
        onlyB?: number;
      };
    };
    try {
      parsed = JSON.parse(call.result) as typeof parsed;
    } catch {
      continue;
    }
    // 只认记录级比对：逐格（address）比对数的是单元格，与记录级不是同一个量纲，混在一起就没法解释
    // mode 缺失的记录同样不计入（量纲无从判断）；这一档在界面上如实显示「模式未记录」，
    // 要不要按形状推断成记录级并计入累计，是会动对外一致率的决定，留给人拍板（见 phase0 文档）
    if (compareModeOf(parsed.sheets) !== "record" || parsed.totals?.accuracyPercent === undefined) continue;
    const at = String(call.started_at ?? "");
    if (isTemplateCompare(call.args, derivedFrom)) {
      template.runs += 1;
      template.filledCells += numOf(parsed.totals.onlyA);
      template.mismatched += numOf(parsed.totals.mismatched);
      if (at >= template.at) template.at = at;
      continue;
    }
    peerRuns += 1;
    if (peer !== null && at < peer.at) continue;
    peer = {
      at,
      compared: numOf(parsed.totals.compared),
      matched: numOf(parsed.totals.matched),
      mismatched: numOf(parsed.totals.mismatched),
      onlyA: numOf(parsed.totals.onlyA),
      onlyB: numOf(parsed.totals.onlyB),
      accuracyPercent: numOf(parsed.totals.accuracyPercent),
    };
  }
  return { peer, peerRuns, template };
}

/** 多个任务的同行评审合计与两个拆分比率（比率一律用原始计数现算，不读记录里的字段） */
export function aggregatePeerCompares(rows: Array<PeerCompare | null>): {
  runs: number;
  compared: number;
  matched: number;
  mismatched: number;
  onlyA: number;
  onlyB: number;
  matchRatePercent: number | null;
  coveragePercent: number | null;
  accuracyPercent: number | null;
  latestAt: string;
} {
  const found = rows.filter((r): r is PeerCompare => r !== null);
  const sum = (f: (r: PeerCompare) => number): number => found.reduce((a, r) => a + f(r), 0);
  const matched = sum((r) => r.matched);
  const mismatched = sum((r) => r.mismatched);
  const onlyA = sum((r) => r.onlyA);
  const compared = sum((r) => r.compared);
  const rates = compareRates(matched, mismatched, onlyA);
  const latest = found.reduce((a, r) => (r.at >= a ? r.at : a), "");
  return {
    runs: found.length,
    compared,
    matched,
    mismatched,
    onlyA,
    onlyB: sum((r) => r.onlyB),
    matchRatePercent: rates.matchRatePercent,
    coveragePercent: rates.coveragePercent,
    accuracyPercent: compared > 0 ? Math.round((matched / compared) * 10000) / 100 : null,
    latestAt: latest,
  };
}

/** 一次比对在库里的留存：工具留下的计数 + 由计数现算的两个比率与它们的文案 */
export type StoredCompare = {
  id: string;
  at: string | null;
  /** 工具返回的 details 原样留存；空对象 / 坏 JSON 时为 null */
  result: Record<string, unknown> | null;
  /** 归一化后的计数；库里没有 totals（实测 13 条比对留存里有 2 条是空对象）时为 null */
  totals: {
    compared: number;
    matched: number;
    mismatched: number;
    onlyA: number;
    onlyB: number;
    accuracyPercent: number;
  } | null;
  rates: {
    matchRatePercent: number | null;
    coveragePercent: number | null;
    /** 与工具返回文本、看板、作品说明同一份 rateText：算不出来写「无可比对项」，不写 0% 也不写 — */
    matchRateText: string;
    coverageText: string;
  } | null;
};

/**
 * 从工具调用历史里取出比对留存：一份实现，`/api/tasks/:id/compares` 与 scan:uimd 的比对页数字核对共用。
 *
 * 比率一律由原始计数现算（compareRates），不读留存里的百分比字段——实测 11 条有结果的留存里 10 条是
 * 「比率拆分」上线前留下的，压根没有 matchRatePercent / coveragePercent，读字段的话这一屏对绝大多数
 * 历史记录都是空的，而工具当时的返回文本里明明写了这两个比率。
 */
export function listStoredCompares(calls: Array<Record<string, unknown>>): StoredCompare[] {
  const out: StoredCompare[] = [];
  for (const call of calls) {
    if (String(call.tool_name ?? "") !== "compare_workpapers") continue;
    if (call.ok !== 1) continue;
    const raw = typeof call.result === "string" ? call.result : "";
    if (raw === "") continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const rawTotals = parsed?.totals;
    const totals: StoredCompare["totals"] =
      rawTotals && typeof rawTotals === "object"
        ? {
            compared: numOf((rawTotals as Record<string, unknown>).compared),
            matched: numOf((rawTotals as Record<string, unknown>).matched),
            mismatched: numOf((rawTotals as Record<string, unknown>).mismatched),
            onlyA: numOf((rawTotals as Record<string, unknown>).onlyA),
            onlyB: numOf((rawTotals as Record<string, unknown>).onlyB),
            accuracyPercent: numOf((rawTotals as Record<string, unknown>).accuracyPercent),
          }
        : null;
    const r = totals ? compareRates(totals.matched, totals.mismatched, totals.onlyA) : null;
    out.push({
      id: String(call.id ?? ""),
      at: typeof call.ended_at === "string" ? call.ended_at : null,
      result: parsed,
      totals,
      rates: r
        ? {
            matchRatePercent: r.matchRatePercent,
            coveragePercent: r.coveragePercent,
            matchRateText: rateText(r.matchRatePercent),
            coverageText: rateText(r.coveragePercent),
          }
        : null,
    });
  }
  return out;
}
