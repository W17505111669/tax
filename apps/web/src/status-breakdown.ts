/**
 * 看板「任务状态分布」的口径与条目：一份实现，App.tsx（算数）、AgentOverview（渲染）与
 * scan:uimd 的看板核对（算期望值）共用。
 *
 * 「执行失败」与「已中断」必须分成两条：服务重启打断的续跑就行，与 Agent 执行报错是两件事，
 * 混在一行会让人去查错方向，也会让看板上的「失败」虚高。判据是 status=failed 且 interrupted。
 *
 * STATUS_BARS 的顺序就是界面自上而下的顺序，也是门禁按位置配对时的顺序——顺序本身是判据的一部分，
 * 名单只在这一处存一份：界面与门禁各写一份标签，改了其中一份就会「界面对、门禁红」或反过来。
 */
export type StatusRow = { status: string; interrupted?: boolean };

export type StatusBreakdown = {
  processing: number;
  waiting_review: number;
  completed: number;
  /** Agent 执行报错的任务数（不含服务重启打断的） */
  failed: number;
  /** 服务重启打断、续跑即可的任务数 */
  interrupted: number;
  /** 建了但一次都没跑起来（TaskStatus 里的 created）：右上角「共 N 件」算它，分布里此前没有它 */
  created: number;
};

export const STATUS_BARS: Array<{ label: string; key: keyof StatusBreakdown; hint?: string }> = [
  { label: "已完成", key: "completed" },
  { label: "执行中", key: "processing" },
  { label: "待复核", key: "waiting_review" },
  { label: "执行失败", key: "failed", hint: "Agent 执行报错，需要看错误原因" },
  {
    label: "已中断",
    key: "interrupted",
    hint: "服务重启打断了执行，结论未完成；在结果页续跑即可，不是 Agent 出错",
  },
  {
    label: "已创建",
    key: "created",
    hint: "建了任务但一次都没跑起来（服务在建任务与开跑之间重启过）；不计入失败，在结果页运行即可",
  },
];

/**
 * 六条必须覆盖 TaskStatus 的全部取值（created / processing / waiting_review / completed / failed，
 * 其中 failed 按 interrupted 拆成两条），否则右上角「共 N 件」与分布之和就会对不上，
 * 少掉的那一类任务在看板上等于不存在。scan:uimd 把这条不变量钉住了。
 */
export function statusBreakdown(tasks: StatusRow[]): StatusBreakdown {
  const n = (f: (t: StatusRow) => boolean): number => tasks.filter(f).length;
  return {
    processing: n((t) => t.status === "processing"),
    waiting_review: n((t) => t.status === "waiting_review"),
    completed: n((t) => t.status === "completed"),
    failed: n((t) => t.status === "failed" && !t.interrupted),
    interrupted: n((t) => t.status === "failed" && Boolean(t.interrupted)),
    created: n((t) => t.status === "created"),
  };
}
