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
 *   pnpm scan:uimd --nointeract         # 不点折叠面板，只扫默认挂载的内容（快，但覆盖有缺口）
 *   pnpm scan:uimd --interact-limit=4   # 每个页面最多点开几个折叠入口（默认 6）
 */
import { db } from "../src/db.ts";
import { launchChromium, WEB_URL } from "./browser-lib.ts";

const WEB = WEB_URL;

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
  interact: boolean;
  interactLimit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    tabs: ["timeline", "result", "compare", "review"],
    all: false,
    json: false,
    strict: false,
    overview: true,
    reader: false,
    interact: true,
    interactLimit: 6,
  };
  for (const a of argv) {
    if (a.startsWith("--tasks=")) out.tasks = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--tabs=")) out.tabs = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--no-overview") out.overview = false;
    else if (a === "--reader") out.reader = true;
    else if (a === "--nointeract") out.interact = false;
    else if (a.startsWith("--interact-limit=")) out.interactLimit = Math.max(0, Number(a.slice(17)) || 0);
  }
  return out;
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

/**
 * 「点击才挂载」的状态：折叠面板、展开更多、侧边浮层。光扫默认挂载的 DOM 永远扫不到它们，
 * 而它们恰恰是文案最密、最容易漏 Markdown 记号的地方（复查面板一整组条目都是现拼的字符串）。
 *
 * 入口靠白/黑名单从页面上自己找，不逐个硬编码：新增一个折叠区就自动被覆盖，不用回来改这里。
 * 白名单只认「展开/收起/折叠/更多/显示全部/查看全部/帮助/详情」这类纯展示动作；黑名单按**可见文本**
 * 排除会写库或发请求的按钮（复查、下载、删除、生成修订指令、上传、续跑、重新解析、核验、标注……）。
 * 黑名单故意不看 title：说明性 title 里出现「点击展开复查面板」这种名词短语，不该把入口挡掉。
 * 点到会跳转的按钮时整页交互立刻中止（DOM 已经换了，继续点只会扫到别的页面），并如实计数。
 */
const TOGGLE_OPEN = /(展开|收起|折叠|更多|显示全部|查看全部|帮助|详情)/;
const TOGGLE_BLOCK =
  /(复查|复核|下载|删除|清空|生成|上传|运行|重跑|续跑|复制|写入|写回|导出|重新解析|校验|核验|标注|保存|提交|新建|发送|启动|停止|归档|打开|跳转|前往)/;
/** 这些入口必须真的点到，否则「交互覆盖」就是空跑绿：面板没展开，里面的残留永远扫不到 */
const REQUIRED_TOGGLES: Array<{ label: string; tabs: string[] }> = [{ label: "文号溯源", tabs: ["result", "review"] }];

const listTogglesSource = `(spec) => {
  const open = new RegExp(spec[0]);
  const block = new RegExp(spec[1]);
  const out = [];
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], summary'))) {
    const title = (el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!open.test(title + ' ' + text)) continue;
    if (block.test(text)) continue;
    if (el.offsetParent === null) continue;
    el.setAttribute('data-scan-toggle', String(out.length));
    out.push({ idx: out.length, label: (text.slice(0, 24) || title.slice(0, 24)).trim() });
  }
  return out;
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

  const browser = await launchChromium();
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
  let pageScans = 0;
  let interacted = 0;
  let toggleFailed = 0;
  let navigatedAway = 0;
  const toggleLabels = new Set<string>();
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
    pageScans += 1;
    if (args.interact && args.interactLimit > 0) {
      // 每轮重新枚举，不复用上一轮的标记：点开一个面板会让 React 重建那一片 DOM，
      // 挂在旧节点上的 data-scan-toggle 跟着没了——第一版一次枚举到底，实测 92 次成功里
      // 有 52 次点击失败，全是这个原因，等于三分之一的折叠态没扫到。
      // 去重按 label：同一个入口展开后文本会变（「展开全部」→「折叠全部」），不会被重复点。
      const clicked = new Set<string>();
      for (let round = 0; round < args.interactLimit; round++) {
        const toggles = (await page.evaluate(
          `(${listTogglesSource})(${JSON.stringify([TOGGLE_OPEN.source, TOGGLE_BLOCK.source])})`,
        )) as Array<{ idx: number; label: string }>;
        const t = toggles.find((x) => !clicked.has(x.label));
        if (!t) break;
        clicked.add(t.label);
        const before = page.url();
        try {
          await page.locator(`[data-scan-toggle="${t.idx}"]`).first().click({ timeout: 2500 });
        } catch {
          // 标记随重渲染丢了、或被别层挡住：如实记一次失败，不当成「扫过了」
          toggleFailed += 1;
          continue;
        }
        await page.waitForTimeout(450);
        if (page.url() !== before) {
          navigatedAway += 1;
          break;
        }
        interacted += 1;
        toggleLabels.add(t.label);
        await scanOnce(`${p.label} · 展开「${t.label}」`);
      }
    }
    if (args.reader && p.tab === "result") {
      const via = await openReader();
      if (via) await scanOnce(`${p.label} · 侧边阅读器（${via}）`);
    }
  }
  await browser.close();

  // 必需入口一次都没点到 = 这一轮交互覆盖是空的。--strict 下按失败处理，不让它绿着过去。
  const requiredMissing = args.interact
    ? REQUIRED_TOGGLES.filter(
        (r) => r.tabs.some((t) => args.tabs.includes(t)) && ![...toggleLabels].some((l) => l.includes(r.label)),
      ).map((r) => r.label)
    : [];

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          scanned,
          pageScans,
          interacted,
          toggleFailed,
          navigatedAway,
          toggleLabels: [...toggleLabels],
          requiredMissing,
          nodesTotal,
          charsTotal,
          thin,
          hits: allHits,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `[scan] 扫描页面 ${pageScans} 个（含交互态共扫 ${scanned} 次）· 文本节点 ${nodesTotal} 个 · 合计 ${charsTotal} 字 · 残留 ${allHits.length} 处`,
  );
  if (args.interact) {
    console.log(
      `[scan] 交互态：点开 ${interacted} 个折叠入口（去重 ${toggleLabels.size} 类）· 点击失败 ${toggleFailed} · 点到导航而中止 ${navigatedAway}`,
    );
    console.log(
      `[scan] 点开的入口：${[...toggleLabels].slice(0, 14).join("；")}${toggleLabels.size > 14 ? "；…" : ""}`,
    );
    if (requiredMissing.length > 0) {
      console.log(`[scan] 必需入口一次都没点到：${requiredMissing.join("；")}（这些面板里的内容等于没扫）`);
    }
  }
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
  if (args.strict && (allHits.length > 0 || thin.length > 0 || requiredMissing.length > 0)) {
    console.log(
      allHits.length > 0
        ? "[FAIL] 界面上仍有 Markdown 原文"
        : thin.length > 0
          ? "[FAIL] 有页面没渲染出内容，扫描不算数"
          : "[FAIL] 必需的折叠入口没点到，交互覆盖是空的",
    );
    process.exit(1);
  }
  console.log("[PASS] 界面 Markdown 原文扫描完成");
}

void main();
