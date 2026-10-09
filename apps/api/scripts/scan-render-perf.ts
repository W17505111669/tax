/**
 * 界面渲染耗时实测：从导航到 DOM 稳定，按任务的事件规模看最慢要多久。
 *
 * 为什么量这个：库里最大的任务有 24717 行事件，而界面是把事件流全量回放成时间线的。聚合层
 * 已经量过（`verify:tlcalls` 每次报 14000 条事件的聚合耗时，几十毫秒量级），但**聚合快不等于页面出得快**——
 * React 还要为每条时间线行建 DOM，那一段此前从来没量过。
 *
 * 测量口径必须交代清楚，否则数字会被误读：每 400 ms 采一次文本节点数、连续 3 次相同才算「稳定」，
 * 所以每个数字都含约 1.2–1.6 秒的确认开销，是**上界**；任务之间的相对差才有意义，绝对值不能
 * 当纯渲染时间读。每次测量前先 `goto("about:blank")`：否则只是 hash 变化、页面不重新加载，
 * 量到的会是路由切换而不是首次渲染。
 *
 * 与 `scan:uimd` 一样要开 Chromium、要前端在 5174 上跑，所以刻意不进 `qa:all`
 *（理由与 scan 相同：环境不在时它会因为「一个页面都没测到」而失败，那不是判据被空输入骗过）。
 *
 * 运行：pnpm perf:render
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromium, WEB_URL } from "./browser-lib.ts";
import { db } from "../src/db.ts";
import { compactEvents } from "../src/services/event-compaction.ts";
import { listEvents, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;
function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

/** 护栏阈值：三次实测最慢的一页都在 4 秒上下，留 5 倍余量。它防的是退化到分钟级，不是追求快 */
const SLOWEST_BUDGET_MS = 20000;
/**
 * 薄页线：与 `scan:uimd` 的薄页判据**同单位同数**（那边是 `found.chars < 400`，量的是字符不是节点）。
 * 少于它说明页面没真渲染出来，此时「秒开」是白屏不是快，耗时数字毫无意义。
 * 这个数在两个脚本里各存一份，所以下面有一条断言把两份钉同源：改一边就红。
 */
const MIN_CHARS = 400;
/**
 * 薄页谓词单独抽出来，是为了让它能被阳性对照钉住。下面那条「白屏不算快」是**扫总体收违规项、
 * 断言列表为空**型判据，它有一种假绿是「确实测到了页面」和「薄页线同源」两条都拦不住的：
 * 谓词方向写反，或 `chars` 采集成 `undefined`（`undefined < 400` 为 false），违规列表都会变空
 * 而不是变红——门禁绿得和「每页都真渲染出来了」一模一样。前者只保证 rows 非空，后者只保证
 * 两个脚本里的常量数字相等，都钉不住谓词本身。
 */
const isThinPage = (r: { chars: number }): boolean => r.chars < MIN_CHARS;
expect(
  "薄页判据确实能命中（已知白屏样本；顺带钉住「正好等于阈值不算薄页」这个边界）",
  [
    { label: "合成白屏页", chars: 0 },
    { label: "合成正常页", chars: MIN_CHARS },
  ]
    .filter(isThinPage)
    .map((r) => r.label),
  ["合成白屏页"],
);
const TASKS = 5;
const TABS = ["timeline", "result"];

const top = db
  .prepare(`SELECT task_id, COUNT(*) AS n FROM events GROUP BY task_id ORDER BY n DESC LIMIT ${TASKS}`)
  .all() as Array<{ task_id: string; n: number }>;
const agentOf = new Map<string, string>();
for (const t of db.prepare(`SELECT id, agent_id FROM tasks`).all() as Array<{ id: string; agent_id: string }>) {
  agentOf.set(t.id, t.agent_id);
}
const totalEvents = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
const totalSseEvents = listTasks().reduce((sum, task) => sum + compactEvents(listEvents(task.id)).length, 0);

// 一次遍历同时取节点数与字符数：节点数用于「耗时与规模相关」那组断言，字符数用于薄页判据
const COUNT = `(function(){let n=0,c=0;const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(w.nextNode()){n++;c+=(w.currentNode.nodeValue||"").length}return {nodes:n,chars:c}})()`;
const rows: Array<{ label: string; events: number; sseEvents: number; ms: number; nodes: number; chars: number }> = [];

if (top.length > 0) {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  for (const r of top) {
    for (const tab of TABS) {
      const url = `${WEB_URL}/#/agent/${agentOf.get(r.task_id) ?? ""}/task/${r.task_id}/tab/${tab}`;
      await page.goto("about:blank");
      const t0 = Date.now();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      let last = -1;
      let same = 0;
      let nodes = 0;
      let chars = 0;
      while (same < 3 && Date.now() - t0 < 60000) {
        await page.waitForTimeout(400);
        const snap = (await page.evaluate(COUNT)) as { nodes: number; chars: number };
        nodes = snap.nodes;
        chars = snap.chars;
        if (nodes === last) same += 1;
        else {
          same = 0;
          last = nodes;
        }
      }
      const ms = Date.now() - t0;
      const sseEvents = compactEvents(listEvents(r.task_id)).length;
      rows.push({ label: `${r.task_id.slice(0, 8)} ${tab}`, events: r.n, sseEvents, ms, nodes, chars });
      console.log(
        `  ${r.task_id.slice(0, 8)} ${tab}：events ${r.n} 行（SSE ${sseEvents} 条）→ ${ms} ms 后 DOM 稳定，文本节点 ${nodes} / ${chars} 字`,
      );
    }
  }
  await browser.close();
}

const sorted = [...rows].sort((a, b) => b.ms - a.ms);
const slowest = sorted[0];
// 走查型断言必须同时断「确实检查到了东西」：前端没起、库是空的、选择器失效，都会让 rows 为空，
// 那时「最慢 0 ms」会是一个漂亮的绿
expect("确实测到了页面（不是空跑）", rows.length, TASKS * TABS.length);
expect("每页都真渲染出了内容（字数超过薄页线，否则「秒开」是白屏不是快）", rows.filter(isThinPage).map((r) => r.label), []);
expect("SSE 历史回放事件数确实少于原始 events 行数", totalSseEvents < totalEvents, true);
expect("确实统计到了 SSE 历史回放事件数（不是空跑）", totalSseEvents > 0, true);
// 薄页线在 scan:uimd 里也存了一份（那边是 `found.chars < 400`）。两份常量各改各的就会静默分叉：
// 这边把线调低，「白屏也算快」就没人拦了。所以直接从那边源码里把数取出来比——取不到（NaN）也算红。
const scanSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "scan-ui-markdown.ts"), "utf8");
const thinInScan = Number(/found\.chars\s*<\s*(\d+)/.exec(scanSrc)?.[1] ?? NaN);
expect(
  `薄页线确实从 scan:uimd 源码里取到了、且与本地这份同数（两份常量钉同源，改一边就红）`,
  thinInScan,
  MIN_CHARS,
);
expect(
  `最慢的一页在 ${SLOWEST_BUDGET_MS / 1000} 秒内出来（这条防的是退化到分钟级，不是追求快）`,
  (slowest?.ms ?? 0) < SLOWEST_BUDGET_MS,
  true,
);
/**
 * 「耗时与数据规模相关」这条不能拿单页名次去断：同一页三次实测 3997 / 4262 / 3850 ms（差 10%），
 * 单页最大能差 36%（6085 行那个任务的结果页 2149 → 2935 ms），名次也跟着抖——24717 行那个任务的
 * 时间线页两次是最慢第 1、一次掉到第 2。用「必须进最慢两页」断它，机器一忙就假红。
 * 改成按**任务**聚合、只比两个极端：事件最多的对事件最少的，这一对事件数差 4 倍（24717 对 6085），
 * 实测三次里耗时之和与节点数都稳定分开（节点数时间线页 13315 对 3766、结果页 2684 对 1245），不靠名次。
 */
const byTask = new Map<string, { events: number; ms: number; nodes: number }>();
for (const r of rows) {
  const key = r.label.split(" ")[0] ?? r.label;
  const cur = byTask.get(key) ?? { events: r.events, ms: 0, nodes: 0 };
  cur.ms += r.ms;
  cur.nodes += r.nodes;
  byTask.set(key, cur);
}
const ranked = [...byTask.entries()].sort((a, b) => b[1].events - a[1].events);
const most = ranked[0];
const least = ranked[ranked.length - 1];
expect(
  `事件最多的任务（${most?.[0] ?? "-"}，${most?.[1].events ?? 0} 行）两页耗时之和确实多于事件最少的（${least?.[0] ?? "-"}，${least?.[1].events ?? 0} 行）`,
  (most?.[1].ms ?? 0) > (least?.[1].ms ?? 0),
  true,
);
// 逐个 tab 比：时间线页与结果页的节点数差一个量级（13315 对 2684），合起来比会被时间线页主导。
// 这条是三个相关性断言里唯一确定性的——节点数由库里的内容决定，不由机器快慢决定：
// 若事件最多的任务节点数反而更少，说明它没把事件流渲染全（卡在加载态或被截断），
// 那前面所有耗时数字量的都是一个没渲染完的页面，护栏再绿也没意义。
for (const tab of TABS) {
  const nodesOf = (task: string): number => rows.find((r) => r.label === `${task} ${tab}`)?.nodes ?? 0;
  expect(
    `${tab} 页上，事件最多的任务节点数确实多于事件最少的（事件流渲染全了，不是卡在加载态）`,
    nodesOf(most?.[0] ?? "") > nodesOf(least?.[0] ?? ""),
    true,
  );
}

console.log(`[perf] SSE 回放事件数：${totalSseEvents} 条（原始 events ${totalEvents} 行）`);
console.log(
  `[perf] 渲染耗时：全库 events ${totalEvents} 行 · 取事件最多的 ${TASKS} 个任务 × ${TABS.length} 个 tab = ${rows.length} 次加载 · 最慢 ${slowest?.label ?? "-"} ${slowest?.ms ?? 0} ms · 中位 ${sorted[Math.floor(sorted.length / 2)]?.ms ?? 0} ms · 最快 ${sorted[sorted.length - 1]?.ms ?? 0} ms（每个数含约 1.2–1.6 秒的稳定确认开销，是上界）`,
);
console.log(`[perf] 渲染耗时检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 界面渲染耗时超出护栏或有页面没渲染出内容");
  process.exit(1);
}
console.log("[PASS] 界面渲染耗时在护栏内，且每页都真渲染出了内容");
