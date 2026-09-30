/**
 * 全平台证据核对台账：每个任务一行，把证据链的九类口径摊成可归档、可导出的表。
 *
 * 单任务的证据核对表回答「这一份材料能不能交」，台账回答「整个项目还有哪些证据欠账」——
 * 归档与答辩都需要后者。行数据由服务端按与任务页完全相同的纯函数算出，
 * 这里只负责排序、合计与两种导出格式（Markdown / CSV），因此界面、下载文件与验证脚本不会各说一套。
 */

import { mdCell } from "./run-tools.ts";

import { csvBody, CSV_BOM, csvField } from "./csv.ts";

// 台账的 CSV 口径全部走 csv.ts，这里只做转出口：AgentOverview 与验证脚本的导入不必改
export { CSV_BOM, csvField };

export type LedgerRow = {
  taskId: string;
  title: string;
  agentId: string;
  status: string;
  /** 政策文号：总数 / 有出处 / 仍无出处 / 复查判定 matched / 有出处中靠复查取得的 */
  docRefTotal: number;
  docRefTraced: number;
  docRefPending: number;
  docRefMatched: number;
  /** docRefTraced 里靠联网复查取得出处的条数（工具留存结果里没有该文号），已含在 docRefTraced 内 */
  docRefTracedByRecheck: number;
  /** 联网引用：总数 / 官方来源（含官方解读页）/ 证据力弱 / 弱证据中已找到替代来源 */
  citations: number;
  official: number;
  weak: number;
  replaced: number;
  /** weak 中已在结论里声明「仅作背景参考，不作为政策依据」的条数：交代过就不算欠账 */
  weakDisclaimed: number;
  /** weak 中只在检索留存里、从未进入结论正文的条数：不是交付依据，也不算欠账 */
  weakUncited: number;
  /** 联网检索：调用次数 / 只留元数据次数 / 拦下的无关结果条数 */
  searchCalls: number;
  searchMetadataOnly: number;
  searchDropped: number;
  /** 结论金额：总数 / 待人工确认 */
  amountTotal: number;
  amountPending: number;
  /** 本次修订对证据影响的总体判断；没有可对比轮次时为 null */
  revision: string | null;
};

export type LedgerTotals = {
  tasks: number;
  docRefTotal: number;
  docRefTraced: number;
  docRefPending: number;
  docRefMatched: number;
  docRefTracedByRecheck: number;
  citations: number;
  official: number;
  weak: number;
  replaced: number;
  weakDisclaimed: number;
  weakUncited: number;
  searchCalls: number;
  searchMetadataOnly: number;
  searchDropped: number;
  amountTotal: number;
  amountPending: number;
  /** 仍有欠账的任务数（弱证据引用或待复查文号大于 0） */
  withGaps: number;
  /** 修订影响可对比的任务数与其中改善的数量 */
  revisionCompared: number;
  revisionImproved: number;
};

/**
 * 单行欠账数：待处置的弱证据引用 + 复查后仍无出处的文号（排序与合计共用）。
 * 两类弱证据不算欠账：结论里已写明「不作为政策依据」的（再去催替换只是噪音，实测一个任务 14 条
 * 弱证据里 8 条属于这种），以及只在检索留存里、从未进入结论正文的（不是这份交付材料的依据，也没处
 * 补标注，实测 9 条待处置里 6 条属于这种）。
 */
export function rowGap(r: LedgerRow): number {
  return Math.max(0, r.weak - r.weakDisclaimed - r.weakUncited) + r.docRefPending;
}

/** 台账排序：欠账多的在前，其次按作品与标题，保证同一批数据每次导出的行序一致 */
export function ledgerSort(rows: LedgerRow[]): LedgerRow[] {
  return [...rows].sort(
    (a, b) => rowGap(b) - rowGap(a) || a.agentId.localeCompare(b.agentId) || a.title.localeCompare(b.title),
  );
}

/** 合计：每列求和，另给「仍有欠账的任务数」与修订影响可比数 */
export function ledgerTotals(rows: LedgerRow[]): LedgerTotals {
  const t: LedgerTotals = {
    tasks: rows.length,
    docRefTotal: 0,
    docRefTraced: 0,
    docRefPending: 0,
    docRefMatched: 0,
    docRefTracedByRecheck: 0,
    citations: 0,
    official: 0,
    weak: 0,
    replaced: 0,
    weakDisclaimed: 0,
    weakUncited: 0,
    searchCalls: 0,
    searchMetadataOnly: 0,
    searchDropped: 0,
    amountTotal: 0,
    amountPending: 0,
    withGaps: 0,
    revisionCompared: 0,
    revisionImproved: 0,
  };
  for (const r of rows) {
    t.docRefTotal += r.docRefTotal;
    t.docRefTraced += r.docRefTraced;
    t.docRefPending += r.docRefPending;
    t.docRefMatched += r.docRefMatched;
    t.docRefTracedByRecheck += r.docRefTracedByRecheck;
    t.citations += r.citations;
    t.official += r.official;
    t.weak += r.weak;
    t.replaced += r.replaced;
    t.weakDisclaimed += r.weakDisclaimed;
    t.weakUncited += r.weakUncited;
    t.searchCalls += r.searchCalls;
    t.searchMetadataOnly += r.searchMetadataOnly;
    t.searchDropped += r.searchDropped;
    t.amountTotal += r.amountTotal;
    t.amountPending += r.amountPending;
    if (rowGap(r) > 0) t.withGaps += 1;
    if (r.revision !== null) {
      t.revisionCompared += 1;
      if (r.revision === "证据质量改善") t.revisionImproved += 1;
    }
  }
  return t;
}

export const LEDGER_COLUMNS = [
  "任务",
  "作品",
  "状态",
  "文号 有出处/总数",
  "其中复查取得",
  "待复查",
  "复查到出处",
  "引用数",
  "官方来源",
  "证据力弱",
  "已声明背景参考",
  "未进结论正文",
  "替代来源就绪",
  "检索次数",
  "仅元数据",
  "拦下无关",
  "金额 待确认/总数",
  "修订影响",
] as const;

/** 一行的取值（表头与取值分开定义，MD 与 CSV 共用，避免两份列序对不上） */
export function ledgerCells(r: LedgerRow, agentName: (id: string) => string): string[] {
  return [
    r.title,
    agentName(r.agentId),
    r.status,
    `${r.docRefTraced}/${r.docRefTotal}`,
    String(r.docRefTracedByRecheck),
    String(r.docRefPending),
    String(r.docRefMatched),
    String(r.citations),
    String(r.official),
    String(r.weak),
    String(r.weakDisclaimed),
    String(r.weakUncited),
    String(r.replaced),
    String(r.searchCalls),
    String(r.searchMetadataOnly),
    String(r.searchDropped),
    `${r.amountPending}/${r.amountTotal}`,
    r.revision ?? "—",
  ];
}

/** 台账 CSV（不含 BOM；下载时前置 CSV_BOM），行序与 MD 一致 */
export function ledgerCsv(rows: LedgerRow[], agentName: (id: string) => string = (x) => x): string {
  const t = ledgerTotals(rows);
  return csvBody([
    LEDGER_COLUMNS,
    ...ledgerSort(rows).map((r) => ledgerCells(r, agentName)),
    [
      `合计（${t.tasks} 个任务）`,
      "",
      "",
      `${t.docRefTraced}/${t.docRefTotal}`,
      t.docRefTracedByRecheck,
      t.docRefPending,
      t.docRefMatched,
      t.citations,
      t.official,
      t.weak,
      t.weakDisclaimed,
      t.weakUncited,
      t.replaced,
      t.searchCalls,
      t.searchMetadataOnly,
      t.searchDropped,
      `${t.amountPending}/${t.amountTotal}`,
      `可比 ${t.revisionCompared} · 改善 ${t.revisionImproved}`,
    ],
  ]);
}

/** 台账 Markdown（含合计行与口径说明） */
export function ledgerMarkdown(
  rows: LedgerRow[],
  agentName: (id: string) => string = (x) => x,
  generatedAt = "",
): string[] {
  const t = ledgerTotals(rows);
  const sorted = ledgerSort(rows);
  const lines = [
    "# 全平台证据核对台账",
    "",
    ...(generatedAt === "" ? [] : [`- 生成时间：${generatedAt}`]),
    `- 任务数：${t.tasks}　仍有证据欠账的任务：${t.withGaps}`,
    `- 政策文号：${t.docRefTotal} 处（有出处 ${t.docRefTraced}，其中复查取得 ${t.docRefTracedByRecheck} · 仍无出处 ${t.docRefPending} · 复查判定 matched ${t.docRefMatched}）`,
    `- 联网引用：${t.citations} 条（官方来源 ${t.official} · 证据力弱 ${t.weak}，其中 ${t.replaced} 条已找到替代来源待写回结论${
      t.weakDisclaimed > 0 ? ` · ${t.weakDisclaimed} 条已在结论中声明为背景参考、不作为依据` : ""
    }${t.weakUncited > 0 ? ` · ${t.weakUncited} 条只在检索留存里、未进入结论正文` : ""}）`,
    `- 联网检索：${t.searchCalls} 次（只留查询元数据 ${t.searchMetadataOnly} 次）· 拦下无关结果与门户首页 ${t.searchDropped} 条`,
    `- 结论金额：${t.amountTotal} 处，待人工确认 ${t.amountPending} 处`,
    `- 修订影响：${t.revisionCompared} 个任务有可对比的两轮结论，其中 ${t.revisionImproved} 个改善`,
    "",
    `| ${LEDGER_COLUMNS.join(" | ")} |`,
    `| ${LEDGER_COLUMNS.map(() => "---").join(" | ")} |`,
  ];
  for (const r of sorted) {
    lines.push(`| ${ledgerCells(r, agentName).map(mdCell).join(" | ")} |`);
  }
  lines.push(
    `| ${[
      `**合计（${t.tasks} 个任务）**`,
      "",
      "",
      `${t.docRefTraced}/${t.docRefTotal}`,
      String(t.docRefTracedByRecheck),
      String(t.docRefPending),
      String(t.docRefMatched),
      String(t.citations),
      String(t.official),
      String(t.weak),
      String(t.weakDisclaimed),
      String(t.weakUncited),
      String(t.replaced),
      String(t.searchCalls),
      String(t.searchMetadataOnly),
      String(t.searchDropped),
      `${t.amountPending}/${t.amountTotal}`,
      `可比 ${t.revisionCompared} · 改善 ${t.revisionImproved}`,
    ]
      .map(mdCell)
      .join(" | ")} |`,
  );
  lines.push(
    "",
    "口径说明：",
    "",
    "- 「文号 有出处/总数」按政策文号溯源口径：结论中的文号核心部分归一化后，能在工具留存结果里找到出处，或联网复查已判定 matched；",
    "- 「其中复查取得」是工具留存里没有、靠联网复查才拿到出处的处数，已包含在「有出处」内，不再另计；",
    "- 「待复查」是仍然没有出处的处数，「复查到出处」是联网复查判定为 matched 的处数（含原本就能从工具留存溯源的）；",
    "- 「证据力弱」指引用指向门户首页、百科词条或检索结果页，不能替代政策原文；「替代来源就绪」是已检索到官方原文、等人工写回结论的条数；",
    "- 「拦下无关」是检索结果里被相关度门槛与入口页规则过滤掉的条数（含历史记录按现行规则回算的部分）；",
    "- 行序按欠账数（证据力弱 + 待复查）倒序，同数按作品与标题，保证同一批数据每次导出行序一致。",
  );
  return lines;
}
