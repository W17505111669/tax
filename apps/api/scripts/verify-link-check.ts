/**
 * 验证脚本：引用链接核验结果的分级（反爬拒绝 ≠ 链接失效）。
 * 运行：pnpm verify:links
 */
import {
  ageHours,
  ageText,
  freshness,
  linkVerdict,
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
expect("不足 1 小时显示刚刚", ageText("2026-09-28T11:30:00.000Z", NOW), "刚刚");
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

console.log(`[verify] 链接核验分级检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 链接核验分级规则不符");
  process.exit(1);
}
console.log("[PASS] 链接核验分级正确（可访问 / 反爬拒绝 / 失效 / 无法核验）");
