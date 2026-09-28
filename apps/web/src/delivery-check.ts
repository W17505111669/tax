/**
 * 交付自检：把「这份材料现在能不能交」写成可核对的规则，放在整页交付 MD 的最前面。
 * 阻断项（block）= 必须先处理才能交付；提醒项（warn）= 交付时需要在说明里交代。
 * 纯函数，便于 apps/api/scripts/verify-delivery-check.ts 直接校验。
 */

import { STALE_HOURS } from "./link-check.ts";
import type { GradeSummary } from "./citation-grade.ts";

export type CheckInput = {
  status: string;
  resultChars: number;
  artifacts: number;
  /** 无法溯源到任何工具调用的产物数 */
  unattributedArtifacts: number;
  toolTotal: number;
  toolFailed: number;
  toolRunning: number;
  pendingReview: number;
  citations: number;
  /** 联网引用的证据力分级汇总；null 表示本次任务没有联网引用 */
  citationGrades: GradeSummary | null;
  /** 联网检索留痕；null 表示本任务没有任何联网检索类工具调用 */
  searches: { calls: number; withUrls: number; metadataOnly: number; reportedResults: number } | null;
  /** 最近一次链接核验的分级汇总；null 表示尚未核验，此时不做任何判断 */
  linkCheck: { total: number; ok: number; blocked: number; dead: number; unreachable: number } | null;
  /** 最近一次链接核验距今的小时数；null 表示尚未核验或时间不可解析 */
  linkCheckAgeHours: number | null;
  /** 结论中识别出的金额处数（金额溯源） */
  amountTotal: number;
  /** 其中在工具结果与客户指令里都找不到出处的处数 */
  amountUntraced: number;
  /** 上传资料总数与其中解析失败的份数 */
  filesTotal: number;
  filesFailed: number;
  /** 政策文号溯源：结论中的文号总数 / 有出处 / 无法核验（联网检索仅存元数据）/ 待人工确认 */
  docRefTotal: number;
  docRefTraced: number;
  docRefUnverifiable: number;
  docRefUntraced: number;
  /** 政策文号联网复查汇总；null 表示从未复查 */
  docRefRecheck: {
    total: number;
    matched: number;
    candidate: number;
    empty: number;
    error: number;
    checkedAt: string | null;
  } | null;
  /** 复查之后仍没有出处的文号处数（待确认 + 无法核验 − 已找到公开出处） */
  docRefPending: number;
};

/** info 只作说明，不影响交付判定（例如反爬导致的「拒绝自动访问」） */
export type CheckLevel = "block" | "warn" | "ok" | "info";

export type CheckItem = { level: CheckLevel; text: string };

export type Verdict = "可交付" | "谨慎交付" | "不建议直接交付";

export type CheckResult = {
  verdict: Verdict;
  items: CheckItem[];
  blocks: number;
  warns: number;
  infos: number;
};

export function deliveryCheck(i: CheckInput): CheckResult {
  const items: CheckItem[] = [];

  if (i.status === "failed") items.push({ level: "block", text: "任务执行失败，结论不可用" });
  if (i.status === "processing" || i.status === "created") {
    items.push({ level: "block", text: `任务仍在${i.status === "processing" ? "执行中" : "待执行"}，尚未产出最终结论` });
  }
  if (i.resultChars <= 0) items.push({ level: "block", text: "缺少审查结论正文" });
  else items.push({ level: "ok", text: `审查结论 ${i.resultChars.toLocaleString("zh-CN")} 字` });

  if (i.status === "completed" && i.pendingReview > 0) {
    items.push({
      level: "block",
      text: `任务已标记完成但仍有 ${i.pendingReview} 项问题未复核，需先「转为待复核」并逐项处理`,
    });
  } else if (i.pendingReview > 0) {
    items.push({ level: "warn", text: `${i.pendingReview} 项问题待税务师复核` });
  } else if (i.toolTotal > 0 || i.artifacts > 0) {
    items.push({ level: "ok", text: "复核事项已全部处理" });
  }

  if (i.toolFailed > 0) {
    items.push({ level: "warn", text: `${i.toolFailed} 次工具调用失败，请核对受影响结论是否已改用其他依据` });
  }
  if (i.toolRunning > 0) items.push({ level: "warn", text: `${i.toolRunning} 次工具调用尚未结束` });
  if (i.toolTotal > 0 && i.toolFailed === 0 && i.toolRunning === 0) {
    items.push({ level: "ok", text: `工具调用 ${i.toolTotal} 次，全部成功` });
  }

  if (i.unattributedArtifacts > 0) {
    items.push({ level: "warn", text: `${i.unattributedArtifacts} 份产物无法溯源到工具调用，需人工确认来源` });
  }
  if (i.artifacts > 0 && i.unattributedArtifacts === 0) {
    items.push({ level: "ok", text: `产物 ${i.artifacts} 份，均可溯源到生成它的工具调用` });
  }

  if (i.amountUntraced > 0) {
    items.push({
      level: "warn",
      text: `${i.amountUntraced} 处结论金额未在工具结果与客户指令中找到出处，需人工确认是否为推算值`,
    });
  } else if (i.amountTotal > 0) {
    items.push({ level: "ok", text: `结论金额 ${i.amountTotal} 处均可溯源到工具结果或客户指令` });
  }

  if (i.filesFailed > 0) {
    items.push({
      level: "warn",
      text: `${i.filesFailed} 份上传资料解析失败，结论可能缺少这部分依据，请重新解析或改用可读版本`,
    });
  } else if (i.filesTotal > 0) {
    items.push({ level: "ok", text: `上传资料 ${i.filesTotal} 份，全部解析成功` });
  }

  // 已经联网复查到公开出处的文号不再算风险：只有确实还没出处的才提醒
  const refsCovered =
    i.docRefRecheck !== null &&
    i.docRefPending === 0 &&
    i.docRefRecheck.matched >= i.docRefUntraced + i.docRefUnverifiable;
  if (i.docRefUntraced > 0) {
    items.push({
      level: refsCovered ? "info" : "warn",
      text: refsCovered
        ? `${i.docRefUntraced} 处政策文号未在工具结果中找到出处，已全部联网复查到公开出处（证据链接见「政策文号溯源」节的复查表）`
        : `${i.docRefUntraced} 处政策文号未在工具结果中找到出处，需人工确认依据后再交付`,
    });
  }
  if (i.docRefUnverifiable > 0) {
    items.push({
      level: "info",
      text: refsCovered
        ? `${i.docRefUnverifiable} 处政策文号无法从留存数据核验（联网检索扩展只持久化查询元数据），已全部联网复查到公开出处，证据链接见「政策文号溯源」节的复查表`
        : `${i.docRefUnverifiable} 处政策文号无法从留存数据核验（联网检索扩展只持久化查询元数据），建议改用政策快照检索、联网复查或附检索页面截图`,
    });
  }
  if (i.docRefTotal > 0 && i.docRefUntraced === 0 && i.docRefUnverifiable === 0) {
    items.push({ level: "ok", text: `政策文号 ${i.docRefTotal} 处均可溯源到工具结果` });
  }
  if (i.docRefRecheck) {
    const r = i.docRefRecheck;
    if (r.matched > 0) {
      items.push({
        level: "ok",
        text: `${r.matched} 处政策文号已联网复查到公开出处${
          i.docRefPending > 0 ? `，复查后仍有 ${i.docRefPending} 处没有出处` : ""
        }`,
      });
    }
    if (r.candidate > 0) {
      items.push({
        level: "info",
        text: `${r.candidate} 处文号复查只找到候选页面（标题与摘要里没有出现该文号），请点开候选页人工确认`,
      });
    }
    if (r.empty > 0 || r.error > 0) {
      items.push({
        level: "info",
        text: `${r.empty} 处文号复查未检索到可用结果${
          r.error > 0 ? `、${r.error} 处检索失败` : ""
        }，请改用政策快照检索或人工核对`,
      });
    }
  }

  // 「没有引用清单」有两种情况：检索过但扩展只留元数据（如实说明），或根本没检索（提醒）
  if (i.citations > 0) {
    items.push({ level: "ok", text: `联网引用 ${i.citations} 条` });
    if (i.searches && i.searches.metadataOnly > 0) {
      items.push({
        level: "info",
        text: `另有 ${i.searches.metadataOnly} 次联网检索只留存查询元数据（未留存标题与 URL），未计入引用清单`,
      });
    }
  } else if (i.searches && i.searches.calls > 0) {
    items.push({
      level: "info",
      text: `本任务执行过 ${i.searches.calls} 次联网检索${
        i.searches.reportedResults > 0 ? `（扩展自报命中 ${i.searches.reportedResults} 条）` : ""
      }，但检索扩展只留存查询元数据，无法生成引用清单；请在结论中附检索词与检索时间，或改用 search_public_cases 留存来源`,
    });
  } else {
    items.push({ level: "warn", text: "无联网引用，涉及政策依据的结论请确认是否已完成在线核验" });
  }

  if (i.citationGrades) {
    if (i.citationGrades.weak > 0) {
      items.push({
        level: "warn",
        text: `${i.citationGrades.weak} 条联网引用指向门户首页、百科词条或检索结果页，证据力不足，交付前请替换为政策原文的具体文件页`,
      });
    }
    if (i.citationGrades.official > 0) {
      items.push({
        level: "ok",
        text: `${i.citationGrades.official} 条联网引用来自政府或税务机关站点的具体文件页`,
      });
    }
  }

  if (i.linkCheck) {
    if (i.linkCheck.dead > 0) {
      items.push({
        level: "warn",
        text: `${i.linkCheck.dead} 条联网引用已失效（4xx），交付前请替换链接或补充其他依据`,
      });
    }
    if (i.linkCheck.blocked > 0 || i.linkCheck.unreachable > 0) {
      items.push({
        level: "info",
        text: `${i.linkCheck.blocked} 条引用拒绝自动访问、${i.linkCheck.unreachable} 条无法核验（反爬 / 超时 / 5xx），需人工点击确认，不计入交付风险`,
      });
    }
    if (i.linkCheck.total > 0 && i.linkCheck.dead === 0 && i.linkCheck.ok === i.linkCheck.total) {
      items.push({ level: "ok", text: `联网引用最近核验全部可访问（${i.linkCheck.total} 条）` });
    }
    if (i.linkCheckAgeHours !== null && i.linkCheckAgeHours > STALE_HOURS) {
      items.push({
        level: "info",
        text: `引用链接核验已超过 ${Math.floor(i.linkCheckAgeHours / 24)} 天，交付前建议重新核验`,
      });
    }
  }

  const blocks = items.filter((x) => x.level === "block").length;
  const warns = items.filter((x) => x.level === "warn").length;
  const verdict: Verdict = blocks > 0 ? "不建议直接交付" : warns > 0 ? "谨慎交付" : "可交付";
  return { verdict, items, blocks, warns, infos: items.filter((x) => x.level === "info").length };
}

const MARK: Record<CheckLevel, string> = { block: "✗", warn: "!", ok: "✓", info: "·" };

/** 生成「交付自检」一节的 Markdown 行 */
export function deliverySection(i: CheckInput): string[] {
  const r = deliveryCheck(i);
  return [
    `- 结论：${r.verdict}（阻断 ${r.blocks} 项 · 提醒 ${r.warns} 项${
      r.infos > 0 ? ` · 说明 ${r.infos} 项` : ""
    }）`,
    `- 任务状态：${i.status}`,
    ...r.items.map((x) => `- ${MARK[x.level]} ${x.text}`),
  ];
}
