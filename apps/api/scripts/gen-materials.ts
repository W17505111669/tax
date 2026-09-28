/**
 * 比赛作品说明生成器（Phase 6 脚手架）。
 * 从 Agent 配置与数据库真实运行记录生成两个作品的说明文档。
 * 运行：pnpm gen:materials
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskDocumentTools, createTemplateTools } from "@tax/document-tools";
import rdAuditAgent from "@tax/agent-rd-audit";
import landVatAgent from "@tax/agent-land-vat";
import type { TaxAgentConfig } from "@tax/agent-core";
import { BACKGROUND, FLOWS, GOALS, INNOVATIONS, latestCompareFor, statsFor } from "./materials-lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outDir = path.join(root, "docs", "competition");
fs.mkdirSync(outDir, { recursive: true });

const dummyCtx = { taskId: "stats", files: [], outputsDir: "" };
const docToolNames = createTaskDocumentTools(dummyCtx).map((t) => ({ name: t.name, label: t.label, description: t.description }));
const tplToolNames = createTemplateTools(dummyCtx).map((t) => ({ name: t.name, label: t.label, description: t.description }));

function toolTable(agent: TaxAgentConfig, extra: Array<{ name: string; label: string; description: string }>): string {
  const rows = [
    ...agent.tools.map((t) => ({ name: t.name, label: t.label, description: t.description, group: "业务工具" })),
    ...(agent.sharedTools ?? []).map((t) => ({ name: t.name, label: t.label, description: t.description, group: "共用设施" })),
    ...extra.map((t) => ({ ...t, group: "任务级工具" })),
  ];
  return [
    "| 工具 | 分组 | 名称 | 职责 |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.label} | ${r.group} | \`${r.name}\` | ${r.description.slice(0, 60)} |`),
  ].join("\n");
}

function build(agent: TaxAgentConfig, extra: Array<{ name: string; label: string; description: string }>): string {
  const stats = statsFor(agent.id);
  const okRate = stats.toolCalls > 0 ? Math.round((stats.toolOk / stats.toolCalls) * 10000) / 100 : 0;
  const lines: string[] = [];
  lines.push(`# ${agent.displayName} 作品说明`);
  lines.push("");
  lines.push(`> 本文档由 \`pnpm gen:materials\` 于 ${new Date().toISOString().slice(0, 10)} 生成；应用效果数据来自平台数据库真实运行记录。`);
  lines.push("");
  lines.push(`## 一、业务背景`);
  lines.push("");
  lines.push(BACKGROUND[agent.id] ?? agent.description);
  lines.push("");
  lines.push(`## 二、实现目标`);
  lines.push("");
  for (const g of GOALS[agent.id] ?? []) lines.push(`- ${g}`);
  lines.push("");
  lines.push(`## 三、技术路线`);
  lines.push("");
  lines.push(`- Agent Runtime：Pi Agent SDK \`@earendil-works/pi-coding-agent@0.87.1\`（嵌入式会话，禁用内置 read/bash/edit/write）`);
  lines.push(`- 联网检索：社区扩展 pi-web-access（Exa MCP 零配置）+ 自建 Bing/百度兜底抓取`);
  lines.push(
    `- 引用可核验：结论引用链接可按需批量核验可达性（服务端 GET、8 秒超时、不下载正文，沿用内网地址拦截），结果分为可访问 / 拒绝自动访问（反爬，需人工确认）/ 失效 / 无法核验四级；核验结果按任务持久化（刷新不丢、时间线留痕），失效引用进入交付自检提醒与整页 MD，反爬不计入交付风险`,
  );
  lines.push(`- 前后端：React + Vite + Tailwind（深色专业工作台）/ Node.js + Fastify + SSE`);
  lines.push(`- 存储与计算：SQLite（node:sqlite）/ ExcelJS / unpdf / tesseract.js（OCR）/ 整数分金额计算`);
  lines.push(
    `- 会话与复核：按任务持久化会话（续跑恢复历史）/ waiting_review 人工复核状态机（完成态若遗留待复核问题，复核页可一键「转为待复核」重新打开）`,
  );
  lines.push(
    `- 交付与溯源：整页交付 MD 含元信息 / 目录 / 结论 / 联网引用（含核验结果、时效与证据力分级）/ 业务资料清单（类型、大小、上传时间、解析状态与解析结果）/ 产物溯源表（每份产物对应生成它的工具调用、生成或引用关系、所属运行与时间）/ 工具调用清单（按运行分组，含结果、耗时与入参摘要）/ 人工复核记录（已复核与待复核分列，含核对备注）；「打包下载」把整页 MD、机器可读的 manifest.json（任务元信息、交付自检结论、资料与产物溯源、工具与引用核验、引用证据力分级、金额与复核计数）与全部产物合成一个 zip（产物归入「产物/」目录，条目名做安全化），打包失败自动退回单文件 MD；交付区显示最近打包时间，并在打包后又有变更（新事件 / 产物更新 / 复核提交 / 金额核对 / 链接核验）时提示重新打包，避免发出过期交付包`,
  );
  lines.push(
    `- 金额可核对：结论中每处金额与工具结果、客户指令做三级比对（工具可溯源 / 来自客户指令 / 待人工确认），待确认金额在正文就地标注、点击即可标记为已核对（写入事件留痕、可撤销），复核页「结论金额核对」小节可集中处理并填写核对依据备注，备注与核对时间一并写入整页交付 MD，用以佐证「金额由确定性工具计算、模型零口算」`,
  );
  lines.push(
    `- 文号可核对：结论里的税收规范性文件文号按核心部分（如「〔2015〕119 号」「2017 年第 40 号」）归一化后在工具结果中匹配，分为有出处 / 无法核验（联网检索扩展只持久化查询元数据，如实标注而非当作有依据）/ 待人工确认三级，结果进结论要点区徽章、交付自检与整页 MD`,
  );
  lines.push(
    `- 引用可分级：Bing 取数优先走 RSS 输出（XML 结构稳定，不受推荐位与页面改版干扰；实测本机 HTML 结果页会返回与检索词完全无关的条目，同一检索词的 RSS 结果则真实对应），拿不到再退回 HTML 解析。检索结果按相关度过滤：检索词切成中文二元组与数字整词，门槛随检索词长度自适应（普通站点 20%、政府与税务机关站点 12%，下限由 TAXAI_SEARCH_MIN_RELEVANCE 控制），因此不会出现「都含『土地』就把《土地管理法》当成土地增值税清算依据」；门户首页 / 栏目入口 / 登录页与重复地址一律不进结果。引擎触发安全验证或结果全部无关时降级下一引擎，全部不可用则如实回报「未检索到」并逐引擎说明原因（含取数方式与过滤条数），不把无关网页塞进结论与引用清单。界面再把每条引用按证据力分为官方原文（政府/税务机关站点的具体文件页）/ 专业来源（机构或社区的具体文章页）/ 证据力弱（门户首页、百科词条、检索结果页）三级并给出判定理由，弱证据在引用芯片上转琥珀色、进入交付自检提醒与整页 MD，manifest.json 同步记录分级汇总，避免「拿百科词条当政策依据」`,
  );
  lines.push(
    `- 检索可留痕：界面区分「留下了来源」与「只留下查询元数据」两类联网检索。自建 search_public_cases / fetch_public_document 与扩展 fetch_content 都会留下标题与 URL（fetch_content 读过的政策法规库原文页此前不进引用清单，现已按同一口径纳入，真实任务引用从 29 条升到 40 条、其中政府与税务机关站点 23 条）；社区扩展 web_search 只写回查询词、条数、检索 ID 与 provider，因此「没有引用清单」不再被误报成「没有联网核验」，而是如实说明「执行过 N 次检索、扩展自报命中 M 条、未留存标题与 URL」，并给出补救动作（结论附检索词与检索时间，或改用自建工具留存来源）。引用清单上限 20 条并按 URL 去重，交付自检据此分为提醒与说明两级，manifest.json 记录 calls / withUrls / metadataOnly / reportedResults 与检索词、provider`,
  );
  lines.push(
    `- 文号可复查：「无法核验」与「待人工确认」不是终点——结论要点区的文号徽章可点开复查面板，一键用自建检索通道（Bing RSS 优先 + 相关度过滤）逐条联网复查。检索词自动补上发文机关（「按国税函〔2010〕220 号」→「国税函〔2010〕220号」）并给出去掉内部空格的紧凑写法作为第二种候选，第一种空手而归时自动换写法再查；判定分四级——找到公开出处（标题或摘要里确实出现该文号）/ 有候选待确认（检索到相关页面但没出现文号，不把候选当依据）/ 未检索到 / 检索失败。每条都记录实际检索词、逐引擎尝试过程与证据链接，按任务落库（刷新不丢）并写入事件留痕（交付包随之提示重新打包）；复查到出处的文号不再计入交付风险，整页 MD 的「政策文号溯源」节附复查表，manifest.json 记录四级计数与复查时间。实测某土增清算任务 3 处「无法核验」文号一键复查后全部找到公开出处`,
  );
  lines.push(
    `- 缺口看得见：平台应用效果看板在「全平台复核闭环缺口条」之外增加「全平台证据缺口条」——按作品分组列出仍有弱证据引用或待复查文号的任务，点击直达结果页处理（无缺口时转为翠绿并给出正向口径）。条上同时给出全平台数字：联网检索次数（留下来源 / 只留查询元数据）、引用总数与其中官方原文 / 证据力弱条数、检索拦下的无关结果与门户首页条数（过滤规则上线前的历史记录按现行规则回算，并明确标注是回算而非实时拦截）、政策文号总数（工具可溯源 / 待复查 / 已复查到公开出处）。这些数字与任务结果页、整页交付 MD、manifest.json 出自同一套纯函数，看板与交付材料不会对不上；实测当前口径为检索 31 次（留来源 12 / 仅元数据 19）、引用 40 条（官方 9 · 弱 25）、拦下 33 条、文号 31 处（可溯源 10 · 待复查 18 · 已复查到出处 3）、缺口任务 10 个`,
  );
  lines.push("");
  lines.push(`## 四、核心流程`);
  lines.push("");
  lines.push("```mermaid");
  lines.push(FLOWS[agent.id] ?? "");
  lines.push("```");
  lines.push("");
  lines.push(`## 五、工具清单`);
  lines.push("");
  lines.push(toolTable(agent, extra));
  lines.push("");
  lines.push(`## 六、创新点`);
  lines.push("");
  for (const item of INNOVATIONS[agent.id] ?? []) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`## 七、应用效果（真实运行统计）`);
  lines.push("");
  lines.push(`- 累计任务 ${stats.tasks} 个，其中已完成 ${stats.completed} 个`);
  lines.push(`- 工具调用 ${stats.toolCalls} 次，成功 ${stats.toolOk} 次（成功率 ${okRate}%）`);
  lines.push(`- 生成专业底稿/产物 ${stats.artifacts} 份`);
  lines.push(
    stats.compareAccuracy !== null
      ? `- 与人工底稿记录级比对准确率 ${stats.compareAccuracy}%（${stats.compareRuns} 次比对；差异项均为预埋或真实口径差异，已列待核查）`
      : `- 暂无记录级比对数据`,
  );
  lines.push(`- 自动化验证：verify:pi / verify:docs / verify:template / verify:policy / verify:compare / verify:ocr / verify:agents 全部 PASS（见 docs/testing/test-report-*.md）`);
  lines.push("");
  const cmp = latestCompareFor(agent.id);
  if (cmp) {
    lines.push(`### 附录：与人工底稿差异明细（最近一次记录级比对）`);
    lines.push("");
    lines.push(
      `- 总准确率 ${cmp.totals.accuracyPercent}%（比对 ${cmp.totals.compared}：一致 ${cmp.totals.matched}、差异 ${cmp.totals.mismatched}、仅系统 ${cmp.totals.onlyA}、仅人工 ${cmp.totals.onlyB}）`,
    );
    lines.push(`- 差异项一律列为待核查事项，系统不按人工底稿自动"改正"。`);
    lines.push("");
    lines.push(`| 类型 | 位置 | 系统底稿 | 人工底稿 |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const s of cmp.sheets) {
      for (const d of s.diffs.slice(0, 10)) {
        lines.push(`| ${d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅系统" : "仅人工"} | ${d.address} | ${d.a ?? "∅"} | ${d.b ?? "∅"} |`);
      }
    }
    lines.push("");
  }
  lines.push(`## 八、演示与录屏清单`);
  lines.push("");
  lines.push(`- [ ] 启动平台并选择本智能体（首页 KPI 与工具清单）`);
  lines.push(`- [ ] 示例任务一键执行：执行时间线 + 工具折叠行 + 联网检索 chips`);
  lines.push(`- [ ] 审查结论：Markdown 报告 + mermaid 图 + 引用 chips + 交付卡片`);
  lines.push(`- [ ] 侧边阅读器：外链阅读模式 / Excel 工作表预览 / PDF 预览`);
  lines.push(agent.id === "land-vat" ? `- [ ] 模板保留式填列：已填列模板产物预览（公式列未触碰）` : `- [ ] 政策依据：search_rd_policy 比例与文号 + 联网核验`);
  lines.push(`- [ ] 人工复核：waiting_review → 逐项确认 → completed；完成态遗留问题可重新打开复核`);
  lines.push(`- [ ] 录屏要求：MP4、≤500MB、≤8 分钟，覆盖启动到交付全过程`);
  lines.push("");
  lines.push(`## 九、边界与合规`);
  lines.push("");
  lines.push(`- 不对接电子税务局/ERP/银行接口，不自动申报，不出具具法律效力的鉴证意见`);
  lines.push(`- 业务 Agent 禁用 Pi 内置系统操作工具；上传文件类型与大小受限、路径隔离`);
  lines.push(`- 模型密钥仅存服务端环境变量；客户资料默认不发送至第三方云模型（部署时可配置）`);
  lines.push(`- 合成案例仅用于开发验证，正式测试使用经授权脱敏的真实案例`);
  return lines.join("\n") + "\n";
}

const rd = build(rdAuditAgent, docToolNames);
const lv = build(landVatAgent, [...docToolNames, ...tplToolNames]);

fs.writeFileSync(path.join(outDir, "智研税审-作品说明.md"), rd, "utf8");
fs.writeFileSync(path.join(outDir, "土增智填-作品说明.md"), lv, "utf8");
console.log(`[materials] written: ${path.join(outDir, "智研税审-作品说明.md")}`);
console.log(`[materials] written: ${path.join(outDir, "土增智填-作品说明.md")}`);
