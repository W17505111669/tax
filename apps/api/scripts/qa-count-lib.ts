/**
 * 「自动化验证有多少项」这个对外数字只许有一份取数。
 *
 * 它有三个消费点：PPT 大纲那页、两份作品说明、README 的命令清单。此前只有 PPT 那份是从
 * `qa:all` 里数出来的（它的注释还记着教训：「这一页原先写着 7 项，实际已 37 项」），
 * 作品说明那份仍然手写死 7 个脚本名、README 那份手写死「58 项」——同一个数字三种表述，
 * 其中两种不会随 `qa:all` 更新。教训在一个文件里学到了，没有搬到隔壁那个文件，这就是它的形状。
 *
 * 口径：数 `qa:all` 命令行里 `pnpm verify:` 出现几次。这与「apps/api/scripts 下有多少个
 * verify-*.ts 文件」不是一回事（58 对 50）——有些 verify 命令跑的是 agents/ 与 packages/ 下的脚本。
 * 对外讲的是「qa:all 一次跑完多少项」，所以就按命令数，不按文件数。
 */
export function qaVerifyCount(scripts: Record<string, string> | undefined): number {
  return (scripts?.["qa:all"] ?? "").split("pnpm verify:").length - 1;
}
