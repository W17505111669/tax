/**
 * 验证脚本：联网检索可信度（词元切分 / 相关度门槛 / 入口页过滤 / 验证页识别 / 历史数据回放）。
 * 运行：pnpm verify:websearch
 */
import {
  describeAttempts,
  detectBlockedPage,
  filterSearchResults,
  isAuthoritativeUrl,
  isEncyclopediaUrl,
  isEntryPage,
  parseBingRss,
  queryTokens,
  relevanceHits,
  relevanceThreshold,
  rssWorthUsing,
  searchWebDetailed,
  unwrapBingRedirect,
  type SearchAttempt,
  type WebSearchResult,
} from "@tax/business-tools";
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

const Q = "土地增值税清算 建安成本 合同金额与发票金额不一致 暂估入账 扣除口径";

const r = (title: string, url: string, snippet = "", engine: "bing" | "baidu" = "bing"): WebSearchResult => ({
  title,
  url,
  snippet,
  engine,
});

// 1) 词元切分
expect("切分中文二元组", queryTokens("土地增值税清算").slice(0, 3), ["土地", "地增", "增值"]);
expect("切分保留数字与字母整词", queryTokens("财税2015 119号 RD费用").includes("2015"), true);
expect("虚词不计入词元", queryTokens("如何进行处理").includes("如何"), false);
expect("空检索词无词元", queryTokens("").length, 0);

// 2) 相关度
expect(
  "无关百科词条只命中 1 个词元（低于默认门槛 2）",
  relevanceHits(Q, r("土地（自然经济综合体）_百度百科", "https://baike.baidu.com/item/%E5%9C%9F%E5%9C%B0/12005092")).hits,
  1,
);
ok(
  "相关结果命中数达到门槛",
  relevanceHits(Q, r("土地增值税清算中暂估入账成本的处理口径", "https://www.shui5.cn/article/abc.html", "合同金额与发票金额不一致时，建安成本如何扣除")).hits >= 2,
);
expect("URL 百分号编码也参与匹配", relevanceHits("研发费用加计扣除", r("研发", "https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440")).hits >= 1, true);

// 3) 入口页 / 权威域名 / 百科
expect("站点首页是入口页", isEntryPage("https://www.mnr.gov.cn/"), true);
expect("index.html 是入口页", isEntryPage("https://www.gsxt.gov.cn/index.html"), true);
expect("单级栏目页是入口页", isEntryPage("https://www.gov.cn/guoqing/"), true);
expect("登录页是入口页", isEntryPage("https://etax.xinjiang.chinatax.gov.cn:8443/loginb/"), true);
expect("服务门户 main 是入口页", isEntryPage("https://12366.chinatax.gov.cn/bsfw/onlinetaxation/main"), true);
expect("政策原文页不是入口页", isEntryPage("https://fgk.chinatax.gov.cn/zcfgk/c100012/c5197801/content.html"), false);
expect("知乎专栏不是入口页", isEntryPage("https://zhuanlan.zhihu.com/p/513504457"), false);
expect("gov.cn 是权威域名", isAuthoritativeUrl("https://www.most.gov.cn/xxgk/a.pdf"), true);
expect("百科词条识别", isEncyclopediaUrl("https://baike.baidu.com/item/%E5%9C%9F%E5%9C%B0/12005092"), true);
expect("MBA 智库百科识别", isEncyclopediaUrl("https://wiki.mbalib.com/wiki/%E7%A0%94%E5%8F%91"), true);
expect("官方文件页不是百科", isEncyclopediaUrl("https://fgk.chinatax.gov.cn/zcfgk/c100012/c5197801/content.html"), false);

// 4) 过滤：真实历史数据里出现过的无关结果必须被丢掉
const junk: WebSearchResult[] = [
  r("土地（自然经济综合体）_百度百科", "https://baike.baidu.com/item/%E5%9C%9F%E5%9C%B0/12005092"),
  r("自然资源部", "https://www.mnr.gov.cn/"),
  r("中华人民共和国国情", "https://www.gov.cn/guoqing/"),
  r("含羞草 - 品质线上服务平台", "https://cn-hxc.com.cn/"),
  r("国家税务总局12366纳税服务平台", "https://12366.chinatax.gov.cn/"),
];
const good: WebSearchResult[] = [
  r(
    "土地增值税清算中暂估入账的建安成本如何扣除",
    "https://fgk.chinatax.gov.cn/zcfgk/c100012/c5197801/content.html",
    "合同金额与发票金额不一致时的扣除口径",
  ),
  r("土增清算暂估成本与发票差异案例", "https://zhuanlan.zhihu.com/p/513504457", "建安成本 暂估入账 扣除口径"),
];
const filtered = filterSearchResults(Q, [...junk, ...good], 2);
expect("无关结果全部被过滤", filtered.kept.length, 2);
expect("过滤条数", filtered.dropped.length, 5);
expect(
  "入口页给出专门原因",
  filtered.dropped.find((d) => d.url === "https://www.mnr.gov.cn/")?.reason,
  "entry",
);
expect(
  "百科词条按相关度不足过滤",
  filtered.dropped.find((d) => d.url.includes("baike.baidu.com"))?.reason,
  "irrelevant",
);
expect("重复地址只保留一条", filterSearchResults(Q, [...good, ...good], 2).kept.length, 2);
expect("重复地址标记为 duplicate", filterSearchResults(Q, [...good, ...good], 2).dropped[0]?.reason, "duplicate");
expect("短检索词门槛不低于设定值", relevanceThreshold("研发费用", "https://a.cn/x/y.html", 2), 2);
ok("长检索词按比例提高门槛", relevanceThreshold(Q, "https://a.cn/x/y.html", 2) >= 5, `实际 ${relevanceThreshold(Q, "https://a.cn/x/y.html", 2)}`);
ok(
  "权威域名门槛低于普通站点",
  relevanceThreshold(Q, "https://x.gov.cn/a/b.html", 2) < relevanceThreshold(Q, "https://a.cn/x/y.html", 2),
);
expect("空检索词门槛为 0", relevanceThreshold("", "https://a.cn/x/y.html", 2), 0);
expect("权威域名门槛至少为 1", relevanceThreshold("土地", "https://x.gov.cn/a/b.html", 0) >= 1, true);
expect("保留结果按命中数降序", (() => {
  const f = filterSearchResults(Q, [good[1]!, good[0]!], 2);
  return (f.kept[0]!.relevance ?? 0) >= (f.kept[1]!.relevance ?? 0);
})(), true);
expect(
  "门槛设 0 时长检索词仍按比例过滤（同名词条不放行）",
  filterSearchResults(Q, [...junk, ...good], 0).kept.length,
  2,
);
expect("短检索词 + 门槛 0：命中 1 个词元即保留", filterSearchResults("土地增值税", [junk[0]!], 0).kept.length, 1);
expect(
  "同一条结果在长检索词下被过滤（门槛随长度自适应）",
  filterSearchResults(Q, [junk[0]!], 0).kept.length,
  0,
);
expect("入口页在任何门槛下都被过滤", filterSearchResults("土地增值税", [junk[1]!], 0).kept.length, 0);

// 4b) RSS 退化成兜底噪声时不能挡住 HTML 通道
// 本机实测过 RSS 整批返回微软帮助页、Facebook 登录页一类与检索词无关的条目，条数照样是 10；
// 只判断条数就会一直走 RSS，百度又被安全验证拦住，联网复查于是全部 empty。
expect("全部无关的 RSS 不采用", rssWorthUsing(Q, junk, 2), false);
expect("只剩入口页的 RSS 不采用", rssWorthUsing("土地增值税", [junk[1]!], 0), false);
expect("空结果不采用", rssWorthUsing(Q, [], 2), false);
expect("留下可用结果的 RSS 才采用", rssWorthUsing(Q, [...junk, ...good], 2), true);

// 4c) Bing 跳转包装地址还原：包装地址当证据会让来源域名显示成 bing.com，既拿不到权威判定也可能失效
const BING_TARGET = "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202002/content.html";
const BING_WRAP = `https://www.bing.com/ck/a?!&&p=abc123&u=a1${Buffer.from(BING_TARGET)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")}&ntb=1`;
expect("跳转包装还原成真实地址", unwrapBingRedirect(BING_WRAP), BING_TARGET);
expect("还原后能判定为权威域名", isAuthoritativeUrl(unwrapBingRedirect(BING_WRAP)), true);
expect("非包装地址原样返回", unwrapBingRedirect(BING_TARGET), BING_TARGET);
expect("缺 u 参数的包装地址原样返回", unwrapBingRedirect("https://www.bing.com/ck/a?!&&p=abc"), "https://www.bing.com/ck/a?!&&p=abc");
expect("u 参数解不出地址时原样返回", unwrapBingRedirect("https://www.bing.com/ck/a?u=a1bm90LWEtdXJs"), "https://www.bing.com/ck/a?u=a1bm90LWEtdXJs");
// 5) 验证页识别与引擎尝试说明
expect("识别百度安全验证", detectBlockedPage("<html><head><title>百度安全验证</title></head></html>"), "百度安全验证");
expect("识别反爬提示", detectBlockedPage("<p>We have detected unusual traffic from your network</p>") !== null, true);
expect("识别验证码提示", detectBlockedPage("<div>请输入验证码后继续访问</div>") !== null, true);
expect("正常检索页不误判", detectBlockedPage("<html><head><title>财税〔2015〕119号 - 搜索</title></head><body>结果</body></html>"), null);
const attempts: SearchAttempt[] = [
  { engine: "bing", via: "RSS", status: "irrelevant", fetched: 10, kept: 0, dropped: 10, httpStatus: 200, note: "RSS 10 条结果与检索词无关" },
  { engine: "baidu", via: "HTML", status: "blocked", fetched: 0, kept: 0, dropped: 0, httpStatus: 200, note: "百度安全验证" },
];
expect(
  "引擎尝试说明包含两个引擎",
  describeAttempts(attempts),
  "Bing 结果与检索词无关（RSS 10 条结果与检索词无关）；百度 触发安全验证（百度安全验证）",
);
expect("无尝试时如实说明", describeAttempts([]), "未尝试任何检索引擎");

// 5b) Bing RSS 解析：结构稳定，CDATA 与非 http 地址都要正确处理
const RSS = [
  `<?xml version="1.0" encoding="utf-8"?><rss><channel>`,
  `<item><title><![CDATA[研发费用加计扣除 政策执行指引（2.0版）]]></title><link>https://www.most.gov.cn/xxgk/a.pdf</link><description><![CDATA[财税〔2015〕119号 相关口径]]></description></item>`,
  `<item><title>空链接条目</title><link></link><description>x</description></item>`,
  `<item><title><![CDATA[财税_百度百科]]></title><link>https://baike.baidu.com/item/%E8%B4%A2%E7%A8%8E/8216429</link><description>财税</description></item>`,
  `</channel></rss>`,
].join("");
expect("RSS 解析条数（跳过无链接条目）", parseBingRss(RSS).length, 2);
expect("RSS 标题去掉 CDATA", parseBingRss(RSS)[0]?.title, "研发费用加计扣除 政策执行指引（2.0版）");
expect("RSS 地址原样保留", parseBingRss(RSS)[0]?.url, "https://www.most.gov.cn/xxgk/a.pdf");
expect("RSS 摘要可用", parseBingRss(RSS)[0]?.snippet, "财税〔2015〕119号 相关口径");
expect("RSS 引擎标记为 bing", parseBingRss(RSS)[0]?.engine, "bing");
expect("空 RSS 返回空", parseBingRss("<rss><channel></channel></rss>").length, 0);
expect(
  "RSS 结果同样接受相关度过滤",
  filterSearchResults("财税〔2015〕119号 研发费用加计扣除", parseBingRss(RSS), 2).kept.map((k) => k.url),
  ["https://www.most.gov.cn/xxgk/a.pdf"],
);

// 6) 历史数据回放：库里真实落过盘的检索结果，过滤后必须只剩相关条目
type Row = { args: string | null; result: string | null };
const rows = db.prepare(`SELECT args, result FROM tool_calls WHERE tool_name = 'search_public_cases' AND ok = 1`).all() as Row[];
let replayed = 0;
let beforeTotal = 0;
let afterTotal = 0;
let entryDropped = 0;
for (const row of rows) {
  let query = "";
  let results: WebSearchResult[] = [];
  try {
    const d = JSON.parse(row.result ?? "{}") as { query?: string; results?: WebSearchResult[] };
    query = d.query ?? "";
    results = Array.isArray(d.results) ? d.results : [];
  } catch {
    continue;
  }
  if (!query || results.length === 0) continue;
  replayed += 1;
  const f = filterSearchResults(query, results, 2);
  beforeTotal += results.length;
  afterTotal += f.kept.length;
  entryDropped += f.dropped.filter((d) => d.reason === "entry").length;
  for (const kept of f.kept) {
    ok(
      `回放保留项必须过门槛（${kept.url.slice(0, 60)}）`,
      isEntryPage(kept.url) === false && relevanceHits(query, kept).hits >= relevanceThreshold(query, kept.url, 2),
    );
  }
}
ok("历史检索记录可回放", replayed > 0, `实际 ${replayed} 条`);
console.log(`[verify] 历史检索回放：${replayed} 次调用 · 原 ${beforeTotal} 条 → 过滤后 ${afterTotal} 条（入口页 ${entryDropped} 条被丢弃）`);

// 7) 实网冒烟：只校验不变量（保留项一定过门槛）。
// 默认门禁不联网——检索通道可用性随本机网络环境变化（实测同一台机器上 RSS 与 HTML 谁退化成
// 兜底噪声会互换），联网项会让 qa:all 的时长与结果都不稳定。设 TAXAI_VERIFY_LIVE=1 才跑。
const LIVE_QUERY = "财税〔2015〕119号 研发费用加计扣除 政策原文";
if (process.env.TAXAI_VERIFY_LIVE === "1") {
  try {
    const live = await searchWebDetailed(LIVE_QUERY, AbortSignal.timeout(15000));
    // 计数跟着真正执行到的断言走：原先两句无条件 checks += 1 会在什么都没校验时虚增检查项
    checks += 1;
    if (live.attempts.some((a) => a.via !== "RSS" && a.via !== "HTML" && a.via !== "JSON")) {
      failures.push("实网冒烟：出现未知的取数方式");
    }
    for (const k of live.results) {
      checks += 1;
      if (isEntryPage(k.url) || relevanceHits(LIVE_QUERY, k).hits < relevanceThreshold(LIVE_QUERY, k.url, 2)) {
        failures.push(`实网冒烟：保留项未过门槛 ${k.url}`);
      }
    }
    console.log(
      `[verify] 实网冒烟：可用 ${live.results.length} 条 · 门槛 ${live.minScore} · ${describeAttempts(live.attempts)}`,
    );
  } catch (err) {
    console.log(`[verify] 实网冒烟跳过（网络不可用：${err instanceof Error ? err.message : String(err)}）`);
  }
} else {
  console.log("[verify] 实网冒烟跳过（默认门禁不联网；设 TAXAI_VERIFY_LIVE=1 可跑）");
}

console.log(`[verify] 联网检索可信度检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 联网检索可信度规则不符");
  process.exit(1);
}
console.log("[PASS] 联网检索可信度规则正确（相关度门槛 / 入口页过滤 / 验证页识别 / 历史数据回放）");
