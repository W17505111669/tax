/**
 * 交付 MD 的头部元信息（标题 + 任务 ID / 智能体 / 案例 / 状态 / 运行次数 / 创建 / 导出）。
 *
 * 为什么抽出来：这六行此前直接写在 TaskWorkbench 的 `bundleLines()` 里，是组件内闭包，
 * 任何单测都碰不到；而同一批字段在 `buildManifest` 里又写了一遍（`id / title / caseId /
 * agentId / status / createdAt / runCount`）。两份各写各的，就会各说一套——上一轮刚修掉的
 * 「打回待复核后 MD 头部写『已完成』、manifest 写 waiting_review」正是这么来的：
 * `reopened` 那个三元接到了 manifest，没接到头部。
 *
 * 所以这里不只是把渲染搬出来，而是让两侧**共用同一个 task 对象**：`task` 的类型就是
 * `ManifestInput["task"]`，字段少一个、口径差一点都编译不过。
 */
import { dateTimeStamp } from "./time-format.ts";
import type { ManifestInput } from "./manifest.ts";

/** 与 manifest 的 task 字段同一个类型：不是「两份保持一致」，是同一份 */
export type ManifestTask = ManifestInput["task"];

export type DeliveryHeaderInput = {
  task: ManifestTask;
  /** 智能体中文名。manifest 里存的是 agentId（给归档系统检索），MD 是给人读的，写名字 */
  agentName: string;
  model?: string | null;
  /**
   * 状态的中文完整说法，由调用方用 `taskStatusLabel(task.status)` 给出。
   * 刻意不在这里再翻一遍：状态文案只有 task-status.ts 一份，这里多一个映射就是第五份名单。
   */
  statusText: string;
  /** 导出时刻。与 createdAt 分开传：一个是任务属性、一个是本次导出动作的时间 */
  exportedAt: string | Date;
};

/** 头部出现的字段名，顺序即渲染顺序；断言用它数「每行该有什么」，不手写字段清单 */
export const HEADER_FIELDS = ["任务 ID", "智能体", "案例", "状态", "运行次数", "创建", "导出"] as const;

export function headerLines(i: DeliveryHeaderInput): string[] {
  return [
    `# ${i.task.title}`,
    "",
    `- 任务 ID：${i.task.id}`,
    `- 智能体：${i.agentName}${i.model ? `（${i.model}）` : ""}`,
    `- 案例：${i.task.caseId}　状态：${i.statusText}　运行次数：${i.task.runCount}`,
    `- 创建：${dateTimeStamp(i.task.createdAt)}　导出：${dateTimeStamp(i.exportedAt)}`,
    "",
  ];
}
