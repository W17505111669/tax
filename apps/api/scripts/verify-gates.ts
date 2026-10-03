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
 *
 * 名单也不能只列几个熟脸：第二版写的是 `services/(task-store|stats)`，于是 verify-doc-source.ts
 * 从 `services/ref-checks.ts` 取数却被归到「纯函数脚本」，从来没被空库复跑过——而它的三条
 * `every(...)` 在空索引上恰恰全部通过。改成认整个 `services/` 与 `routes/` 目录：判据是「有没有
 * 从服务端取数」，不是「从哪个文件取数」。
 */
const READS_DB = /from "\.\.\/src\/(?:db|services\/[a-z-]+|routes\/[a-z-]+)\.ts"|from "\.\/docref-lib\.ts"/;
const SELF = "verify-gates.ts";
const files = fs.readdirSync(here).filter((f) => /^verify-.*\.ts$/.test(f)).sort();
const srcOf = (f: string): string => fs.readFileSync(path.join(here, f), "utf8");
const real = files.filter((f) => f !== SELF && READS_DB.test(srcOf(f)));
const pure = files.filter((f) => f !== SELF && !READS_DB.test(srcOf(f)));

expect("确实找到了 verify 脚本（不是目录空了在这儿空跑）", files.length >= 40, true);
expect("确实找到了走真实数据的脚本", real.length >= 15, true);
expect("确实有不读库的纯函数脚本（两类分得开）", pure.length >= 10, true);

// 走真实数据的脚本必须自带防空跑断言。下面的空库复跑查的是「判据能不能被空输入骗过」，查不出
// 「真实数据这一侧压根没走到」——例如全库都没有某类记录时，`every(...)` 与「全部满足」这类断言
// 会齐齐通过。约定：这类脚本的源码里必须出现「空跑 / 确实 / >= 1」字样的断言（本项目一直这么写，
// 这里把它变成硬要求）。实测此前 28 个走真实数据的脚本里有 1 个不符合，就是上面那个 doc-source。
const GUARD = /空跑|确实|>=\s*1\b|>=\s*2\b/;
const unguarded = real.filter((f) => !GUARD.test(srcOf(f)));
expect("走真实数据的脚本都自带防空跑断言", unguarded, []);

/**
 * 两个 scan 门禁（`scan:uimd` / `scan:deliverables`）同样读真实库、同样在 `--strict` 下用退出码表态，
 * 但上面的名单只收 `verify-*.ts`，于是这道元门禁从来没审过它们——「所有门禁都在验真实数据而不是
 * 空跑绿」这句话此前对这两个是不成立的，而它们恰恰是覆盖面最大的两个（151 页 / 1072 次交互）。
 * 这里把它们接进**静态**那一半判据：必须从服务端取数、必须自带防空跑断言。
 *
 * 空库复跑那一半刻意不接：scan 要开 Chromium、要前端在 5174 上跑，空库下它会因为「一个页面都没
 * 扫到」而失败——那不是判据被空输入骗过，是环境不在，硬塞进复跑只会让这道元门禁在没浏览器的机器
 * 上必红。所以复跑名单仍然只含 `verify-*`，并把这个排除本身钉住：名单里冒出 scan 就是有人改坏了。
 */
const scanFiles = fs.readdirSync(here).filter((f) => /^scan-.*\.ts$/.test(f)).sort();
const realScans = scanFiles.filter((f) => READS_DB.test(srcOf(f)));
expect("确实找到了 scan 门禁脚本（不是目录空了在这儿空跑）", scanFiles.length >= 2, true);
expect("scan 门禁都从服务端取数（不读库的 scan 等于没在验真实数据）", realScans.length, scanFiles.length);
expect("scan 门禁都自带防空跑断言", realScans.filter((f) => !GUARD.test(srcOf(f))), []);
expect("空库复跑名单里只有 verify-*（scan 要浏览器与前端，复跑只会误红）", real.every((f) => f.startsWith("verify-")), true);

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

console.log(
  `[verify] 门禁空跑抽检 检查项=${checks} 失败=${failures.length}（verify 脚本 ${files.length} 个：走真实数据 ${real.length} / 纯函数 ${pure.length}；scan 门禁 ${scanFiles.length} 个走静态判据、不进空库复跑）`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 有门禁能被空输入骗过");
  process.exit(1);
}
console.log("[PASS] 走真实数据的门禁在空库下全部会红（没有一个能被空输入骗过）");
