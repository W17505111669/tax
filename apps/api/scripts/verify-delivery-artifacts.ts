/**
 * 验证脚本：交付 MD 的「生成产物与溯源」节。
 *
 * 这一节此前写在 TaskWorkbench 的 bundleLines() 闭包里，任何单测都碰不到它：底层取数有门禁
 *（verify:artsrc 核来源判定、verify:runart 核运行时间窗），但把它们拼成对外表格的那一段没有。
 * 而这一节正是交付包里「产物从哪来」的对外声称——列错位、或把「未识别」写成「生成」，
 * 材料就在撒谎，且没有任何门禁会红。抽成 delivery-artifacts.ts 之后这里逐项钉住。
 *
 * 三块：渲染层（列数与文案由常量给出、三态与空态如实）、真实数据走查（逐任务用与界面同一批
 * 纯函数组装出行，核每行列数与关系列）、静态走查（组件里不再留内联表头与 role 三元兜底）。
 * 「所属运行」列的归属判据（runOfArtifact）本轮从组件闭包搬进 run-artifacts.ts，它的断言在下面
 * 第四节——真实走查里不算这一列，因为那需要重组 timeline，而归属逻辑本身用固定时间窗就能钉死。
 *
 * 运行：pnpm verify:delivart
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_COLUMNS,
  ARTIFACT_DASH,
  ARTIFACT_EMPTY_NOTE,
  ARTIFACT_ROLE_TEXT,
  ARTIFACT_UNKNOWN_SOURCE,
  artifactsSection,
  type DeliveryArtifactRow,
} from "../../web/src/delivery-artifacts.ts";
import { fmtBytes, runOfArtifact, type RunWindow } from "../../web/src/run-artifacts.ts";
import { artifactSources } from "../../web/src/artifact-sources.ts";
import type { SourceCall } from "../../web/src/artifact-sources.ts";
import { taskArtifacts, taskIds } from "./artifacts-lib.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** 表格行按 | 切之后，首尾各多出一段空串，所以列数 = 段数 - 2 */
const cellsOf = (line: string): string[] => line.split("|").slice(1, -1).map((c) => c.trim());

// ---- 1) 渲染层：三态、空态、列数 ----
const rows: DeliveryArtifactRow[] = [
  {
    name: "底稿-系统.xlsx",
    byteSize: 20480,
    source: { id: "c1", toolName: "generate_workpaper", at: "2026-09-29T02:00:00.000Z", role: "producer" },
    run: 2,
  },
  {
    name: "底稿-人工.xlsx",
    byteSize: 512,
    source: { id: "c2", toolName: "compare_workpapers", at: "2026-09-29T03:00:00.000Z", role: "ref" },
    run: null,
  },
  { name: "来历不明.pdf", byteSize: 0, source: null, run: null },
];
const sec = artifactsSection(rows);
expect("空清单给出明确说明，不留一张空表（看起来像漏了内容）", artifactsSection([]), [ARTIFACT_EMPTY_NOTE]);
expect("行数 = 表头 + 分隔 + 每个产物一行", sec.length, rows.length + 2);
expect("表头列名与列数由同一个常量给出", sec[0], `| ${ARTIFACT_COLUMNS.join(" | ")} |`);
expect("对外表格是 6 列（宽度由常量给出，不手写）", ARTIFACT_COLUMNS.length, 6);
expect("分隔行与列数同源", cellsOf(sec[1] ?? ""), ARTIFACT_COLUMNS.map(() => "---"));
expect("role 名单每个取值都有文案（漏一个编译就不过，这里再钉一次运行时）", Object.keys(ARTIFACT_ROLE_TEXT).length, 2);
expect("生成 / 引用两态文案", [ARTIFACT_ROLE_TEXT.producer, ARTIFACT_ROLE_TEXT.ref], ["生成", "引用"]);
expect("大小列与界面角标共用 fmtBytes（不各写一份格式化）", cellsOf(sec[2] ?? "")[1], fmtBytes(20480));
expect("归属到运行的产物写出「第 N 次」", cellsOf(sec[2] ?? "")[5], "第 2 次");
expect("归不到运行的产物写 —，不写成第 0 次", cellsOf(sec[3] ?? "")[5], ARTIFACT_DASH);
expect("引用关系如实写「引用」，不与「生成」混为一谈", cellsOf(sec[3] ?? "")[3], "引用");
expect("没识别出来源的行写「未识别」，不猜一个工具名", cellsOf(sec[4] ?? "")[3], ARTIFACT_UNKNOWN_SOURCE);
expect(
  "没识别出来源时，来源工具与时间两列都是 —",
  [cellsOf(sec[4] ?? "")[2], cellsOf(sec[4] ?? "")[4]],
  [ARTIFACT_DASH, ARTIFACT_DASH],
);

// ---- 2) 真实数据走查：逐任务用与界面同一批纯函数组装，核列数与关系列 ----
let tasks = 0;
let rowsTotal = 0;
let unknownSrc = 0;
// 三态在真实数据上各走了几条要报出来：全库若只有 producer 一种，那「引用 / 未识别」两态就只由
// 上面的 fixture 覆盖，走查这一半是虚的——如实报数，不靠「检查项 25」这个数字掩盖
const roleCounts: Record<SourceCall["role"], number> = { producer: 0, ref: 0 };
for (const id of taskIds()) {
  const got = taskArtifacts(id);
  if (!got) continue;
  tasks += 1;
  const names = got.artifacts.map((a) => a.name);
  const src = artifactSources(names, got.calls);
  const real: DeliveryArtifactRow[] = got.artifacts.map((a) => ({
    name: a.name,
    byteSize: a.byteSize,
    source: src.get(a.name) ?? null,
    run: null,
  }));
  rowsTotal += real.length;
  const lines = artifactsSection(real);
  if (lines.length !== real.length + 2) {
    failures.push(`${id.slice(0, 8)} 产物节 ${lines.length} 行 ≠ 产物 ${real.length} 个 + 表头分隔 2 行`);
  }
  real.forEach((row, i) => {
    const cells = cellsOf(lines[i + 2] ?? "");
    if (cells.length !== ARTIFACT_COLUMNS.length) {
      failures.push(
        `${id.slice(0, 8)}/${row.name} 渲染出 ${cells.length} 列，表头是 ${ARTIFACT_COLUMNS.length} 列（串列）`,
      );
      return;
    }
    if (cells[0] !== row.name) failures.push(`${id.slice(0, 8)} 第 ${i + 1} 行文件名列错位：${cells[0]}`);
    if (cells[1] !== fmtBytes(row.byteSize)) {
      failures.push(`${id.slice(0, 8)}/${row.name} 大小列 ${cells[1]} ≠ fmtBytes(${row.byteSize})`);
    }
    // 关系列必须与 artifactSources 的判定同源：manifest 的 sourceRole 存的也是这个 role
    const wantRole = row.source ? ARTIFACT_ROLE_TEXT[row.source.role] : ARTIFACT_UNKNOWN_SOURCE;
    if (cells[3] !== wantRole) {
      failures.push(`${id.slice(0, 8)}/${row.name} 关系列 ${cells[3]} ≠ 来源判定 ${wantRole}`);
    }
    if (row.source === null) unknownSrc += 1;
    else roleCounts[row.source.role] += 1;
  });
}
expect("真实走查确实走到了带产物的任务（不是空跑）", tasks > 0, true);
expect("真实走查确实渲染出了产物行", rowsTotal > 0, true);
console.log(
  `[verify] 交付 MD 产物节真实走查：${tasks} 个带产物的任务 · ${rowsTotal} 行（生成 ${roleCounts.producer} · 引用 ${roleCounts.ref} · 未识别 ${unknownSrc}）——与 verify:artsrc 同一份取数、同一个判据`,
);

// ---- 3) 静态走查：组件里不再留内联表头与 role 三元兜底 ----
const benchSrc = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "TaskWorkbench.tsx"),
  "utf8",
);
expect("TaskWorkbench 源码真读到了（静态走查不能空跑）", benchSrc.length > 10000, true);
expect("产物节走共享模块", benchSrc.includes("artifactsSection("), true);
expect("组件里不再有内联的 6 列表头", benchSrc.includes("| 文件 | 大小 | 来源工具 | 关系 | 时间 | 所属运行 |"), false);
expect(
  "组件里不再自己判 role 文案（那份三元兜底会把新增的 role 静默归成「引用」）",
  benchSrc.includes('? "生成" : "引用"'),
  false,
);
expect(
  "界面产物区块与 tooltip 都走同一份 role 名单（新增 role 时编译不过，而不是静默归成「引用」）",
  [benchSrc.includes('src.role === "producer"'), benchSrc.includes("ARTIFACT_ROLE_NOTE[src.role]")],
  [false, true],
);
expect("产物归属判据不在组件里重复实现", benchSrc.includes("const runOfArtifact ="), false);

// ---- 4) 归属判据：runOfArtifact 本轮从组件闭包搬进 run-artifacts.ts ----
const wins: RunWindow[] = [
  { run: 1, start: "2026-09-29T01:00:00.000Z", end: "2026-09-29T01:30:00.000Z" },
  { run: 2, start: "2026-09-29T02:00:00.000Z", end: null },
];
const arts = [
  { name: "a.xlsx", byteSize: 1, updatedAt: "2026-09-29T01:10:00.000Z" },
  { name: "b.xlsx", byteSize: 1, updatedAt: "2026-09-29T02:10:00.000Z" },
  { name: "c.xlsx", byteSize: 1, updatedAt: "2026-09-28T00:00:00.000Z" },
];
expect("落在第一次运行窗内的产物归第 1 次", runOfArtifact(arts, wins, "a.xlsx"), 1);
expect("end 为 null 的运行窗一直开着，其后的产物归它", runOfArtifact(arts, wins, "b.xlsx"), 2);
expect("早于所有运行窗的产物归不到任何一次，返回 null 由调用方写 —", runOfArtifact(arts, wins, "c.xlsx"), null);
expect("不存在的产物名返回 null，不拿第一次运行兜底", runOfArtifact(arts, wins, "没有这个.xlsx"), null);

console.log(`[verify] 交付 MD 产物节检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 12)) console.log(`  - ${f}`);
  if (failures.length > 12) console.log(`  …另有 ${failures.length - 12} 处`);
  console.log("[FAIL] 交付 MD 的「生成产物与溯源」节不符");
  process.exit(1);
}
console.log("[PASS] 交付 MD 的「生成产物与溯源」节：列数与文案同源、三态如实、真实产物逐行对得上来源判定");
