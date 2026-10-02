/**
 * 验证脚本：交付包打包（条目名安全化 + zip 往返 + 真实任务条目组装）。
 * 运行：pnpm verify:bundle
 */
import JSZip from "jszip";
import fs from "node:fs";
import { collectBundleEntries, createBundleZip, sanitizeEntryName } from "../src/services/bundle-zip.ts";
import { listFiles, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 条目名安全化：不允许盘符、绝对路径与上跳
expect("反斜杠转正斜杠", sanitizeEntryName("产物\\底稿.xlsx"), "产物/底稿.xlsx");
expect("去掉盘符", sanitizeEntryName("C:\\tmp\\out\\a.xlsx"), "tmp/out/a.xlsx");
expect("禁止上跳", sanitizeEntryName("../../etc/passwd"), "etc/passwd");
expect("去掉重复斜杠与当前目录", sanitizeEntryName("a//./b.md"), "a/b.md");
expect("空名兜底", sanitizeEntryName("   "), "未命名");
expect("中文名保留", sanitizeEntryName("整页交付.md"), "整页交付.md");

// 2) 打包与往返（用 jszip 读回，内容为王）
const zip = await createBundleZip([
  { name: "整页交付.md", data: "# 交付\n\n- 结论：可交付\n" },
  { name: "C:\\data\\outputs\\t1\\底稿-联动.xlsx", data: new Uint8Array([1, 2, 3, 255]) },
]);
expect("zip 以 PK 开头", [zip[0], zip[1]], [80, 75]);
const loaded = await JSZip.loadAsync(zip);
expect(
  "条目名安全化后进入压缩包（只数文件，忽略 jszip 自动补的目录项）",
  Object.keys(loaded.files)
    .filter((k) => !loaded.files[k]?.dir)
    .sort(),
  ["data/outputs/t1/底稿-联动.xlsx", "整页交付.md"],
);
expect("文本内容往返一致", await loaded.file("整页交付.md")?.async("string"), "# 交付\n\n- 结论：可交付\n");
expect(
  "二进制内容往返一致",
  Array.from(await loaded.file("data/outputs/t1/底稿-联动.xlsx")!.async("uint8array")),
  [1, 2, 3, 255],
);
expect(
  "空条目列表也能生成合法 zip",
  Object.keys((await JSZip.loadAsync(await createBundleZip([]))).files).length,
  0,
);

// 3) 真实任务的条目组装：MD 在最前，产物在「产物/」下、上传资料在「资料/」下。
//    manifest 会申报这两类，包里就必须真的有——只申报不打包等于交付清单在说谎（实测 rd-audit
//    的回归案例申报了「辅助账.xlsx」而包里没有，直到 scan:deliverables 铺开覆盖面才撞出来）。
let withArtifacts = 0;
let withFiles = 0;
let declaredFiles = 0;
for (const t of listTasks()) {
  const entries = await collectBundleEntries(t.id, "# 交付");
  checks += 1;
  if (entries[0]?.name !== "整页交付.md") failures.push(`${t.id} 首条目不是整页交付 MD`);
  checks += 1;
  if (!entries.slice(1).every((e) => e.name.startsWith("产物/") || e.name.startsWith("资料/"))) {
    failures.push(`${t.id} 存在既不在产物目录、也不在资料目录的条目`);
  }
  if (entries.some((e) => e.name.startsWith("产物/"))) withArtifacts += 1;
  // 磁盘上实有的资料必须逐份打进包里；磁盘上没有的不塞空文件充数，也就不许出现在条目里
  const onDisk = listFiles(t.id).filter((f) => fs.existsSync(f.storagePath));
  const packed = entries.filter((e) => e.name.startsWith("资料/"));
  declaredFiles += onDisk.length;
  checks += 1;
  if (packed.length !== onDisk.length) {
    failures.push(`${t.id} 资料条目 ${packed.length} 份 ≠ 磁盘上实有的 ${onDisk.length} 份`);
  }
  checks += 1;
  const missing = onDisk.filter((f) => !packed.some((e) => e.name === `资料/${f.fileName}`)).map((f) => f.fileName);
  if (missing.length > 0) failures.push(`${t.id} 申报的资料没打进包里：${missing.join("、")}`);
  if (packed.length > 0) withFiles += 1;
}
expect("至少有一个任务带产物", withArtifacts > 0, true);
expect("至少有一个任务带上传资料（否则资料这一档是空跑）", withFiles > 0, true);

console.log(
  `[verify] 交付打包检查项=${checks} 失败=${failures.length}（带产物任务=${withArtifacts} · 带资料任务=${withFiles} · 打进包里的资料 ${declaredFiles} 份）`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付打包规则不符");
  process.exit(1);
}
console.log("[PASS] 交付打包正确（条目名安全化 / zip 往返 / 真实任务条目组装 / 申报的资料都在包里）");
