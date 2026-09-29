/**
 * 验证脚本：联网引用证据力分级（分级口径 / 与检索过滤口径交叉核对 / 真实任务引用走查）。
 * 运行：pnpm verify:citegrade
 */
import { isAuthoritativeUrl, isEncyclopediaUrl as isEncyclopediaNode, isEntryPage } from "@tax/business-tools";
import {
  gradeCitation,
  GRADE_HINT,
  GRADE_TEXT,
  isEncyclopediaUrl,
  isEntryUrl,
  isOfficialUrl,
  isSearchResultUrl,
  summarizeGrades,
  WEAK_TEXT,
} from "../../web/src/citation-grade.ts";
import { db } from "../src/db.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

// 1) 分级口径
expect(
  "政策法规库原文判为官方",
  gradeCitation("https://fgk.chinatax.gov.cn/zcfgk/c100012/c5197801/content.html").grade,
  "official",
);
expect("政府站点 PDF 判为官方", gradeCitation("https://www.most.gov.cn/xxgk/a/P020250926369462261750.pdf").grade, "official");
expect("部委首页判为弱（入口页）", gradeCitation("https://www.mnr.gov.cn/").weak, "entry");
expect("门户栏目页判为弱（入口页）", gradeCitation("https://www.gov.cn/guoqing/").weak, "entry");
expect("12366 首页判为弱（入口页）", gradeCitation("https://12366.chinatax.gov.cn/").weak, "entry");
expect("登录页判为弱（入口页）", gradeCitation("https://etax.xinjiang.chinatax.gov.cn:8443/loginb/").weak, "entry");
expect("index_pc.html 变体也是入口页", isEntryUrl("https://www.nda.gov.cn/sjj/index_pc.html"), true);
expect("变体入口页不再被判成官方原文", gradeCitation("https://www.nda.gov.cn/sjj/index_pc.html").grade, "weak");
expect("index-m.html 是入口页", isEntryUrl("https://www.gov.cn/index-m.html"), true);
expect("default.aspx 是入口页", isEntryUrl("https://www.chinatax.gov.cn/default.aspx"), true);
expect("homepage.htm 是入口页", isEntryUrl("https://www.mof.gov.cn/homepage.htm"), true);
expect("栏目下的 index.shtml 是入口页", isEntryUrl("https://www.gov.cn/zhengce/index.shtml"), true);
expect("真正的文件页不受影响", isEntryUrl("https://www.gov.cn/zhengce/content/2023-08/28/content_6900000.htm"), false);
expect(
  "多层路径的文件页不受影响",
  isEntryUrl("https://www.chinatax.gov.cn/n810341/n810755/c101434/c5097638/content.html"),
  false,
);
expect("search2024.html 判为检索页（功能页，没有文件内容）", isEntryUrl("https://www.gov.cn/search2024.html"), true);
expect(
  "research 报告页不因含 search 字样被误判",
  isEntryUrl("https://www.gov.cn/research-report-2024.html"),
  false,
);
expect("App 下载页判为功能页", isEntryUrl("https://app.gjzwfw.gov.cn/fwmhapp/downloadApp/android.html"), true);
expect("工具页判为功能页", isEntryUrl("https://12366.chinatax.gov.cn/wap/pages/tools.html"), true);
expect("App 下载页不再分级为官方原文", gradeCitation("https://app.gjzwfw.gov.cn/fwmhapp/downloadApp/android.html", "国家政务服务平台").grade, "weak");
expect(
  "政策原文页不因功能页规则被误伤",
  isEntryUrl("https://www.gov.cn/zhengce/content/2023-08/28/content_6900000.htm"),
  false,
);
expect(
  "税务实务库法规页不被误伤",
  isEntryUrl("https://www.shui5.cn/article/ae/10559.html"),
  false,
);
expect(
  "12366 详情页不被误伤",
  isEntryUrl("https://12366.chinatax.gov.cn/fwtz/detail?bh=e42d800091014105b4342"),
  false,
);
expect("政策文件名里带 index 字样不误判", isEntryUrl("https://www.gov.cn/zhengce/2024/index-cpi-report.htm"), false);
expect("百科词条判为弱", gradeCitation("https://baike.baidu.com/item/%E5%9C%9F%E5%9C%B0/12005092").weak, "encyclopedia");
expect("MBA 智库百科判为弱", gradeCitation("https://wiki.mbalib.com/wiki/%E7%A0%94%E5%8F%91").weak, "encyclopedia");
expect("标题带百度百科也判为弱", gradeCitation("https://example.com/a/b.html", "研发（科学研究）_百度百科").weak, "encyclopedia");
expect("检索结果页判为弱", gradeCitation("https://www.bing.com/search?q=%E7%A0%94%E5%8F%91").weak, "search");
expect("百度搜索页判为弱", gradeCitation("https://www.baidu.com/s?wd=%E7%A0%94%E5%8F%91").weak, "search");
expect("知乎专栏文章判为专业来源", gradeCitation("https://zhuanlan.zhihu.com/p/513504457").grade, "professional");
expect("税务师事务所文章判为专业来源", gradeCitation("https://www.shui5.cn/article/9f/12345.html").grade, "professional");
expect("无法解析的地址判为弱", gradeCitation("不是网址").weak, "unparsable");
expect("空地址判为弱", gradeCitation("").weak, "unparsable");
expect("弱证据都有可读原因", gradeCitation("https://www.mnr.gov.cn/").reason, WEAK_TEXT.entry);
expect("官方来源有可读原因", gradeCitation("https://fgk.chinatax.gov.cn/zcfgk/c100012/c5197801/content.html").reason.length > 0, true);
expect("三级文案齐全", [GRADE_TEXT.official, GRADE_TEXT.professional, GRADE_TEXT.weak].every((s) => s.length > 0), true);
expect("三级提示齐全", [GRADE_HINT.official, GRADE_HINT.professional, GRADE_HINT.weak].every((s) => s.length > 0), true);
expect("检索页识别不影响普通页面", isSearchResultUrl("https://zhuanlan.zhihu.com/p/513504457"), false);

// 2) 汇总
const list = [
  { url: "https://fgk.chinatax.gov.cn/zcfgk/c100012/c5197801/content.html" },
  { url: "https://zhuanlan.zhihu.com/p/513504457" },
  { url: "https://www.mnr.gov.cn/" },
  { url: "https://baike.baidu.com/item/%E5%9C%9F%E5%9C%B0/12005092" },
];
expect("汇总总数", summarizeGrades(list).total, 4);
expect("汇总分级", summarizeGrades(list), { total: 4, official: 1, professional: 1, weak: 2 });
expect("空清单汇总", summarizeGrades([]), { total: 0, official: 0, professional: 0, weak: 0 });
expect(
  "汇总四类自洽",
  (() => {
    const s = summarizeGrades(list);
    return s.official + s.professional + s.weak === s.total;
  })(),
  true,
);

// 3) 与检索过滤口径交叉核对：两套实现必须对同一批地址给出同样判断，防止规则漂移
const crossUrls = [
  ...list.map((x) => x.url),
  "https://www.gsxt.gov.cn/index.html",
  "https://12366.chinatax.gov.cn/bsfw/onlinetaxation/main",
  "https://data.stats.gov.cn/",
  "https://shanghai.chinatax.gov.cn/zcfw/tjss/202311/t469200.html",
  "https://www.zhihu.com/question/590527746",
  "https://cn-hxc.com.cn/",
  "https://yewu.ghzrzyw.beijing.gov.cn/gwxxfb/tdsc/tdzpgxm.html",
];
for (const u of crossUrls) {
  expect(`入口页口径一致 ${u.slice(0, 50)}`, isEntryUrl(u), isEntryPage(u));
  expect(`百科口径一致 ${u.slice(0, 50)}`, isEncyclopediaUrl(u), isEncyclopediaNode(u));
  expect(`官方口径一致 ${u.slice(0, 50)}`, isOfficialUrl(u), isAuthoritativeUrl(u));
}

// 4) 真实任务走查：库里所有检索结果地址都要能分级，且「官方」不得是入口页
const rows = db.prepare(`SELECT result FROM tool_calls WHERE result IS NOT NULL`).all() as Array<{ result: string }>;
const seen = new Set<string>();
for (const row of rows) {
  for (const m of row.result.matchAll(/https?:\/\/[^"'\s\\)\]]{8,300}/g)) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (seen.size < 400) seen.add(url);
  }
}
const real = [...seen].map((url) => ({ url }));
const sum = summarizeGrades(real);
checks += 1;
if (sum.official + sum.professional + sum.weak !== sum.total) failures.push("真实地址分级四类之和不等于总数");
for (const c of real) {
  const g = gradeCitation(c.url);
  if (g.grade === "official" && isEntryUrl(c.url)) failures.push(`官方分级却是入口页：${c.url}`);
  if (g.grade === "weak" && !g.weak) failures.push(`弱证据缺少原因：${c.url}`);
  checks += 1;
}
console.log(
  `[verify] 真实地址走查：${sum.total} 条 · 官方 ${sum.official} · 专业 ${sum.professional} · 证据力弱 ${sum.weak}`,
);
const weakSamples = real.filter((c) => gradeCitation(c.url).grade === "weak").slice(0, 5).map((c) => c.url.slice(0, 70));
if (weakSamples.length > 0) console.log(`[verify] 弱证据样例：${weakSamples.join(" | ")}`);

console.log(`[verify] 引用分级检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 引用证据力分级规则不符");
  process.exit(1);
}
console.log("[PASS] 引用证据力分级正确（分级口径 / 两套实现一致 / 真实地址走查）");
