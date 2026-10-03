/**
 * 底稿比对的「模式」判据与标签：一处定义，比对页、测试报告、平台统计三处共用。
 *
 * 此前三处各写各的，对同一批记录给出三个不同答案。实测 26f91720「底稿比对准确率闭环」的
 * 4 条比对记录里 `sheets[0].mode` 字段根本不存在（当时写入侧还没落这个字段）：
 * - 比对页写 `mode === "address" ? "地址模式" : "记录级模式"`，于是显示「记录级模式」——
 *   凭空断言了一个库里没有的属性；
 * - `summarizeTaskCompares` 判 `mode !== "record"` 就跳过，于是该任务对平台累计一致率的贡献是 0；
 * - 测试报告在「没有记录级比对」时兜底查 `sheets[0].mode === "address"`，查不到就把准确率列留成
 *   `—`。同一行的工具链列明明写着 4 次 `compare_workpapers`，准确率列却说「没有数据」——
 *   行内自相矛盾，而且没有任何门禁发现（09-29 那份报告里这格还是「0%（地址模式）」，
 *   判据收紧之后它静默退化成了 `—`）。
 *
 * 缺失就是缺失，不猜也不兜底成某一档：单列 `unrecorded`。工具将来若新增模式，落进 `unknown`
 * 并把原始取值带出来，而不是被静默归进「记录级」——那正是本轮要修的毛病。
 */

/** 工具真正会落的两种模式：record 数记录条数，address 数单元格，两者不是一个量纲 */
export const COMPARE_MODES = ["record", "address"] as const;

export type CompareMode = (typeof COMPARE_MODES)[number];

/** 一条比对记录的模式情形：两种已知模式 / 当时没落这个字段 / 落了但取值不在名单里 */
export type CompareModeState = CompareMode | "unrecorded" | "unknown";

export const COMPARE_MODE_LABEL: Record<CompareModeState, string> = {
  record: "记录级模式",
  address: "地址模式",
  unrecorded: "模式未记录",
  unknown: "未知模式",
};

/** 只看第一个工作表：实测全库 13 条比对记录的 sheets 长度都是 0 或 1，没有混合模式 */
export function compareModeOf(sheets: Array<{ mode?: string }> | undefined | null): CompareModeState {
  const raw = sheets?.[0]?.mode;
  if (raw === undefined || raw === null || raw === "") return "unrecorded";
  return (COMPARE_MODES as readonly string[]).includes(raw) ? (raw as CompareMode) : "unknown";
}

/** 界面上的模式文案。unknown 带上原始取值，否则新增模式会被显示成一个查不到出处的词 */
export function compareModeLabel(state: CompareModeState, raw?: string): string {
  if (state === "unknown" && raw) return `${COMPARE_MODE_LABEL.unknown}（${raw}）`;
  return COMPARE_MODE_LABEL[state];
}
