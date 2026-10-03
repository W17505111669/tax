/**
 * 实测脚本：真的下载一次交付物，验字节，不验生成逻辑。
 * 运行：pnpm scan:deliverables            # 需要 pnpm dev 已起（API 8787 + 前端 5174）
 *   pnpm scan:deliverables --strict       # 有任何一项不符即退出码 1
 *   pnpm scan:deliverables --json         # 输出机器可读结果
 *
 * 为什么需要它：verify:csv 验的是 csv.ts 的纯函数（转义 / BOM / CRLF / 往返），verify:bundle 验的
 * 是打包函数与条目组装，verify:diaexport 验的是图类型识别、文件名与导出配置——三个都在验
 * 「生成逻辑对不对」，没有一个真的产出过一份文件。于是对外声称的「CSV 带 BOM，Excel 打开不乱码、
 * 含逗号与引号的标题不串列」「PNG 带背景色，Office 与 WPS 直接插得进」「bundle 里文件齐且
 * manifest 自校验通过」这三句话，此前全靠推断。这里用真浏览器点真按钮，把字节落到磁盘再逐项验。
 *
 * 与 scan:uimd 同理不进 qa:all：要开浏览器、要前端在跑，失败原因常常与代码无关。
 *
 * 覆盖的下载件：台账 CSV、台账 Markdown（作品总览页）；单任务核对表 MD、交付包 zip、
 * mermaid 的 PNG 与 SVG（任务结果页）。
 *
 * 结果页那一档按维度挑**多个**任务跑，不只挑一个最齐的：每个智能体各一个「资料 + 产物 + 图」
 * 都齐的、一个「有结论但没产物」的空态、一个带 error 的失败态。一个任务通过不代表别的任务也
 * 通过——此前只测一个，实测挑中的是 land-vat 的回归案例，rd-audit 的交付物一次都没被下载过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { Page } from "playwright-core";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { listFiles } from "../src/services/task-store.ts";
import { CSV_BOM, parseCsv } from "../../web/src/csv.ts";
import { markdownTableCells } from "../../web/src/md-text.ts";
import { MANIFEST_SCHEMA, manifestIssues, type BundleManifest } from "../../web/src/manifest.ts";
import { launchChromium, WEB_URL } from "./browser-lib.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const strict = process.argv.includes("--strict");
const asJson = process.argv.includes("--json");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "tax-deliverables-"));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/**
 * 公式注入判据。提到具名函数上是为了让阳性对照与判据用**同一份实现**——内联写在 for 循环里
 * 就没法自检，而这条判据的断言方向是「injected 必须为空」：字符类少一个符号（比如漏了 `@`）、
 * 或者转义写错，它就永远不命中、永远绿，绿的样子与「交付的 CSV 确实干净」一模一样。
 * 这是对外那句「Excel 打开不乱码不串列、不会被当公式执行」的唯一落盘验证。
 */
const FORMULA_START = /^[=+\-@]/;
const isInjectable = (cell: string): boolean => FORMULA_START.test(cell) && !cell.startsWith("'");
expect("公式注入判据确实能命中 = 开头（否则那条残留判据是假绿）", isInjectable("=SUM(A1:A9)"), true);
expect("公式注入判据确实能命中 + - @ 开头", [isInjectable("+8610"), isInjectable("-1"), isInjectable("@SUM(A1)")], [true, true, true]);
expect("公式注入判据认前置单引号为已挡下（生成侧正是这么防的）", isInjectable("'=SUM(A1)"), false);
expect("公式注入判据不误伤普通中文与数字", [isInjectable("合计"), isInjectable("1,234.00")], [false, false]);

type Got = { label: string; name: string; file: string; buf: Buffer };
const got: Got[] = [];
/** manifest 里申报过的产物与资料份数：为 0 就说明「申报的都在包里」这条核对是在空数组上通过的 */
let declaredTotal = 0;

/** 点一个下载按钮，接住 download 事件并把字节落盘；按钮不存在返回 null（不算失败，末尾统一断覆盖率） */
async function grab(page: Page, sel: string, label: string, timeout = 90000): Promise<Got | null> {
  const btn = page.locator(sel).first();
  if ((await btn.count()) === 0) return null;
  // 先把按钮滚进视口：总览页的台账区在很下面，不滚动的话点击会一直等到超时，
  // 而超时信息只会说「Timeout exceeded」，看不出是遮挡、不可见还是 disabled。
  await btn.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => undefined);
  const visible = await btn.isVisible().catch(() => false);
  const enabled = await btn.isEnabled().catch(() => false);
  try {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout }), btn.click({ timeout: 5000 })]);
    const name = dl.suggestedFilename();
    const file = path.join(OUT, `${label}__${name}`);
    await dl.saveAs(file);
    const g: Got = { label, name, file, buf: fs.readFileSync(file) };
    got.push(g);
    return g;
  } catch (e) {
    // 点了却拿不到下载，原因必须说出来：可能是按钮被浮层挡住、可能它压根不走下载（比如是复制）
    const why = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    failures.push(
      `${label}：点了按钮却没拿到下载（${sel}）——visible=${visible} enabled=${enabled} ${why.slice(0, 90)}`,
    );
    return null;
  }
}

function checkCsv(g: Got): void {
  expect(`${g.label}：以 UTF-8 BOM 开头（Excel 双击不乱码）`, g.buf.subarray(0, 3).equals(BOM), true);
  const text = g.buf.subarray(3).toString("utf8");
  expect(`${g.label}：换行是 CRLF`, text.includes("\r\n"), true);
  const rows = parseCsv(text);
  expect(`${g.label}：确实解析出了多行`, rows.length > 2, true);
  expect(`${g.label}：每行字段数一致（不串列）`, new Set(rows.map((r) => r.length)).size, 1);
  const header = rows[0] ?? [];
  expect(`${g.label}：表头是中文且没乱码`, header.some((c) => /[\u4e00-\u9fa5]/.test(c)), true);
  expect(
    `${g.label}：解析回来的表头与生成侧的 BOM/EOL 常量同源`,
    CSV_BOM === "\uFEFF" && g.buf.subarray(0, 3).equals(BOM),
    true,
  );
  // 公式注入：任何以 = + - @ 开头的格子，Excel 会当公式执行。生成侧靠前置单引号挡，这里验落盘的字节。
  const injected: string[] = [];
  for (const r of rows) for (const c of r) if (isInjectable(c)) injected.push(c.slice(0, 30));
  expect(`${g.label}：没有能被 Excel 当公式执行的格子`, injected, []);
  console.log(`  ${g.label}：${rows.length} 行 × ${(rows[0] ?? []).length} 列，${(g.buf.length / 1024).toFixed(1)} KB`);
}

function checkMd(g: Got, wantTable: boolean): void {
  const text = g.buf.toString("utf8");
  expect(`${g.label}：不是空文件`, text.trim().length > 200, true);
  expect(`${g.label}：UTF-8 解码后中文正常`, /[\u4e00-\u9fa5]/.test(text), true);
  expect(`${g.label}：不带 BOM（MD 不需要，只有 CSV 需要）`, g.buf.subarray(0, 3).equals(BOM), false);
  const tableLines = text.split(/\r?\n/).filter((l) => l.trim().startsWith("|"));
  if (!wantTable) return;
  expect(`${g.label}：确实含表格`, tableLines.length > 3, true);
  expect(
    `${g.label}：表格每行单元格数一致（不错位）`,
    new Set(tableLines.map((l) => markdownTableCells(l).length)).size,
    1,
  );
  expect(`${g.label}：表格有分隔行`, tableLines.some((l) => /^\|[\s\-|]+\|$/.test(l.trim())), true);
  console.log(`  ${g.label}：${text.length} 字，表格 ${tableLines.length} 行`);
}

/** 返回 manifest 申报的产物 + 资料份数：0 说明「申报的都在包里」这条核对是在空数组上通过的 */
async function checkZip(g: Got): Promise<number> {
  const zip = await JSZip.loadAsync(g.buf);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir);
  expect(`${g.label}：zip 能解开且确实有文件`, names.length > 1, true);
  expect(`${g.label}：包含 manifest.json`, names.includes("manifest.json"), true);
  expect(`${g.label}：包含整页交付 MD`, names.some((n) => n.toLowerCase().endsWith(".md")), true);
  const mf = zip.file("manifest.json");
  if (!mf) return 0;
  const m = JSON.parse(await mf.async("string")) as BundleManifest;
  expect(`${g.label}：manifest schema 对得上`, m.schema, MANIFEST_SCHEMA);
  expect(`${g.label}：manifest 自校验通过（内部不变量）`, manifestIssues(m), []);
  // manifest 申报的产物必须真在包里：申报了却没打进去，等于交付清单在说谎
  const declared = (m.artifacts ?? []).map((a) => a.name);
  const missing = declared.filter((n) => !names.some((p) => p.endsWith(n)));
  expect(`${g.label}：manifest 申报的产物都在包里`, missing, []);
  const declaredFiles = (m.files ?? []).map((f) => f.name);
  const missingFiles = declaredFiles.filter((n) => !names.some((p) => p.endsWith(n)));
  expect(`${g.label}：manifest 申报的资料文件都在包里`, missingFiles, []);
  declaredTotal += declared.length + declaredFiles.length;
  console.log(
    `  ${g.label}：${names.length} 个文件，${(g.buf.length / 1024).toFixed(1)} KB · 申报产物 ${declared.length} 份 / 资料 ${declaredFiles.length} 份`,
  );
  return declared.length + declaredFiles.length;
}

function checkPng(g: Got): void {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(`${g.label}：PNG 魔数正确`, g.buf.subarray(0, 8).equals(sig), true);
  expect(`${g.label}：第一个块是 IHDR`, g.buf.subarray(12, 16).toString("latin1"), "IHDR");
  const w = g.buf.readUInt32BE(16);
  const h = g.buf.readUInt32BE(20);
  expect(`${g.label}：宽度 > 0`, w > 0, true);
  expect(`${g.label}：高度 > 0`, h > 0, true);
  expect(
    `${g.label}：以 IEND 收尾（没被截断）`,
    g.buf.subarray(g.buf.length - 8).toString("latin1").includes("IEND"),
    true,
  );
  expect(`${g.label}：体积不像空图（2 倍分辨率导出应 > 8KB）`, g.buf.length > 8192, true);
  console.log(`  ${g.label}：${w}×${h}，${(g.buf.length / 1024).toFixed(1)} KB`);
}

function checkSvg(g: Got): void {
  const text = g.buf.toString("utf8");
  expect(`${g.label}：以 <?xml 或 <svg 开头`, /^\s*(<\?xml|<svg)/.test(text), true);
  expect(`${g.label}：以 </svg> 收尾`, text.trimEnd().endsWith("</svg>"), true);
  expect(`${g.label}：有 width/height 或 viewBox（Office 才知道画多大）`, /(width="|viewBox=")/.test(text), true);
  expect(`${g.label}：确实有图形元素`, /<(path|rect|polygon|line|text)\b/.test(text), true);
  // mermaid 默认用 foreignObject 摆 HTML 标签，Office 与不少编辑器会渲染成空白——导出配置里必须关掉
  expect(`${g.label}：不含 foreignObject（Office 插入会变空白）`, text.includes("foreignObject"), false);
  console.log(`  ${g.label}：${text.length} 字，${(g.buf.length / 1024).toFixed(1)} KB`);
}

async function main(): Promise<void> {
  type Row = { id: string; title: string; agentId: string; result: string | null; error: string };
  const rows = db
    .prepare(
      `SELECT id, title, agent_id AS agentId, result, COALESCE(error,'') AS error FROM tasks WHERE LENGTH(COALESCE(result,'')) > 0 ORDER BY created_at DESC`,
    )
    .all() as Row[];
  // 挑任务不能只挑「结论里有 mermaid」：交付包这一档还要有产物与上传资料，否则 manifest 的
  // 申报核对就在空数组上通过了（空跑一样是绿的）。所以三样都齐的必须有一个；但只测它也不够，
  // 空态与失败态各有各的走法（空态的包里只有结论 MD 与 manifest；失败态的下载按钮此前压根
  // 不渲染，是上一轮才修出来的），都得真下载一次。
  const artDir = (id: string): string => path.join(dirs.outputs, id);
  const artCount = (id: string): number => (fs.existsSync(artDir(id)) ? fs.readdirSync(artDir(id)).length : 0);
  const hasDiagram = (r: Row): boolean => /```mermaid/.test(r.result ?? "");
  const complete = (r: Row): boolean => hasDiagram(r) && listFiles(r.id).length > 0 && artCount(r.id) > 0;
  const picked = new Map<string, { row: Row; tags: string[] }>();
  const pick = (row: Row | undefined, tag: string): void => {
    if (!row) return;
    const e = picked.get(row.id) ?? { row, tags: [] };
    if (!e.tags.includes(tag)) e.tags.push(tag);
    picked.set(row.id, e);
  };
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  for (const a of agentIds) {
    const inAgent = rows.filter((r) => r.agentId === a);
    pick(inAgent.find(complete) ?? inAgent.find(hasDiagram) ?? inAgent[0], `齐全·${a}`);
  }
  pick(rows.find((r) => artCount(r.id) === 0), "空态·无产物");
  pick(rows.find((r) => r.error !== ""), "失败态·带error");
  const targets = [...picked.values()];
  if (targets.length === 0) {
    console.log("[FAIL] 库里没有带结论的任务，无从实测下载");
    process.exit(2);
  }

  const browser = await launchChromium();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  // 1) 作品总览页：台账 CSV 与台账 MD
  await page.goto(`${WEB_URL}/#/agent/rd-audit`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  // 台账区在 <details> 里、默认折叠，里面的下载按钮 visible=false，直接点会一直等到超时。
  // 先点开它——这正是「点击才挂载的状态」，扫描器不点就永远测不到这两份交付物。
  const ledgerSummary = page.locator('summary:has-text("全平台证据核对台账")').first();
  if ((await ledgerSummary.count()) > 0) {
    await ledgerSummary.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
  const csv = await grab(page, 'button[title^="下载台账 CSV"]', "台账CSV");
  const ledgerMd = await grab(page, 'button[title^="下载台账 Markdown"]', "台账MD");

  // 2) 每个目标任务的结果页：核对表 MD、交付包 zip、mermaid PNG / SVG
  let diagramTasks = 0;
  let emptyDeclared = -1;
  const perTask: string[] = [];
  for (const t of targets) {
    const tag = t.tags.join("+");
    await page.goto(`${WEB_URL}/#/agent/${t.row.agentId}/task/${t.row.id}/tab/result`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    // 等按钮真的挂上再点：事件多的任务（实测最大 13829 条）回放要几秒，固定等 2.5 秒会点到空
    await page.waitForSelector('button[title^="单独下载这一页核对表"]', { timeout: 40000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const sheetMd = await grab(page, 'button[title^="单独下载这一页核对表"]', `核对表MD·${tag}`);
    const zip = await grab(page, 'button[title*="zip"]', `交付包zip·${tag}`);
    // mermaid 是异步渲染的，工具条要等图出来才会挂上；结论里没图的任务不必白等 20 秒
    await page
      .waitForSelector(".mermaid-tools button", { timeout: hasDiagram(t.row) ? 20000 : 3000 })
      .catch(() => undefined);
    const diagramBtns = page.locator(".mermaid-tools button");
    const dn = await diagramBtns.count();
    if (dn > 0) diagramTasks += 1;
    for (let i = 0; i < Math.min(dn, 2); i++) {
      const label = (await diagramBtns.nth(i).textContent())?.trim() ?? `图${i}`;
      const g = await grab(page, `.mermaid-tools button >> nth=${i}`, `mermaid${label.replace(/\s+/g, "")}·${tag}`);
      if (g && /\.png$/i.test(g.name)) checkPng(g);
      if (g && /\.svg$/i.test(g.name)) checkSvg(g);
    }
    expect(`${tag}：确实下载到了核对表 MD`, sheetMd !== null, true);
    expect(`${tag}：确实下载到了交付包 zip`, zip !== null, true);
    if (sheetMd) checkMd(sheetMd, true);
    if (zip) {
      const declared = await checkZip(zip);
      if (t.tags.some((x) => x.startsWith("空态"))) emptyDeclared = declared;
      perTask.push(
        `${tag}「${t.row.title.slice(0, 16)}」资料 ${listFiles(t.row.id).length} · 产物 ${artCount(
          t.row.id,
        )} · 图 ${hasDiagram(t.row)} · 申报 ${declared} 份`,
      );
    }
  }
  await browser.close();

  if (csv) checkCsv(csv);
  if (ledgerMd) checkMd(ledgerMd, true);

  // 覆盖率：走查型断言必须同时断「确实下载到了东西」，否则按钮改了 title 就悄悄变成空跑
  const labels = new Set(got.map((g) => g.label));
  for (const want of ["台账CSV", "台账MD"]) {
    expect(`确实下载到了「${want}」`, labels.has(want), true);
  }
  expect("确实下载到了 mermaid 图（PNG 或 SVG 至少一种）", got.some((g) => g.label.startsWith("mermaid")), true);
  expect("下载的交付物不少于 5 份", got.length >= 5, true);
  expect("确实核对到了 manifest 申报的文件（不是空数组上通过）", declaredTotal > 0, true);
  // 覆盖维度必须真的覆盖到，否则「按维度挑任务」这段就是摆设
  expect("覆盖到的任务不少于 4 个（两个智能体 + 空态 + 失败态）", targets.length >= 4, true);
  expect("库里的智能体都覆盖到了", agentIds.every((a) => targets.some((t) => t.row.agentId === a)), true);
  expect("覆盖了「有结论但没产物」的空态任务", targets.some((t) => t.tags.some((x) => x.startsWith("空态"))), true);
  expect("覆盖了带 error 的失败态任务（它的下载按钮上一轮才刚出现）", targets.some((t) => t.tags.some((x) => x.startsWith("失败态"))), true);
  expect(
    "空态任务的 manifest 申报确实是 0（这一档的申报核对不算数，别把它当成有效覆盖）",
    emptyDeclared,
    0,
  );
  expect("确实有任务的结论里带图（图这一档不是空跑）", diagramTasks >= 1, true);
  console.log(`[scan] 覆盖 ${targets.length} 个任务 · 其中结论带图 ${diagramTasks} 个 · 共下载 ${got.length} 份交付物`);
  for (const line of perTask) console.log(`  - ${line}`);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          outDir: OUT,
          tasks: targets.map((t) => ({ id: t.row.id, title: t.row.title, tags: t.tags })),
          files: got.map((g) => ({ label: g.label, name: g.name, bytes: g.buf.length, path: g.file })),
          checks,
          failures,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `[scan] 真下载 ${got.length} 份交付物（覆盖 ${targets.length} 个任务）· 检查项=${checks} · 失败=${failures.length}`,
  );
  console.log(`[scan] 文件落在 ${OUT}（可用 Excel / Office 打开复核）`);
  if (failures.length > 0) {
    for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
    if (failures.length > 20) console.log(`  …另有 ${failures.length - 20} 项`);
    console.log(
      strict
        ? "[FAIL] 交付物实测不通过"
        : "[WARN] 交付物实测有不符合项（没加 --strict，退出码仍为 0；上面的 [PASS] 不再打印）",
    );
    if (strict) {
      process.exit(1);
    }
    return;
  }
  console.log("[PASS] 交付物实测完成（字节级校验：BOM / CRLF / 不串列 / zip 与 manifest / PNG / SVG）");
}

void main();
