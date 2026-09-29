/**
 * 修订模式（只改依据与引用）的工具黑名单。
 *
 * 只在修订指令里写「不要重新调用业务工具」是不够的：实测一次补引用出处的续跑里，
 * Agent 顺手重新调用了 generate_workpaper，新底稿把三行归集数写成 54 行明细，
 * 紧接着那次记录级比对 0/54 命中，平台比对准确率从 60% 掉到 1.79%——
 * 上一轮的交付证据被替换掉了，而且界面上看不出是谁干的。
 *
 * 所以修订模式下这些工具直接从本轮会话里摘掉：模型调不到，就不会误伤。
 * 保留检索与读取类工具（web_search / fetch_public_document / search_rd_policy /
 * search_public_cases / inspect_workpaper_template），补出处时仍需要打开原文核对标题。
 *
 * 纯数据 + 纯函数，便于验证脚本直接校验。
 */

export const REVISION_BLOCKED_TOOLS: readonly string[] = [
  // 会重新生成产物：底稿、模板填列结果、关系图
  "generate_workpaper",
  "fill_land_vat_workpaper",
  "render_matching_diagram",
  // 会新增比对记录：记录级比对准确率是平台 KPI，重跑一次就把上一轮的交付证据替换掉
  "compare_workpapers",
  // 会重写解析与抽取记录
  "parse_uploaded_files",
  "parse_invoice",
  "parse_contract",
  // 会改变测算结果与差异认定，而修订只允许动依据与引用
  "check_rd_expenses",
  "calculate_rd_adjustment",
  "match_invoice_ledger",
  "match_contract_invoice",
  "check_amount_consistency",
];

/** 修订模式下仍然可用的工具（检索与读取类），列出来是为了让界面能说明「本轮能做什么」 */
export const REVISION_ALLOWED_TOOLS: readonly string[] = [
  "web_search",
  "fetch_public_document",
  "search_rd_policy",
  "search_public_cases",
  "inspect_workpaper_template",
];

export function isRevisionBlocked(toolName: string): boolean {
  return REVISION_BLOCKED_TOOLS.includes(toolName);
}

/** 从工具清单里摘掉黑名单工具；原数组不变 */
export function revisionAllowedTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => !isRevisionBlocked(t.name));
}

/** 实际被摘掉的工具名（用于事件留痕与界面提示，让人知道本轮为什么少了几件工具） */
export function revisionBlockedNames<T extends { name: string }>(tools: T[]): string[] {
  return tools.filter((t) => isRevisionBlocked(t.name)).map((t) => t.name);
}
