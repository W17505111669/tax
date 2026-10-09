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
// 判据按 import 做**传递闭包**，不靠手写白名单。此前是「匹配脚本自己的 import 行 + 一份手写的
// lib 白名单（docref / artifacts / revision-lib）」。白名单每加一个 lib 都得记得回来改这里，
// 忘了就漏判——verify:delivart 正是这么被判成「纯函数」的：它通过 ./artifacts-lib.ts 间接读库
// 与产物目录，而 lib 名字当时不在白名单里，于是它不进空库复跑，那条「确实走到了带产物的任务」
// 的防空跑断言永远不会被自动验证（上一个提交里刚踩到，靠手工加名字补上）。
// 判据的实质是「这个脚本运行时会不会碰到真实库 / 真实产物」，那就顺着 import 走过去看，
// 而不是靠谁记得登记名字。递归只走同目录的 ./xxx.ts：../src/ 一命中就算取数；
// ../../web/src/ 是前端纯函数模块、不读库，不参与递归（它们由各自的 web 侧门禁覆盖）。
const DIRECT_DB = /from "\.\.\/src\/(?:db|services\/[a-z-]+|routes\/[a-z-]+)\.ts"/;
const LOCAL_IMPORT = /from "\.\/([a-z0-9-]+\.ts)"/g;
const SELF = "verify-gates.ts";
const files = fs.readdirSync(here).filter((f) => /^verify-.*\.ts$/.test(f)).sort();
const srcOf = (f: string): string => fs.readFileSync(path.join(here, f), "utf8");
/** seen 防环：本地模块之间互相 import 时不会无限递归，也避免同一个 lib 被重复读盘 */
function readsRealData(src: string, seen: Set<string>): boolean {
  if (DIRECT_DB.test(src)) return true;
  for (const m of src.matchAll(LOCAL_IMPORT)) {
    const dep = m[1];
    if (!dep || seen.has(dep)) continue;
    seen.add(dep);
    const p = path.join(here, dep);
    if (!fs.existsSync(p)) continue;
    if (readsRealData(fs.readFileSync(p, "utf8"), seen)) return true;
  }
  return false;
}
const readsReal = (f: string): boolean => readsRealData(srcOf(f), new Set([f]));
const real = files.filter((f) => f !== SELF && readsReal(f));
const pure = files.filter((f) => f !== SELF && !readsReal(f));

expect("确实找到了 verify 脚本（不是目录空了在这儿空跑）", files.length >= 40, true);
expect("确实找到了走真实数据的脚本", real.length >= 15, true);
expect("确实有不读库的纯函数脚本（两类分得开）", pure.length >= 10, true);
// 闭包不是白写的：确实有脚本自己一行 ../src/ 都不 import，只因为 import 了取数 lib 才算走真实数据。
// 这条盯的是递归本身——把递归去掉（只看脚本自己的 import），real 会静默缩小、空库复跑少跑几个，
// 而其它断言一条都不会红（上面那条 real.length >= 15 照样过）。**漏判是静默的**，所以必须直接钉住，
// 不能指望「项数没掉」来发现问题：项数从来不会因为你少审了几个脚本而变少。
const directOnly = files.filter((f) => f !== SELF && DIRECT_DB.test(srcOf(f)));
const viaLib = real.filter((f) => !directOnly.includes(f));
expect("确实有脚本是靠 import 闭包才认出来的（递归没白写）", viaLib.length > 0, true);
console.log(
  `[verify] 靠 import 闭包才认出「走真实数据」的脚本 ${viaLib.length} 个（自己一行 ../src/ 都不 import，只 import 了取数 lib）：${viaLib.join("、")}`,
);

// 走真实数据的脚本必须自带防空跑断言。下面的空库复跑查的是「判据能不能被空输入骗过」，查不出
// 「真实数据这一侧压根没走到」——例如全库都没有某类记录时，`every(...)` 与「全部满足」这类断言
// 会齐齐通过。约定：这类脚本的源码里必须出现「空跑 / 确实 / >= 1」字样的断言（本项目一直这么写，
// 这里把它变成硬要求）。实测此前 28 个走真实数据的脚本里有 1 个不符合，就是上面那个 doc-source。
const GUARD = /空跑|确实|>=\s*1\b|>=\s*2\b/;
const unguarded = real.filter((f) => !GUARD.test(srcOf(f)));
expect("走真实数据的脚本都自带防空跑断言", unguarded, []);

/**
 * scan 门禁（`scan:uimd` / `scan:deliverables` / `perf:render`）同样读真实库、同样用退出码表态，
 * 但上面的名单只收 `verify-*.ts`，于是这道元门禁从来没审过它们——「所有门禁都在验真实数据而不是
 * 空跑绿」这句话此前对它们是不成立的，而它们恰恰是覆盖面最大的几个（151 页 / 1072 次交互）。
 * 这里把它们接进**静态**那一半判据：必须从服务端取数、必须自带防空跑断言。
 *
 * 空库复跑那一半刻意不接：scan 要开 Chromium、要前端在 5174 上跑，空库下它会因为「一个页面都没
 * 扫到」而失败——那不是判据被空输入骗过，是环境不在，硬塞进复跑只会让这道元门禁在没浏览器的机器
 * 上必红。所以复跑名单仍然只含 `verify-*`，并把这个排除本身钉住：名单里冒出 scan 就是有人改坏了。
 */
const scanFiles = fs.readdirSync(here).filter((f) => /^scan-.*\.ts$/.test(f)).sort();
const realScans = scanFiles.filter((f) => readsReal(f));
expect("确实找到了 scan 门禁脚本（不是目录空了在这儿空跑）", scanFiles.length >= 2, true);
expect("scan 门禁都从服务端取数（不读库的 scan 等于没在验真实数据）", realScans.length, scanFiles.length);
expect("scan 门禁都自带防空跑断言", realScans.filter((f) => !GUARD.test(srcOf(f))), []);
expect("空库复跑名单里只有 verify-*（scan 要浏览器与前端，复跑只会误红）", real.every((f) => f.startsWith("verify-")), true);

/**
 * 残留判据的「阳性对照」覆盖率。
 *
 * 走查型判据最常见的形态是「offenders 必须是空数组」。它有一种假绿是空库复跑查不出来的：
 * **模式本身写废了**。正则少一个转义、字符串常量改了一次大小写，offenders 永远是空的，
 * 门禁绿得和「全库都合规」一模一样。空库复跑查的是「真实数据这一侧走没走到」，查不出
 * 「判据这一侧还能不能命中」。本轮就在 verify:format 上亲手踩过一次：新加的「裸拼 % 残留」
 * 判据如果不配一条拿已知违规样本去断正则命中的自检，写废了也没人知道。
 *
 * 唯一能钉住它的办法是阳性对照：拿一个**已知违规的字面量样本**断那条正则确实命中
 *（`verify:reltime` 与 `verify:format` 已经这么写了）。本轮实测覆盖面见下面的报告行。
 *
 * 这里先把它量成常驻报告行 + 一条只许涨不许跌的下限，而不是一条硬性要求：给二十来个脚本
 * 补阳性对照，每个都得先读懂它的判据、再挑一个**真的会长成这样**的坏样本，一次提交里赶完
 * 只会产出一批为了绿而写的样本——那比没有更坏。补齐一个就把下限抬一格。
 */
// 分诊规则（本轮逐条看过之后定下来的，三类**不需要**阳性对照，别再照着名单硬补）：
// 1. 纯函数的「空输入 → 空输出」单测，例如 verify-textfind 的「空查询没有命中」、
//    verify-tool-failures 的「空清单分组为空数组」。判据坏了会变红不会变绿。
// 2. 模式驱动但方向朝红的：例如 `/^https?:\/\//.test(url)` 不匹配就 push 进 failures，
//    模式写废 → 全都判违规 → 红。这类是自保护的。
// 3. 「某个文件不再出现字符串 X」型探针（verify-textfind 里那一批 `!reader.includes(...)`）。
//    X 已经不在代码里了，阳性对照在原理上无法构造——你没法让一段被删掉的旧写法重现。
//    这类的有效防护是同一个文件上必须有正向 includes 断言，证明读对了文件、文件不是空的。
// 真正需要补的只剩一种：**扫一个总体（文件树 / 库里的行）收集违规项、断言列表为空**，
// 且模式写废会让列表变空而不是变红。
const RESIDUE = /, \[\]\);/;
// 这个探针是**刻意宽的**，它会把纯函数单测也算进来（例如「空变更列表」「空数组是合法值」
// 「非对象结果返回空」——那些是输入为空时期望输出为空的正常单测，判据坏了会变红不会变绿，
// 不需要阳性对照）。所以报告行里的「待补 N 个」是**上界**，得人工分诊。
// 试过收窄成「脚本里有 readdirSync 且有空数组断言」，得到 8 个——那个收窄是错的：
// verify-md-text.ts 的 ARTIFACTS 走查遍历的是库里的真实结论而不是文件，不含 readdirSync，
// 会被漏掉，而它恰恰是「界面不出现 Markdown 原文」这句对外承诺的唯一门禁判据。
// 宁可分母高估，不可漏报。
// 阳性对照的识别是**约定式**的（与上面 GUARD 认「确实 / 空跑」同一个套路）：要么直接拿字面量
// 样本 `.test("...")`，要么断言名里写「确实能命中」。所以补对照时得沿用这个措辞，否则统计不到。
const POSITIVE_CTL = /\.test\(\s*["'`]|确实能命中|确实命中/;
const allGates = [...files, ...scanFiles].filter((f) => f !== SELF);
const withResidue = allGates.filter((f) => RESIDUE.test(srcOf(f)));
const withCtl = withResidue.filter((f) => POSITIVE_CTL.test(srcOf(f)));
const noCtl = withResidue.filter((f) => !POSITIVE_CTL.test(srcOf(f)));
expect("确实找到了带残留判据的门禁（不是这条走查自己空跑）", withResidue.length >= 20, true);
expect("带阳性对照的门禁数不许跌（补齐一个就抬一格；分诊规则见上，不是名单上每个都要补）", withCtl.length >= 11, true);
console.log(
  `[verify] 残留判据阳性对照覆盖：${withResidue.length} 个门禁有「必须为空」型判据 · 其中 ${withCtl.length} 个带已知违规样本自检 · 待分诊 ${noCtl.length} 个（含纯函数空输入单测，不都需要补）`,
);
console.log(`[verify] 待分诊阳性对照的门禁：${noCtl.join("、")}`);

/**
 * 生成物循环依赖：`report:test` 内部会逐个跑 `VERIFY_SCRIPTS`（42 个）再把 PASS/FAIL 写进
 * 测试报告第二节与「总体结论」。所以任何**读 `test-report-*.md` 的门禁**都不能出现在那份名单里，
 * 否则它读到的是上一次生成的报告——滞后一轮。本轮实测踩过：把「报告行内自相矛盾」那条走查放进
 * `verify:stats` 之后，单独跑一次 `report:test` 就把「存在未通过验证项」这个假结论写进了对外
 * 交付文档（而所有门禁实测全绿），再跑一次才恢复。判据本身没错，错在它读的是自己参与生成的文件。
 *
 * 文件名与 pnpm 脚本名不是机械对应（`verify-platform-stats.ts` → `verify:stats`），所以映射从
 * `apps/api/package.json` 反查，不靠字符串变换——那正是「两边各存一份名单」的静默退化形状。
 */
const apiPkg = JSON.parse(fs.readFileSync(path.resolve(apiDir, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
// 矩阵里的命令是从**仓库根**跑的（`pnpm verify:pi` 这种跨包脚本只在根 package.json 里），
// 所以「这个名字存在吗」要查两个 package.json 的并集。第一版只查了 apps/api 那份，
// 于是把 verify:pi / verify:docs / verify:compare 等 8 个跨包脚本全报成了「查不到」。
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(apiDir, "..", "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const knownScripts = new Set(
  [...Object.keys(apiPkg.scripts), ...Object.keys(rootPkg.scripts)].filter((n) => n.startsWith("verify:")),
);
const scriptOf = new Map<string, string>();
for (const [name, cmd] of Object.entries(apiPkg.scripts)) {
  const m = /scripts\/([a-z0-9-]+\.ts)/.exec(cmd);
  if (m?.[1] && name.startsWith("verify:")) scriptOf.set(m[1], name);
}
const matrix = [...srcOf("gen-test-report.ts").matchAll(/name: "(verify:[a-z-]+)"/g)]
  .map((m) => m[1])
  .filter((n): n is string => n !== undefined);
const readsReport = files.filter((f) => f !== SELF && /test-report-/.test(srcOf(f)));
const looped = readsReport.map((f) => scriptOf.get(f) ?? f).filter((n) => matrix.includes(n));
expect("报告验证矩阵确实枚举到了脚本（不是名单空了在这儿空跑）", matrix.length >= 40, true);
expect("确实找到了读测试报告的门禁（这条走查不能空跑）", readsReport.length >= 1, true);
expect("确实查到了 verify 脚本名（两个 package.json 都读到了）", knownScripts.size >= 40, true);
expect("矩阵里的脚本名都能在 package.json 里查到（写错名字会让报告列出跑不了的命令）", matrix.filter((n) => !knownScripts.has(n)), []);
expect("读测试报告的门禁不在报告自己的验证矩阵里（否则它读到上一次的报告，滞后一轮）", looped, []);
/**
 * 反方向：`qa:all` 里每个 verify 都必须进矩阵，否则报告第二节列不全，而结尾那句
 * 「全部自动化验证通过」就覆盖不到它。本轮实测漏了 **16 个**（qa:all 58 项、矩阵 42 项）——
 * 上面那条只查了「矩阵里的名字都存在」，从没查过「该进矩阵的都进了」。
 *
 * 排除名单不手写，由两条静态判据推导，这样「谁不进矩阵」永远是一个能复算的决定而不是一份会腐化的清单：
 * 1. 自己读 `test-report-*.md` 的（进了矩阵就只能读到上一轮的报告，滞后一轮）；
 * 2. 自己会 spawn 别的门禁的（进了矩阵等于在报告里嵌套跑一遍全套；本轮全库只有 verify-gates 一个）。
 */
const qaVerifies = [...(rootPkg.scripts["qa:all"] ?? "").matchAll(/pnpm (verify:[a-z0-9-]+)/g)].map(
  (m) => m[1] ?? "",
);
// 这条**不排除 SELF**：verify-gates 自己就是那个「会拿空库把每个门禁再跑一遍」的脚本，
// 它进矩阵等于在 report:test 里嵌套跑一遍全套。上面 readsReport 排除 SELF 是为了不自指，
// 这里排除的恰恰是它自己，所以必须留着。
const spawners = files.filter((f) => /spawnSync|execFileSync|execSync/.test(srcOf(f))).map((f) => scriptOf.get(f) ?? "");
const reportExcluded = new Set([...readsReport.map((f) => scriptOf.get(f) ?? ""), ...spawners]);
const notInMatrix = qaVerifies.filter((n) => !matrix.includes(n) && !reportExcluded.has(n));
expect("qa:all 里确实枚举到了 verify 条目（不是 package.json 没读到在这儿空跑）", qaVerifies.length >= 40, true);
expect("推导出的排除名单确实非空（两条判据都没命中就说明推导本身写废了）", [...reportExcluded].filter((n) => n !== "").length >= 1, true);
expect("qa:all 里每个 verify 都进报告矩阵（否则报告那句「全部自动化验证通过」覆盖不到它）", notInMatrix, []);
console.log(
  `[verify] 报告矩阵覆盖：qa:all 跑 ${qaVerifies.length} 项 verify · 矩阵列 ${matrix.length} 项 · 推导排除 ${[...reportExcluded].filter((n) => n !== "").join("、") || "无"} · 既不在矩阵也没被排除 ${notInMatrix.length} 项`,
);

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
