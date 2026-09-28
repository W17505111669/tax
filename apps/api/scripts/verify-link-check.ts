/**
 * 验证脚本：引用链接核验结果的分级（反爬拒绝 ≠ 链接失效）。
 * 运行：pnpm verify:links
 */
import { linkVerdict, summarizeLinkChecks, VERDICT_HINT, VERDICT_TEXT } from "../../web/src/link-check.ts";

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

console.log(`[verify] 链接核验分级检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 链接核验分级规则不符");
  process.exit(1);
}
console.log("[PASS] 链接核验分级正确（可访问 / 反爬拒绝 / 失效 / 无法核验）");
