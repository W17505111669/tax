/**
 * 验证脚本：联网检索留痕与引用提取（各工具结果形状 / 去重与上限 / 元数据检索如实说明 / 真实任务走查）。
 * 运行：pnpm verify:searchev
 */
import {
  CITATION_LIMIT,
  extractCitations,
  queriesOfCall,
  SEARCH_TOOL_NAMES,
  searchEvidence,
  searchEvidenceNote,
  urlsOfCall,
} from "../../web/src/search-evidence.ts";
import { db } from "../src/db.ts";
import { listTasks } from "../src/services/task-store.ts";

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

/** 政府/税务机关站点（与前端 isOfficialUrl 同口径，这里只用于统计输出） */
function isGov(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase().endsWith("gov.cn");
  } catch {
    return false;
  }
}

// 1) 各工具结果形状的 URL 提取
expect(
  "search_public_cases 的 results 逐条提取",
  urlsOfCall("search_public_cases", {
    results: [
      { title: "甲", url: "https://a.gov.cn/x/y.html" },
      { title: "", url: "https://b.cn/z" },
    ],
  }),
  [
    { url: "https://a.gov.cn/x/y.html", title: "甲" },
    { url: "https://b.cn/z", title: "https://b.cn/z" },
  ],
);
expect(
  "fetch_content 单地址沿用标题",
  urlsOfCall("fetch_content", { urls: ["https://fgk.chinatax.gov.cn/a.html"], title: "国家税务总局政策法规库" }),
  [{ url: "https://fgk.chinatax.gov.cn/a.html", title: "国家税务总局政策法规库" }],
);
expect(
  "fetch_content 多地址时标题不可归属，退回地址",
  urlsOfCall("fetch_content", { urls: ["https://x.cn/1", "https://x.cn/2"], title: "共用标题" }).map((u) => u.title),
  ["https://x.cn/1", "https://x.cn/2"],
);
expect(
  "fetch_public_document 的单条 url",
  urlsOfCall("fetch_public_document", { url: "https://y.cn/doc", title: "文档" }),
  [{ url: "https://y.cn/doc", title: "文档" }],
);
expect(
  "web_search 只留元数据，提不出 URL",
  urlsOfCall("web_search", { queries: ["q"], totalResults: 15, searchId: "s1" }),
  [],
);
expect("非 http 地址被拒绝", urlsOfCall("search_public_cases", { results: [{ url: "ftp://x/y" }] }), []);
expect("相对地址被拒绝", urlsOfCall("search_public_cases", { results: [{ url: "/a/b.html" }] }), []);
expect("结果为空时安全返回", urlsOfCall("search_public_cases", null), []);
expect("结果不是对象时安全返回", urlsOfCall("web_search", "字符串结果"), []);

// 2) 检索词与 provider
expect(
  "web_search 的检索词与 provider",
  queriesOfCall({
    queries: ["甲", "乙"],
    queryProviders: [
      { query: "甲", providers: ["exa"] },
      { query: "丙", providers: ["exa", "bocha"] },
    ],
  }),
  { queries: ["甲", "乙", "丙"], providers: ["exa", "bocha"] },
);
expect("search_public_cases 的单个检索词", queriesOfCall({ query: " 研发费用 加计扣除 " }).queries, ["研发费用 加计扣除"]);
expect("空结果的检索词为空", queriesOfCall(null).queries, []);

// 3) 引用清单：去重、上限、来源工具、非检索工具忽略
const calls = [
  { toolName: "search_public_cases", result: { query: "q1", results: [{ title: "A", url: "https://a.cn/1" }] } },
  { toolName: "search_public_cases", result: { query: "q1", results: [{ title: "A 重复", url: "https://a.cn/1" }] } },
  { toolName: "fetch_content", result: { urls: ["https://fgk.chinatax.gov.cn/a.html"], title: "政策法规库", totalResults: 0 } },
  { toolName: "web_search", result: { queries: ["q2"], queryProviders: [{ query: "q2", providers: ["exa"] }], totalResults: 15 } },
  { toolName: "generate_workpaper", result: { url: "https://不该被采集.cn/x" } },
];
expect("按 URL 去重", extractCitations(calls).length, 2);
expect("首次出现的标题胜出", extractCitations(calls)[0]?.title, "A");
expect("记录来源工具", extractCitations(calls).map((c) => c.via), ["search_public_cases", "fetch_content"]);
expect("非检索工具不采集", extractCitations(calls).some((c) => c.url.includes("不该被采集")), false);
expect("上限可配置", extractCitations(calls, 1).length, 1);
expect("默认上限", CITATION_LIMIT, 20);

// 4) 检索留痕汇总
const ev = searchEvidence(calls);
expect("检索调用数只算检索类工具", ev.calls, 4);
expect("留下来源的调用数", ev.withUrls, 3);
expect("只留元数据的调用数", ev.metadataOnly, 1);
expect("两类之和等于调用数", ev.withUrls + ev.metadataOnly, ev.calls);
expect("自报命中数累计", ev.reportedResults, 15);
expect("检索词去重", ev.queries, ["q1", "q2"]);
expect("provider 去重", ev.providers, ["exa"]);
expect("工具名清单", ev.tools.sort(), ["fetch_content", "search_public_cases", "web_search"]);
expect("无检索时全为 0", searchEvidence([]).calls, 0);
expect("检索词最多 12 条", searchEvidence(
  Array.from({ length: 20 }, (_, i) => ({ toolName: "web_search", result: { queries: [`q${i}`] } })),
).queries.length, 12);
expect("工具名清单属于已知集合", ev.tools.every((t) => SEARCH_TOOL_NAMES.has(t)), true);

// 5) 「没有引用清单」的如实说明
expect("有引用时不需要说明", searchEvidenceNote(ev, 2), null);
expect("没有检索时不需要说明", searchEvidenceNote(searchEvidence([]), 0), null);
expect("有来源却没提取到引用时不需要说明", searchEvidenceNote({ ...ev, metadataOnly: 0 }, 0), null);
const note = searchEvidenceNote(
  searchEvidence([{ toolName: "web_search", result: { queries: ["土增清算 口径"], totalResults: 18, queryProviders: [{ query: "土增清算 口径", providers: ["exa"] }] } }]),
  0,
);
ok("元数据检索给出说明", typeof note === "string" && note.length > 0, String(note));
ok("说明含调用次数", (note ?? "").includes("1 次联网检索"), note ?? "");
ok("说明含自报命中数", (note ?? "").includes("18 条"), note ?? "");
ok("说明含工具名", (note ?? "").includes("web_search"), note ?? "");
ok("说明含检索词", (note ?? "").includes("土增清算 口径"), note ?? "");
ok("说明给出处置建议", (note ?? "").includes("请在结论中附检索词"), note ?? "");

// 6) 真实任务走查：工具结果里留存过的每个 URL 都必须能进入引用清单（除非超过上限）
let taskTotal = 0;
let withSearch = 0;
let metaOnlyCalls = 0;
let citeTotal = 0;
let officialTotal = 0;
for (const t of listTasks()) {
  const rows = db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`).all(t.id) as Array<{
    tool_name: string;
    result: string | null;
  }>;
  const parsed = rows.map((r) => {
    let result: unknown = null;
    try {
      result = r.result ? JSON.parse(r.result) : null;
    } catch {
      result = null;
    }
    return { toolName: r.tool_name, result };
  });
  const cites = extractCitations(parsed);
  const evidence = searchEvidence(parsed);
  taskTotal += 1;
  citeTotal += cites.length;
  officialTotal += cites.filter((c) => isGov(c.url)).length;
  if (evidence.calls > 0) withSearch += 1;
  metaOnlyCalls += evidence.metadataOnly;
  checks += 1;
  if (evidence.calls !== evidence.withUrls + evidence.metadataOnly) {
    failures.push(`${t.id.slice(0, 8)} 检索留痕两类之和不等于调用数`);
  }
  if (cites.length > CITATION_LIMIT) failures.push(`${t.id.slice(0, 8)} 引用清单超过上限`);
  // 每个留存过 URL 的检索调用都必须被计入 withUrls，且其地址出现在清单里（超上限的除外）
  for (const c of parsed) {
    if (!SEARCH_TOOL_NAMES.has(c.toolName)) continue;
    const urls = urlsOfCall(c.toolName, c.result).map((u) => u.url);
    if (urls.length === 0) continue;
    if (cites.length < CITATION_LIMIT) {
      for (const u of urls) {
        checks += 1;
        if (!cites.some((x) => x.url === u)) failures.push(`${t.id.slice(0, 8)} 留存的 URL 未进入引用清单：${u.slice(0, 80)}`);
      }
    }
  }
}
console.log(
  `[verify] 真实任务走查：${taskTotal} 个任务 · ${withSearch} 个用过联网检索 · 引用 ${citeTotal} 条（政府/税务机关站点 ${officialTotal} 条）· 只留元数据的检索 ${metaOnlyCalls} 次`,
);

console.log(`[verify] 检索留痕检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 联网检索留痕规则不符");
  process.exit(1);
}
console.log("[PASS] 联网检索留痕与引用提取正确（各工具形状 / 去重上限 / 元数据检索如实说明 / 真实任务走查）");
