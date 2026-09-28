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
  queryTokens,
  relevanceHits,
  searchWebDetailed,
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
expect("保留结果按命中数降序", (() => {
  const f = filterSearchResults(Q, [good[1]!, good[0]!], 2);
  return (f.kept[0]!.relevance ?? 0) >= (f.kept[1]!.relevance ?? 0);
})(), true);
expect("门槛为 0 时只过滤入口页与重复", filterSearchResults(Q, [...junk, ...good], 0).kept.length, 3);

// 5) 验证页识别与引擎尝试说明
expect("识别百度安全验证", detectBlockedPage("<html><head><title>百度安全验证</title></head></html>"), "百度安全验证");
expect("识别反爬提示", detectBlockedPage("<p>We have detected unusual traffic from your network</p>") !== null, true);
expect("识别验证码提示", detectBlockedPage("<div>请输入验证码后继续访问</div>") !== null, true);
expect("正常检索页不误判", detectBlockedPage("<html><head><title>财税〔2015〕119号 - 搜索</title></head><body>结果</body></html>"), null);
const attempts: SearchAttempt[] = [
  { engine: "bing", status: "irrelevant", fetched: 10, kept: 0, dropped: 10, httpStatus: 200, note: "10 条结果与检索词无关" },
  { engine: "baidu", status: "blocked", fetched: 0, kept: 0, dropped: 0, httpStatus: 200, note: "百度安全验证" },
];
expect("引擎尝试说明包含两个引擎", describeAttempts(attempts), "Bing 结果与检索词无关（10 条结果与检索词无关）；百度 触发安全验证（百度安全验证）");
expect("无尝试时如实说明", describeAttempts([]), "未尝试任何检索引擎");

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
      isEntryPage(kept.url) === false && (isAuthoritativeUrl(kept.url) ? relevanceHits(query, kept).hits >= 1 : relevanceHits(query, kept).hits >= 2),
    );
  }
}
ok("历史检索记录可回放", replayed > 0, `实际 ${replayed} 条`);
console.log(`[verify] 历史检索回放：${replayed} 次调用 · 原 ${beforeTotal} 条 → 过滤后 ${afterTotal} 条（入口页 ${entryDropped} 条被丢弃）`);

// 7) 实网冒烟：只校验不变量（保留项一定过门槛），网络不可用时如实跳过
try {
  const live = await searchWebDetailed("财税〔2015〕119号 研发费用加计扣除 政策原文", AbortSignal.timeout(15000));
  checks += 1;
  for (const k of live.results) {
    if (isEntryPage(k.url) || relevanceHits("财税〔2015〕119号 研发费用加计扣除 政策原文", k).hits < (isAuthoritativeUrl(k.url) ? 1 : 2)) {
      failures.push(`实网冒烟：保留项未过门槛 ${k.url}`);
    }
  }
  console.log(
    `[verify] 实网冒烟：可用 ${live.results.length} 条 · 门槛 ${live.minScore} · ${describeAttempts(live.attempts)}`,
  );
} catch (err) {
  console.log(`[verify] 实网冒烟跳过（网络不可用：${err instanceof Error ? err.message : String(err)}）`);
}

console.log(`[verify] 联网检索可信度检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 联网检索可信度规则不符");
  process.exit(1);
}
console.log("[PASS] 联网检索可信度规则正确（相关度门槛 / 入口页过滤 / 验证页识别 / 历史数据回放）");
