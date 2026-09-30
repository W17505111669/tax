/**
 * 待复核问题的跨任务分组：同一件事在多个任务里各出现一次时，让复核的人一次看清、一次处置。
 *
 * 实测 58 条待复核里去重后只有 42 种，其中 7 种跨任务重复——「留存备查资料『研发人员名单』尚未取得」
 * 在 6 个任务里各出现一次，「直接投入费用 辅助账 420000 对财务明细账 880000」在 4 个任务里各出现
 * 一次。逐任务点「全部确认」要点 6 遍，而判断其实是同一个。
 *
 * 纯函数：看板与验证脚本共用一份，避免两处分组规则漂移。
 */
export type PendingIssueRow = {
  taskId: string;
  taskTitle: string;
  agentId: string;
  issueId: string;
  issueType: string;
  description: string;
};

export type IssueGroup = {
  issueType: string;
  description: string;
  items: PendingIssueRow[];
};

/**
 * 按「类型 + 描述原文」分组。组内按任务标题排序，组间按出现次数倒序、其次类型与描述——
 * 排序必须确定，否则同一批数据每次导出的行序不同，跨任务批量处置就没法核对。
 */
export function groupPendingIssues(rows: PendingIssueRow[]): IssueGroup[] {
  const map = new Map<string, IssueGroup>();
  for (const r of rows) {
    const key = `${r.issueType}|${r.description}`;
    const g = map.get(key);
    if (g) g.items.push(r);
    else map.set(key, { issueType: r.issueType, description: r.description, items: [r] });
  }
  return [...map.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => a.taskTitle.localeCompare(b.taskTitle)) }))
    .sort(
      (a, b) =>
        b.items.length - a.items.length ||
        a.issueType.localeCompare(b.issueType) ||
        a.description.localeCompare(b.description),
    );
}

/** 分组汇总：总条数、去重后的组数、其中跨任务重复的组数与这些组涉及的条数 */
export function groupSummary(groups: IssueGroup[]): {
  items: number;
  groups: number;
  recurringGroups: number;
  recurringItems: number;
} {
  const recurring = groups.filter((g) => g.items.length > 1);
  return {
    items: groups.reduce((s, g) => s + g.items.length, 0),
    groups: groups.length,
    recurringGroups: recurring.length,
    recurringItems: recurring.reduce((s, g) => s + g.items.length, 0),
  };
}
