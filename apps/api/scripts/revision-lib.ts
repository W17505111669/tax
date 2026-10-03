/**
 * 修订素材的取数：一个任务能生成什么样的修订指令。
 *
 * 两个消费点：写回脚本（writeback-evidence）拿它列计划，界面实测（scan-ui-markdown）拿它核对
 * 结果页那颗「生成修订指令（N）」按钮上的 N。此前只有写回脚本算得出来，界面上那颗按钮的数字
 * 从来没被核对过——而按钮的渲染条件与数字必须同源（组件里就写着这条注释），没人核对就等于
 * 让「渲染条件」与「数字」各自漂移。取数收到这里一份，判据本身仍在 web/src/ref-check.ts
 *（revisionItemsForTask / deadLinkTargets），这里只负责把数据喂进去。
 */
import { db } from "../src/db.ts";
import { listLinkChecks } from "../src/services/link-checks.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  UNCAPPED,
} from "../../web/src/search-evidence.ts";
import { deadLinkTargets, revisionItemsForTask, type RevisionItem } from "../../web/src/ref-check.ts";

export type RevisionPlan = {
  items: RevisionItem[];
  dead: Array<{ title: string; url: string }>;
};

/**
 * @param result 结论正文由调用方传入而不是自己读：写回脚本要先判「结论为空不进清单」
 *（结论为空时续跑只会让模型凭空生成一份结论），两个消费点必须用同一个 result。
 */
export function revisionPlanFor(taskId: string, result: string): RevisionPlan {
  const items = revisionItemsForTask(listRefChecks(taskId), result);
  const calls = (db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`).all(taskId) ?? []) as Array<{
    tool_name: string;
    result: string | null;
  }>;
  const parsed = calls.map((c) => {
    let parsedResult: unknown = null;
    try {
      parsedResult = c.result ? JSON.parse(c.result) : null;
    } catch {
      parsedResult = null;
    }
    return { toolName: c.tool_name, result: parsedResult };
  });
  // 引用清单按全量取（与平台统计同口径），deadLinkTargets 内部会再按当前清单过滤掉过期核验行
  const cites = mergeCitations(
    extractCitations(parsed, UNCAPPED),
    extractTextCitations(result, UNCAPPED),
    UNCAPPED,
  );
  return { items, dead: deadLinkTargets(listLinkChecks(taskId), cites) };
}
