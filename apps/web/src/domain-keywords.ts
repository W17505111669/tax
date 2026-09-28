/**
 * 涉税领域词表与「主题补充词」。
 *
 * 两处用途共用同一份词表，避免各写一套：
 * - 结论要点区的关键词芯片（按出现次数取 Top N，点击过滤段落）；
 * - 弱证据引用找官方原文时的检索补充词——百科词条的标题常常只有一两个词
 *   （「研发_百度百科」「中华人民共和国国情」），单独拿去检索命不中任何有用页面，
 *   补上结论里出现最多的领域词才构成一条能用的检索词。
 *
 * 纯函数、无 Node 依赖，服务端（apps/api/src/services/ref-checks.ts）与验证脚本直接复用。
 */

export const DOMAIN_KEYWORDS = [
  "研发费用",
  "加计扣除",
  "土地增值税",
  "扣除项目",
  "核验",
  "比对",
  "底稿",
  "政策依据",
  "限额",
  "置信度",
  "OCR",
  "mermaid",
  "发票",
  "合同",
  "差异",
  "准确率",
];

/** 按出现次数倒序取领域词（次数相同按词表顺序），用于关键词芯片 */
export function topDomainWords(text: string, limit = 8): Array<{ w: string; n: number }> {
  if (!text) return [];
  return DOMAIN_KEYWORDS.map((w) => ({ w, n: text.split(w).length - 1 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/**
 * 主题补充词：从文本里取出现最多的前 maxWords 个领域词，空格连接。
 * 没有命中任何领域词时返回空串，由调用方决定是否只用原始标题检索。
 */
export function topicHint(text: string, maxWords = 2): string {
  return topDomainWords(text, maxWords)
    .map((x) => x.w)
    .join(" ");
}
