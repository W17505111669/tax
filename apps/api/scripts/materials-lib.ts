/** 比赛材料共享内容：背景/目标/创新点/流程图与真实运行统计，供作品说明与 PPT 大纲生成器复用。 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { BATCH_REF_BUDGET, BATCH_REF_MAX } from "../src/services/ref-checks.ts";
import { compareRates, rateText } from "@tax/document-tools";

/**
 * 作品说明里引用的那串全平台实测数字，直接取自 computePlatformStats。
 *
 * 原先这些数字写死在散文里（「检索 31 次…文号 31 处（可溯源 10 · 待复查 18）」），
 * 而同一句话承诺的恰恰是「看板与交付材料不会对不上」——平台口径一改，交付材料就成了反例。
 * 生成时取数，文档才可能永远与看板同源。
 */
export function evidenceSnapshotText(): string {
  const ev = computePlatformStats().evidence;
  return [
    `检索 ${ev.searchCalls} 次（留来源 ${ev.searchWithUrls} / 仅元数据 ${ev.searchMetadataOnly}）`,
    `引用 ${ev.citations} 条（官方 ${ev.officialCitations} · 弱 ${ev.weakCitations}${
      ev.weakDisclaimed > 0 ? `，其中 ${ev.weakDisclaimed} 条已在结论中声明为背景参考、不作为依据` : ""
    }）`,
    `拦下 ${ev.searchDropped + ev.searchDroppedReplay} 条`,
    `文号 ${ev.docRefs} 处（有出处 ${ev.docRefTraced}，其中复查取得 ${ev.docRefTracedByRecheck} · 待复查 ${ev.docRefPending} · 复查判定 matched ${ev.docRefMatched}）`,
    `缺口任务 ${ev.gaps.length} 个`,
  ].join("、");
}

/**
 * 文号复查的当前口径，与看板同源、生成时取数。
 *
 * 这一串数字曾以「实测一次点按覆盖 4 个任务 12 处文号：找到公开出处 9 处、候选待确认 1 处、
 * 未检索到 2 处，平台口径随即从待复查 18 变为 12」的形式写死在作品说明里，而平台口径随后就变了
 *（待复查一路降到 0），写死的那句立刻成了同一份文档里的反例——上一行还承诺「看板与交付材料不会对不上」。
 */
export function docRefSnapshotText(): string {
  const ev = computePlatformStats().evidence;
  return `文号 ${ev.docRefs} 处（有出处 ${ev.docRefTraced}，其中复查取得 ${ev.docRefTracedByRecheck} · 待复查 ${ev.docRefPending} · 复查判定 matched ${ev.docRefMatched}）`;
}

/**
 * 批量复查的预算口径：直接取服务端的真常量，文档里不写死数字。
 * 常量一改文档自动跟着改，不会出现「说明写 12 处、代码已经改成 20 处」。
 */
export function batchBudgetText(): string {
  return `默认 ${BATCH_REF_BUDGET} 处、硬上限 ${BATCH_REF_MAX} 处`;
}
export const BACKGROUND: Record<string, string> = {
  "rd-audit":
    "面向企业研发费用加计扣除专项审查业务。事务所需要从研发项目资料、费用辅助账和企业财务记录中识别关键业务信息，检查费用归集情况，结合税收政策形成专业审查意见。传统方式下资料来源分散、辅助账与财务账需人工核对、不同费用类型涉及不同归集要求、专项审查底稿编制工作量大。",
  "land-vat":
    "面向土地增值税清算过程中工作底稿的资料采集、数据匹配与自动填列环节。事务所需要阅读工程合同提取关键条款、逐张查看发票、在账簿中寻找对应业务记录、建立合同-发票-账簿对应关系并核对金额后填入 Excel 底稿。一份合同对应多张发票和多笔账面记录时，人工处理容易出现重复、遗漏或错误匹配。",
};

export const GOALS: Record<string, string[]> = {
  "rd-audit": [
    "研发项目资料与辅助账的结构化解析与信息提取",
    "辅助账与财务明细账的账账比对、差异与缺失识别",
    "按费用年度与企业类型确定性确认加计扣除比例及政策依据",
    "其他相关费用限额与加计扣除额的程序化测算（整数分计算）",
    "专项审查底稿生成、与人工底稿比对、税务师复核闭环",
  ],
  "land-vat": [
    "工程合同、发票、账簿的结构化解析",
    "一对一/一对多关联匹配与金额一致性核验",
    "歧义与差异事项的人工确认闭环",
    "事务所原始 Excel 模板的保留式自动填列（公式/合并/样式不破坏）",
    "已填列底稿与人工底稿的逐格比对与准确率输出",
  ],
};

export const INNOVATIONS: Record<string, string[]> = {
  "rd-audit": [
    "金额零口算：限额、基数、加计额全部由 TypeScript 工具以整数分确定性计算，模型只解释不计算",
    "政策双保险：本地版本化政策快照给出比例与文号，正式引用前强制联网核验并记录核验时间",
    "证据链贯穿：每项结论可追溯到文件、记录、字段与工具执行记录",
    "复核状态机：存在待复核问题时任务进入 waiting_review，税务师逐项确认后才流转为已完成；问题清单由工具结果实时提取，若完成后才发现遗留问题，复核页「转为待复核」可重新打开复核",
    "交付可签字：结果页一页「证据核对表」把九项证据口径收成可签字的一页（含交付前待办与核对人签字行），平台层再给一张全平台证据核对台账并可导出 MD/CSV，文号无出处、证据力弱、金额待确认逐项列明，不填占位数字",
  ],
  "land-vat": [
    "映射式填列：模型只给表头列名与数据行，地址定位/金额换算/公式避让由工具确定性完成",
    "保留式写盘：在模板副本上写入，公式、合并单元格与样式零破坏，原始模板 sha256 校验不变",
    "记录级比对：跨版式底稿按表头与主键对齐逐格比对，输出可直接入测试报告的准确率",
    "异常不认定：差异只形成待核查事项并给出可能原因，不直接认定企业申报错误",
    "交付可签字：清算底稿与填列结果附一页「证据核对表」（含交付前待办与核对人签字行），平台层再给一张全平台证据核对台账并可导出 MD/CSV，扣除项目金额与政策依据的欠账逐项列明，不填占位数字",
  ],
};

export const FLOWS: Record<string, string> = {
  "rd-audit": `flowchart TD
  A["上传研发项目资料/辅助账/财务明细"] --> B["parse_uploaded_files 结构化解析"]
  B --> C["check_rd_expenses 账账比对与缺失识别"]
  C --> D["search_rd_policy 政策适用与比例确认"]
  D --> E["calculate_rd_adjustment 确定性测算"]
  E --> F{"存在待复核问题?"}
  F -->|是| G["waiting_review 税务师复核"]
  G --> H["generate_workpaper 专项审查底稿"]
  F -->|否| H
  H --> I["compare_workpapers 与人工底稿比对"]
  I --> J["交付：底稿/引用清单/测试报告"]`,
  "land-vat": `flowchart TD
  A["上传合同/发票/账簿/原始模板"] --> B["parse_uploaded_files 结构化解析"]
  B --> C["match_contract_invoice 合同发票关联"]
  C --> D["match_invoice_ledger 发票账簿匹配"]
  D --> E["check_amount_consistency 金额核验"]
  E --> F{"存在歧义或差异?"}
  F -->|是| G["waiting_review 人工确认"]
  G --> H["inspect_workpaper_template 模板结构检查"]
  F -->|否| H
  H --> I["fill_land_vat_workpaper 映射式保留填列"]
  I --> J["compare_workpapers 与人工底稿比对"]
  J --> K["交付：已填列模板/差异清单/测试报告"]`,
};

export interface Stats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  /** 最近一次记录级比对的构成与两个拆分比率：总准确率会把「填错」与「范围没对上」混成一个数 */
  compareMatched: number;
  compareMismatched: number;
  compareOnlyA: number;
  compareOnlyB: number;
  compareMatchRate: number | null;
  compareCoverage: number | null;
}

export function statsFor(agentId: string): Stats {
  const tasks = db.prepare(`SELECT id, status FROM tasks WHERE agent_id = ?`).all(agentId) as unknown as Array<{
    id: string;
    status: string;
  }>;
  let toolCalls = 0;
  let toolOk = 0;
  let artifacts = 0;
  let compareAccuracy: number | null = null;
  let compareRuns = 0;
  let compareAt = "";
  let compareMatched = 0;
  let compareMismatched = 0;
  let compareOnlyA = 0;
  let compareOnlyB = 0;
  let compareMatchRate: number | null = null;
  let compareCoverage: number | null = null;
  for (const t of tasks) {
    const calls = db.prepare(`SELECT ok, tool_name, result, started_at FROM tool_calls WHERE task_id = ?`).all(t.id) as unknown as Array<{
      ok: number | null;
      tool_name: string;
      result: string | null;
      started_at: string | null;
    }>;
    toolCalls += calls.length;
    toolOk += calls.filter((c) => c.ok === 1).length;
    const dir = path.join(dirs.outputs, t.id);
    if (fs.existsSync(dir)) artifacts += fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length;
    for (const c of calls) {
      if (c.tool_name !== "compare_workpapers" || c.ok !== 1 || !c.result) continue;
      try {
        const parsed = JSON.parse(c.result) as {
          sheets?: Array<{ mode?: string }>;
          totals?: {
            accuracyPercent?: number;
            matched?: number;
            mismatched?: number;
            onlyA?: number;
            onlyB?: number;
          };
        };
        if (parsed.sheets?.[0]?.mode === "record" && parsed.totals?.accuracyPercent !== undefined) {
          compareRuns += 1;
          // 「最近一次」按调用开始时间判定，与平台看板同一口径。早先按遍历顺序取最后一条，
          // 实测取到的是 09-28 的旧比对（2 项 / 一致 1）而不是 09-29 的最新一次（3 项 / 一致 2），
          // 于是作品说明写的准确率与看板上的对不上——正是本文档反复承诺不会发生的事。
          const at = String(c.started_at ?? "");
          if (at < compareAt) continue;
          compareAt = at;
          compareAccuracy = parsed.totals.accuracyPercent;
          compareMatched = parsed.totals.matched ?? 0;
          compareMismatched = parsed.totals.mismatched ?? 0;
          compareOnlyA = parsed.totals.onlyA ?? 0;
          compareOnlyB = parsed.totals.onlyB ?? 0;
          // 比率按原始计数现算：拆分上线前的旧记录里没有这两个字段
          const rates = compareRates(compareMatched, compareMismatched, compareOnlyA);
          compareMatchRate = rates.matchRatePercent;
          compareCoverage = rates.coveragePercent;
        }
      } catch {
        // 忽略坏记录
      }
    }
  }
  return {
    tasks: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    toolCalls,
    toolOk,
    artifacts,
    compareAccuracy,
    compareRuns,
    compareMatched,
    compareMismatched,
    compareOnlyA,
    compareOnlyB,
    compareMatchRate,
    compareCoverage,
  };
}

/** 比率展示：null 说「无可比对项」，不写成 0% 也不写成 100% */
export { rateText };

export function recentTaskLinks(agentId: string, limit = 3): Array<{ title: string; status: string; link: string }> {
  const rows = db
    .prepare(`SELECT id, title, status FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(agentId, limit) as unknown as Array<{ id: string; title: string; status: string }>;
  return rows.map((r) => ({
    title: r.title,
    status: r.status,
    link: `#/agent/${agentId}/task/${r.id}/tab/result`,
  }));
}

export interface CompareLike {
  totals: {
    compared: number;
    matched: number;
    mismatched: number;
    onlyA: number;
    onlyB: number;
    accuracyPercent: number;
  };
  sheets: Array<{ diffs: Array<{ kind: string; address: string; a: unknown; b: unknown }> }>;
}

/** 取该智能体最近一次记录级比对结果，供作品说明附录展示差异明细。 */
export function latestCompareFor(agentId: string): CompareLike | null {
  const row = db
    .prepare(
      `SELECT tc.result FROM tool_calls tc JOIN tasks t ON t.id = tc.task_id
       WHERE t.agent_id = ? AND tc.tool_name = 'compare_workpapers' AND tc.ok = 1 AND tc.result IS NOT NULL
       ORDER BY tc.started_at DESC LIMIT 1`,
    )
    .get(agentId) as { result: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.result) as CompareLike & { sheets?: Array<{ mode?: string }> };
    return parsed.sheets?.[0]?.mode === "record" ? (parsed as CompareLike) : null;
  } catch {
    return null;
  }
}
