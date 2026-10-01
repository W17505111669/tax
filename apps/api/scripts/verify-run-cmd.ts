/**
 * 验证脚本：脚本头部注释里写的那条运行命令，是不是真能跑到这个脚本。
 * 运行：pnpm verify:runcmd
 *
 * 为什么需要它：注释里的运行命令是给人照着敲的，写错了不会有任何报错——照着跑只会跑到别的
 * 检查上，看到一片绿还以为本脚本过了。上一轮就手工查出过 1 处这种错（`verify:policytrace`
 * 写成 `verify:policy`，那是智研税审政策库的另一项检查）。手工查过一次不等于以后不会漂：
 * 脚本会改名、script 键会重命名、`qa:all` 会增删条目，所以把它做成门禁。
 *
 * 判据（两个方向都查）：
 * 1. 正向：每个脚本头部注释里的 `运行：pnpm <name>`，顺着 package.json 的 `pnpm --filter` 链
 *    解析到最终命令行，命令行里必须出现**这个脚本自己的文件名**；
 * 2. 反向：`qa:all` 里列的每个 `pnpm verify:*` 都必须能解析到一条真实存在的脚本命令，
 *    不允许出现「门禁清单里挂着一个已经不存在的脚本」。
 */
import fs from "node:fs";
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
const ROOT = path.resolve(here, "..", "..", "..");

type Pkg = { name: string; dir: string; scripts: Record<string, string> };
const pkgs = new Map<string, Pkg>();
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  scripts?: Record<string, string>;
};
pkgs.set(rootPkg.name, { name: rootPkg.name, dir: ROOT, scripts: rootPkg.scripts ?? {} });
// agents/ 也是 workspace 的一组包（智研税审、土增智填两个智能体），漏掉它会让
// `pnpm --filter @tax/agent-rd-audit verify:policy` 这条链解析不出来
for (const group of ["agents", "apps", "packages"]) {
  const gdir = path.join(ROOT, group);
  if (!fs.existsSync(gdir)) continue;
  for (const d of fs.readdirSync(gdir)) {
    const p = path.join(gdir, d, "package.json");
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { name?: string; scripts?: Record<string, string> };
    if (typeof j.name === "string") pkgs.set(j.name, { name: j.name, dir: path.join(gdir, d), scripts: j.scripts ?? {} });
  }
}
expect("确实读到了 workspace 的各个包（不是空跑）", pkgs.size >= 6, true);

/** 顺着 `pnpm --filter <pkg> <script>` 一路解析到最终命令行；解析不出来返回 null */
function resolveScript(name: string, pkgName: string, depth = 0): string | null {
  if (depth > 5) return null;
  const cmd = pkgs.get(pkgName)?.scripts?.[name];
  if (typeof cmd !== "string") return null;
  const m = /^pnpm\s+(?:-\S+\s+)*--filter\s+(\S+)\s+(\S+)\s*$/.exec(cmd.trim());
  if (m && m[1] && m[2]) return resolveScript(m[2], m[1], depth + 1);
  return cmd.trim();
}

/** 这个文件属于哪个包（取最近的 package.json） */
function ownerOf(file: string): string | null {
  let dir = path.dirname(file);
  for (;;) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as { name?: string };
      if (typeof j.name === "string") return j.name;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const scriptFiles: string[] = [];
for (const p of pkgs.values()) {
  const sdir = path.join(p.dir, "scripts");
  if (!fs.existsSync(sdir)) continue;
  for (const f of fs.readdirSync(sdir)) {
    if (f.endsWith(".ts") && !f.startsWith("tmp-")) scriptFiles.push(path.join(sdir, f));
  }
}
expect("确实扫到了脚本文件（不是空目录）", scriptFiles.length >= 40, true);

let withCmd = 0;
let withoutCmd = 0;
for (const file of scriptFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const head = fs.readFileSync(file, "utf8").slice(0, 3000);
  const m = /运行[：:]\s*pnpm\s+([A-Za-z0-9:_-]+)/.exec(head);
  if (!m) {
    // 共享库与临时脚本本来就没有运行命令，如实计数、不算失败
    withoutCmd += 1;
    continue;
  }
  withCmd += 1;
  const name = m[1] ?? "";
  const owner = ownerOf(file);
  checks += 1;
  if (!owner) {
    failures.push(`${rel} 找不到所属包`);
    continue;
  }
  // 注释里写的是仓库根的脚本名（大家都这么敲），所以从根包开始解析
  const cmd = resolveScript(name, rootPkg.name) ?? resolveScript(name, owner);
  if (cmd === null) {
    failures.push(`${rel} 头部写的「运行：pnpm ${name}」在 package.json 里不存在`);
    continue;
  }
  checks += 1;
  if (!cmd.includes(path.basename(file))) {
    failures.push(`${rel} 头部写的「运行：pnpm ${name}」实际执行的是「${cmd}」，跑不到本脚本`);
  }
}
expect("确实核对到了带运行命令的脚本（不是全都跳过）", withCmd >= 40, true);
console.log(`[verify] 脚本 ${scriptFiles.length} 个：带运行命令 ${withCmd} 个 · 共享库/无命令 ${withoutCmd} 个`);

// 反向：qa:all 里挂着的每个 verify 都要能解析到真实脚本，不能有空条目
const qaAll = rootPkg.scripts?.["qa:all"] ?? "";
const qaNames = [...qaAll.matchAll(/pnpm\s+(verify:[A-Za-z0-9_-]+)/g)].map((m) => m[1] ?? "");
expect("qa:all 里确实列了一串 verify（不是空串）", qaNames.length >= 40, true);
let qaResolved = 0;
for (const n of new Set(qaNames)) {
  const cmd = resolveScript(n, rootPkg.name);
  checks += 1;
  if (cmd === null) {
    failures.push(`qa:all 里的 ${n} 在 package.json 里解析不出来`);
    continue;
  }
  const target = /tsx\s+(\S+\.ts)/.exec(cmd)?.[1];
  checks += 1;
  if (!target) {
    failures.push(`qa:all 里的 ${n} 解析到「${cmd}」，看不出要跑哪个脚本`);
    continue;
  }
  // 目标脚本相对它所属包；从各包目录逐个找一遍
  const hit = [...pkgs.values()].some((p) => fs.existsSync(path.join(p.dir, target)));
  if (hit) qaResolved += 1;
  else failures.push(`qa:all 里的 ${n} 指向 ${target}，但这个文件不存在`);
}
expect("qa:all 的 verify 条目全部指向真实脚本", qaResolved, new Set(qaNames).size);
// 本脚本自己也得在 qa:all 里，否则它永远只在有人手工想起时才跑
expect("本脚本已挂进 qa:all", qaNames.includes("verify:runcmd"), true);
console.log(`[verify] qa:all 里 ${new Set(qaNames).size} 个 verify 条目全部解析到真实脚本（${qaResolved} 个）`);

// 3) 对外文档里写的命令也要能跑：README 与 docs/competition 是交付件，照着敲却报
//    「Command not found」比脚本注释写错更难看。docs/testing 是内部记录，里面本来就会
//    写「此前误写成某某」这类历史叙述，不纳入核对。
const BUILTIN = new Set([
  "install", "i", "add", "remove", "rm", "run", "exec", "dlx", "list", "ls", "why",
  "publish", "pack", "store", "update", "up", "rebuild", "prune", "create", "import",
  "link", "unlink", "fetch", "outdated", "audit", "licenses",
]);
const docFiles = [path.join(ROOT, "README.md")];
const compDir = path.join(ROOT, "docs", "competition");
if (fs.existsSync(compDir)) {
  for (const f of fs.readdirSync(compDir)) if (f.endsWith(".md")) docFiles.push(path.join(compDir, f));
}
const allScriptNames = new Set<string>();
for (const p of pkgs.values()) for (const k of Object.keys(p.scripts)) allScriptNames.add(k);
let docCmds = 0;
for (const file of docFiles) {
  if (!fs.existsSync(file)) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/pnpm\s+([a-z][a-z0-9-]*(?::[a-z0-9-]+)?)/g)) {
    const name = m[1] ?? "";
    if (BUILTIN.has(name)) continue;
    docCmds += 1;
    checks += 1;
    if (!allScriptNames.has(name)) failures.push(`${rel} 里写的「pnpm ${name}」在任何一个 package.json 里都不存在`);
  }
}
expect("确实核对到了文档里的命令（不是没扫着）", docCmds >= 8, true);
console.log(`[verify] 对外文档 ${docFiles.length} 份里的 ${docCmds} 条 pnpm 命令逐个核对存在性`);

console.log(`[verify] 运行命令一致性检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 脚本头部运行命令与 package.json 不一致");
  process.exit(1);
}
console.log("[PASS] 脚本头部运行命令与 package.json 一致（正向解析 + qa:all 反向核对）");
