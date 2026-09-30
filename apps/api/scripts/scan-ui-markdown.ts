/**
 * 实测脚本：在真实浏览器里扫描站点，找出「界面把 Markdown 原文当纯文本显示」的位置。
 *
 * 为什么需要它：结论正文走 MarkdownView（marked + DOMPurify + mermaid）渲染成 HTML，
 * 一句话展示位走 md-text.ts 剥记号。但界面上还有一批位置是把字符串直接塞进 JSX 的，
 * 光看代码看不出最终文本长什么样——只有真的渲染出来扫 DOM 文本节点才知道漏没漏。
 * 上一轮靠人工在浏览器里扫了一次（7 处），这里把它固化成可反复跑的实测：新建任务、
 * 换页签、改组件之后都能重扫，不依赖某一次的人工观察。
 *
 * 扫描口径：遍历 body 下所有文本节点，跳过 pre / code / textarea / input / script / style / svg
 * （代码块与输入框里出现记号是应该的），也跳过标了 data-keep-raw 的容器（那是有意逐字回显
 * 用户输入的位置，见 TaskWorkbench 的任务指令面板）。剩下的文本里出现下列记号即算残留：
 * 井号标题、反引号、粗体、表格分隔行、表格竖线行、链接语法、围栏代码、引用记号、列表记号。
 *
 * 依赖：playwright-core（不下载浏览器，复用本机 ms-playwright 缓存里的 Chromium）。
 *
 * 运行：
 *   pnpm scan:uimd                      # 扫最近 8 个有结论的任务 x 4 个页签 + 两个作品总览页
 *   pnpm scan:uimd --tasks=4e3aa131,e17ec362 --tabs=result,timeline
 *   pnpm scan:uimd --all --json         # 全库任务，输出机器可读结果
 *   pnpm scan:uimd --strict             # 有残留即退出码 1（供门禁使用）
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../src/db.ts";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:5174";

/** 记号判据：名称 + 正则源串（在页面里 new RegExp，故用字符串传）。 */
const PATTERNS: Array<[string, string]> = [
  ["井号标题", "(^|\\n)\\s{0,3}#{1,6}\\s"],
  ["反引号", "`"],
  ["粗体记号", "\\*\\*[^*\\n]+\\*\\*"],
  ["表格分隔行", "\\|\\s*:?-{3,}"],
  ["表格竖线行", "^\\s*\\|.+\\|\\s*$"],
  ["链接语法", "\\]\\(\\s*https?:\\/\\/"],
  ["围栏代码", "```"],
  ["引用记号", "(^|\\n)\\s{0,3}>\\s"],
];
// 刻意不收「列表记号」：渲染后的表格单元格里出现「1. 人员人工费用」「+ B：」是结论作者写的
// 正常编号文字，不是 Markdown 残留。实测 30 处命中里 13 处是这类误报，把真问题淹了。
// 真正的原文泄漏一定伴随更强的记号（# | ` ** > ```），靠那些就够。

type Hit = { page: string; pattern: string; text: string; chain: string };

interface Args {
  tasks?: string[];
  tabs: string[];
  all: boolean;
  json: boolean;
  strict: boolean;
  overview: boolean;
  reader: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    tabs: ["timeline", "result", "compare", "review"],
    all: false,
    json: false,
    strict: false,
    overview: true,
    reader: false,
  };
  for (const a of argv) {
    if (a.startsWith("--tasks=")) out.tasks = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--tabs=")) out.tabs = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--no-overview") out.overview = false;
    else if (a === "--reader") out.reader = true;
  }
  return out;
}

/** 找本机 ms-playwright 缓存里的 Chromium。 */
function findChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean) as string[];
  // headless shell 优先：完整版 chrome.exe 在同目录 chrome.dll 缺失时会以
  // 「Failed to load Chrome DLL」启动失败——本机缓存正是这种情况，实测踩过，故校验依赖文件。
  const CANDIDATES: Array<[string, string | undefined]> = [
    [path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe"), undefined],
    [path.join("chrome-headless-shell-linux", "chrome-headless-shell"), undefined],
    [path.join("chrome-headless-shell-mac", "chrome-headless-shell"), undefined],
    [path.join("chrome-win64", "chrome.exe"), path.join("chrome-win64", "chrome.dll")],
    [path.join("chrome-win", "chrome.exe"), path.join("chrome-win", "chrome.dll")],
    [path.join("chrome-linux", "chrome"), undefined],
    [path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"), undefined],
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // 目录名两种写法都出现过：chromium-1223 与 chromium_headless_shell-1223（下划线），
    // 早先按 /^chromium(-headless-shell)?-\d+$/ 匹配把后者漏掉，直接判定「找不到浏览器」。
    const dirs = fs
      .readdirSync(root)
      .filter((d) => /^chromium/i.test(d) && fs.statSync(path.join(root, d)).isDirectory())
      .sort();
    for (const d of dirs) {
      for (const [rel, needs] of CANDIDATES) {
        const p = path.join(root, d, rel);
        if (!fs.existsSync(p)) continue;
        if (needs && !fs.existsSync(path.join(root, d, needs))) continue;
        return p;
      }
    }
  }
  return undefined;
}

/** 页面内执行的扫描函数：只取文本节点，跳过代码/输入/有意保留原文的容器。 */
const scanSource = `(patterns) => {
  const SKIP = new Set(["PRE", "CODE", "TEXTAREA", "INPUT", "SCRIPT", "STYLE", "SVG", "NOSCRIPT"]);
  const res = patterns.map((p) => ({ name: p[0], re: new RegExp(p[1], "m") }));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const hits = [];
  let nodes = 0;
  let chars = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = (n.nodeValue || "").trim();
    if (!value) continue;
    const el = n.parentElement;
    if (!el) continue;
    nodes += 1;
    chars += value.length;
    if (el.closest("[data-keep-raw]")) continue;
    let skip = false;
    for (let e = el; e; e = e.parentElement) {
      if (SKIP.has(e.tagName)) { skip = true; break; }
    }
    if (skip) continue;
    const chain = [];
    for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) {
      const cls = (e.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 3).join(".");
      chain.push(e.tagName.toLowerCase() + (cls ? "." + cls : ""));
    }
    for (const p of res) {
      if (p.re.test(value)) hits.push({ pattern: p.name, text: value.slice(0, 160), chain: chain.join(" < ") });
    }
  }
  return { hits, nodes, chars };
}`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = db
    .prepare(
      `SELECT id, title, agent_id AS agentId, status, LENGTH(COALESCE(result,'')) AS rlen FROM tasks ORDER BY created_at DESC`,
    )
    .all() as unknown as Array<{ id: string; title: string; agentId: string; status: string; rlen: number }>;

  let targets = rows;
  if (args.tasks && args.tasks.length > 0) {
    const keys = args.tasks.map((t) => t.trim());
    targets = rows.filter((r) => keys.some((k) => r.id.startsWith(k) || r.title.includes(k)));
  } else if (!args.all) {
    targets = rows.filter((r) => r.rlen > 0).slice(0, 8);
  } else {
    targets = rows.filter((r) => r.rlen > 0);
  }

  const exe = findChromium();
  if (!exe) {
    console.log("[FAIL] 找不到本机 Chromium 缓存（ms-playwright），无法实测扫描");
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pages: Array<{ label: string; url: string; tab: string }> = [];
  if (args.overview) {
    for (const agentId of ["rd-audit", "land-vat"]) {
      pages.push({ label: `总览 ${agentId}`, url: `${WEB}/#/agent/${agentId}`, tab: "" });
    }
  }
  for (const t of targets) {
    for (const tab of args.tabs) {
      pages.push({
        label: `${t.title.slice(0, 18)} · ${tab}`,
        url: `${WEB}/#/agent/${t.agentId}/task/${t.id}/tab/${tab}`,
        tab,
      });
    }
  }

  const allHits: Hit[] = [];
  let scanned = 0;
  let nodesTotal = 0;
  let charsTotal = 0;
  const thin: string[] = [];
  const scanOnce = async (label: string): Promise<void> => {
    // 字符串形式的 pageFunction 在 playwright 里是「表达式求值」，不会自动调用也不接参数，
    // 必须自己包成 IIFE 并把判据序列化进去（第一版直接传参，拿到的是函数本身，for-of 就炸了）。
    const found = (await page.evaluate(`(${scanSource})(${JSON.stringify(PATTERNS)})`)) as {
      hits: Array<Omit<Hit, "page">>;
      nodes: number;
      chars: number;
    };
    scanned += 1;
    nodesTotal += found.nodes;
    charsTotal += found.chars;
    // 页面内容太少说明没渲染出来（路由错、任务不存在、数据还在加载）：这种页面扫出 0 处不算通过
    if (found.chars < 400) thin.push(`${label}（${found.chars} 字）`);
    for (const h of found.hits) allHits.push({ page: label, ...h });
  };

  /**
   * 侧边阅读器要点击才会挂载，光扫主区域永远扫不到它——而它恰恰是显示外部网页正文与产物内容的地方。
   * 优先点产物（本地文件，快且稳），没有产物再点引用胶囊（要联网抓取，慢一些）。
   */
  const openReader = async (): Promise<string | null> => {
    for (const [sel, label] of [
      ['button[title="在侧边阅读器中预览"]', "本地产物"],
      ['button[title^="http"]', "联网引用"],
    ] as Array<[string, string]>) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) === 0) continue;
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(4000);
        return label;
      } catch {
        // 元素被折叠区挡住或渲染中，换下一个入口
      }
    }
    return null;
  };

  for (const p of pages) {
    try {
      await page.goto(p.url, { waitUntil: "networkidle", timeout: 30000 });
    } catch {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    // mermaid 与流式渲染都是异步的，多等一会儿再扫，避免把半成品当成残留
    await page.waitForTimeout(1800);
    await scanOnce(p.label);
    if (args.reader && p.tab === "result") {
      const via = await openReader();
      if (via) await scanOnce(`${p.label} · 侧边阅读器（${via}）`);
    }
  }
  await browser.close();

  if (args.json) {
    console.log(JSON.stringify({ scanned, nodesTotal, charsTotal, thin, hits: allHits }, null, 2));
    return;
  }
  console.log(
    `[scan] 扫描页面 ${scanned} 个 · 文本节点 ${nodesTotal} 个 · 合计 ${charsTotal} 字 · 残留 ${allHits.length} 处`,
  );
  if (thin.length > 0) console.log(`[scan] 内容过少（可能没渲染出来）：${thin.slice(0, 10).join("；")}`);
  const byPattern = new Map<string, number>();
  for (const h of allHits) byPattern.set(h.pattern, (byPattern.get(h.pattern) ?? 0) + 1);
  for (const [k, v] of [...byPattern].sort((a, b) => b[1] - a[1])) console.log(`  记号 ${k}: ${v}`);
  const byPage = new Map<string, number>();
  for (const h of allHits) byPage.set(h.page, (byPage.get(h.page) ?? 0) + 1);
  for (const [k, v] of [...byPage].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  页面 ${k}: ${v}`);
  for (const h of allHits.slice(0, 25)) {
    console.log(`  - [${h.page}] ${h.pattern} :: ${h.text.replace(/\s+/g, " ").slice(0, 90)} :: ${h.chain}`);
  }
  if (allHits.length > 25) console.log(`  …另有 ${allHits.length - 25} 处，用 --json 看全量`);
  if (args.strict && (allHits.length > 0 || thin.length > 0)) {
    console.log(allHits.length > 0 ? "[FAIL] 界面上仍有 Markdown 原文" : "[FAIL] 有页面没渲染出内容，扫描不算数");
    process.exit(1);
  }
  console.log("[PASS] 界面 Markdown 原文扫描完成");
}

void main();
