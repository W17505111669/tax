/**
 * Phase 1 验证脚本：确认两个 Agent 真正独立。
 * 检查项：系统提示词不同、工具集不重叠、会话中实际启用的工具与配置一致。
 * 运行：pnpm verify:agents
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRuntimeConfig,
  createTaxAgentSession,
  readPromptFile,
  MAX_RETAINED_TEXT,
  TEXT_EVIDENCE_TOOLS,
  withRetainedText,
} from "@tax/agent-core";
import { SEARCH_TOOL_NAMES } from "../../web/src/search-evidence.ts";
import { resolveCommunityExtensions } from "../src/extensions.ts";
import rdAuditAgent from "@tax/agent-rd-audit";
import landVatAgent from "@tax/agent-land-vat";

const cfg = loadRuntimeConfig();
cfg.extensionPaths = [...cfg.extensionPaths, ...resolveCommunityExtensions()];
console.log("[verify] 社区扩展:", cfg.extensionPaths.join(", ") || "(未解析到)");
const agents = [rdAuditAgent, landVatAgent];

// 业务工具必须互不重叠；sharedTools 属共用基础设施，允许同时出现在两个 Agent 中
const rdTools = new Set(rdAuditAgent.tools.map((t) => t.name));
const lvTools = new Set(landVatAgent.tools.map((t) => t.name));
const sharedNames = new Set((rdAuditAgent.sharedTools ?? []).map((t) => t.name));
const overlap = [...rdTools].filter((n) => lvTools.has(n));

console.log("[verify] 智研税审工具:", [...rdTools].join(", "));
console.log("[verify] 土增智填工具:", [...lvTools].join(", "));
console.log("[verify] 工具集重叠:", overlap.length === 0 ? "无（符合独立性要求）" : overlap.join(", "));
console.log("[verify] 系统提示词是否不同:", rdAuditAgent.systemPrompt !== landVatAgent.systemPrompt);

let pass = overlap.length === 0 && rdAuditAgent.systemPrompt !== landVatAgent.systemPrompt;

for (const agent of agents) {
  const expected = [...(agent.sharedTools ?? []), ...agent.tools].map((t) => t.name).sort();
  const session = await createTaxAgentSession({
    agent,
    cfg,
    cwd: process.cwd(),
    onEvent: () => {},
  });
  const active = session.tools;
  const actual = [...active].sort();
  // 会话工具应包含全部业务/共用工具，社区扩展工具为额外增量
  const same = expected.every((name) => actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  const noBuiltin = !actual.some((n) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(n));
  console.log(`[verify] ${agent.shortName} 会话工具: ${actual.join(", ") || "(无)"} | 含全部业务工具=${same} | 扩展增量=${extra.join(",") || "(无)"} | 已禁用内置编码工具=${noBuiltin}`);
  pass = pass && same && noBuiltin;
  session.dispose();
}

const failures: string[] = [];
// 检查项数由计数器给出，不再手写公式：上一版公式在新断言加进来后仍然报旧数字，
// 「检查项=27 失败=0」看着像跑了 27 项，实际跑的比这多——计数失真和没断言一样危险
let checks = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}
function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 留存正文的工具名单必须与前端引用提取／检索统计用的名单一致：一边决定「存不存正文」，
// 另一边决定「认不认这是联网调用」，两份名单漂移就会出现存了不用、或用没存的数据
expect(
  "TEXT_EVIDENCE_TOOLS 与 SEARCH_TOOL_NAMES 完全一致",
  [...TEXT_EVIDENCE_TOOLS].sort(),
  [...SEARCH_TOOL_NAMES].sort(),
);

// 正文留存：只对联网类工具生效，原有元数据保留，截断量如实记录
const BODY = "其他相关费用限额按全部研发项目统一计算。".repeat(4);
const merged = withRetainedText("fetch_public_document", { url: "https://x.gov.cn/a", charCount: 30 }, BODY) as Record<
  string,
  unknown
>;
ok("联网工具的结果里补上了留存正文", merged.retainedText === BODY);
ok("原有元数据字段一个不少", merged.url === "https://x.gov.cn/a" && merged.charCount === 30);
expect("留存字符数与截断量如实记录", [merged.retainedChars, merged.omittedChars], [BODY.length, 0]);
const nonWeb = withRetainedText("calculate_rd_adjustment", { deductionYuan: "1.00" }, BODY) as Record<string, unknown>;
ok("非联网工具不留存正文（避免无谓膨胀）", nonWeb.retainedText === undefined);
ok("空正文不凭空造字段", (withRetainedText("web_search", { a: 1 }, "") as Record<string, unknown>).retainedText === undefined);
const long = "字".repeat(MAX_RETAINED_TEXT + 500);
const capped = withRetainedText("get_search_content", null, long) as Record<string, unknown>;
expect("超长正文按上限截断，且省略号不计入留存字符数", [capped.retainedChars, capped.omittedChars], [
  MAX_RETAINED_TEXT,
  500,
]);
ok("details 为空时也能单独留存正文", typeof capped.retainedText === "string");

// 撞名不覆盖：联网扩展自己截断返回内容时也写 `omittedChars`（实测 web_search 的 details 里有
// truncated / originalChars / returnedChars / omittedChars，两条共 14831 字），我们这一层再展开一次
// 就会把工具那一层的数字盖掉——实测 29443fec 那条 fetch_content 就是这么丢的，两层截断只剩一层看得见。
const clash = withRetainedText(
  "web_search",
  { truncated: true, originalChars: 36918, returnedChars: 30173, omittedChars: 6745 },
  "字".repeat(MAX_RETAINED_TEXT + 100),
) as Record<string, unknown>;
expect("我们这一层的截断量写进 omittedChars", clash.omittedChars, 100);
expect("工具那一层的截断量原样保留在 toolOmittedChars", clash.toolOmittedChars, 6745);
ok(
  "工具自报的其余字段一个不少",
  clash.truncated === true && clash.originalChars === 36918 && clash.returnedChars === 30173,
);
ok(
  "没撞名时不凭空造 toolOmittedChars",
  (withRetainedText("web_search", { a: 1 }, BODY) as Record<string, unknown>).toolOmittedChars === undefined,
);

// 系统提示词必须是惰性 getter。在模块顶层 readFileSync 会让「改完 .md 不重启就不生效」，而且
// 没有任何提示——实测 API 进程 23:07:31 启动、两份 system-prompt.md 23:28 才改，之后跑的仍是
// 21 分钟前的旧提示词（tsx watch 盯的是 import 图，readFileSync 读的 .md 不在里面）。
for (const agent of agents) {
  const desc = Object.getOwnPropertyDescriptor(agent, "systemPrompt");
  ok(
    `${agent.shortName} 的 systemPrompt 是 getter（改完 .md 下个任务即生效，不必重启）`,
    typeof desc?.get === "function",
  );
  ok(
    `${agent.shortName} 的提示词确实读到了内容`,
    (agent.systemPrompt ?? "").trim().length > 200,
    `${(agent.systemPrompt ?? "").length} 字`,
  );
}

// 缓存按 mtime + 大小失效：只比 mtime 时，同一毫秒内改写可能分辨不出来
const tmpPrompt = path.join(os.tmpdir(), `taxai-prompt-cache-${process.pid}.md`);
const V2 = "第二版（内容更长，确保大小也变了）";
fs.writeFileSync(tmpPrompt, "第一版");
ok("首次读取拿到内容", readPromptFile(tmpPrompt) === "第一版");
ok("未修改时重复读取内容一致（走缓存）", readPromptFile(tmpPrompt) === "第一版");
fs.writeFileSync(tmpPrompt, V2);
ok("文件改动后再次读取拿到新内容", readPromptFile(tmpPrompt) === V2);
fs.rmSync(tmpPrompt, { force: true });

// 照着 7 条真实工具失败写进提示词的约束不能被悄悄删掉：其中 3 条是模型猜错 get_search_content
// 的参数组合、1 条是拿 file:// 本地路径去调远程抓取，都属于「提示词能治」的那一类
const PROMPT_RULES: Array<[string, string]> = [
  ["get_search_content 必须带 responseId", "responseId"],
  ["定位参数四选一（urlIndex）", "urlIndex"],
  ["定位参数四选一（queryIndex）", "queryIndex"],
  ["findText 是过滤器不是定位参数", "不能用来定位"],
  ["findText 不得传 JSON 字符串化的数组", "JSON.stringify"],
  ["两种误用的报错原文（便于模型自查）", "No URL specified"],
  ["禁止拿 file:// 本地路径远程抓取", "file://"],
  ["本地上传资料改用 parse_uploaded_files", "parse_uploaded_files"],
  ["HTTP 404 的处置", "HTTP 404"],
  ["HTTP 412 的处置与自有通道兜底", "HTTP 412"],
];
for (const [name, needle] of PROMPT_RULES) {
  for (const agent of agents) {
    ok(`${agent.shortName} 提示词含「${name}」`, agent.systemPrompt.includes(needle));
  }
}

console.log(`[verify] 提示词惰性加载 / 联网约束 / 正文留存 检查项=${checks} 失败=${failures.length}`);
for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
pass = pass && failures.length === 0;

console.log(pass ? "\n[PASS] 两个 Agent 相互独立，且未启用 Pi 内置系统操作工具。" : "\n[FAIL] Agent 独立性验证未通过。");
process.exitCode = pass ? 0 : 1;
