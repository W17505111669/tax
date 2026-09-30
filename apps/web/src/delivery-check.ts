/**
 * 交付自检：把「这份材料现在能不能交」写成可核对的规则，放在整页交付 MD 的最前面。
 * 阻断项（block）= 必须先处理才能交付；提醒项（warn）= 交付时需要在说明里交代。
 * 纯函数，便于 apps/api/scripts/verify-delivery-check.ts 直接校验。
 */

import { STALE_HOURS } from "./link-check.ts";
import type { GradeSummary } from "./citation-grade.ts";
import { isInterruptedOnRestart } from "./task-status.ts";

export type CheckInput = {
  status: string;
  /** 任务的错误串：用来把「服务重启打断」与「执行真的失败」分开，缺省按执行失败处理 */
  error?: string | null;
  resultChars: number;
  artifacts: number;
  /** 无法溯源到任何工具调用的产物数 */
  unattributedArtifacts: number;
  toolTotal: number;
  toolFailed: number;
  toolRunning: number;
  pendingReview: number;
  citations: number;
  /**
   * 联网引用的证据力分级汇总；null 表示本次任务没有联网引用。
   * weakDisclaimed 是其中已在结论里写明「仅作背景参考，不作为政策依据」的条数：交代过的不再是
   * 交付前待办，否则自检会一直催替换一批模型已经处理过的引用（分级本身只看地址与标题，判不出
   * 结论有没有交代，因此由调用方按正文算好带进来）。
   * weakUncited 是只在检索留存里、从未进入结论正文的条数：它们不是这份交付材料的依据，也没法在
   * 结论里补标注，同样不算待办（口径与「没有结论就不计证据欠账」一致）。
   */
  citationGrades: (GradeSummary & { weakDisclaimed?: number; weakUncited?: number }) | null;
  /**
   * 与业务主题无关的引用标题（标题与结论主题词没有任何完整涉税领域词交集）。
   * 空数组表示没有，或结论里取不到主题词因而无从判断。
   */
  offTopicCitations: string[];
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
  /** 弱证据引用的替代来源检索汇总；null 表示从未检索 */
  citationRecheck: {
    total: number;
    matched: number;
    candidate: number;
    empty: number;
    error: number;
    checkedAt: string | null;
  } | null;
  /** 本次修订（最近一次续跑）对证据的影响；null 表示没有可对比的上一轮结论 */
  revision: {
    citations: number;
    official: number;
    weak: number;
    docRefs: number;
    improved: boolean;
    regressed: boolean;
  } | null;
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

  if (i.status === "failed") {
    // 两者处置方式相反：服务重启打断的续跑就行、结论并没有错，执行失败的才要查错误原因。
    // 都写「任务执行失败」会把开发期热重载打断的任务说成 Agent 出错，排查方向就错了。
    items.push(
      isInterruptedOnRestart({ status: i.status, error: i.error })
        ? { level: "block", text: "任务被服务重启打断，结论未完成；在结果页续跑即可，不是执行出错" }
        : { level: "block", text: "任务执行失败，结论不可用" },
    );
  }
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

  // 复查判定 matched 的文号已经计入 docRefTraced，不会再落进 untraced / unverifiable，
  // 所以这里剩下的都是确实还没有出处的，直接提醒即可。原先「已全部复查到出处」的降级分支
  // 在新口径下不可能触发（docRefPending 就是两者之和，为 0 时两个计数必然都为 0），
  // 留着会让人以为还存在第三种状态。
  if (i.docRefUntraced > 0) {
    items.push({
      level: "warn",
      text: `${i.docRefUntraced} 处政策文号未找到公开出处，需人工确认依据后再交付`,
    });
  }
  if (i.docRefUnverifiable > 0) {
    items.push({
      level: "info",
      text: `${i.docRefUnverifiable} 处政策文号无法从留存数据核验（联网检索扩展只持久化查询元数据），建议改用政策快照检索、联网复查或附检索页面截图`,
    });
  }
  if (i.docRefTotal > 0 && i.docRefUntraced === 0 && i.docRefUnverifiable === 0) {
    items.push({
      level: "ok",
      text: `政策文号 ${i.docRefTotal} 处均有公开出处（工具留存结果或联网复查记录）`,
    });
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
    if (i.searches === null || i.searches.calls === 0) {
      // 没有任何联网检索调用时，引用只可能来自结论正文（政策快照或模型给出的地址）
      items.push({
        level: "info",
        text: `本任务没有联网检索类工具调用，${i.citations} 条引用取自结论正文，请用「核验链接」确认可达性并核对依据来源`,
      });
    } else if (i.searches.metadataOnly > 0) {
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

  if (i.offTopicCitations.length > 0) {
    const sample = i.offTopicCitations
      .slice(0, 3)
      .map((t) => `「${t}」`)
      .join("、");
    items.push({
      level: "warn",
      text: `${i.offTopicCitations.length} 条联网引用与业务主题无关（如 ${sample}），不能替代政策依据；这类词条找不到同主题的官方原文，建议直接从结论中删掉，而不是花时间找替代来源`,
    });
  }
  if (i.citationGrades) {
    const disclaimed = i.citationGrades.weakDisclaimed ?? 0;
    const uncited = i.citationGrades.weakUncited ?? 0;
    const weakOpen = Math.max(0, i.citationGrades.weak - disclaimed - uncited);
    if (weakOpen > 0) {
      items.push({
        level: "warn",
        text: `${weakOpen} 条联网引用指向门户首页、百科词条或检索结果页，证据力不足，交付前请替换为政策原文的具体文件页`,
      });
    }
    if (disclaimed > 0) {
      items.push({
        level: "ok",
        text: `另有 ${disclaimed} 条弱证据引用已在结论中声明「未取得公开原文，仅作背景参考，不作为政策依据」，无需再找替代来源`,
      });
    }
    if (uncited > 0) {
      items.push({
        level: "info",
        text: `${uncited} 条弱证据引用只存在于检索留存、未进入结论正文，不是本次交付的依据，无需替换`,
      });
    }
    if (i.citationGrades.official > 0) {
      items.push({
        level: "ok",
        text: `${i.citationGrades.official} 条联网引用来自政府或税务机关站点的具体文件页`,
      });
    }
    // 只在当前确实还有弱证据引用时才谈替代来源：替换完成后这条说明自然消失
    if (weakOpen > 0 && i.citationRecheck && i.citationRecheck.total > 0) {
      if (i.citationRecheck.matched > 0) {
        items.push({
          level: "info",
          text: `${i.citationRecheck.matched} 条弱证据引用已找到可替换的官方原文，请在结论中替换后重新打包`,
        });
      }
      if (i.citationRecheck.candidate > 0) {
        items.push({
          level: "info",
          text: `${i.citationRecheck.candidate} 条弱证据引用只找到候选页（非官方原文），需人工确认后再替换`,
        });
      }
      if (i.citationRecheck.matched === 0 && i.citationRecheck.candidate === 0) {
        items.push({
          level: "info",
          text: `${i.citationRecheck.total} 条弱证据引用没有检索到可替换的官方原文，请在结论中说明依据来源或改用政策快照`,
        });
      }
    }
  }

  // 本次修订把证据改坏了就不能当作没事：退步给提醒，有增有减给说明，改善给正向条目
  if (i.revision) {
    const r = i.revision;
    const sgn = (n: number) => (n > 0 ? `+${n}` : String(n));
    const detail = `弱证据引用 ${sgn(r.weak)} · 官方来源 ${sgn(r.official)}`;
    if (r.regressed && !r.improved) {
      items.push({ level: "warn", text: `本次修订让证据质量退步（${detail}），请核对修订内容后再交付` });
    } else if (r.improved && r.regressed) {
      items.push({ level: "info", text: `本次修订对证据质量有增有减（${detail}），请核对修订内容` });
    } else if (r.improved) {
      items.push({ level: "ok", text: `本次修订改善了证据质量（${detail}）` });
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
