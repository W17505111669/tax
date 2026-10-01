/**
 * 验证脚本：引用链接核验结果的分级（反爬拒绝 ≠ 链接失效）。
 * 运行：pnpm verify:links
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ageHours,
  ageText,
  freshness,
  linkVerdict,
  liveLinkChecks,
  STALE_HOURS,
  summarizeLinkChecks,
  VERDICT_HINT,
  VERDICT_TEXT,
} from "../../web/src/link-check.ts";
import { db } from "../src/db.ts";
import { listLinkChecks, saveLinkChecks } from "../src/services/link-checks.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

expect("200 可访问", linkVerdict({ ok: true, status: 200 }), "ok");
expect("301 可访问", linkVerdict({ ok: true, status: 301 }), "ok");
expect("403 归为拒绝自动访问（反爬）", linkVerdict({ ok: false, status: 403 }), "blocked");
expect(
  "401 / 405 / 429 同为拒绝自动访问",
  [linkVerdict({ ok: false, status: 401 }), linkVerdict({ ok: false, status: 405 }), linkVerdict({ ok: false, status: 429 })],
  ["blocked", "blocked", "blocked"],
);
expect(
  "412 归为拒绝自动访问而不是失效：普通 GET 不带 If-* 头却回 412，实测是省级税务机关站点的 WAF 在挡",
  linkVerdict({ ok: false, status: 412 }),
  "blocked",
);
expect("521 一类非标 5xx 归为无法核验，不算失效", linkVerdict({ ok: false, status: 521 }), "unreachable");
expect("404 归为失效", linkVerdict({ ok: false, status: 404 }), "dead");
expect("410 归为失效", linkVerdict({ ok: false, status: 410 }), "dead");
expect("其他 4xx 归为失效", linkVerdict({ ok: false, status: 400 }), "dead");
expect("5xx 归为无法核验", linkVerdict({ ok: false, status: 503 }), "unreachable");
expect("无状态（超时 / 内网拦截）归为无法核验", linkVerdict({ ok: false, status: null, error: "timeout" }), "unreachable");

expect(
  "汇总分类计数",
  summarizeLinkChecks([
    { ok: true, status: 200 },
    { ok: false, status: 403 },
    { ok: false, status: 429 },
    { ok: false, status: 404 },
    { ok: false, status: null },
  ]),
  { total: 5, ok: 1, blocked: 2, dead: 1, unreachable: 1 },
);
expect("汇总空列表", summarizeLinkChecks([]), { total: 0, ok: 0, blocked: 0, dead: 0, unreachable: 0 });
expect("四类文案齐备", [Object.keys(VERDICT_TEXT).length, Object.keys(VERDICT_HINT).length], [4, 4]);

// 核验时效：以固定 now 计算，保证断言可重复
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
expect("1 小时前", ageHours("2026-09-28T11:00:00.000Z", NOW), 1);
expect("恰好阈值内算新鲜", freshness("2026-09-25T12:00:00.000Z", NOW, STALE_HOURS), "fresh");
expect("超过阈值算过期", freshness("2026-09-25T11:59:59.000Z", NOW, STALE_HOURS), "stale");
expect("从未核验算未知", freshness(null, NOW), "unknown");
expect("时间不可解析算未知", freshness("不是时间", NOW), "unknown");
expect("晚于当前时间算未知", freshness("2026-09-29T12:00:00.000Z", NOW), "unknown");
expect("不足 1 小时按分钟显示（与全平台口径一致）", ageText("2026-09-28T11:30:00.000Z", NOW), "30 分钟前");
expect("不足 1 天显示小时", ageText("2026-09-28T05:00:00.000Z", NOW), "7 小时前");
expect("超过 1 天显示天数", ageText("2026-09-20T12:00:00.000Z", NOW), "8 天前");
expect("无核验时间返回空串", ageText(null, NOW), "");
expect(
  "汇总各类计数相加等于总数",
  (() => {
    const s = summarizeLinkChecks([
      { ok: true, status: 200 },
      { ok: false, status: 403 },
      { ok: false, status: 404 },
      { ok: false, status: null },
    ]);
    return s.ok + s.blocked + s.dead + s.unreachable === s.total;
  })(),
  true,
);

// 持久化往返：写入 → 读取 → 同 URL 覆盖更新；用合成任务 id，结束即清理
const TMP = "verify-link-checks-tmp";
try {
  db.prepare(`DELETE FROM link_checks WHERE task_id = ?`).run(TMP);
  saveLinkChecks(TMP, [
    { url: "https://a.example/x", ok: true, status: 200, finalUrl: "https://a.example/x", ms: 12 },
    { url: "https://b.example/y", ok: false, status: 403, finalUrl: "https://b.example/y", ms: 30 },
  ]);
  expect(
    "写入后可读取",
    listLinkChecks(TMP).map((r) => [r.url, r.status, r.ok]),
    [
      ["https://a.example/x", 200, true],
      ["https://b.example/y", 403, false],
    ],
  );
  saveLinkChecks(TMP, [{ url: "https://a.example/x", ok: false, status: 404, finalUrl: "https://a.example/x", ms: 8 }]);
  expect(
    "同 URL 覆盖更新且不产生重复行",
    listLinkChecks(TMP).map((r) => [r.url, r.status]),
    [
      ["https://a.example/x", 404],
      ["https://b.example/y", 403],
    ],
  );
  expect("记录带核验时间", typeof listLinkChecks(TMP)[0]?.checkedAt, "string");
  expect("错误信息可空", listLinkChecks(TMP).every((r) => r.error === undefined), true);
} finally {
  db.prepare(`DELETE FROM link_checks WHERE task_id = ?`).run(TMP);
}

// 防空跑：链接核验分级的真实走查在空库下一条都不跑
expect(
  "确实走到了真实任务（空库不算通过）",
  (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n >= 1,
  true,
);

// 陈旧行过滤：link_checks 按 (task_id, url) upsert 且从不删行，结论续跑或回滚之后旧地址的行
// 仍挂在库里。汇总、交付 MD 的明细行、核对表待办三处消费点必须共用同一道过滤，否则同一份材料
// 会自相矛盾（实测 3 个任务：MD 汇总写「非可访问 4 条」底下却列了 5 行明细）。
const STALE = [
  { url: "https://a.gov.cn/live", ok: false, status: 404, ms: 10 },
  { url: "https://a.gov.cn/gone", ok: false, status: 404, ms: 11 },
  { url: "https://b.gov.cn/live", ok: true, status: 200, ms: 9 },
];
expect(
  "只保留地址仍在引用清单里的行",
  liveLinkChecks(STALE, ["https://a.gov.cn/live", "https://b.gov.cn/live"]).map((r) => r.url),
  ["https://a.gov.cn/live", "https://b.gov.cn/live"],
);
expect("确实丢掉了陈旧行（不是原样返回）", liveLinkChecks(STALE, ["https://a.gov.cn/live", "https://b.gov.cn/live"]).length, 2);
expect("引用清单为空时一条都不留", liveLinkChecks(STALE, []).length, 0);
expect("清单里的重复地址不会让行翻倍", liveLinkChecks(STALE, ["https://b.gov.cn/live", "https://b.gov.cn/live"]).length, 1);
expect(
  "过滤后再汇总：陈旧失效行不再算进「失效」",
  summarizeLinkChecks(liveLinkChecks(STALE, ["https://b.gov.cn/live"])),
  { total: 1, ok: 1, blocked: 0, dead: 0, unreachable: 0 },
);
expect(
  "不过滤就会把陈旧行算成失效（这条断言钉住「过滤是必要的」）",
  summarizeLinkChecks(STALE).dead,
  2,
);

// 同源：判据只写一遍，组件里三处消费点都走它，不再各自 Object.values(linkChecks) 直接过滤
const here = path.dirname(fileURLToPath(import.meta.url));
const benchSrc = fs.readFileSync(path.resolve(here, "..", "..", "web", "src", "components", "TaskWorkbench.tsx"), "utf8");
expect("组件里只调用一次 liveLinkChecks（判据没有第二份实现）", benchSrc.split("liveLinkChecks(").length - 1, 1);
expect(
  "组件里不再直接按 linkVerdict 过滤全量核验行",
  /Object\.values\(linkChecks\)\s*\n?\s*\.filter\(\(r\) => linkVerdict/.test(benchSrc),
  false,
);
expect(
  "汇总与明细同源：linkSummary 由 liveChecks 算出",
  benchSrc.includes("summarizeLinkChecks(liveChecks)"),
  true,
);
console.log(`[verify] 链接核验分级检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 链接核验分级规则不符");
  process.exit(1);
}
console.log("[PASS] 链接核验分级正确（可访问 / 反爬拒绝 / 失效 / 无法核验）");
