/**
 * 验证脚本：结论金额溯源（提取规则 / 工具数值收集 / 三级口径 / 真实任务走查）。
 * 运行：pnpm verify:amounts
 */
import {
  amountKey,
  classifyUntraced,
  UNTRACED_ORIGIN_HINT,
  UNTRACED_ORIGIN_TEXT,
  type UntracedOrigin,
  collectToolCents,
  extractAmounts,
  TEXT_AMOUNT_TOOLS,
  traceAmounts,
} from "../../web/src/amount-trace.ts";
import { db } from "../src/db.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";
import { listAmountChecks, setAmountCheck } from "../src/services/amount-checks.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 提取规则
expect("千分位 + 元", extractAmounts("合同金额 12,000,000.00 元").map((a) => a.cents), [1200000000]);
expect("万元换算", extractAmounts("财政补助 50 万元").map((a) => a.cents), [50000000]);
expect("负号差异", extractAmounts("差异 -460,000.00 元").map((a) => a.cents), [-46000000]);
expect("U+2212 负号", extractAmounts("差额 −6,666.67").map((a) => a.cents), [-666667]);
expect("百分号不计入", extractAmounts("加计扣除比例 100%").length, 0);
expect("年份不计入", extractAmounts("2025 年度研发项目").length, 0);
expect("量词不计入", extractAmounts("共 3 份合同、6 大类费用").length, 0);
expect("URL 中的数字不计入", extractAmounts("见 https://x.gov.cn/t.php?tid=27828 与 /c100012/c5194166/").length, 0);
// 冒号后的金额必须计入：工具正文与结论大量写成「限额: 175555.55 元」，正则的前导 \s* 会让匹配
// 从冒号后的空格起算，若按匹配起点判「是不是长记号的一部分」，前一个字符正好是 ":"，整条金额被
// 跳过——等于给手算数字留了「写成 冒号+空格 就查不到」的口子（实测平台少了 24 处金额没被核对）。
expect("冒号+空格后的金额计入", extractAmounts("其他相关费用限额: 175555.55 元").map((a) => a.cents), [17555555]);
expect("冒号后的千分位金额计入", extractAmounts("前五类合计: 1,580,000.00 元").map((a) => a.cents), [158000000]);
expect("冒号后的负数金额计入且保留符号", extractAmounts("差额: -10,000.00 元").map((a) => a.cents), [-1000000]);
expect("负号金额不被自己的负号误杀", extractAmounts("差异 -460,000.00 元").map((a) => a.cents), [-46000000]);
expect("紧挨冒号的数字仍视为记号一部分（时间）", extractAmounts("检索时间 09:17 完成").length, 0);
expect("紧挨等号的数字仍视为记号一部分（查询串）", extractAmounts("见 https://x.gov.cn/t.php?tid=278280").length, 0);
expect("短编号不计入（12366 热线）", extractAmounts("国家税务总局12366纳税服务平台的答复").length, 0);
expect("6 位以上无单位数字计入", extractAmounts("辅助账 860000 与财务账 0").map((a) => a.cents), [86000000]);
expect("无单位但带千分位/位数足够时计入", extractAmounts("金额 1,200,000 与 860000").map((a) => a.cents), [
  120000000, 86000000,
]);
expect("上下文片段非空", extractAmounts("辅助账 860,000.00 元")[0]?.context.includes("860,000.00"), true);
// 篇幅与行列计数不是金额：实测结论里「PDF 共 37 页、28,263 字符，已解析」的 28,263 带千分位、
// 位数也够长，两道「不像金额」的守卫都拦不住，被当成一笔待人工确认的金额挂进了缺口清单
expect("字符数不计入", extractAmounts("PDF 共 37 页、28,263 字符，已解析").length, 0);
expect("页数、行数、列数不计入", extractAmounts("正文 1,200 页、3,400 行、5,600 列").length, 0);
expect("张数、笔数不计入", extractAmounts("发票 1,200 张、记账凭证 3,400 笔").length, 0);
expect("带单位的金额不因新增后缀被误杀", extractAmounts("直接投入 420,000 元").map((a) => a.cents), [42000000]);

// 2) 工具数值收集（元 / 分双量纲）
const pool = collectToolCents([{ amountYuan: "5,000,000.00", cents: 420000, nested: [{ v: 860000 }] }, "不是数字"]);
expect("字符串金额按元登记", pool.has(500000000), true);
expect("数值同时登记元与分", [pool.has(42000000), pool.has(420000)], [true, true]);
expect("嵌套数组可收集", pool.has(86000000), true);
expect("非数值字符串忽略", pool.size > 0 && !pool.has(Number.NaN), true);
// OCR 与文档解析把整页文字放进一个字符串字段，金额不是 JSON 数值：默认不收，开了 scanText 才按正文扫。
// 实测 cc644639「OCR 扫描件解析验证」的「人员人工 860000 元」就在 textPreview 里，
// 结论如实引用它却被判成待人工确认（4/4 全部待确认）
const ocr = [{ textPreview: "研发费用辅助账\n人员人工 860000 元\n直接投入 420000 元\n", ocrProvider: "tesseract" }];
expect(
  "默认不把正文里的数字当出处：联网结果里满是别人网页上的数字，一律收进来这道核对就形同虚设",
  collectToolCents(ocr).has(86000000),
  false,
);
expect("开了 scanText 就能从正文里取到金额", collectToolCents(ocr, { scanText: true }).has(86000000), true);
expect("scanText 同样登记元与分两种量纲", collectToolCents(ocr, { scanText: true }).has(860000), true);
expect(
  "正文里的篇幅计数不会被 scanText 当成金额",
  collectToolCents([{ textPreview: "PDF 共 37 页、28,263 字符" }], { scanText: true }).has(2826300),
  false,
);
expect(
  "正文类工具名单只含资料解析",
  [...TEXT_AMOUNT_TOOLS],
  ["parse_uploaded_files"],
);
expect(
  "traceAmounts 第四参收正文类结果：OCR 金额可溯源",
  traceAmounts("识别出人员人工 860000 元", [], "", ocr).traced,
  1,
);
expect(
  "不传第四参时仍判为待确认（默认口径不变）",
  traceAmounts("识别出人员人工 860000 元", ocr).untraced.length,
  1,
);

// 3) 三级口径
const results = [{ diff: 460000, total: "12,000,000.00" }];
const text = "合同金额 12,000,000.00 元，差异 -460,000.00 元；客户提供 5,000,000.00 元；推算 84,444.44 元。";
const trace = traceAmounts(text, results, "发票 FP-001 金额 5,000,000.00 元");
expect("工具结果可溯源", trace.traced, 2);
expect("来自客户指令", trace.fromInput, 1);
expect("两边都没有 → 待确认（raw 保留原文单位）", trace.untraced.map((u) => u.raw), ["84,444.44元"]);
expect("总数一致", trace.total, trace.traced + trace.fromInput + trace.untraced.length);
expect("符号不敏感匹配（结论负数 / 工具正数）", traceAmounts("差异 -460,000.00 元", results).traced, 1);
expect("空结论", traceAmounts("", results).total, 0);

// 3b) 就地标注依赖的原文片段：必须是结论里的精确子串，否则标注不会出现
const sample = "推算 84,444.44 元，差异 -460,000.00 元，补助 50 万元。";
const extracted = extractAmounts(sample);
expect("样例提取 3 处", extracted.length, 3);
expect("match 都是原文精确子串", extracted.every((a) => sample.includes(a.match)), true);
expect("match 保留原文空格与单位", extracted.map((a) => a.match), ["84,444.44 元", "-460,000.00 元", "50 万元"]);
expect("raw 为归一化展示形式", extracted.map((a) => a.raw), ["84,444.44元", "-460,000.00元", "50万元"]);

// 3c) 人工核对标记的键：同一金额的不同写法共用一个键，标记一次覆盖全部出现处
expect("核对键只由值决定", amountKey({ cents: -46000000 }), "-46000000");
expect("同值不同写法共用一个键", amountKey({ cents: 5000000 }) === amountKey({ cents: 5000000 }), true);
expect("提取结果可直接生成核对键", amountKey(extracted[0]!), "8444444");
// 4) 真实任务走查：可溯源比例不得低于 90%（当前实现约 96%）
let total = 0;
let explained = 0;
let tasks = 0;
const worst: string[] = [];
for (const t of listTasks()) {
  const detail = getTask(t.id);
  const text2 = detail?.result ?? "";
  if (!text2.trim()) continue;
  const rows = db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ? AND ok = 1`).all(t.id) as Array<{
    tool_name: string;
    result: string | null;
  }>;
  const parsedAll = rows.map((r) => {
    try {
      return r.result ? JSON.parse(r.result) : null;
    } catch {
      return null;
    }
  });
  const parsed = parsedAll;
  // OCR / 文档解析结果里的金额是正文字符串：与平台统计、结果页、交付包走查同一口径地按正文再扫一遍
  const textParsed = rows.filter((r) => TEXT_AMOUNT_TOOLS.has(r.tool_name)).map((r, i) => parsedAll[i] ?? null);
  const res = traceAmounts(text2, parsed, detail?.instruction ?? "", textParsed);
  tasks += 1;
  total += res.total;
  explained += res.traced + res.fromInput;
  if (res.untraced.length > 0) worst.push(`${t.id.slice(0, 8)}:${res.untraced.length}/${res.total}`);
  checks += 1;
  const badMatch = res.untraced.filter((u) => !text2.includes(u.match)).length;
  if (badMatch > 0) failures.push(`${t.id} 有 ${badMatch} 处待确认金额的原文片段不是结论子串（标注会失效）`);
}
checks += 1;
const ratio = total === 0 ? 1 : explained / total;
if (ratio < 0.9) failures.push(`真实任务金额溯源比例 ${(ratio * 100).toFixed(1)}% 低于 90%`);
console.log(
  `[verify] 真实任务=${tasks} 金额=${total} 可溯源=${explained} 待确认=${total - explained} 比例=${(
    ratio * 100
  ).toFixed(1)}%`,
);
if (worst.length > 0) console.log(`[verify] 含待确认金额的任务：${worst.join(" ")}`);

// 5) 人工核对标记的读写：写入 → 修订备注（upsert）→ 撤销；用合成任务 id，结束即清理
const TMP_TASK = "verify-amount-checks-tmp";
try {
  db.prepare(`DELETE FROM amount_checks WHERE task_id = ?`).run(TMP_TASK);
  setAmountCheck(TMP_TASK, "8444444", true, "初版备注");
  expect(
    "写入后可读取",
    listAmountChecks(TMP_TASK).map((c) => [c.key, c.note]),
    [["8444444", "初版备注"]],
  );
  setAmountCheck(TMP_TASK, "8444444", true, "修订备注");
  expect(
    "同键重复写入更新备注且不产生重复行",
    listAmountChecks(TMP_TASK).map((c) => [c.key, c.note]),
    [["8444444", "修订备注"]],
  );
  setAmountCheck(TMP_TASK, "8444444", false, "");
  expect("撤销后清空", listAmountChecks(TMP_TASK), []);
} finally {
  db.prepare(`DELETE FROM amount_checks WHERE task_id = ?`).run(TMP_TASK);
}

// 未溯源金额的去向分类：为什么找不到出处，决定复核人该做什么
const WEB_RESULTS = [
  { content: [{ type: "text", text: "其他相关费用限额不得超过 175555.55 元，加计扣除比例为 100%" }] },
];
const UNTRACED = extractAmounts("限额 175,555.55 元与两口径差额 454,444.45 元");
const SPLIT = classifyUntraced(UNTRACED, WEB_RESULTS);
expect("未溯源样例确实提取到两处金额", UNTRACED.length, 2);
expect(
  "能在联网正文里找到的归为「引自联网正文」",
  SPLIT.web.map((a) => a.cents),
  [17555555],
);
expect(
  "三处都找不到的归为「疑似口算」",
  SPLIT.unexplained.map((a) => a.cents),
  [45444445],
);
expect("两类之和等于未溯源总数", SPLIT.web.length + SPLIT.unexplained.length, UNTRACED.length);
expect(
  "没有联网结果时全部归为疑似口算",
  classifyUntraced(UNTRACED, []).unexplained.length,
  UNTRACED.length,
);
expect("空清单安全兜底", [classifyUntraced([], WEB_RESULTS).web.length, classifyUntraced([], WEB_RESULTS).unexplained.length], [0, 0]);

// 两类的界面文案与依据说明只出一份：台账列名、看板 tooltip、复核页徽章、就地标注的 label 共用它。
// 必须非空、必须覆盖两档、且不能带 Markdown 记号（这些字符串会直接进 JSX 文本与 title 属性）。
expect("两类文案都给了", Object.keys(UNTRACED_ORIGIN_TEXT).sort(), ["unexplained", "web"]);
expect("两类说明都给了", Object.keys(UNTRACED_ORIGIN_HINT).sort(), ["unexplained", "web"]);
const MD_MARK = /(\*\*|`|^#{1,6}\s|\[[^\]]*\]\([^)]*\)|^\s*\|\s*---|^>\s)/m;
for (const k of ["web", "unexplained"] as UntracedOrigin[]) {
  expect(`${k} 的界面文案非空`, UNTRACED_ORIGIN_TEXT[k].trim() !== "", true);
  expect(`${k} 的界面文案不含 Markdown 记号`, MD_MARK.test(UNTRACED_ORIGIN_TEXT[k]), false);
  expect(`${k} 的依据说明非空`, UNTRACED_ORIGIN_HINT[k].trim() !== "", true);
  expect(`${k} 的依据说明不含 Markdown 记号`, MD_MARK.test(UNTRACED_ORIGIN_HINT[k]), false);
}
// 分类必须真的分到了东西：两档都为空的话，界面上的徽章全归一类也没人发现
expect("样例里两类都确实出现了", [SPLIT.web.length > 0, SPLIT.unexplained.length > 0], [true, true]);
// 关键：分类**不改变**溯源判定。联网正文依然不进可溯源池，否则任何金额都能声称有出处
const webTraced = traceAmounts("限额 175,555.55 元", WEB_RESULTS, "", []);
expect("联网正文不进可溯源池（分类不改判定）", [webTraced.traced, webTraced.untraced.length], [0, 1]);
const TEXT_RESULT = { textPreview: "人员人工 860000 元" };
expect(
  "按正文扫描只对 textResults（第 4 个参数）生效，普通 results 里的整段文本不收",
  [
    traceAmounts("人员人工 860000 元", [TEXT_RESULT], "", []).traced,
    traceAmounts("人员人工 860000 元", [], "", [TEXT_RESULT]).traced,
  ],
  [0, 1],
);

// 上下文片段既显示在复核页「结论金额核对」清单与 tooltip 里，也会拼进联网复查的检索词：
// 不能带着 Markdown 记号。实测清单里出现过「…其他相关费用为8万元。** > > **（一）按照9…」。
const CTX_MD = [
  "> 项目A的其他相关费用限额为 **100,000.00 元**[90*10%/(1-10%)]：",
  "### 1.2 加计扣除测算（`calculate_rd_adjustment`）得出 1,755,555.55 元",
  "可加计扣除基数 2,040,000.00 元",
].join("\n");
const ctxAmounts = extractAmounts(CTX_MD);
expect("确实从带记号的原文里提到了金额", ctxAmounts.length > 0, true);
for (const a of ctxAmounts) {
  expect(`金额 ${a.raw} 的上下文不含粗体记号`, /\*\*/.test(a.context), false);
  expect(`金额 ${a.raw} 的上下文不含反引号`, a.context.includes("`"), false);
  expect(`金额 ${a.raw} 的上下文不含引用记号`, /(^|\s)>\s/.test(a.context), false);
  expect(`金额 ${a.raw} 的上下文不含标题井号`, /(^|\s)#{1,6}\s/.test(a.context), false);
}
// 上下文窗口只有金额前 24 字，23 字的工具名放不下整个，断言按能落进窗口的那截写。
// 要验的是下划线没被当成斜体记号啃掉（calculate_rd_adjustment 里有两个 _）。
expect(
  "上下文里的工具名下划线保留（不被当斜体啃掉）",
  ctxAmounts.some((a) => a.context.includes("rd_adjustment")),
  true,
);
// raw 与 match 仍必须是原文：正文就地标注靠 match 精确匹配渲染后的文本，改了标不上
// raw 是归一化后的展示形式，带单位：剥记号只动 context，不动 raw 与 match
expect("raw 保持原文写法（含单位）", ctxAmounts.some((a) => a.raw === "1,755,555.55元"), true);
expect("match 保持原文精确片段", ctxAmounts.every((a) => CTX_MD.includes(a.match)), true);

console.log(`[verify] 金额溯源检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 金额溯源规则不符");
  process.exit(1);
}
console.log("[PASS] 金额溯源规则正确（提取 / 双量纲收集 / 三级口径 / 真实任务比例）");
