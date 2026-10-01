/**
 * 门禁的门禁：用空数据目录把每个「声称走真实数据」的 verify 脚本跑一遍，确认它们会红。
 * 运行：pnpm verify:gates
 *
 * 为什么需要它：一个走查型门禁如果断言全是「遍历库里的任务，逐个检查」，那么库空了它就一项都
 * 不检查、打印「失败=0」然后退出 0——**空跑一样是绿的**。此前只能人工抽检（做过 6 处，查出 1 处
 * 「期望值与被测实现共用同一个常量」的盲点），47 个脚本里其余的谁也不知道。这里把它变成可复跑的
 * 自动化：空库跑一遍，仍然绿的就是能被空输入骗过的门禁。
 *
 * 判据：源码里出现 `src/db.ts` / `listTasks` / `computePlatformStats` 的脚本视为「走真实数据」，
 * 在空数据目录（`TAXAI_DATA_DIR`）下必须非 0 退出。纯函数单测（`verify:csv`、`verify:diaexport`、
 * `verify:format` 这类不读库的）不在判据内——它们空库下本来就该绿，强行要求红等于逼人写假断言。
 *
 * 非 0 退出有两种原因，要分开看：**断言红了**（期望的，说明脚本里有「确实检查到了东西」的断言）
 * 与**脚本崩了**（碰巧退不出 0，不等于有防空跑的判据）。崩溃的那些单独列出来，它们是该补断言的
 * 候选，而不是可以放心的对象。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tax-gates-empty-"));

/**
 * 只认 import 语句，不认标识符：第一版按 `listTasks|computePlatformStats|src/db.ts` 这些字样匹配，
 * 结果把**本脚本自己**也算成了「走真实数据」——它的文档注释里正好写着这几个词。于是自己跑自己，
 * 空库下当然是绿的，报出一条谁也修不了的失败。判据要盯着「从哪儿取数」，不是「提到了什么词」。
 */
const READS_DB = /from "\.\.\/src\/(?:db|services\/(?:task-store|stats))\.ts"|from "\.\/docref-lib\.ts"/;
const SELF = "verify-gates.ts";
const files = fs.readdirSync(here).filter((f) => /^verify-.*\.ts$/.test(f)).sort();
const srcOf = (f: string): string => fs.readFileSync(path.join(here, f), "utf8");
const real = files.filter((f) => f !== SELF && READS_DB.test(srcOf(f)));
const pure = files.filter((f) => f !== SELF && !READS_DB.test(srcOf(f)));

expect("确实找到了 verify 脚本（不是目录空了在这儿空跑）", files.length >= 40, true);
expect("确实找到了走真实数据的脚本", real.length >= 15, true);
expect("确实有不读库的纯函数脚本（两类分得开）", pure.length >= 10, true);

const fooled: string[] = [];
const crashed: string[] = [];
let red = 0;
for (const f of real) {
  // 命令拼成一个字符串而不是 (cmd, args[]) + shell:true：后者会触发 Node 的 DEP0190 弃用警告
  //（shell 模式下 args 不做转义、直接拼接），26 个子进程就是 26 行警告，把真正的输出淹掉。
  const r = spawnSync(`npx tsx scripts/${f}`, {
    cwd: apiDir,
    env: { ...process.env, TAXAI_DATA_DIR: empty },
    encoding: "utf8",
    timeout: 180000,
    shell: true,
  });
  checks += 1;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0) {
    fooled.push(f);
    continue;
  }
  if (out.includes("[FAIL]")) red += 1;
  else {
    const why = out.split(/\r?\n/).find((l) => /(Error|error:|Cannot|not a function)/.test(l)) ?? "（输出里没有错误行）";
    crashed.push(`${f}：${why.trim().slice(0, 100)}`);
  }
}

expect("能被空库骗过的门禁（空库下仍然打印 0 失败并退出 0）", fooled, []);
console.log(
  `[verify] verify 脚本 ${files.length} 个：走真实数据 ${real.length} 个 · 纯函数 ${pure.length} 个（不在判据内）`,
);
console.log(`[verify] 空库下：断言红 ${red} 个 · 崩溃退出 ${crashed.length} 个 · 仍然绿 ${fooled.length} 个`);
if (crashed.length > 0) {
  console.log("[verify] 下面是**崩溃**退出的（退出码非 0 但不是断言红，属于该补防空跑断言的候选）：");
  for (const c of crashed) console.log(`  - ${c}`);
}
fs.rmSync(empty, { recursive: true, force: true });

console.log(`[verify] 门禁空跑抽检 检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 有门禁能被空输入骗过");
  process.exit(1);
}
console.log("[PASS] 走真实数据的门禁在空库下全部会红（没有一个能被空输入骗过）");
