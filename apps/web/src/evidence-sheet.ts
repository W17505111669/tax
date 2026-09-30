/**
 * 证据核对表：把散在结果页各处的证据口径汇总成一页可打印、可签字的核对清单。
 *
 * 交付时税务师要回答的其实就九个问题——文号有没有出处、复查过没有、引用是不是官方原文、
 * 弱证据找到替代来源没有、链接还活着吗、检索留没留痕、金额能不能溯源、这次修订改好了没、
 * 现在能不能交付。这一节把这九项连同「还没闭环的具体条目」排成一张表，
 * 界面与整页交付 MD 共用同一份生成逻辑，纸质交付不必翻整份材料。
 *
 * 纯函数，便于 apps/api/scripts/verify-evidence-sheet.ts 直接校验。
 */

import { mdCell } from "./run-tools.ts";

export type SheetInput = {
  taskTitle: string;
  caseId: string;
  agentName: string;
  statusText: string;
  generatedAt: string;
  delivery: { verdict: string; blocks: number; warns: number; infos: number };
  /** 政策文号溯源：total = traced + unverifiable + untraced；pending 为复查后仍无出处的处数 */
  docRefs: { total: number; traced: number; unverifiable: number; untraced: number; pending: number };
  docRefChecks: {
    total: number;
    matched: number;
    candidate: number;
    empty: number;
    error: number;
    checkedAt: string | null;
  };
  citations: {
    total: number;
    official: number;
    professional: number;
    weak: number;
    fromTools: number;
    fromConclusion: number;
    /** 弱证据中已找到官方替代来源、待人工写回结论的条数 */
    replaced: number;
    /** 弱证据中已在结论里声明「仅作背景参考，不作为政策依据」的条数，不再是待办 */
    disclaimed?: number;
    /** 弱证据中只在检索留存里、从未进入结论正文的条数：不是交付依据，也不再是待办 */
    uncited?: number;
  };
  citationChecks: { total: number; matched: number; candidate: number; empty: number; error: number };
  linkCheck: {
    total: number;
    ok: number;
    blocked: number;
    dead: number;
    unreachable: number;
    checkedAt: string | null;
  } | null;
  searches: { calls: number; withUrls: number; metadataOnly: number; dropped: number } | null;
  amounts: { total: number; traced: number; fromInput: number; pending: number; acked: number };
  revision: { verdict: string; detail: string } | null;
  /** 还没闭环的具体条目，用于表末的待办清单 */
  todos: { docRefs: string[]; weakCitations: string[]; deadLinks: string[] };
};

export type SheetRow = { item: string; value: string; note: string };

function stamp(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

/** 九项核对结论：每项一句可核对的值 + 一句说明（口径与结果页、交付自检完全一致） */
export function evidenceSheetRows(i: SheetInput): SheetRow[] {
  const rows: SheetRow[] = [];
  const d = i.docRefs;
  rows.push({
    item: "政策文号溯源",
    value: `有出处 ${d.traced}/${d.total}`,
    note:
      d.total === 0
        ? "结论中没有出现税收规范性文件文号"
        : `无法从留存数据核验 ${d.unverifiable} · 待人工确认 ${d.untraced} · 复查后仍无出处 ${d.pending}`,
  });
  const rc = i.docRefChecks;
  rows.push({
    item: "政策文号联网复查",
    value: rc.total === 0 ? "未复查" : `找到公开出处 ${rc.matched}/${rc.total}`,
    note:
      rc.total === 0
        ? d.pending === 0
          ? "文号都能在工具结果中找到出处，无需复查"
          : `尚有 ${d.pending} 处没有出处，可在文号复查面板一键联网复查`
        : `候选待确认 ${rc.candidate} · 未检索到 ${rc.empty} · 检索失败 ${rc.error}${
            rc.checkedAt ? ` · 最近复查 ${stamp(rc.checkedAt)}` : ""
          }`,
  });
  const c = i.citations;
  rows.push({
    item: "联网引用证据力",
    value: c.total === 0 ? "无联网引用" : `官方来源 ${c.official}/${c.total}`,
    note:
      c.total === 0
        ? "结论未引用联网来源，涉及政策依据请确认是否已完成在线核验"
        : `专业来源 ${c.professional} · 证据力弱 ${c.weak}${
            c.disclaimed ? `（其中 ${c.disclaimed} 条已在结论中声明为背景参考，不作为依据）` : ""
          }${c.uncited ? `（${c.uncited} 条只在检索留存里、未进入结论正文）` : ""}${
            c.replaced > 0 ? `（${c.replaced} 条已找到官方替代来源，待人工写回结论）` : ""
          } · 来源：工具留存 ${c.fromTools} / 结论正文 ${c.fromConclusion}`,
  });
  const cc = i.citationChecks;
  rows.push({
    item: "弱证据替代来源检索",
    value: cc.total === 0 ? "未检索" : `找到官方原文 ${cc.matched}/${cc.total}`,
    note:
      cc.total === 0
        ? Math.max(0, c.weak - (c.disclaimed ?? 0) - (c.uncited ?? 0)) > 0
          ? `尚有 ${Math.max(0, c.weak - (c.disclaimed ?? 0) - (c.uncited ?? 0))} 条弱证据引用待处置，可在联网引用区一键检索官方替代来源`
          : "没有证据力弱的引用，无需检索替代来源"
        : `候选待确认 ${cc.candidate} · 未找到 ${cc.empty + cc.error}（替代来源需人工确认后写回结论并重新打包）`,
  });
  const l = i.linkCheck;
  rows.push({
    item: "引用链接可达性",
    value: l === null ? "未核验" : `可访问 ${l.ok}/${l.total}`,
    note:
      l === null
        ? "点「核验链接」可按需核验（服务端 GET、8 秒超时、不下载正文，结果落库）"
        : `失效 ${l.dead} · 拒绝自动访问 ${l.blocked} · 无法核验 ${l.unreachable}${
            l.checkedAt ? ` · 最近核验 ${stamp(l.checkedAt)}` : ""
          }`,
  });
  const s = i.searches;
  rows.push({
    item: "联网检索留痕",
    value: s === null ? "无检索调用" : `检索 ${s.calls} 次`,
    note:
      s === null
        ? "本任务没有联网检索类工具调用"
        : `留下可引用来源 ${s.withUrls} 次 · 只留查询元数据 ${s.metadataOnly} 次 · 拦下无关结果与门户首页 ${s.dropped} 条`,
  });
  const a = i.amounts;
  rows.push({
    item: "结论金额溯源",
    value: a.total === 0 ? "结论未出现金额" : `可溯源 ${a.traced + a.fromInput}/${a.total}`,
    note:
      a.total === 0
        ? "本次结论没有金额，测算类结论请确认是否遗漏"
        : `工具结果 ${a.traced} · 客户指令 ${a.fromInput} · 待人工确认 ${a.pending}（已人工核对 ${a.acked}）`,
  });
  rows.push({
    item: "本次修订对证据的影响",
    value: i.revision === null ? "无可对比轮次" : i.revision.verdict,
    note:
      i.revision === null
        ? "只运行过一次，或上一轮没有留下结论"
        : `${i.revision.detail}（口径：只比结论正文，不含跨运行累积的工具留存）`,
  });
  rows.push({
    item: "交付自检",
    value: i.delivery.verdict,
    note: `阻断 ${i.delivery.blocks} 项 · 提醒 ${i.delivery.warns} 项 · 说明 ${i.delivery.infos} 项`,
  });
  return rows;
}

export type SheetTodoGroup = { label: string; list: string[] };

/** 待办分组：界面与整页 MD 共用，避免两处各写一套分组与文案 */
export function evidenceSheetTodoGroups(i: SheetInput): SheetTodoGroup[] {
  return [
    { label: "仍无出处、需复查或人工确认的政策文号", list: i.todos.docRefs },
    { label: "待替换为官方原文的弱证据引用", list: i.todos.weakCitations },
    { label: "已失效、需替换或补充依据的链接", list: i.todos.deadLinks },
  ].filter((g) => g.list.length > 0);
}

/** 没有待办时的结论文案（界面与 MD 同一句） */
export const NO_TODO_TEXT =
  "无待办：文号有出处或已复查到公开出处，引用中没有门户首页与百科词条，链接无失效";

/** 待办清单的 Markdown 行（每组最多列 limit 条，超出写「等 N 项」） */
export function evidenceSheetTodos(i: SheetInput, limit = 8): string[] {
  const groups = evidenceSheetTodoGroups(i);
  if (groups.length === 0) return [`- ${NO_TODO_TEXT}`];
  const out: string[] = [];
  for (const g of groups) {
    out.push(`- ${g.label}（${g.list.length} 项）：`, ...g.list.slice(0, limit).map((x) => `  - ${x}`));
    if (g.list.length > limit) {
      out.push(`  - 等 ${g.list.length} 项，完整清单见「政策文号溯源」与「联网引用」两节`);
    }
  }
  return out;
}

/** 整页交付 MD 里的「证据核对表」一节 */
export function evidenceSheetMarkdown(i: SheetInput): string[] {
  const lines = [
    `- 任务：${i.taskTitle}　案例：${i.caseId}　智能体：${i.agentName}　状态：${i.statusText}`,
    `- 生成时间：${stamp(i.generatedAt) || i.generatedAt}`,
    "",
    "| # | 核对项 | 结论 | 说明 |",
    "| --- | --- | --- | --- |",
  ];
  evidenceSheetRows(i).forEach((r, n) => {
    lines.push(`| ${n + 1} | ${mdCell(r.item)} | ${mdCell(r.value)} | ${mdCell(r.note)} |`);
  });
  lines.push("", "**交付前待办**", "");
  lines.push(...evidenceSheetTodos(i));
  lines.push("", `- 核对人：＿＿＿＿＿＿　日期：＿＿＿＿＿＿（本表由平台按真实运行数据生成，口径与界面一致）`);
  return lines;
}

/**
 * 单页文档：核对表单独导出时用（整页交付 MD 里用的是不带 H1 的 evidenceSheetMarkdown）。
 * 纸质归档常常只需要这一页，不必打印整份材料。
 */
export function evidenceSheetDocument(i: SheetInput): string[] {
  return ["# 证据核对表", "", ...evidenceSheetMarkdown(i)];
}
