/**
 * 验证脚本：修订前后的证据对比（快照口径 / 差值与总体判断 / 真实续跑任务走查）。
 * 走查按前端同一方式从事件流重组每次运行的结论：agent_text_delta 累积，遇到 agent_text 收口。
 * 运行：pnpm verify:revimpact
 */
import {
  deltaText,
  deltaVerdict,
  evidenceDelta,
  evidenceSnapshot,
  signed,
} from "../../web/src/revision-impact.ts";
import { db } from "../src/db.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";

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

// 1) 快照口径
const BEFORE = [
  "依据财税〔2015〕119号与国税发〔2006〕187号处理。",
  "参考 [研发_百度百科](https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440) 与 [政策执行指引](https://www.most.gov.cn/xxgk/a.pdf)。",
  "另见 https://www.gov.cn/guoqing/。",
].join("\n");
const s = evidenceSnapshot(BEFORE);
expect("引用条数", s.citations, 3);
expect("官方原文条数", s.official, 1);
expect("弱证据条数（百科 + 门户栏目页）", s.weak, 2);
expect("专业来源条数", s.professional, 0);
expect("文号数", s.docRefs, 2);
expect("四项分级之和等于引用数", s.official + s.professional + s.weak, s.citations);
expect("空文本快照", evidenceSnapshot(""), { citations: 0, official: 0, professional: 0, weak: 0, docRefs: 0 });
expect("没有链接的文本只算文号", evidenceSnapshot("按财税〔2015〕119号执行").citations, 0);

// 2) 差值与总体判断
// 修订后：百科词条换成政策法规库原文（标题也一并换掉——只换地址而标题仍写「百度百科」时，
// 按标题兜底仍会判为弱证据，那是分级规则的正确行为）
const AFTER = BEFORE.replace(
  "[研发_百度百科](https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440)",
  "[研发费用加计扣除政策执行指引](https://fgk.chinatax.gov.cn/zcfgk/c100012/content.html)",
);
const d = evidenceDelta(evidenceSnapshot(BEFORE), evidenceSnapshot(AFTER));
expect("弱证据减少一条", d.weak, -1);
expect("官方原文增加一条", d.official, 1);
expect("引用合计不变", d.citations, 0);
expect("文号数不变", d.docRefs, 0);
expect("判定为改善", [d.improved, d.regressed], [true, false]);
expect("改善文案", deltaVerdict(d), "证据质量改善");
ok("对比文本含前后值与差值", deltaText(d).includes("弱证据引用 2 → 1（-1）"), deltaText(d));
ok("对比文本以判断开头", deltaText(d).startsWith("证据质量改善："), deltaText(d).slice(0, 20));

expect("同一文本对比为质量持平", deltaVerdict(evidenceDelta(s, s)), "证据质量持平（弱证据与官方原文条数未变）");
expect(
  "只换地址不换标题仍判弱证据",
  evidenceSnapshot(
    BEFORE.replace(
      "https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440",
      "https://fgk.chinatax.gov.cn/zcfgk/c100012/content.html",
    ),
  ).weak,
  2,
);
expect(
  "引用条数变化但质量持平时判为持平",
  deltaVerdict(
    evidenceDelta(
      evidenceSnapshot("见 https://www.shui5.cn/article/a/b.html"),
      evidenceSnapshot("见 https://www.shui5.cn/article/a/b.html 与 https://www.shui5.cn/article/c/d.html"),
    ),
  ),
  "证据质量持平（弱证据与官方原文条数未变）",
);
expect("无变化时四项差值都是 0", (() => {
  const x = evidenceDelta(s, s);
  return [x.citations, x.official, x.weak, x.docRefs];
})(), [0, 0, 0, 0]);
const worse = evidenceDelta(evidenceSnapshot(AFTER), evidenceSnapshot(BEFORE));
expect("反向对比为退步", deltaVerdict(worse), "证据质量退步，请核对本次修订");
expect("退步时 improved 为假", worse.improved, false);

// 有增有减：弱证据减少但官方原文也减少
const mixed = evidenceDelta(
  evidenceSnapshot("见 https://www.most.gov.cn/a/b.pdf 与 https://baike.baidu.com/item/x/1"),
  evidenceSnapshot("见 https://www.shui5.cn/article/a/b.html"),
);
expect("有增有减时同时标记改善与退步", [mixed.improved, mixed.regressed], [true, true]);
expect("有增有减的判断文案", deltaVerdict(mixed), "证据质量有增有减，请核对本次修订");

// 3) 数字格式
expect("正数带加号", signed(3), "+3");
expect("负数原样", signed(-2), "-2");
expect("零不加符号", signed(0), "0");

// 4) 真实任务走查：按前端同一方式从事件流重组每次运行的结论
/** agent_text_delta 累积、遇到 agent_text 收口，与 useTaskEvents 的流式合并规则一致 */
function conclusionsOf(taskId: string): string[] {
  const rows = db
    .prepare(`SELECT kind, message FROM events WHERE task_id = ? ORDER BY seq ASC`)
    .all(taskId) as unknown as Array<{ kind: string; message: string }>;
  const out: string[] = [];
  let buf = "";
  for (const r of rows) {
    if (r.kind === "agent_text_delta") buf += r.message ?? "";
    else if (r.kind === "agent_text") {
      if (buf.trim() !== "") out.push(buf);
      buf = "";
    }
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

let compared = 0;
let improved = 0;
let regressed = 0;
let unchanged = 0;
for (const t of listTasks()) {
  const list = conclusionsOf(t.id);
  if (list.length < 2) continue;
  const before = evidenceSnapshot(list[list.length - 2]!);
  const after = evidenceSnapshot(list[list.length - 1]!);
  const delta = evidenceDelta(before, after);
  compared += 1;
  if (delta.improved && !delta.regressed) improved += 1;
  else if (delta.regressed && !delta.improved) regressed += 1;
  else if (delta.unchanged) unchanged += 1;
  checks += 1;
  if (delta.weak !== after.weak - before.weak) failures.push(`${t.id.slice(0, 8)} 弱证据差值与快照不符`);
  checks += 1;
  if (delta.official !== after.official - before.official) failures.push(`${t.id.slice(0, 8)} 官方原文差值与快照不符`);
  checks += 1;
  if (delta.citations !== after.citations - before.citations) failures.push(`${t.id.slice(0, 8)} 引用差值与快照不符`);
  checks += 1;
  if (delta.docRefs !== after.docRefs - before.docRefs) failures.push(`${t.id.slice(0, 8)} 文号差值与快照不符`);
  checks += 1;
  if (!delta.improved && !delta.regressed && !delta.unchanged) {
    failures.push(`${t.id.slice(0, 8)} 三种总体判断都为假`);
  }
  checks += 1;
  if (before.official + before.professional + before.weak !== before.citations) {
    failures.push(`${t.id.slice(0, 8)} 上一轮快照四项之和不等于引用数`);
  }
  checks += 1;
  if (deltaText(delta).length < 20) failures.push(`${t.id.slice(0, 8)} 对比文本过短`);
  // 最新一轮结论与任务表里的 result 应当一致（result 为空时以事件流为准）
  const stored = (getTask(t.id)?.result ?? "").trim();
  if (stored !== "") {
    checks += 1;
    const last = list[list.length - 1]!.trim();
    if (stored !== last && !stored.startsWith(last.slice(0, 40))) {
      failures.push(`${t.id.slice(0, 8)} 事件流重组的结论与任务 result 不一致`);
    }
  }
}
ok("存在可对比的续跑任务", compared > 0, `实际 ${compared} 个`);
console.log(
  `[verify] 真实续跑走查：${compared} 个任务可对比（改善 ${improved} · 退步 ${regressed} · 无变化 ${unchanged} · 有增有减 ${
    compared - improved - regressed - unchanged
  }）`,
);

console.log(`[verify] 修订影响检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 修订前后证据对比规则不符");
  process.exit(1);
}
console.log("[PASS] 修订前后证据对比正确（快照口径 / 差值与判断 / 真实续跑任务走查）");
