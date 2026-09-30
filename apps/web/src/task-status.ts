/**
 * 任务状态的展示口径（纯函数、无 Node 依赖，浏览器与服务端共用）。
 *
 * `failed` 一个状态承担着两种完全不同的事实：Agent 执行真的失败，以及服务重启把正在跑的任务
 * 打断（server.ts 启动时会把残留的 processing 一律落库为 failed）。两者的处置方式相反——
 * 前者要看错误原因、可能要改提示词或工具；后者续跑就行，结论并没有「错」。
 *
 * 此前界面上统一写「已中断」，交付自检却写「任务执行失败，结论不可用」，同一件事两种说法，
 * 而且两种说法各自都只对一半。这里把判据收成一处：中断的标记串由 server.ts 与本模块共用同一个
 * 常量，改文案时两边一起改，不会出现「服务端换了措辞、前端就认不出来了」。
 */

/** 服务重启打断执行时落库的错误串。server.ts 与前端共用这一个定义 */
export const INTERRUPTED_ON_RESTART = "服务重启导致执行中断";

export const STATUS_TEXT: Record<string, string> = {
  created: "待执行",
  processing: "执行中",
  waiting_review: "待复核",
  completed: "已完成",
  failed: "执行失败",
};

/** 这个任务是被服务重启打断的（续跑即可），而不是执行本身失败 */
export function isInterruptedOnRestart(task: { status: string; error?: string | null }): boolean {
  return task.status === "failed" && (task.error ?? "").includes(INTERRUPTED_ON_RESTART);
}

/**
 * 状态标签。`failed` 按错误串分成「已中断（服务重启）」与「执行失败」两种说法，
 * 其余状态沿用既有措辞；未知状态原样返回，不猜。
 */
export function taskStatusLabel(status: string, error?: string | null): string {
  if (status !== "failed") return STATUS_TEXT[status] ?? status;
  return isInterruptedOnRestart({ status, error }) ? "已中断（服务重启）" : "执行失败";
}
