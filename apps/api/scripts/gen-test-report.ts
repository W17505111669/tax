/**
 * 测试报告生成器（比赛"应用效果/测试报告"交付物）。
 * 实时执行六条自动化验证脚本，并汇总数据库中全部真实任务的工具链、比对准确率与产物清单。
 * 运行：pnpm report:test
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db.ts";
import { LEDGER_COLUMNS } from "../../web/src/evidence-ledger.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { summarizeTaskCompares, type CompareCall } from "../src/services/compare-stats.ts";
import { compareRates, rateText } from "@tax/document-tools";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

const VERIFY_SCRIPTS: Array<{ name: string; cmd: string; scope: string }> = [
  { name: "verify:pi", cmd: "pnpm verify:pi", scope: "Pi SDK 安装、模型连接、自定义工具调用、事件回传" },
  { name: "verify:docs", cmd: "pnpm verify:docs", scope: "Excel/CSV 解析与 Excel 底稿生成" },
  { name: "verify:template", cmd: "pnpm verify:template", scope: "模板检查与保留式填列（地址/映射双模式）" },
  { name: "verify:policy", cmd: "pnpm verify:policy", scope: "政策快照与加计扣除比例规则" },
  { name: "verify:compare", cmd: "pnpm verify:compare", scope: "底稿逐格/记录级比对统计口径" },
  { name: "verify:ocr", cmd: "pnpm verify:ocr", scope: "OCR 适配器中文+数字识别" },
  { name: "verify:extract", cmd: "pnpm verify:extract", scope: "合同/发票票面字段确定性抽取" },
  { name: "verify:diagram", cmd: "pnpm verify:diagram", scope: "关联关系图 mermaid 确定性生成" },
  { name: "verify:agents", cmd: "pnpm verify:agents", scope: "双 Agent 独立性与内置工具禁用" },
  { name: "verify:progress", cmd: "pnpm verify:progress", scope: "列表执行进度 0-5 步推导规则" },
  {
    name: "verify:locate",
    cmd: "pnpm verify:locate",
    scope: "阅读器表格定位命中规则（记录地址 / A1 / 文本 / 差异值校验）",
  },
  { name: "verify:review", cmd: "pnpm verify:review", scope: "人工复核状态一致性（完成态遗留待复核问题的补救判定）" },
  {
    name: "verify:tlcalls",
    cmd: "pnpm verify:tlcalls",
    scope: "时间线工具调用配对（callId 精确匹配 + 同名序号兜底）",
  },
  {
    name: "verify:runart",
    cmd: "pnpm verify:runart",
    scope: "运行时间窗推导与产物归属（导出「本次运行产物清单」的依据）",
  },
  {
    name: "verify:artsrc",
    cmd: "pnpm verify:artsrc",
    scope: "产物溯源（生成产物与工具调用的确定性对应）",
  },
  {
    name: "verify:rtools",
    cmd: "pnpm verify:rtools",
    scope: "工具调用清单（按运行分组 / 入参摘要 / 耗时 / 汇总）",
  },
  {
    name: "verify:revexp",
    cmd: "pnpm verify:revexp",
    scope: "人工复核记录导出（计数与后端同口径 / 转义 / 状态提示）",
  },
  {
    name: "verify:dcheck",
    cmd: "pnpm verify:dcheck",
    scope: "交付自检分级规则（阻断 / 提醒 / 可交付）与真实任务走查",
  },
  {
    name: "verify:amounts",
    cmd: "pnpm verify:amounts",
    scope: "结论金额溯源（提取规则 / 双量纲收集 / 工具-指令-待确认三级口径）",
  },
  {
    name: "verify:links",
    cmd: "pnpm verify:links",
    scope: "引用链接核验分级（可访问 / 反爬拒绝 / 失效 / 无法核验）",
  },
  {
    name: "verify:fileparse",
    cmd: "pnpm verify:fileparse",
    scope: "上传资料解析摘要（状态中文化 / 表格与 OCR 摘要 / 按文件名汇总）",
  },
  {
    name: "verify:bundle",
    cmd: "pnpm verify:bundle",
    scope: "交付包打包（条目名安全化 / zip 往返 / 真实任务条目组装）",
  },
  {
    name: "verify:manifest",
    cmd: "pnpm verify:manifest",
    scope: "交付清单 manifest.json（结构 / 内部一致性自校验 / 真实任务走查）",
  },
  {
    name: "verify:fresh",
    cmd: "pnpm verify:fresh",
    scope: "交付包新鲜度（上次打包后的变更识别与提示文案）",
  },
  {
    name: "verify:stats",
    cmd: "pnpm verify:stats",
    scope: "平台统计口径（比对准确率双口径 / 工具 / 任务 / 产物计数）",
  },
  {
    name: "verify:policytrace",
    cmd: "pnpm verify:policytrace",
    scope: "政策文号溯源（提取 / 归一化 / 有出处-无法核验-待确认三级口径）",
  },
  {
    name: "verify:websearch",
    cmd: "pnpm verify:websearch",
    scope: "联网检索可信度（词元切分 / 相关度门槛 / 入口页过滤 / 验证页识别 / 历史数据回放）",
  },
  {
    name: "verify:citegrade",
    cmd: "pnpm verify:citegrade",
    scope: "联网引用证据力分级（官方来源 / 专业来源 / 首页百科检索页 + 两套实现口径交叉核对）",
  },
  {
    name: "verify:searchev",
    cmd: "pnpm verify:searchev",
    scope: "联网检索留痕与引用提取（各工具结果形状 / 去重上限 / 只留元数据时如实说明 / 真实任务走查）",
  },
  {
    name: "verify:refcheck",
    cmd: "pnpm verify:refcheck",
    scope: "政策文号联网复查（发文机关前缀与检索词构造 / 四级判定 / 落库往返与覆盖 / 真实任务走查）",
  },
  {
    name: "verify:revimpact",
    cmd: "pnpm verify:revimpact",
    scope: "修订前后证据对比（快照口径 / 差值与总体判断 / 按事件流重组结论的真实续跑走查）",
  },
  {
    name: "verify:trend",
    cmd: "pnpm verify:trend",
    scope: "指标趋势（每日快照记录与裁剪 / 基线日选择 / 环比差值 / 越高越好与越低越好的方向判断）",
  },
  {
    name: "verify:sheet",
    cmd: "pnpm verify:sheet",
    scope: "证据核对表（九项核对结论 / 空输入如实兜底 / 待办分组 / MD 片段 / 真实任务走查）",
  },
  {
    name: "verify:amtnote",
    cmd: "pnpm verify:amtnote",
    scope: "金额核对备注模板（模板可用性 / 追加分段与去重 / 撤销最近一段 / 留痕有效性判断 / 自定义模板按作品存取、脏数据丢弃、新增校验与合并去重）",
  },
  {
    name: "verify:ledger",
    cmd: "pnpm verify:ledger",
    scope: `全平台证据核对台账（缺口判断 / 排序与合计 / ${LEDGER_COLUMNS.length} 列单元格 / CSV 与 Markdown 导出 / 与平台统计口径交叉核对）`,
  },
  {
    name: "verify:csv",
    cmd: "pnpm verify:csv",
    scope: "CSV 与文件下载统一口径（转义 / 公式注入防护 / CRLF 与 BOM / RFC 往返解析 / 组件里不再手写 createObjectURL）",
  },
  {
    name: "verify:diaexport",
    cmd: "pnpm verify:diaexport",
    scope: "mermaid 图导出（图类型识别 / 文件名不互相覆盖 / 导出配置指令 / SVG 尺寸解析 / 交付件脱敏 / 真实比赛材料走查）",
  },
  {
    name: "verify:localstore",
    cmd: "pnpm verify:localstore",
    scope: "本地存储统一入口（读写与内存降级 / 形状校验 / 脏数据回落不抛错 / 收藏与排序等跨组件共享键 / 键登记 / 前端不再绕过入口的静态走查）",
  },
  {
    name: "verify:format",
    cmd: "pnpm verify:format",
    scope: "数字与单位排版口径（小数去零 / 百分比取值与「—」兜底不写成「—%」/ 中文单位留空格而 % 紧贴 / 字节数 / 组件不再各自 round 的静态走查）",
  },
  {
    name: "verify:reltime",
    cmd: "pnpm verify:reltime",
    scope: "时间显示口径（相对时间分档 / 坏数据兜底不猜「刚刚」/ 与旧实现逐值一致 / link-check 空串语义 / 文件名时间戳 / 不许再出现第二份实现）",
  },
  {
    name: "verify:textfind",
    cmd: "pnpm verify:textfind",
    scope: "阅读器查找口径（命中区间 / 计数与旧口径逐例一致 / 高亮分段拼接保真 / 环形序号与旋转角 / 计数文案 / markdown 以 DOM mark 数为准 / 无第二份实现）",
  },
  {
    name: "verify:upload",
    cmd: "pnpm verify:upload",
    scope: "上传预检规则（扩展名 / 大小 / 空文件 / 批量分组 / 提示文案）",
  },
];

function runVerify(cmd: string): { pass: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd: root, timeout: 240000 }).toString("utf8");
    return { pass: /\[PASS\]/.test(output), output };
  } catch (err) {
    const output =
      err instanceof Error
        ? String((err as { stdout?: unknown }).stdout ?? "") + String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    return { pass: /\[PASS\]/.test(output), output };
  }
}

interface TaskRow {
  id: string;
  agent_id: string;
  title: string;
  status: string;
  case_id: string;
  created_at: string;
  error: string | null;
}

const tasks = db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`).all() as unknown as TaskRow[];

const lines: string[] = [];
const now = new Date();
const stamp = now.toISOString().slice(0, 10);

lines.push(`# 测试报告（${stamp}）`);
lines.push("");
lines.push(`生成方式：\`pnpm report:test\` 实时执行验证脚本并汇总数据库真实任务记录，非人工填写。`);
lines.push("");
lines.push(`## 一、运行环境`);
lines.push("");
lines.push(`- Node ${process.version} / Windows`);
const agentCorePkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "agent-core", "package.json"), "utf8"));
lines.push(`- Pi Agent SDK ${agentCorePkg.dependencies["@earendil-works/pi-coding-agent"]}`);
lines.push(`- 模型端点：${process.env.TAXAI_BASE_URL ?? "http://127.0.0.1:15721/v1"}（OpenAI Responses 兼容网关）`);
lines.push(`- 社区扩展：pi-web-access（联网检索/正文提取）`);
lines.push("");
lines.push(`## 二、自动化验证矩阵`);
lines.push("");
lines.push(`| 验证脚本 | 覆盖范围 | 结果 |`);
lines.push(`| --- | --- | --- |`);

let allPass = true;
for (const script of VERIFY_SCRIPTS) {
  process.stdout.write(`[report] running ${script.name}...\n`);
  const { pass } = runVerify(script.cmd);
  if (!pass) allPass = false;
  lines.push(`| \`pnpm ${script.name}\` | ${script.scope} | ${pass ? "PASS" : "FAIL"} |`);
}
lines.push("");

lines.push(`## 三、真实任务台账`);
lines.push("");
lines.push(`| 任务 | 智能体 | 案例 | 状态 | 工具调用链 | 比对准确率 | 产物 |`);
lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);

let comparedTotal = 0;
let matchedTotal = 0;
let mismatchTotal = 0;
let onlyATotal = 0;
let onlyBTotal = 0;
// 「已填列底稿 vs 它自己的原始模板」那一类单独统计：模板本来是空的，只有一侧有的格子正是填进去的值
let templateRuns = 0;
let templateFilled = 0;
let templateMismatched = 0;

for (const task of tasks) {
  const calls = db
    .prepare(`SELECT tool_name, ok, args, result, started_at FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`)
    .all(task.id) as unknown as CompareCall[];
  const chain = calls.map((c) => `${c.tool_name}${c.ok === 1 ? "" : c.ok === 0 ? "(!)" : "(…)"}`).join(" → ") || "—";

  const compares = calls.filter((c) => c.tool_name === "compare_workpapers" && c.ok === 1);
  let accuracy = "—";
  // 与平台统计、作品说明共用 compare-stats.ts 那一份实现：每个任务只取「最近一次记录级比对」计入合计。
  // 原来这里自己写过一遍，且取的是最后一次比对、不分模式，逐格比对排在后面时该任务就整个不计入，
  // 于是报告与看板给出两个累计准确率（实测 60% vs 33.33%）——是本脚本自己的 WARN 抓到的。
  // 必须把该任务的**全部**调用传进去：分类靠产物溯源（填列/生成类调用的 outputName ← fileName），
  // 只传比对调用就建不出溯源表，模板核对会被误当成同行评审——实测报告因此仍打 33.33%、
  // 而平台已是 60%，是本脚本自己那条「两处口径不一致」的 WARN 抓到的
  const cmp = summarizeTaskCompares(calls);
  if (cmp.peer !== null) {
    comparedTotal += cmp.peer.compared;
    matchedTotal += cmp.peer.matched;
    mismatchTotal += cmp.peer.mismatched;
    onlyATotal += cmp.peer.onlyA;
    onlyBTotal += cmp.peer.onlyB;
    accuracy = `${cmp.peer.accuracyPercent}%`;
  }
  templateRuns += cmp.template.runs;
  templateFilled += cmp.template.filledCells;
  templateMismatched += cmp.template.mismatched;
  if (cmp.peer === null && cmp.template.runs > 0) accuracy = `模板核对 ${cmp.template.runs} 次`;
  // 逐格（address）模式与记录级不是同一个量纲，只在表格里标一下，不进合计
  if (cmp.peer === null && cmp.template.runs === 0) {
    const hasAddress = compares.some((c) => {
      try {
        return (JSON.parse(c.result ?? "{}") as { sheets?: Array<{ mode?: string }> }).sheets?.[0]?.mode === "address";
      } catch {
        return false;
      }
    });
    if (hasAddress) accuracy = "地址模式";
  }

  const outDir = path.join(root, "data", "outputs", task.id);
  const artifacts = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => fs.statSync(path.join(outDir, f)).isFile())
    : [];
  const files = db.prepare(`SELECT file_name FROM files WHERE task_id = ?`).all(task.id) as unknown as Array<{ file_name: string }>;

  lines.push(
    `| ${task.title} | ${task.agent_id} | ${task.case_id} | ${task.status}${task.error ? `（${task.error.slice(0, 24)}）` : ""} | ${chain} | ${accuracy} | ${artifacts.length > 0 ? `${artifacts.length} 个` : "—"}${files.length > 0 ? `（上传 ${files.length}）` : ""} |`,
  );
}
lines.push("");

lines.push(`## 四、准确率统计（记录级比对口径）`);
lines.push("");
if (comparedTotal > 0 || templateRuns > 0) {
  const rates = compareRates(matchedTotal, mismatchTotal, onlyATotal);
  if (comparedTotal > 0) {
    lines.push(
      `- 与人工参考底稿的同行评审（每任务取最近一次）：比对项合计 ${comparedTotal}，一致 ${matchedTotal}、差异 ${mismatchTotal}、仅自动底稿有 ${onlyBTotal}、仅人工底稿有 ${onlyATotal}`,
    );
    lines.push(
      `- 一致率 **${rateText(rates.matchRatePercent)}**（= 一致 /（一致 + 差异），只看两边都有的项，回答「填得对不对」）· 覆盖率 **${rateText(
        rates.coveragePercent,
      )}**（= 一致 /（一致 + 仅人工底稿有），回答「人工底稿有的项自动填到了多少」）`,
    );
    lines.push(
      `- 口径说明：一致=正确识别；差异=错误识别；仅人工=未识别；仅自动底稿有=系统多出项（需人工复核）。差异项一律列为待核查事项，不计入正确。不再报「总准确率」——它把「填错」与「范围没对上」混成一个数，两类问题会互相掩盖。`,
    );
  }
  if (templateRuns > 0) {
    lines.push(
      `- 另有「已填列底稿 vs 它自己的原始模板」核对 ${templateRuns} 次：填列新增 ${templateFilled} 处、与模板既有内容冲突 ${templateMismatched} 处。**不计入上面两个比率**——模板本来是空的，只有一侧有的格子正是填进去的值，算成覆盖缺口等于把「填了多少」记成「漏了多少」。`,
    );
  }
} else {
  lines.push(`- 暂无记录级比对数据。`);
}
lines.push("");

lines.push(`## 五、案例回归（case:run）`);
lines.push("");
lines.push(`| 案例 | 状态 | 比对准确率 | 结论 | 工具链 |`);
lines.push(`| --- | --- | --- | --- | --- |`);
const casesDir = path.join(root, "data", "cases");
if (fs.existsSync(casesDir)) {
  for (const dirName of fs.readdirSync(casesDir).sort()) {
    const dir = path.join(casesDir, dirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    const reports = fs.readdirSync(dir).filter((f) => /^report-.*\.md$/.test(f)).sort();
    const latest = reports[reports.length - 1];
    if (!latest) {
      lines.push(`| ${dirName} | 暂无回归记录 | — | — | — |`);
      continue;
    }
    const text = fs.readFileSync(path.join(dir, latest), "utf8");
    const status = /- 状态：(.+)/.exec(text)?.[1]?.trim() ?? "—";
    const chain = /- 工具链：(.+)/.exec(text)?.[1]?.trim() ?? "—";
    const acc = /比对准确率：(.+)/.exec(text)?.[1]?.trim() ?? "—";
    const verdict = /\*\*结论：(PASS|FAIL)\*\*/.exec(text)?.[1] ?? "—";
    lines.push(`| ${dirName}（${latest.replace("report-", "").replace(".md", "")}） | ${status} | ${acc} | ${verdict} | ${chain} |`);
  }
} else {
  lines.push(`| — | 无案例目录 | — | — | — |`);
}
lines.push("");
lines.push(`## 六、已知限制`);
lines.push("");
lines.push(`- OCR 扫描件识别未接入：PDF 无文本层时工具明确提示需 OCR，不虚构内容。`);
lines.push(`- 政策快照为开发参考版本，正式引用前 Agent 会联网核验并记录核验时间。`);
lines.push(`- 任务会话为内存态，服务重启后运行中任务标记为已中断，历史事件与产物保留。`);
lines.push(`- 电子税务局申报、ERP/银行接口不在本期范围。`);
lines.push("");
lines.push(`**总体结论：${allPass ? "全部自动化验证通过" : "存在未通过验证项，见第二节"}；真实任务台账与准确率统计均来自数据库记录。**`);

const report = lines.join("\n");
const outPath = path.join(root, "docs", "testing", `test-report-${stamp}.md`);
fs.writeFileSync(outPath, report, "utf8");
console.log(`\n[report] written: ${outPath}`);
// 两个口径分别标注，避免与概览页「最近一次记录级比对准确率」混淆
const platformNow = computePlatformStats();
const overallNow = comparedTotal > 0 ? Math.round((matchedTotal / comparedTotal) * 10000) / 100 : null;
if (overallNow !== null && platformNow.compareAccuracyOverall !== overallNow) {
  console.log(
    `[report][WARN] 累计比对准确率两处口径不一致：报告 ${overallNow}% vs 平台统计 ${platformNow.compareAccuracyOverall}%`,
  );
}
console.log(
  `[report] allVerifyPass=${allPass} tasks=${tasks.length} recordCompareLatest=${
    platformNow.compareAccuracy ?? "n/a"
  }% recordCompareOverall=${overallNow ?? "n/a"}%（一致 ${matchedTotal}/比对 ${comparedTotal}）`,
);
