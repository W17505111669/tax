/**
 * 录屏分镜表生成器（Phase 6 交付物）。
 * 从数据库真实任务中自动挑选每幕代表任务，输出带深链的分镜脚本。
 * 运行：pnpm demo:script
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(root, "docs", "competition");
fs.mkdirSync(outDir, { recursive: true });

interface TaskInfo {
  id: string;
  agentId: string;
  title: string;
  status: string;
  tools: Set<string>;
  hasResume: boolean;
  hasReview: boolean;
  hasImageFile: boolean;
  hasExcelFile: boolean;
  createdAt: string;
}

const rows = db.prepare(`SELECT id, agent_id, title, status, created_at FROM tasks ORDER BY created_at DESC`).all() as unknown as Array<{
  id: string;
  agent_id: string;
  title: string;
  status: string;
  created_at: string;
}>;

const tasks: TaskInfo[] = rows.map((r) => {
  const calls = db.prepare(`SELECT tool_name FROM tool_calls WHERE task_id = ?`).all(r.id) as unknown as Array<{ tool_name: string }>;
  const events = db.prepare(`SELECT message FROM events WHERE task_id = ? AND kind = 'run_started'`).all(r.id) as unknown as Array<{ message: string }>;
  const reviews = db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?`).get(r.id) as unknown as { n: number };
  const files = db.prepare(`SELECT file_type FROM files WHERE task_id = ?`).all(r.id) as unknown as Array<{ file_type: string }>;
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    status: r.status,
    tools: new Set(calls.map((c) => c.tool_name)),
    hasResume: events.some((e) => e.message.includes("续跑")),
    hasReview: reviews.n > 0,
    hasImageFile: files.some((f) => ["png", "jpg", "jpeg", "bmp"].includes(f.file_type)),
    hasExcelFile: files.some((f) => ["xlsx", "xls"].includes(f.file_type)),
    createdAt: r.created_at,
  };
});

const link = (t: TaskInfo | undefined, tab: string): string =>
  t ? `http://127.0.0.1:5173/#/agent/${t.agentId}/task/${t.id}/tab/${tab}` : "（缺示例任务：可用首页示例任务一键创建）";

function pick(pred: (t: TaskInfo) => boolean, titleHint?: string): TaskInfo | undefined {
  const pool = titleHint ? tasks.filter((t) => t.title.includes(titleHint)) : tasks;
  const search = (list: TaskInfo[]) => list.find((t) => pred(t) && t.status !== "failed") ?? list.find(pred);
  return search(pool) ?? search(tasks);
}

const scenes: Array<{
  title: string;
  task?: TaskInfo;
  tab: string;
  link?: string;
  talk: string;
  expect: string;
  seconds: number;
}> = [
  {
    title: "平台总览与应用效果看板",
    tab: "timeline",
    link: "http://127.0.0.1:5173/#/agent/rd-audit",
    talk: "双智能体定位、共享底座、KPI 与平台应用效果实时数据（任务数/工具成功率/比对准确率）。",
    expect:
      "图标栏 + 可折叠会话侧栏（任务行带「未复核 N」角标，「复核 N」一键过滤全部待复核任务）、首页大数字 hero 与状态条形图、平台效果带（含全平台复核闭环缺口条：按作品分组，点击任务直达复核页，或两步确认「批量转为待复核」/「转该组 N」；以及全平台证据缺口条：弱证据引用与待复查文号按作品分组，点击任务直达结果页，条上同时给出联网检索拦下的无关结果数、只留元数据的检索次数与文号复查进度，「批量联网复查」两步确认后跨任务复查政策文号并当场回写缺口数字）、工具清单、底部发光输入框（Ctrl+Enter 提交；落区标注允许的类型与单文件上限，不合规文件当场拦下并逐份说明原因）。",
    seconds: 40,
  },
  {
    title: "智研税审：费用核查与确定性测算",
    task: pick((t) => t.agentId === "rd-audit" && t.tools.has("calculate_rd_adjustment") && t.tools.has("check_rd_expenses")),
    tab: "result",
    talk: "Agent 调用核查与测算工具；强调金额全部由 TypeScript 工具以整数分计算，模型零口算。",
    expect:
      "居中对话列与分段页签、执行时间线工具折叠行（含耗时）、引用来源胶囊与复制/重新生成操作行、结论要点区的「金额溯源 N/M」徽章（悬停看待确认金额与上下文，待确认金额在结论正文里以虚线下划线就地标注）、结果页操作行的「交付自检」结论徽章（阻断/提醒分级，悬停展开清单）与「打包下载」（整页 MD + 全部产物合成 zip）、审查结论 Markdown 表格与 mermaid 图。",
    seconds: 50,
  },
  {
    title: "政策依据：快照检索 + 联网核验",
    task: pick((t) => t.tools.has("search_rd_policy"), "政策依据"),
    tab: "result",
    talk: "search_rd_policy 给出比例与文号；正式引用前 web_search 联网核验并记录核验时间。",
    expect:
      "结论中的政策依据表格与核验状态、结论要点区的「文号溯源 N/M」徽章（悬停看有出处 / 无法核验 / 待确认三级明细，点开展开复查面板：对没有出处的文号一键联网复查，四级判定 + 证据链接可点开进侧边阅读器，结果落库刷新不丢）、联网引用区的「核验链接」按钮与四级结果标记（可访问 / 拒绝自动访问 / 失效 / 无法核验，悬停看原因），以及每条引用胶囊上的证据力徽章（官方原文 / 专业来源 / 证据力弱，悬停看判定理由）。",
    seconds: 40,
  },
  {
    title: "资料解析与底稿生成",
    task: pick((t) => t.tools.has("parse_uploaded_files") && t.tools.has("generate_workpaper") && t.hasExcelFile, "上传资料"),
    tab: "timeline",
    talk: "上传 Excel 辅助账 → parse_uploaded_files 结构化 → generate_workpaper 生成底稿 → 产物栏预览。",
    expect:
      "工具链四连（含耗时）、把文件拖到工作台任意位置即可上传（虚线落区提示 + 上传结果浮层）、业务资料面板的解析摘要（已解析 · N 个工作表 · M 行）与「重新解析」按钮（与智能体工具同一套 parseOne，状态卡在待解析或失败时可单独补救）、生成产物列表（每份产物标出大小与「由哪个工具在何时生成」，点「定位」跳到时间线对应调用）、阅读器「文件生成」分组与 Excel 表格预览。",
    seconds: 50,
  },
  {
    title: "OCR 扫描件识别",
    task: pick((t) => t.hasImageFile && t.tools.has("parse_uploaded_files")),
    tab: "timeline",
    talk: "tesseract.js 本地引擎识别中文扫描件，返回置信度；无文本层 PDF 的降级提示。",
    expect:
      "parse_uploaded_files 行、业务资料面板上的 OCR 引擎与置信度（如 tesseract 92.3%）、文本摘录与解析状态中文化。",
    seconds: 35,
  },
  {
    title: "土增智填：关联核验与模板保留式填列",
    task: pick((t) => t.agentId === "land-vat" && t.tools.has("fill_land_vat_workpaper")),
    tab: "timeline",
    talk: "合同-发票-账簿关联 → 映射模式填列原始模板 → 公式/合并零破坏 → 已填列产物预览。",
    expect: "match/fill 工具行、生成产物「已填列-…」预览。",
    seconds: 60,
  },
  {
    title: "底稿比对与差异定位",
    task: pick((t) => t.tools.has("compare_workpapers")),
    tab: "compare",
    talk: "记录级比对输出准确率；点击差异行同时打开两份底稿并高亮定位；导出比对报告。",
    expect:
      "比对 KPI 卡、差异表（↑/↓ 选择、Enter 定位）、点击差异行后阅读器自动双栏对照（A 主栏 / B 副栏，两份都预载）+ 琥珀高亮行与加深单元格自动滚入视口（徽章显示命中行数；记录地址与 A1 地址均可定位，并按该侧差异值校验，值不符则不高亮）+ 工具栏「‹ i/N ›」或 Enter / Shift+Enter 逐处跳转命中行，当前处在主栏与副栏同时以玫红底标出。",
    seconds: 50,
  },
  {
    title: "人工复核状态机",
    task: pick((t) => t.hasReview),
    tab: "review",
    talk: "waiting_review → 税务师逐项确认/驳回 → 自动流转 completed；复核意见留痕。",
    expect:
      "复核页签问题卡、决定徽章、状态点变化、「结论金额核对」小节（待确认金额一键标记为已核对并可填写核对依据备注，与结论正文的就地标注同步，可撤销；备注写入整页交付 MD）。",
    seconds: 40,
  },
  {
    title: "续跑：会话历史恢复",
    task: pick((t) => t.hasResume),
    tab: "timeline",
    talk: "补充意见后续跑，Agent 引用上一轮工具结果直接作答，不重复核查。",
    expect:
      "「续跑任务」事件与引用上轮结论的回答；续跑分隔行标出本次运行的产物数（悬停看清单与大小），按次运行导出的 MD 含时间窗与产物表。",
    seconds: 40,
  },
  {
    title: "阅读器与报告版式",
    task: pick((t) => t.tools.has("search_public_cases"), "缺失资料"),
    tab: "result",
    talk:
      "资料缺失时 search_public_cases 联网检索公开案例，检索结果先按相关度过滤，无关网页与门户首页不进结论；引用 chips 点击进阅读模式，切换四套纸张版式后打印导出 PDF。",
    expect:
      "联网引用区的证据力汇总行（官方原文 N · 专业来源 M · 证据力弱 K，弱证据胶囊转琥珀色并悬停看判定理由）与「核验链接」四级标记、侧边阅读器「引用文件 / 文件生成」分组页签、点阵加载动画、白纸预览、版式切换器、打印样式与目录页。",
    seconds: 45,
  },
];

const total = scenes.reduce((a, s) => a + s.seconds, 0);
const lines: string[] = [];
lines.push(`# 运行录屏分镜表（${new Date().toISOString().slice(0, 10)} 生成）`);
lines.push("");
lines.push(`> 由 \`pnpm demo:script\` 从数据库真实任务自动生成；深链可直接粘贴到浏览器跳转。`);
lines.push(`> 附件4 要求：MP4、≤500MB、≤8 分钟。本表合计建议时长 **${Math.ceil(total / 60)} 分 ${total % 60} 秒**，${total <= 480 ? "符合要求" : "超出 8 分钟，需压缩旁白或删减幕" }。`);
lines.push("");
lines.push(`| # | 幕 | 建议时长 | 深链 | 旁白要点 | 画面验收 |`);
lines.push(`| --- | --- | --- | --- | --- | --- |`);
scenes.forEach((s, i) => {
  const taskLabel = s.task ? `${s.task.title}（${s.task.status}）` : "待创建";
  lines.push(
    `| ${i + 1} | ${s.title}<br/>任务：${taskLabel} | ${s.seconds}s | ${s.link ?? (s.task ? link(s.task, s.tab) : link(undefined, s.tab))} | ${s.talk} | ${s.expect} |`,
  );
});
lines.push("");
lines.push(`## 录屏操作提示`);
lines.push("");
lines.push(`- 每幕开场先停 2 秒展示深链地址栏，证明为真实运行环境；`);
lines.push(`- 执行类镜头优先选「重新执行」现场跑一遍（SSE 实时事件可见），历史任务镜头用深链回放；`);
lines.push(`- 结尾 30 秒：测试报告（docs/testing/test-report-*.md）与两份作品说明滚屏，收在应用效果看板。`);
lines.push("");

const out = path.join(outDir, "录屏分镜表.md");
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`[demo] written: ${out}`);
console.log(
  `[demo] scenes=${scenes.length} totalSeconds=${total} missing=${scenes.filter((s) => !s.task && !s.link).length}`,
);
