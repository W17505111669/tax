/**
 * 验证脚本：修订前后的证据对比（快照口径 / 差值与总体判断 / 真实续跑任务走查）。
 * 走查按前端同一方式从事件流重组每次运行的结论：agent_text_delta 累积，遇到 agent_text 收口。
 * 运行：pnpm verify:revimpact
 */
import {
  deltaDetail,
  deltaText,
  deltaVerdict,
  evidenceDelta,
  evidenceSnapshot,
  signed,
} from "../../web/src/revision-impact.ts";
import { getTask, listConclusions, listTasks } from "../src/services/task-store.ts";
import { db } from "../src/db.ts";

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
expect("空文本快照", evidenceSnapshot(""), {
  citations: 0,
  official: 0,
  professional: 0,
  weak: 0,
  weakDisclaimed: 0,
  docRefs: 0,
});
expect("没有链接的文本只算文号", evidenceSnapshot("按财税〔2015〕119号执行").citations, 0);
// 新增的弱证据若已在同一段正文里声明为背景参考，就不算质量退步：那正是修订指令要求的动作
//（实测 aabd138a 一轮补了官方来源、新增 2 条当场标注的弱证据，被判成「有增有减，请核对」）
const labelBefore = "依据见 https://fgk.chinatax.gov.cn/zcfgk/c1/content.html";
const labelAfter = [
  "依据见 https://fgk.chinatax.gov.cn/zcfgk/c1/content.html 与 https://www.gov.cn/zhengce/a.html",
  "",
  "## 未取得公开原文的项目",
  "",
  "| 项目 | URL | 说明 |",
  "| 研发_百度百科 | https://baike.baidu.com/item/x | 未取得公开原文，仅作背景参考，不作为政策依据 |",
  "| 研发 - MBA智库百科 | https://wiki.mbalib.com/wiki/y | 仅作背景参考，不作为政策依据 |",
].join("\n");
const labeled = evidenceDelta(evidenceSnapshot(labelBefore), evidenceSnapshot(labelAfter));
expect("原始弱证据条数照实给出", labeled.weak, 2);
expect("已声明的两条不计入待处置", labeled.weakOpen, 0);
expect("补了官方原文且新增弱证据均已声明 → 判改善", deltaVerdict(labeled), "证据质量改善");
ok(
  "明细同时给出原始条数、已声明与待处置",
  deltaDetail(labeled).includes("弱证据引用 0 → 2") &&
    deltaDetail(labeled).includes("其中已声明为背景参考 0 → 2、待处置 0"),
  deltaDetail(labeled),
);
const unlabeled = evidenceDelta(
  evidenceSnapshot(labelBefore),
  evidenceSnapshot("依据见 https://fgk.chinatax.gov.cn/zcfgk/c1/content.html 与 https://baike.baidu.com/item/x"),
);
expect("新增弱证据没声明 → 仍判退步", unlabeled.regressed, true);
expect("没声明时待处置数跟着涨", unlabeled.weakOpen, 1);

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
ok("对比文本给出已声明与待处置的拆分", deltaText(d).includes("其中已声明为背景参考 0 → 0、待处置 -1"), deltaText(d));
ok("对比文本以判断开头", deltaText(d).startsWith("证据质量改善："), deltaText(d).slice(0, 20));

expect("同一文本对比为质量持平", deltaVerdict(evidenceDelta(s, s)), "证据质量持平（弱证据与官方来源条数未变）");
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
  "证据质量持平（弱证据与官方来源条数未变）",
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

// 3.1 政策文号出处的增减也算质量变化：写回结论这条链路补的正是文号出处
const moreRefs = evidenceDelta(
  evidenceSnapshot("依据 财税〔2015〕119号"),
  evidenceSnapshot("依据 财税〔2015〕119号 与 国家税务总局公告2017年第40号"),
);
expect("文号出处增加判为改善", [moreRefs.improved, moreRefs.regressed], [true, false]);
expect("文号出处增加的文案", deltaVerdict(moreRefs), "证据质量改善");
const fewerRefs = evidenceDelta(moreRefs.after, moreRefs.before);
expect("文号出处减少判为退步", [fewerRefs.improved, fewerRefs.regressed], [false, true]);
expect("文号出处减少的文案", deltaVerdict(fewerRefs), "证据质量退步，请核对本次修订");
const mixedRefs = evidenceDelta(
  evidenceSnapshot(
    "见 https://www.most.gov.cn/a/b.pdf，依据 财税〔2015〕119号 与 国家税务总局公告2017年第40号",
  ),
  evidenceSnapshot("见 https://www.most.gov.cn/a/b.pdf 与 https://www.gov.cn/x/y.htm，依据 财税〔2015〕119号"),
);
expect("官方原文增加但文号减少 → 有增有减", [mixedRefs.improved, mixedRefs.regressed], [true, true]);
expect("有增有减的文案", deltaVerdict(mixedRefs), "证据质量有增有减，请核对本次修订");
expect("官方原文确实增加了", mixedRefs.official > 0, true);
expect("文号确实减少了", mixedRefs.docRefs < 0, true);

// 3.2 结论按运行分组：一次运行里的过程播报不能被当成「上一轮结论」（那会让比对基线是空快照）
let grouped = 0;
for (const t of listTasks()) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'run_started'`)
    .get(t.id) as { n: number };
  const list = listConclusions(t.id);
  grouped += 1;
  checks += 1;
  if (list.length > Math.max(1, row.n)) {
    failures.push(`${t.id.slice(0, 8)} 结论条数 ${list.length} 超过运行次数 ${row.n}（说明按段而不是按运行分组）`);
  }
  const result = (getTask(t.id)?.result ?? "").trim();
  if (result !== "" && list.length > 0) {
    checks += 1;
    if (list[list.length - 1]!.trim() !== result) {
      failures.push(`${t.id.slice(0, 8)} 最后一条重组结论与 tasks.result 不一致`);
    }
  }
  if (list.length >= 2) {
    checks += 1;
    // 上一轮结论必须自己就有证据内容，否则「持平」是拿空快照比出来的假象
    const prev = evidenceSnapshot(list[list.length - 2]!);
    if (prev.citations === 0 && prev.docRefs === 0 && evidenceSnapshot(list[list.length - 1]!).citations > 0) {
      failures.push(`${t.id.slice(0, 8)} 上一轮结论是空快照，修订影响的比对基线不可信`);
    }
  }
}
ok("确实走查了真实任务的运行分组", grouped > 0, String(grouped));

// 4) 真实任务走查：结论按运行重组（listConclusions 与前端 useTaskEvents 同一规则）
let compared = 0;
let improved = 0;
let regressed = 0;
let unchanged = 0;
for (const t of listTasks()) {
  const list = listConclusions(t.id);
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

// 超过引用清单上限时快照必须数全量：截断是界面需要，度量按截断窗口算会随结论长度凭空涨跌。
// 实测一次写回真加了 2 条官方原文（全量 official 11 → 13），却因前 20 条窗口挪动被算成
// official 11 → 10、判为「证据质量退步」，把假警报送进了交付自检。
const urlBlock = (n: number, base: string, label: string) =>
  Array.from({ length: n }, (_, i) => `- [${label}${i}](${base}${i}/content.html)`).join("\n");
const capBefore = [
  urlBlock(11, "https://fgk.chinatax.gov.cn/zcfgk/c10001", "官方原文"),
  urlBlock(9, "https://baike.baidu.com/item/x", "百科词条"),
].join("\n");
const capAfter = `${capBefore}\n${urlBlock(2, "https://fgk.chinatax.gov.cn/zcfgk/c20002", "新增官方")}`;
const capSnapBefore = evidenceSnapshot(capBefore);
const capSnapAfter = evidenceSnapshot(capAfter);
expect("前置：上一轮正好卡在引用清单上限", capSnapBefore.citations, 20);
expect("补进 2 条官方原文后按全量计为 22 条", capSnapAfter.citations, 22);
expect("官方原文按全量计不被截断", capSnapAfter.official, 13);
expect("弱证据条数不受新增官方原文影响", capSnapAfter.weak, 9);
expect(
  "补官方原文判为改善，不因窗口挪动误判退步",
  deltaVerdict(evidenceDelta(capSnapBefore, capSnapAfter)),
  "证据质量改善",
);

console.log(`[verify] 修订影响检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 修订前后证据对比规则不符");
  process.exit(1);
}
console.log("[PASS] 修订前后证据对比正确（快照口径 / 差值与判断 / 真实续跑任务走查）");
