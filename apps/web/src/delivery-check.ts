/**
 * 交付自检：把「这份材料现在能不能交」写成可核对的规则，放在整页交付 MD 的最前面。
 * 阻断项（block）= 必须先处理才能交付；提醒项（warn）= 交付时需要在说明里交代。
 * 纯函数，便于 apps/api/scripts/verify-delivery-check.ts 直接校验。
 */

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
  /** 结论中识别出的金额处数（金额溯源） */
  amountTotal: number;
  /** 其中在工具结果与客户指令里都找不到出处的处数 */
  amountUntraced: number;
};

export type CheckLevel = "block" | "warn" | "ok";

export type CheckItem = { level: CheckLevel; text: string };

export type Verdict = "可交付" | "谨慎交付" | "不建议直接交付";

export type CheckResult = { verdict: Verdict; items: CheckItem[]; blocks: number; warns: number };

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

  if (i.citations > 0) items.push({ level: "ok", text: `联网引用 ${i.citations} 条` });
  else items.push({ level: "warn", text: "无联网引用，涉及政策依据的结论请确认是否已完成在线核验" });

  const blocks = items.filter((x) => x.level === "block").length;
  const warns = items.filter((x) => x.level === "warn").length;
  const verdict: Verdict = blocks > 0 ? "不建议直接交付" : warns > 0 ? "谨慎交付" : "可交付";
  return { verdict, items, blocks, warns };
}

const MARK: Record<CheckLevel, string> = { block: "✗", warn: "!", ok: "✓" };

/** 生成「交付自检」一节的 Markdown 行 */
export function deliverySection(i: CheckInput): string[] {
  const r = deliveryCheck(i);
  return [
    `- 结论：${r.verdict}（阻断 ${r.blocks} 项 · 提醒 ${r.warns} 项）`,
    `- 任务状态：${i.status}`,
    ...r.items.map((x) => `- ${MARK[x.level]} ${x.text}`),
  ];
}
