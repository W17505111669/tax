/**
 * 渲染前的中文 Markdown 修正：让 marked 能吃下模型实际写出来的那些写法。
 *
 * 界面上「输出成 Markdown 原文」的最后一类残留不在展示位，而在正文渲染里——marked 严格按
 * CommonMark 走，而模型写的是中文习惯的 Markdown，两处对不上就会把记号原样吐出来。
 * 全库 142 个页面实测扫出 11 处，都是这两类：
 *
 * 一、裸地址后面紧跟中文，整段被当成链接
 *    原文「（中瑞财税信息网站，http://www.cntax.cn/list_detail/36801.html）摘要称该公告
 *    「第一条」因…该信息**来自非官方来源，未经核验，不得作为依据引用**。」
 *    gfm 的自动链接只在 ASCII 空白与 `<` 处收尾，中文与全角标点都不算，于是从 http 起
 *    一直到句号整段变成一个 `<a>`：满屏蓝色链接文字、点进去必然 404，段内的 `**` 也不再渲染。
 *    修法是把裸地址显式包成 `<http://…>`，边界由我们自己定，地址尾部沿用 cleanBareUrl 的口径
 *    （全角标点处截断）——引用清单与正文渲染共用同一份清理规则，不各写一套。
 *
 * 二、`**` 紧贴全角标点，CommonMark 判不出强调
 *    原文「**「归集比对」**工作表」。闭合的 `**` 前跟 `」`（标点）、后跟 `工`（非标点非空白），
 *    按 CommonMark 不构成 right-flanking，于是整对 `**` 原样显示。
 *    修法是在 `**` 与紧邻的全角标点之间插一个零宽空格（U+200B）。CommonMark 的 flanking 判定
 *    只看「是不是 Unicode 空白」「是不是 Unicode 标点」，ZWSP 属于 Cf 格式字符，两者都不是，
 *    于是 `**` 两侧都成了合法边界，强调能正常配对。
 *
 *    这里踩过一个坑，记下来：第一版是把标点移到 `**` 外侧（`**（正文）**` → `**（正文**）`），
 *    看着等价，实际把粗体范围改小了，还让本该配对的 `**` 错位——全库扫描的残留从 11 处涨到
 *    253 处。改内容永远比加边界危险，所以现在的判据里有一条硬断言：
 *    「去掉零宽空格后与原文逐字相同」。
 *
 *    也没走「自己拼 `<strong>`」那条路：拼 HTML 就得转义，转义会啃掉地址里的 `&`，
 *    而且 `<strong>` 内部的 Markdown（链接、行内代码）marked 不再解析。
 *
 * 纯函数，便于 apps/api/scripts/verify-mdrender.ts 直接校验。
 */
import { cleanBareUrl } from "./search-evidence.ts";

/** 零宽空格：不是 Unicode 空白也不是标点，正好用来给 `**` 造出合法的 flanking 边界 */
const ZWSP = "\u200b";

/**
 * 「`**` 紧贴全角标点」的判定式：修正逻辑与验证脚本共用同一份，字符集不会两处漂移。
 * 只用于统计有多少份结论受这个问题影响（全角标点是最常见的一种触发写法）。
 */
const CJK_PUNCT = "「『《〈（【“‘」』》〉）】”’";

/**
 * 注意是 new RegExp 的源串，`\\*` 才是正则里的转义星号（写成 `\\\\*` 会变成匹配字面反斜杠）。
 */
export const EMPH_CJK_RE = new RegExp(`(\\*\\*[${CJK_PUNCT}]|[${CJK_PUNCT}]\\*\\*)`);

/**
 * 代码块里的内容一个字都不能动：围栏块与行内代码先换成占位符，改完再还原。
 * 占位符用 \u0000 包起来，正文里不会出现，也不会被强调/地址规则误伤。
 */
function guardCode(text: string): { text: string; restore: (s: string) => string } {
  const stash: string[] = [];
  const guarded = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g, (m) => {
    stash.push(m);
    return `\u0000${stash.length - 1}\u0000`;
  });
  return {
    text: guarded,
    restore: (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? ""),
  };
}

/**
 * 裸地址显式包成 `<http://…>`。
 *
 * 前面不能是 `<`（已经是尖括号自动链接）、引号（HTML 属性里）或字母数字（是别的词的一部分）；
 * 地址本身的字符类排除空白与各类闭合符，尾部再由 cleanBareUrl 剥全角标点。
 * 已写成的 `[标题](地址)` 会被包成 `[标题](<地址>)`——尖括号形式的链接目标同样是合法写法。
 */
export function wrapBareUrls(text: string): string {
  // 字符类里排除 `*` 与零宽空格：前者是强调记号（**https://x**），后者是本模块自己插的边界符，
  // 两者被吃进地址都会让 cleanBareUrl 之后多出一段「尾巴」
  return text.replace(/(?<![<"'=\w])(https?:\/\/[^\s<>"'`)\]}*\u200b]+)/g, (m) => {
    const clean = cleanBareUrl(m);
    if (!/^https?:\/\//i.test(clean)) return m;
    // 匹配吃进来的尾巴要原样放回去：cleanBareUrl 只负责判定地址到哪为止，
    // 第一版直接返回 <clean> 把后面的正文一起删了——实测某任务结论的 `**` 从 116 个变成 113 个，
    // 被删掉的正是「…36801.html）摘要称…**来自非官方来源…**」里那段中文与强调记号。
    return `<${clean}>${m.slice(clean.length)}`;
  });
}

/**
 * 给每个成对的 `**` 内外两侧都插一个零宽空格，让 CommonMark 一定能判定强调边界（内容不动）。
 *
 * 为什么不做成「只在紧贴全角标点时才插」：第一版正是那么写的，结果全库扫描又扫出 17 处
 * `**[账账差异]**「直接投入费用」…`——紧贴的是 ASCII 方括号，同样让闭合的 `**` 判不出
 * right-flanking。逐类枚举标点永远会漏下一类，无条件插反而更简单：ZWSP 不可见，
 * 对本来就能配对的写法毫无影响。
 *
 * `***粗斜体***` 要跳过：那种 marked 本来就能渲染，插手只会把星号拆散。
 */
export function fixCjkEmphasis(text: string): string {
  // 只插入、不搬动、不删除：去掉零宽空格后必须与原文逐字相同（验证脚本有这条硬断言）
  return text.replace(/(?<!\*)\*\*(?!\*)/g, `${ZWSP}**${ZWSP}`);
}

/** 渲染前统一入口：保护代码块 → 包地址 → 修强调 → 还原代码块 */
export function prepareMarkdown(text: string): string {
  const src = String(text ?? "");
  if (!src) return src;
  const { text: guarded, restore } = guardCode(src);
  // 先包地址再插边界符：地址一旦被 <> 定界，强调规则就不会把地址尾巴当成标点处理
  return restore(fixCjkEmphasis(wrapBareUrls(guarded)));
}
