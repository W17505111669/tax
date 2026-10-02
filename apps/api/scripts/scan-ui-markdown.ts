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
 *   pnpm scan:uimd --interact-limit=4   # 每个页面最多点开几个折叠入口（默认 10）
 */
import { db } from "../src/db.ts";
import { launchChromium, WEB_URL } from "./browser-lib.ts";
import { loadTaskDocRefs } from "./docref-lib.ts";
import { TEXT_AMOUNT_TOOLS, traceAmounts } from "../../web/src/amount-trace.ts";
import { percentValue } from "../../web/src/format.ts";
import { outcomeOf, resolvedCalls } from "../../web/src/tool-outcome.ts";
import { STATUS_BARS, statusBreakdown } from "../../web/src/status-breakdown.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { listAgents } from "../src/agents.ts";
import { AGENT_IDS } from "@tax/shared-schemas";
import { listStoredCompares, type StoredCompare } from "../src/services/compare-stats.ts";
import { listTasks, listToolCalls } from "../src/services/task-store.ts";
import {
  ledgerCells,
  ledgerSort,
  ledgerTotals,
  ledgerTotalCells,
  LEDGER_COLUMNS,
  type LedgerRow,
} from "../../web/src/evidence-ledger.ts";

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

/** 比对页在界面上读到的东西：每条记录一张卡片区 + 工作表行，外加汇总环图与「没留下结果」提示 */
type CmpUi = {
  recs: Array<{
    id: string;
    kpi: Record<string, string>;
    sheets: Array<{ name: string; acc: number; matched: number; compared: number; skipped: number }>;
  }>;
  unusableShown: number;
  heading: string;
  ids: string[];
  donut: Array<{ label: string; v: number; pct: number }>;
};

/**
 * 在页面里读出比对页的结构化数字。用 DOM 结构而不是整页 innerText 正则：差异表的「类型」列里
 * 也有「差异 / 仅系统 / 仅人工」这几个词，按行配对会把表格单元格的值当成 KPI 卡的值。
 */
const CMP_READ = `(() => {
  const LABELS = ["总准确率", "一致率", "覆盖率", "比对项", "一致", "差异", "仅系统", "仅人工"];
  const recs = [];
  const secs = document.querySelectorAll("section.glow-card");
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    const grid = sec.querySelector("div.grid");
    const kpi = {};
    if (grid) {
      for (let j = 0; j < grid.children.length; j++) {
        const card = grid.children[j];
        const lab = ((card.children[0] && card.children[0].innerText) || "").trim();
        if (LABELS.indexOf(lab) >= 0) {
          kpi[lab] = ((card.children[1] && card.children[1].innerText) || "").replace(/\\s+/g, " ").trim();
        }
      }
    }
    const text = sec.innerText || "";
    const idm = /#([0-9a-f]{8})/.exec(text);
    const sheets = [];
    const re = /工作表「([^」]+)」[\\s\\S]*?准确率\\s*([0-9.]+)%\\s*·\\s*一致\\s*(\\d+)\\/(\\d+)\\s*·\\s*跳过公式格\\s*(\\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      sheets.push({
        name: m[1],
        acc: Number(m[2]),
        matched: Number(m[3]),
        compared: Number(m[4]),
        skipped: Number(m[5]),
      });
    }
    recs.push({ id: idm ? idm[1] : "", kpi: kpi, sheets: sheets });
  }
  const bt = document.body.innerText || "";
  const um = /另有 (\\d+) 次比对没有留下结构化结果/.exec(bt);
  const donut = [];
  const du = document.querySelector("[data-compare-donut]");
  if (du) {
    for (let k = 0; k < du.children.length; k++) {
      const t = (du.children[k].innerText || "").replace(/\\s+/g, " ").trim();
      const dm = /^(\\S+) (\\d+) (\\d+)%$/.exec(t);
      if (dm) donut.push({ label: dm[1], v: Number(dm[2]), pct: Number(dm[3]) });
    }
  }
  return {
    recs: recs,
    unusableShown: um ? Number(um[1]) : 0,
    heading: /没有可用的比对结果/.test(bt) ? "unusable" : /暂无比对记录/.test(bt) ? "none" : "",
    ids: (bt.match(/#[0-9a-f]{8}/g) || []).map((s) => s.slice(1)),
    donut: donut,
  };
})()`;

/**
 * 看板顶部那一排 KPI 卡（label / 数值 / 单位串）。值取 flex 行的第一个子元素、单位取最后一个：
 * 中间可能夹着「较上次变化」的 delta 徽章，按 children[1] 取会把徽章文字当成单位。
 */
const KPI_READ = `(() => {
  const grid = document.querySelector("[data-kpi-grid]");
  if (!grid) return { cards: [] };
  const cards = [];
  for (let i = 0; i < grid.children.length; i++) {
    const card = grid.children[i];
    const row = card.children[1];
    const first = row ? row.firstElementChild : null;
    const last = row ? row.lastElementChild : null;
    cards.push({
      label: ((card.children[0] && card.children[0].innerText) || "").trim(),
      value: (first && first.innerText ? first.innerText : "").trim(),
      unit: (last && last !== first && last.innerText ? last.innerText : "").replace(/\\s+/g, " ").trim(),
    });
  }
  return { cards: cards };
})()`;

/** 看板「任务状态分布」那几条（标签 + 件数）与右上角的「共 N 件」 */
const BARS_READ = `(() => {
  const ul = document.querySelector("[data-status-bars]");
  const bars = [];
  if (ul) {
    for (let i = 0; i < ul.children.length; i++) {
      const li = ul.children[i];
      bars.push({
        label: ((li.children[0] && li.children[0].innerText) || "").trim(),
        value: ((li.children[2] && li.children[2].innerText) || "").trim(),
      });
    }
  }
  const m = /共 (\\d+) 件/.exec(document.body.innerText || "");
  return { bars: bars, total: m ? Number(m[1]) : null };
})()`;

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
    interactLimit: 10,
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
const TOGGLE_OPEN = /(展开|收起|折叠|更多|显示全部|查看全部|帮助|详情|快捷键|修订指令)/;
const TOGGLE_BLOCK =
  /(复查|复核|下载|删除|清空|生成|上传|运行|重跑|续跑|复制|写入|写回|导出|重新解析|校验|核验|标注|保存|提交|新建|发送|启动|停止|归档|打开|跳转|前往)/;
/**
 * 纯布局开关：点开只会**藏起**文本（会话侧栏收起后任务列表整块没了），而且「收起 / 展开」是
 * 一对 label 不同的开关，去重按 label 挡不住，每页白白吃掉两轮预算。实测 6 轮预算里被它们占掉
 * 2 轮 + 键盘快捷键 1 轮，剩 3 轮走不到「文号溯源」那条链（查看全部 → 展开其余 33 类 → 折叠全部
 * → 文号溯源），必需入口一次都没点到。排掉它们，把预算留给真正会长出新文本的面板。
 */
const TOGGLE_SKIP = /(会话侧栏)/;
/**
 * BLOCK 的例外，逐个点名、只按**可见文字**精确放行：这些按钮的名字里带 BLOCK 词，但点下去只改
 * 前端状态（`fillRevisionInstruction` 把修订指令填进「续跑任务」输入框并展开面板），既不写库也不
 * 发请求。它打开的正是 P0 里点名要覆盖的「修订模式对话框」，而那一块文本此前从来没被扫过。
 * 放行范围严格限定在按钮文字上，title 里的「需人工核对后提交」不参与判断；面板里真正会提交的
 * 按钮（提交 / 续跑 / 运行）仍在 BLOCK 里，一个都不放。
 */
const TOGGLE_ALLOW = /^生成修订指令/;
/**
 * 这些入口必须真的点到，否则「交互覆盖」就是空跑绿：面板没展开，里面的残留永远扫不到。
 * 「键盘快捷键」是图标按钮（只有 title，没有文字），此前 OPEN 词汇表里没有它，于是这个浮层的
 * 内容从来没被扫过一次——实测 34 页 201 次点击、14 类入口，全是带文字的按钮。
 */
const REQUIRED_TOGGLES: Array<{ label: string; tabs: string[] }> = [
  { label: "文号溯源", tabs: ["result", "review"] },
  { label: "键盘快捷键", tabs: ["timeline", "result", "compare", "review"] },
  { label: "生成修订指令", tabs: ["result", "review"] },
];

const listTogglesSource = `(spec) => {
  const open = new RegExp(spec[0]);
  const block = new RegExp(spec[1]);
  const skip = new RegExp(spec[2]);
  const allow = new RegExp(spec[3]);
  const out = [];
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], summary'))) {
    const flat = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const title = flat(el.getAttribute('title'));
    const aria = flat(el.getAttribute('aria-label'));
    const text = flat(el.textContent);
    const hay = title + ' ' + aria + ' ' + text;
    if (!open.test(hay)) continue;
    // BLOCK 的分寸：有文字就只看文字，没文字（图标按钮）才退回 title / aria-label。
    // 两边都得防：图标按钮的 text 是空的，只拿 text 试 BLOCK 等于不设防，一个 title 写着
    // 「更多操作（删除 / 清空）」的图标按钮会因为 OPEN 命中「更多」而被点下去；而有文字的按钮
    // 不能拿 title 试 BLOCK——title 常常是一整段说明，实测「文号溯源」那个只读面板的 title 里
    // 写着「已联网复查 N 处…待人工确认 N 处」，一下命中三个 BLOCK 词，必需入口被自己排掉了。
    if (block.test(text === '' ? hay : text) && !allow.test(text)) continue;
    if (skip.test(hay)) continue;
    if (el.offsetParent === null) continue;
    el.setAttribute('data-scan-toggle', String(out.length));
    out.push({
      idx: out.length,
      label: (text.slice(0, 24) || aria.slice(0, 24) || title.slice(0, 24)).trim(),
      iconOnly: text === '',
    });
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
  /**
   * 范围内的全部任务（含没有结论的那几个）。逐页扫的仍是 targets，但**不依赖结论**的判据
   *（比对页就是）要用 scoped：--all 时 targets 按 rlen>0 过滤，实测 4bb22d34 那 2 次比对留存
   * 是空对象、正是「没有可用结果」这条路径唯一的真实样本，它没有结论，于是不在 targets 里，
   * 全库跑压根走不到它——判据留着也等于空转。
   */
  let scoped = rows;
  if (args.tasks && args.tasks.length > 0) {
    const keys = args.tasks.map((t) => t.trim());
    targets = rows.filter((r) => keys.some((k) => r.id.startsWith(k) || r.title.includes(k)));
    scoped = targets;
  } else if (!args.all) {
    targets = rows.filter((r) => r.rlen > 0).slice(0, 8);
    scoped = targets;
  } else {
    targets = rows.filter((r) => r.rlen > 0);
    scoped = rows;
  }

  // 界面上渲染出来的数字也要与库里的取数对一遍。门禁此前比的是台账 / 交付 MD / manifest /
  // 作品说明，**界面这条腿一直是空的**：徽章取数与门禁取数不同源、或哪个 useMemo 依赖漏了，
  // 界面上的数字就会与交付材料对不上，而没有任何东西会报警。期望值全部用门禁那一份口径算
  // （docref-lib 的文号溯源、verify:amounts 的金额溯源、tool_calls 的调用数），不另立一套。
  const docrefOf = new Map<string, { traced: number; total: number }>();
  for (const td of loadTaskDocRefs()) docrefOf.set(td.taskId, { traced: td.res.traced, total: td.res.total });
  // 看板取数：台账合计行那一行里有 15 个数字，全部与它对
  const board = computePlatformStats();
  const bev = board.evidence;
  // 看板 KPI 卡的期望值：与界面同一个 computePlatformStats()，比率与分母也走界面那一份
  // percentValue / resolvedCalls / outcomeOf（outcomeOf 本轮从 AgentOverview 挪进 tool-outcome.ts，
  // 就是为了不在这里再抄一遍四个字段名——抄错一个，成功率的分母就悄悄换了）。
  const boardOutcome = outcomeOf(board);
  const kpiWant: Array<{ label: string; value: string; unit: string }> = [
    { label: "累计任务", value: board.tasks.toLocaleString("zh-CN"), unit: "个" },
    { label: "已完成", value: board.completed.toLocaleString("zh-CN"), unit: "个" },
    { label: "工具成功率", value: percentValue(board.toolOk, resolvedCalls(boardOutcome)), unit: "%" },
    { label: "底稿产物", value: board.artifacts.toLocaleString("zh-CN"), unit: "份" },
    {
      label: "记录级比对准确率",
      value: board.compareAccuracy !== null ? String(board.compareAccuracy) : "—",
      // 单位串里还带着一个对外数字（累计一致率），所以整串一起对，不只对那个百分号
      unit:
        board.compareMatchRateOverall !== null ? `% · 累计一致率 ${board.compareMatchRateOverall}%` : "%",
    },
    {
      label: "OCR 平均置信度",
      value: board.ocrAvgConfidence !== null ? String(board.ocrAvgConfidence) : "—",
      unit: board.ocrRuns > 0 ? `% · ${board.ocrRuns} 次` : "%",
    },
  ];
  // 台账表格的期望值：与导出（MD / CSV）同一份 ledgerCells，行序也与界面同一份 ledgerSort
  const agents = listAgents();
  // 看板「任务状态分布」的期望值：与 App.tsx 同一份 statusBreakdown、同一份 STATUS_BARS 名单，
  // 任务清单走 listTasks(agentId)——interrupted 是它按 error 文本算出来的，不是库里的一列，
  // 自己写 SQL 数就会把「服务重启打断的」重新混回「执行失败」，正是界面刻意分开的那两类。
  const barsWant = new Map<string, { total: number; bars: Array<{ label: string; value: string }> }>();
  for (const agentId of AGENT_IDS) {
    const list = listTasks(agentId);
    const bd = statusBreakdown(list);
    barsWant.set(agentId, {
      total: list.length,
      bars: STATUS_BARS.map((b) => ({ label: b.label, value: String(bd[b.key]) })),
    });
  }
  // 用 shortName：界面与导出（ledgerMarkdown / ledgerCsv）传的是同一个 agentName 函数，取的是
  // shortName；第一版拿 displayName 当期望值，「作品」列 40 行全部报不一致，报的是我自己的错。
  const agentNameOf = (id: string): string => agents.find((a) => a.id === id)?.shortName ?? id;
  const expLedgerRows = ledgerSort(bev.ledger as unknown as LedgerRow[]);
  const expLedgerCells = expLedgerRows.map((r) => ledgerCells(r, agentNameOf));
  /** 单任务证据核对表的期望值来源：看板 ledger 那一份（与台账逐行同源） */
  const ledgerOf = new Map(bev.ledger.map((r) => [r.taskId, r]));
  /** 比对页的期望值：可用记录（含现算的一致率 / 覆盖率）与「没留下结构化结果」的记录 */
  const cmpOf = new Map<string, { usable: StoredCompare[]; unusable: StoredCompare[] }>();
  const expectOf = new Map<
    string,
    { calls: number; docTraced: number; docTotal: number; amtTraced: number; amtTotal: number }
  >();
  for (const t of targets) {
    const d = db
      .prepare(`SELECT COALESCE(result,'') AS result, COALESCE(instruction,'') AS instruction FROM tasks WHERE id = ?`)
      .get(t.id) as { result: string; instruction: string };
    const callRows = db.prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`).all(t.id) as Array<{
      tool_name: string;
      result: string | null;
      ok: number | null;
    }>;
    const parsedAll = callRows.map((r) => {
      try {
        return r.result ? (JSON.parse(r.result) as unknown) : null;
      } catch {
        return null;
      }
    });
    const okIdx = callRows.map((_, i) => i).filter((i) => callRows[i]!.ok === 1);
    const amt = traceAmounts(
      d.result,
      okIdx.map((i) => parsedAll[i]),
      d.instruction,
      okIdx
        .filter((i) => TEXT_AMOUNT_TOOLS.has(callRows[i]!.tool_name))
        .map((i) => parsedAll[i]),
    );
    const dr = docrefOf.get(t.id) ?? { traced: 0, total: 0 };
    expectOf.set(t.id, {
      calls: callRows.length,
      docTraced: dr.traced,
      docTotal: dr.total,
      amtTraced: amt.traced,
      amtTotal: amt.total,
    });
    // 比对页的期望值走 /api/tasks/:id/compares 用的那一份 listStoredCompares，顺序也是同一个
    // listToolCalls（ORDER BY started_at ASC）：界面少渲染一条、或把比率换成读留存字段，这里都会红。
    const cmp = listStoredCompares(listToolCalls(t.id));
    cmpOf.set(t.id, {
      usable: cmp.filter((c) => c.totals !== null && c.rates !== null),
      unusable: cmp.filter((c) => c.totals === null),
    });
  }

  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pages: Array<{ label: string; url: string; tab: string; taskId: string; agentId: string }> = [];
  if (args.overview) {
    // 作品名单取 shared-schemas 的 AGENT_IDS：此前这里手抄了一份 ["rd-audit", "land-vat"]，
    // 多一个作品时看板会整个漏扫，而且漏得悄无声息（页数少两页而已）
    for (const agentId of AGENT_IDS) {
      pages.push({ label: `总览 ${agentId}`, url: `${WEB}/#/agent/${agentId}`, tab: "", taskId: "", agentId });
    }
  }
  for (const t of targets) {
    for (const tab of args.tabs) {
      pages.push({
        label: `${t.title.slice(0, 18)} · ${tab}`,
        url: `${WEB}/#/agent/${t.agentId}/task/${t.id}/tab/${tab}`,
        tab,
        taskId: t.id,
        agentId: t.agentId,
      });
    }
  }
  // 补上「范围内有比对留存、但没有结论」的任务的比对页。只补真有留存的那几个，
  // 否则失败任务的空页会被整批拖进来，扫得慢还容易撞上「内容过少」判据。
  if (args.tabs.includes("compare")) {
    const inTargets = new Set(targets.map((t) => t.id));
    for (const r of scoped.filter((x) => !inTargets.has(x.id))) {
      const cmp = listStoredCompares(listToolCalls(r.id));
      if (cmp.length === 0) continue;
      cmpOf.set(r.id, {
        usable: cmp.filter((c) => c.totals !== null && c.rates !== null),
        unusable: cmp.filter((c) => c.totals === null),
      });
      pages.push({
        label: `${r.title.slice(0, 18)} · compare`,
        url: `${WEB}/#/agent/${r.agentId}/task/${r.id}/tab/compare`,
        tab: "compare",
        taskId: r.id,
        agentId: r.agentId,
      });
    }
  }

  const allHits: Hit[] = [];
  let scanned = 0;
  let pageScans = 0;
  let interacted = 0;
  let toggleFailed = 0;
  let navigatedAway = 0;
  /** 点开过的图标按钮（只有 title / aria-label，没有文字）：为 0 就说明这条路根本没生效 */
  let iconOnlyClicked = 0;
  const iconOnlyLabels = new Set<string>();
  /** 界面数字与库取数的核对：项数与不一致清单（不一致即失败，不是提醒） */
  let numChecks = 0;
  const numFails: string[] = [];
  /** 台账表格逐格核对：核到的单元格数与不一致数（为 0 说明表格压根没展开） */
  let ledgerCellChecks = 0;
  let ledgerCellBad = 0;
  /** 比对页数字核对：核到的数字个数（为 0 说明这一屏压根没核到，覆盖是空的） */
  let cmpChecks = 0;
  /** 看板 KPI 卡核对：核到的项数（标签 / 数值 / 单位串各算一项） */
  let kpiChecks = 0;
  /** 看板「任务状态分布」核对：核到的项数（每条算标签 + 件数，外加合计与「共 N 件」） */
  let barsChecks = 0;
  /**
   * 枚举时**见过**的入口（点没点到另说）。「必需入口」的判据是「范围内出现过就必须点到」，
   * 不是「任何时候都必须点到」：窄范围跑（--tasks 指定几个任务、--no-overview）时，
   * 有些入口在这些页面上压根不存在——实测 4 个失败任务的结果页就没有「文号溯源」，
   * 按老判据会红，而红的原因与覆盖率无关。
   */
  const seenLabels = new Set<string>();
  const seenIconOnly = new Set<string>();
  /** 其中扫完成功关回去的次数：关不掉的浮层会一直盖住后面的入口 */
  let iconOnlyClosed = 0;
  /** 点开过多少次「续跑任务」面板（由「生成修订指令」打开，扫完按 Esc 收起） */
  let revisionPanels = 0;
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

  /** 枚举当前页点得动的折叠入口。每轮都要重新枚举，理由见下面循环里的注释。 */
  const listToggles = () =>
    page.evaluate(
      `(${listTogglesSource})(${JSON.stringify([
        TOGGLE_OPEN.source,
        TOGGLE_BLOCK.source,
        TOGGLE_SKIP.source,
        TOGGLE_ALLOW.source,
      ])})`,
    ) as Promise<Array<{ idx: number; label: string; iconOnly: boolean }>>;

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
    if (p.tab === "result" && p.taskId !== "") {
      const want = expectOf.get(p.taskId);
      // 等界面把事件回放完再取数：以头部「工具调用 N 次」与库里的调用数对齐为准。固定等一小段
      // 时间在大任务上会量到半成品（徽章还没挂上就被判成「界面没有这个数」），在小任务上白等。
      const deadline = Date.now() + 30000;
      let bodyText = (await page.evaluate(`document.body.innerText`)) as string;
      while (Date.now() < deadline && want !== undefined && !bodyText.includes(`工具调用 ${want.calls} 次`)) {
        await page.waitForTimeout(500);
        bodyText = (await page.evaluate(`document.body.innerText`)) as string;
      }
      const one = (re: RegExp): number | null => {
        const m = re.exec(bodyText);
        return m ? Number(m[1]) : null;
      };
      const pair = (re: RegExp): [number, number] | null => {
        const m = re.exec(bodyText);
        return m ? [Number(m[1]), Number(m[2])] : null;
      };
      if (want) {
        const calls = one(/工具调用 (\d+) 次/);
        numChecks += 1;
        if (calls !== want.calls) numFails.push(`${p.label} 头部「工具调用 ${calls} 次」≠ 库里 ${want.calls} 次`);
        const doc = pair(/文号溯源 (\d+)\/(\d+)/);
        numChecks += 1;
        if (want.docTotal > 0) {
          if (doc === null) {
            numFails.push(`${p.label} 门禁取数有 ${want.docTotal} 处文号，界面上却没有「文号溯源」徽章`);
          } else if (doc[0] !== want.docTraced || doc[1] !== want.docTotal) {
            numFails.push(`${p.label} 文号溯源徽章 ${doc[0]}/${doc[1]} ≠ 门禁取数 ${want.docTraced}/${want.docTotal}`);
          }
        } else if (doc !== null) {
          numFails.push(`${p.label} 门禁取数里没有文号，界面却显示「文号溯源 ${doc[0]}/${doc[1]}」`);
        }
        const amt = pair(/金额溯源 (\d+)\/(\d+)/);
        numChecks += 1;
        if (want.amtTotal > 0) {
          if (amt === null) {
            numFails.push(`${p.label} 门禁取数有 ${want.amtTotal} 处金额，界面上却没有「金额溯源」徽章`);
          } else if (amt[0] !== want.amtTraced || amt[1] !== want.amtTotal) {
            numFails.push(`${p.label} 金额溯源徽章 ${amt[0]}/${amt[1]} ≠ 门禁取数 ${want.amtTraced}/${want.amtTotal}`);
          }
        } else if (amt !== null) {
          numFails.push(`${p.label} 门禁取数里没有金额，界面却显示「金额溯源 ${amt[0]}/${amt[1]}」`);
        }
        // 单任务「证据核对表」：这张表同时会作为核对表 MD 进交付包，界面渲染与导出用的是同一份
        // 取数（evidence-sheet.ts），但**渲染路径**此前没人核对过——表少一行、或某一行的数字
        // 换了口径，导出侧的门禁（verify:sheet）照样全绿。
        const sheet = (await page.evaluate(`(function () {
          for (const t of Array.from(document.querySelectorAll('table'))) {
            const head = Array.from(t.querySelectorAll('thead th, thead td')).map((c) =>
              (c.textContent || '').replace(/\\s+/g, ' ').trim(),
            );
            if (head.join('|') !== '#|核对项|结论|说明') continue;
            return Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
              Array.from(tr.querySelectorAll('td,th')).map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim()),
            );
          }
          return null;
        })()`)) as string[][] | null;
        const lrow = ledgerOf.get(p.taskId);
        numChecks += 1;
        if (!sheet) {
          numFails.push(`${p.label} 没找到「证据核对表」（表头应为 # / 核对项 / 结论 / 说明）`);
        } else if (lrow) {
          const textOf = (name: string): string | null => {
            const r = sheet.find((x) => (x[1] ?? "").includes(name));
            return r ? r.slice(2).join(" ") : null;
          };
          const wantItem = (name: string, frag: string): string | null => {
            const text = textOf(name);
            numChecks += 1;
            if (text === null) {
              numFails.push(`${p.label} 核对表里没有「${name}」这一项`);
              return null;
            }
            if (!text.includes(frag)) {
              numFails.push(`${p.label} 核对表「${name}」界面「${text.slice(0, 40)}」不含取数值「${frag}」`);
            }
            return text;
          };
          wantItem("政策文号溯源", `${lrow.docRefTraced}/${lrow.docRefTotal}`);
          // 0 条引用 / 0 次检索时，核对表给的不是「0/0」而是一句空态提示（「无联网引用 结论未引用
          // 联网来源，涉及政策依据请确认是否已完成在线核验」/「无检索调用 本任务没有联网检索类
          // 工具调用」）。这是**该保住的行为**：空态无提示正是界面走查要拦的缺陷之一，所以这里
          // 两种写法都认，但必须出现其中之一——第一版按数字硬对，8 处全是我的期望值错了。
          const citeText = textOf("联网引用证据力");
          numChecks += 1;
          if (citeText === null) numFails.push(`${p.label} 核对表里没有「联网引用证据力」这一项`);
          else if (lrow.citations > 0) {
            if (!citeText.includes(`${lrow.official}/${lrow.citations}`)) {
              numFails.push(
                `${p.label} 核对表「联网引用证据力」界面「${citeText.slice(0, 40)}」不含取数值「${lrow.official}/${lrow.citations}」`,
              );
            }
          } else if (!citeText.includes("无联网引用")) {
            numFails.push(
              `${p.label} 核对表「联网引用证据力」0 条引用时既没写 0/0 也没给空态提示（界面：${citeText.slice(0, 40)}）`,
            );
          }
          const searchText = textOf("联网检索留痕");
          numChecks += 1;
          if (searchText === null) numFails.push(`${p.label} 核对表里没有「联网检索留痕」这一项`);
          else if (lrow.searchCalls > 0) {
            if (!searchText.includes(`检索 ${lrow.searchCalls} 次`)) {
              numFails.push(
                `${p.label} 核对表「联网检索留痕」界面「${searchText.slice(0, 40)}」不含取数值「检索 ${lrow.searchCalls} 次」`,
              );
            }
          } else if (!searchText.includes("无检索调用")) {
            numFails.push(
              `${p.label} 核对表「联网检索留痕」0 次检索时既没写「检索 0 次」也没给空态提示（界面：${searchText.slice(0, 40)}）`,
            );
          }
          // 弱证据条数写在「联网引用证据力」的说明里；为 0 时界面不写这一段，所以只在有弱证据时要求
          if (lrow.weak > 0) {
            const text = textOf("联网引用证据力");
            numChecks += 1;
            if (text === null || !text.includes(`证据力弱 ${lrow.weak}`)) {
              numFails.push(`${p.label} 核对表「联网引用证据力」没写出证据力弱 ${lrow.weak} 条（界面：${(text ?? "无此项").slice(0, 40)}）`);
            }
          }
          // 只留元数据的检索次数：与「引自联网正文 / 三处均无出处」一样，是判定成立的前提，必须交代
          if (lrow.searchMetadataOnly > 0) {
            const text = textOf("联网检索留痕");
            numChecks += 1;
            if (text === null || !text.includes(`只留查询元数据 ${lrow.searchMetadataOnly} 次`)) {
              numFails.push(`${p.label} 核对表「联网检索留痕」没写出只留查询元数据 ${lrow.searchMetadataOnly} 次`);
            }
          }
        }
      }
    }
    // 比对页：这一屏的数字此前一个都没被核对过（scan 只是路过它扫 Markdown 残留）。期望值来自
    // /api/tasks/:id/compares 用的那一份 listStoredCompares——计数取自留存，一致率 / 覆盖率由
    // compareRates 现算（与工具返回文本、看板、作品说明同一个函数），不读留存里的百分比字段。
    if (p.tab === "compare" && p.taskId !== "") {
      const want = cmpOf.get(p.taskId);
      const wantCount = want ? want.usable.length + want.unusable.length : 0;
      let ui = (await page.evaluate(CMP_READ)) as CmpUi;
      if (want && wantCount > 0) {
        // 等界面把比对记录取回来再取数：以渲染出的记录条数对齐为准，固定等一小段在大任务上会量到半成品
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && ui.recs.length + ui.unusableShown < wantCount) {
          await page.waitForTimeout(400);
          ui = (await page.evaluate(CMP_READ)) as CmpUi;
        }
        cmpChecks += 1;
        if (ui.recs.length !== want.usable.length) {
          numFails.push(
            `${p.label} 比对页渲染了 ${ui.recs.length} 条记录，库里可用的是 ${want.usable.length} 条（少的那条此前是 !totals 就 return null 静默丢的）`,
          );
        }
        const byId = new Map(ui.recs.map((r) => [r.id, r]));
        for (const r of want.usable) {
          const short = r.id.slice(0, 8);
          const got = byId.get(short);
          cmpChecks += 1;
          if (!got) {
            numFails.push(`${p.label} 库里比对记录 #${short} 在界面上找不到（渲染时被静默丢掉）`);
            continue;
          }
          const t = r.totals!;
          const rt = r.rates!;
          const exp: Record<string, string> = {
            一致率: rt.matchRateText,
            覆盖率: rt.coverageText,
            比对项: String(t.compared),
            一致: String(t.matched),
            差异: String(t.mismatched),
            仅系统: String(t.onlyA),
            仅人工: String(t.onlyB),
          };
          // 总准确率那张卡后面可能跟着「较上次比对变化」的 ▲/▼，所以只钉开头那一段
          cmpChecks += 1;
          const acc = String(got.kpi["总准确率"] ?? "");
          if (!acc.startsWith(`${t.accuracyPercent}%`)) {
            numFails.push(`${p.label} #${short}「总准确率」界面「${acc || "(缺)"}」不含取数「${t.accuracyPercent}%」`);
          }
          for (const [lab, wantText] of Object.entries(exp)) {
            cmpChecks += 1;
            const gotText = String(got.kpi[lab] ?? "");
            if (gotText !== wantText) {
              numFails.push(`${p.label} #${short}「${lab}」界面「${gotText || "(缺)"}」≠ 取数「${wantText}」`);
            }
          }
          const expSheets = (r.result?.sheets ?? []) as unknown as Array<{
            sheetA: string;
            accuracyPercent: number;
            matched: number;
            compared: number;
            skippedFormulas: number;
          }>;
          cmpChecks += 1;
          if (got.sheets.length !== expSheets.length) {
            numFails.push(
              `${p.label} #${short} 界面上渲染了 ${got.sheets.length} 个工作表，留存里是 ${expSheets.length} 个`,
            );
          }
          expSheets.forEach((s, i) => {
            const g = got.sheets[i];
            cmpChecks += 1;
            if (!g) {
              numFails.push(`${p.label} #${short} 界面上少了工作表「${s.sheetA}」`);
              return;
            }
            for (const [lab, wantV, gotV] of [
              ["表名", s.sheetA, g.name],
              ["准确率", `${s.accuracyPercent}%`, `${g.acc}%`],
              ["一致/比对", `${s.matched}/${s.compared}`, `${g.matched}/${g.compared}`],
              ["跳过公式格", String(s.skippedFormulas), String(g.skipped)],
            ] as Array<[string, string, string]>) {
              cmpChecks += 1;
              if (wantV !== gotV) {
                numFails.push(`${p.label} #${short} 工作表「${s.sheetA}」${lab} 界面「${gotV}」≠ 留存「${wantV}」`);
              }
            }
          });
        }
        // 汇总环图：四个计数必须等于各条记录之和，百分比必须等于该计数占四项合计的比例
        const sum = { 一致: 0, 差异: 0, 仅系统: 0, 仅人工: 0 };
        for (const r of want.usable) {
          const t = r.totals!;
          sum.一致 += t.matched;
          sum.差异 += t.mismatched;
          sum.仅系统 += t.onlyA;
          sum.仅人工 += t.onlyB;
        }
        const sumAll = sum.一致 + sum.差异 + sum.仅系统 + sum.仅人工;
        const gotDonut = new Map(ui.donut.map((d) => [d.label, d]));
        for (const [lab, wantV] of Object.entries(sum)) {
          cmpChecks += 1;
          if (sumAll === 0) {
            if (ui.donut.length !== 0) {
              numFails.push(`${p.label} 四项计数合计为 0，汇总环图不该出现（界面画了 ${ui.donut.length} 项）`);
            }
            continue;
          }
          const g = gotDonut.get(lab);
          if (!g) {
            numFails.push(`${p.label} 汇总环图里没有「${lab}」这一项`);
            continue;
          }
          if (g.v !== wantV) {
            numFails.push(`${p.label} 汇总环图「${lab}」${g.v} ≠ 各条记录之和 ${wantV}`);
          }
          cmpChecks += 1;
          const wantPct = Math.round((wantV / sumAll) * 100);
          if (g.pct !== wantPct) {
            numFails.push(`${p.label} 汇总环图「${lab}」百分比 ${g.pct}% ≠ ${wantPct}%`);
          }
        }
        // 没留下结构化结果的那几次：必须如实列出条数与记录号，不能静默不渲染
        cmpChecks += 1;
        if (ui.unusableShown !== want.unusable.length) {
          numFails.push(
            `${p.label} 库里 ${want.unusable.length} 次比对没有留下结构化结果，界面写的是「另有 ${ui.unusableShown} 次」`,
          );
        }
        for (const u of want.unusable) {
          const short = u.id.slice(0, 8);
          cmpChecks += 1;
          if (!ui.ids.includes(short)) {
            numFails.push(`${p.label} 没有结构化结果的比对 #${short} 没在界面上列出来（静默丢掉）`);
          }
        }
        if (want.usable.length === 0 && want.unusable.length > 0) {
          cmpChecks += 1;
          if (ui.heading !== "unusable") {
            numFails.push(
              `${p.label} 有 ${want.unusable.length} 次比对没留下结果、一条可用的都没有，界面却写「${
                ui.heading === "none" ? "暂无比对记录" : ui.heading || "(没有任何提示)"
              }」`,
            );
          }
        }
      } else if (want) {
        // 库里一条比对留存都没有：这一屏必须是明确的空态，不能是白板
        cmpChecks += 2;
        if (ui.recs.length !== 0 || ui.unusableShown !== 0) {
          numFails.push(
            `${p.label} 库里没有比对留存，界面却渲染了 ${ui.recs.length} 条记录 /「另有 ${ui.unusableShown} 次」`,
          );
        }
        if (ui.heading !== "none") {
          numFails.push(`${p.label} 库里没有比对留存，界面没给「暂无比对记录」空态（读到「${ui.heading || "无"}」）`);
        }
      }
    }
    // 看板页：台账合计行是界面这条腿上数字最密的一处（一行 15 个数），逐个与看板取数对。
    // 判据钉的是渲染出来的文本，所以版式一改（少一个空格、换个词）这里就会红——那是有意的：
    // 这一行是复核人扫一眼就看全平台欠账的地方，改了版式就得同时确认数字还是同一份取数。
    if (p.tab === "" && p.taskId === "") {
      const bodyText = ((await page.evaluate(`document.body.innerText`)) as string).replace(/\s+/g, " ");
      // 看板顶部那一排 KPI 卡是全平台最显眼的 6 个数字（22px），此前一项都没被核对过：
      // scan 在这一页只核过台账合计行与台账表格。按位置逐张对标签 / 数值 / 单位串——
      // 顺序也是判据的一部分，重排会让「工具成功率」顶着「累计任务」的标签显示。
      const kpiUi = (await page.evaluate(KPI_READ)) as {
        cards: Array<{ label: string; value: string; unit: string }>;
      };
      kpiChecks += 1;
      if (kpiUi.cards.length !== kpiWant.length) {
        numFails.push(
          `${p.label} 看板 KPI 卡渲染了 ${kpiUi.cards.length} 张，取数侧期望 ${kpiWant.length} 张（少一张就是有一个对外数字不见了）`,
        );
      }
      kpiWant.forEach((w, i) => {
        const g = kpiUi.cards[i];
        kpiChecks += 1;
        if (!g) {
          numFails.push(`${p.label} 看板第 ${i + 1} 张 KPI 卡「${w.label}」在界面上不存在`);
          return;
        }
        for (const [field, wantV, gotV] of [
          ["标签", w.label, g.label],
          ["数值", w.value, g.value],
          ["单位串", w.unit, g.unit],
        ] as Array<[string, string, string]>) {
          kpiChecks += 1;
          if (wantV !== gotV) {
            numFails.push(`${p.label} 看板第 ${i + 1} 张 KPI 卡${field}「${gotV || "(空)"}」≠ 取数「${wantV}」`);
          }
        }
      });
      // 「任务状态分布」与右上角「共 N 件」：这一块是 App.tsx 按 visibleTasks 现算的，
      // 与上面那排 KPI 卡（computePlatformStats）不是同一个来源，所以要单独对一遍。
      const barsUi = (await page.evaluate(BARS_READ)) as {
        bars: Array<{ label: string; value: string }>;
        total: number | null;
      };
      const bw = barsWant.get(p.agentId);
      if (bw) {
        barsChecks += 1;
        if (barsUi.total !== bw.total) {
          numFails.push(`${p.label} 「共 ${barsUi.total ?? "(没读到)"} 件」≠ 库里该作品 ${bw.total} 个任务`);
        }
        barsChecks += 1;
        if (barsUi.bars.length !== bw.bars.length) {
          numFails.push(
            `${p.label} 状态分布渲染了 ${barsUi.bars.length} 条，名单里是 ${bw.bars.length} 条（少一条就是有一类任务状态在看板上不见了）`,
          );
        }
        bw.bars.forEach((w, i) => {
          const g = barsUi.bars[i];
          barsChecks += 1;
          if (!g) {
            numFails.push(`${p.label} 状态分布第 ${i + 1} 条「${w.label}」在界面上不存在`);
            return;
          }
          // 按位置对：顺序本身是判据——「执行失败」与「已中断」调个位，件数就顶错了标签
          for (const [field, wantV, gotV] of [
            ["标签", w.label, g.label],
            ["件数", w.value, g.value],
          ] as Array<[string, string, string]>) {
            barsChecks += 1;
            if (wantV !== gotV) {
              numFails.push(`${p.label} 状态分布第 ${i + 1} 条${field}「${gotV || "(空)"}」≠ 取数「${wantV}」`);
            }
          }
        });
        // 各条件数之和必须等于「共 N 件」：TaskStatus 新增取值而名单没跟上时，这一条会先红
        barsChecks += 1;
        const barSum = bw.bars.reduce((a, b) => a + Number(b.value), 0);
        if (barSum !== bw.total) {
          numFails.push(
            `${p.label} 状态分布 ${bw.bars.length} 条合计 ${barSum} ≠ 该作品任务数 ${bw.total}（有状态被漏计，看板右上角那个数与分布对不上）`,
          );
        }
      }
      const LEDGER_TOTAL =
        /全平台证据核对台账（(\d+) 个任务）文号 (\d+)\/(\d+) 有出处（其中复查取得 (\d+) · 仅正文提到 (\d+)）· 待复查 (\d+)（已标注 (\d+)） · 引用 (\d+) 条（官方 (\d+) · 弱 (\d+)，待处置 (\d+)）· 金额待确认 (\d+)（引自联网正文 (\d+) · 三处均无出处 (\d+)） · 欠账任务 (\d+) 个/;
      const m = LEDGER_TOTAL.exec(bodyText);
      numChecks += 1;
      if (!m) {
        numFails.push(`${p.label} 没找到「全平台证据核对台账」合计行（界面数字最密的一处，改版式要同步这里的判据）`);
      } else {
        const NAMES = [
          "任务数",
          "文号有出处",
          "文号总数",
          "复查取得",
          "仅正文提到",
          "待复查",
          "已标注背景参考",
          "引用条数",
          "官方来源",
          "证据力弱",
          "弱证据待处置",
          "金额待确认",
          "引自联网正文",
          "三处均无出处",
          "欠账任务数",
        ];
        const wantNums = [
          board.tasks,
          bev.docRefTraced,
          bev.docRefs,
          bev.docRefTracedByRecheck,
          bev.docRefTracedByBody,
          // 界面上「待复查」是扣掉已标注的净值，「已标注」另给一个数：与台账的欠账公式同一口径
          Math.max(0, bev.docRefPending - bev.docRefLabeled),
          bev.docRefLabeled,
          bev.citations,
          bev.officialCitations,
          bev.weakCitations,
          Math.max(0, bev.weakCitations - bev.weakDisclaimed - bev.weakUncited),
          bev.amountPending,
          bev.amountPendingWeb,
          bev.amountPendingUnexplained,
          bev.gaps.length,
        ];
        const got = m.slice(1).map(Number);
        for (let i = 0; i < wantNums.length; i++) {
          numChecks += 1;
          if (got[i] !== wantNums[i]) {
            numFails.push(`${p.label} 台账合计行「${NAMES[i]}」界面 ${got[i]} ≠ 看板取数 ${wantNums[i]}`);
          }
        }
      }
      // 台账表格本体：40 行 × 22 列，此前在界面上一个单元格都没被核对过。表头与列序正是「按位置
      // 配对的两个数组」那类静默退化：JSX 里少一个 <td>、或列序与 LEDGER_COLUMNS 不一致，导出
      // （MD / CSV 走 ledgerCells）与界面就会各说一套，而两边各自看起来都是自洽的。
      const ledgerSummary = page.locator('summary:has-text("全平台证据核对台账")').first();
      if ((await ledgerSummary.count()) > 0) {
        await ledgerSummary.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(700);
      }
      const table = (await page.evaluate(`(function () {
        for (const t of Array.from(document.querySelectorAll('table'))) {
          const headRow = t.querySelector('thead tr') || t.querySelector('tr');
          if (!headRow) continue;
          const head = Array.from(headRow.querySelectorAll('th,td')).map((c) =>
            (c.textContent || '').replace(/\\s+/g, ' ').trim(),
          );
          if (head[0] !== '任务' || head.length < 20) continue;
          const rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
            Array.from(tr.querySelectorAll('td,th')).map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim()),
          );
          return { head: head, rows: rows };
        }
        return null;
      })()`)) as { head: string[]; rows: string[][] } | null;
      numChecks += 1;
      if (!table) {
        numFails.push(`${p.label} 没找到台账表格（表头第一列应为「任务」，需要先点开「全平台证据核对台账」）`);
      } else {
        numChecks += 1;
        if (table.head.join("|") !== LEDGER_COLUMNS.join("|")) {
          numFails.push(
            `${p.label} 台账表头与 LEDGER_COLUMNS 不一致：界面 ${table.head.length} 列（${table.head
              .slice(0, 4)
              .join("/")}…）vs 定义 ${LEDGER_COLUMNS.length} 列`,
          );
        }
        const lastRow = table.rows[table.rows.length - 1] ?? [];
        const totalRow = /合计/.test(lastRow[0] ?? "") ? lastRow : null;
        const bodyRows = totalRow ? table.rows.slice(0, -1) : table.rows;
        numChecks += 1;
        if (bodyRows.length !== expLedgerCells.length) {
          numFails.push(`${p.label} 台账界面 ${bodyRows.length} 行 ≠ 取数 ${expLedgerCells.length} 行`);
        }
        // 逐格比：界面单元格里可能还挂了徽章或链接文字，所以判据是「包含取数值」而不是全等
        let cellBad = 0;
        for (let i = 0; i < Math.min(bodyRows.length, expLedgerCells.length); i++) {
          for (let j = 0; j < LEDGER_COLUMNS.length; j++) {
            const want = expLedgerCells[i]![j] ?? "";
            if (want === "") continue;
            ledgerCellChecks += 1;
            const got = bodyRows[i]![j] ?? "";
            if (!got.includes(want)) {
              cellBad += 1;
              if (cellBad <= 6) {
                numFails.push(
                  `${p.label} 台账第 ${i + 1} 行「${LEDGER_COLUMNS[j]}」界面「${got.slice(0, 28)}」不含取数值「${want.slice(0, 28)}」`,
                );
              }
            }
          }
        }
        ledgerCellBad += cellBad;
        if (totalRow) {
          const wantTotal = ledgerTotalCells(ledgerTotals(expLedgerRows));
          for (let j = 0; j < wantTotal.length; j++) {
            const want = wantTotal[j] ?? "";
            if (want === "") continue;
            ledgerCellChecks += 1;
            if (!(totalRow[j] ?? "").includes(want)) {
              ledgerCellBad += 1;
              numFails.push(
                `${p.label} 台账合计行第 ${j + 1} 列界面「${(totalRow[j] ?? "").slice(0, 28)}」不含取数值「${want.slice(0, 28)}」`,
              );
            }
          }
        }
        // 界面表格没有合计行是**对的**：合计走 <summary> 那一行（上面已按 15 个数字逐项核过），
        // ledgerTotalCells 只用于 MD / CSV 导出。所以合计行「有就核、没有不算失败」。
      }
    }
    if (args.interact && args.interactLimit > 0) {
      // 每轮重新枚举，不复用上一轮的标记：点开一个面板会让 React 重建那一片 DOM，
      // 挂在旧节点上的 data-scan-toggle 跟着没了——第一版一次枚举到底，实测 92 次成功里
      // 有 52 次点击失败，全是这个原因，等于三分之一的折叠态没扫到。
      // 去重按 label：同一个入口展开后文本会变（「展开全部」→「折叠全部」），不会被重复点。
      const clicked = new Set<string>();
      for (let round = 0; round < args.interactLimit; round++) {
        const toggles = await listToggles();
        for (const x of toggles) {
          seenLabels.add(x.label);
          if (x.iconOnly) seenIconOnly.add(x.label);
        }
        // 必需入口先点：interactLimit 是每页的点击预算（默认 6），DOM 顺序在前的一堆普通入口
        // 就能把预算吃光，于是「必须点到」这条断言变成自己无法满足的要求。
        const pending = toggles.filter((x) => !clicked.has(x.label));
        const t = pending.find((x) => REQUIRED_TOGGLES.some((r) => x.label.includes(r.label))) ?? pending[0];
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
        if (t.iconOnly) {
          iconOnlyClicked += 1;
          iconOnlyLabels.add(t.label);
          // 图标按钮开的是绝对定位浮层，开着会盖住主内容左侧的入口：第一版扫完就留着不关，
          // 实测 34 次点击被它拦下、必需入口「文号溯源」一次都没点到，扫过的文本节点从
          // 130789 掉到 117791——为了多扫一个浮层反而少扫了七类面板。扫完立刻点回去关掉。
          const back = (await listToggles()).find((x) => x.label === t.label);
          if (back) {
            try {
              await page.locator(`[data-scan-toggle="${back.idx}"]`).first().click({ timeout: 2500 });
              iconOnlyClosed += 1;
            } catch {
              toggleFailed += 1;
            }
            await page.waitForTimeout(200);
          }
        }
        // 「生成修订指令」会把修订指令填进「续跑任务」面板并展开它（只改前端状态）。面板是覆盖层，
        // 扫完按 Esc 收起——快捷键表里就写着「Esc 收起续跑面板 / 阅读器」，别让它挡住后面的入口。
        if (TOGGLE_ALLOW.test(t.label)) {
          revisionPanels += 1;
          await page.keyboard.press("Escape");
          await page.waitForTimeout(250);
        }
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
        (r) =>
          r.tabs.some((t) => args.tabs.includes(t)) &&
          [...seenLabels].some((l) => l.includes(r.label)) &&
          ![...toggleLabels].some((l) => l.includes(r.label)),
      ).map((r) => r.label)
    : [];
  /** 本次扫描范围内压根没出现的必需入口：如实报出来，但不算失败 */
  const requiredAbsent = args.interact
    ? REQUIRED_TOGGLES.filter(
        (r) => r.tabs.some((t) => args.tabs.includes(t)) && ![...seenLabels].some((l) => l.includes(r.label)),
      ).map((r) => r.label)
    : [];
  // 图标按钮一个都没点到 = title / aria-label 那条匹配路径失效了（词汇表被改窄、或组件换了写法），
  // 这些浮层里的内容会静默退出扫描范围，而扫描照样是绿的。
  const iconOnlyMissing =
    args.interact && args.interactLimit > 0 && seenIconOnly.size > 0 && iconOnlyClicked === 0;

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
          iconOnlyClicked,
          iconOnlyClosed,
          iconOnlyLabels: [...iconOnlyLabels],
          revisionPanels,
          requiredMissing,
          requiredAbsent,
          seenLabels: [...seenLabels],
          numChecks,
          numFails,
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
    console.log(
      `[scan] 其中图标按钮（无文字，只靠 title / aria-label 认出来）：点开 ${iconOnlyClicked} 次 · 关回 ${iconOnlyClosed} 次 · ${iconOnlyLabels.size} 类${
        iconOnlyLabels.size > 0 ? `：${[...iconOnlyLabels].join("；")}` : ""
      }`,
    );
    console.log(`[scan] 「续跑任务」面板（修订模式对话框）：点开并扫过 ${revisionPanels} 次`);
    if (requiredMissing.length > 0) {
      console.log(`[scan] 必需入口一次都没点到：${requiredMissing.join("；")}（这些面板里的内容等于没扫）`);
    }
    if (requiredAbsent.length > 0) {
      console.log(`[scan] 本次范围内没出现的必需入口：${requiredAbsent.join("；")}（不计为失败，换 --all 复扫才会覆盖到）`);
    }
    if (iconOnlyMissing) console.log("[scan] 一个图标按钮都没点到：这些浮层里的内容等于没扫");
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
  // 台账表格没展开时逐格核对会一个都不剩，那这项覆盖就是空的（合计行那 15 个数还在，容易掩盖）
  if (args.overview && ledgerCellChecks === 0) {
    numFails.push("一个台账单元格都没核到（表格没展开？），逐格核对这项覆盖是空的");
  }
  // 比对页同理：范围内有比对留存却一个数字都没核到，说明这一屏的覆盖是空的（比如页面压根没挂载）
  // 数 cmpOf 而不是 targets：补进来的「有比对留存但没有结论」的任务不在 targets 里，
  // 按 targets 数会少报一个（实测 4 对 5），报出来的覆盖面比真实的小。
  let cmpTargets = 0;
  for (const c of cmpOf.values()) if (c.usable.length + c.unusable.length > 0) cmpTargets += 1;
  const compareMissing = args.tabs.includes("compare") && cmpTargets > 0 && cmpChecks === 0;
  if (args.tabs.includes("compare") && cmpTargets > 0) {
    console.log(`[scan] 比对页数字核对：${cmpChecks} 项（范围内 ${cmpTargets} 个任务有比对留存）`);
  }
  // 看板 KPI 卡同理：扫了总览页却一张卡都没核到，说明 data-kpi-grid 这个钩子失效了（版式改过）
  const kpiMissing = args.overview && kpiChecks === 0;
  if (args.overview) console.log(`[scan] 看板 KPI 卡核对：${kpiChecks} 项（期望每张卡 3 项 × ${kpiWant.length} 张 × 总览页数）`);
  const barsMissing = args.overview && barsChecks === 0;
  if (args.overview) console.log(`[scan] 看板状态分布核对：${barsChecks} 项（${STATUS_BARS.length} 条 × 2 项 + 条数 + 共 N 件 + 合计，× 总览页数）`);
  console.log(
    `[scan] 界面数字与库取数核对：${numChecks} 项 + 台账单元格 ${ledgerCellChecks} 个 + 比对页 ${cmpChecks} 项 + 看板 KPI ${kpiChecks} 项 + 状态分布 ${barsChecks} 项（不一致 ${ledgerCellBad} 个）· 合计不一致 ${numFails.length} 处`,
  );
  for (const f of numFails.slice(0, 10)) console.log(`  - ${f}`);
  if (numFails.length > 10) console.log(`  …另有 ${numFails.length - 10} 处`);
  // 只有本轮确实扫了结果页时才要求「核对过数字」，否则 --tabs=timeline 这种窄跑会被误判成空跑
  const numbersMissing = args.tabs.includes("result") && targets.length > 0 && numChecks === 0;
  if (
    args.strict &&
    (allHits.length > 0 ||
      thin.length > 0 ||
      requiredMissing.length > 0 ||
      iconOnlyMissing ||
      numFails.length > 0 ||
      numbersMissing ||
      compareMissing ||
      kpiMissing ||
      barsMissing)
  ) {
    console.log(
      allHits.length > 0
        ? "[FAIL] 界面上仍有 Markdown 原文"
        : thin.length > 0
          ? "[FAIL] 有页面没渲染出内容，扫描不算数"
          : requiredMissing.length > 0
            ? "[FAIL] 必需的折叠入口没点到，交互覆盖是空的"
            : iconOnlyMissing
              ? "[FAIL] 一个图标按钮都没点到，浮层覆盖是空的"
              : numbersMissing
                ? "[FAIL] 一个结果页都没核对到界面数字，这项覆盖是空的"
                : compareMissing
                  ? "[FAIL] 一个比对页都没核对到界面数字，这项覆盖是空的"
                  : kpiMissing
                    ? "[FAIL] 一张看板 KPI 卡都没核对到，这项覆盖是空的"
                    : barsMissing
                      ? "[FAIL] 看板状态分布一条都没核对到，这项覆盖是空的"
                      : "[FAIL] 界面上的数字与库里的取数对不上",
    );
    process.exit(1);
  }
  console.log("[PASS] 界面 Markdown 原文扫描完成");
}

void main();
