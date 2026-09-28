/**
 * 验证脚本：上传预检规则，并核对前端拿到的策略与服务端配置一致。
 * 运行：pnpm verify:upload
 */
import {
  checkFile,
  extensionOf,
  partitionFiles,
  policyHint,
  policyMessage,
  verdictItems,
} from "../../web/src/upload-policy.ts";
import { allowedExtensions, maxUploadBytes } from "../src/config.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const policy = { allowedExtensions: ["xlsx", "pdf", "png"], maxUploadBytes: 1000 };

expect("扩展名小写化", extensionOf("底稿.XLSX"), "xlsx");
expect("无扩展名", extensionOf("README"), "");
expect("点开头不算扩展名", extensionOf(".gitignore"), "");
expect("多个点取最后一段", extensionOf("a.b.csv"), "csv");

expect("白名单内通过", checkFile({ name: "底稿.xlsx", size: 100 }, policy), { ok: true, reason: "" });
expect("大小写不敏感", checkFile({ name: "SCAN.PNG", size: 100 }, policy).ok, true);
expect("类型不支持", checkFile({ name: "virus.exe", size: 100 }, policy), { ok: false, reason: "不支持的类型 .exe" });
expect("缺少扩展名", checkFile({ name: "无扩展名", size: 100 }, policy).reason, "缺少扩展名");
expect("恰好等于上限通过", checkFile({ name: "a.pdf", size: 1000 }, policy).ok, true);
expect("超过上限被拒", checkFile({ name: "a.pdf", size: 1001 }, policy).ok, false);
expect("超限原因带可读上限", checkFile({ name: "a.pdf", size: 1001 }, policy).reason.includes("1000 B"), true);
expect("空文件被拒", checkFile({ name: "a.pdf", size: 0 }, policy).reason, "空文件");

const split = partitionFiles(
  [
    { name: "a.xlsx", size: 10 },
    { name: "b.exe", size: 10 },
    { name: "c.pdf", size: 10 },
    { name: "d.zip", size: 10 },
  ],
  policy,
);
expect("批量预检-可上传", split.accepted.map((f) => f.name), ["a.xlsx", "c.pdf"]);
expect("批量预检-被拒原因", split.rejected.map((r) => r.reason), ["不支持的类型 .exe", "不支持的类型 .zip"]);
expect("全部通过时无提示", policyMessage(2, []), "");
expect("部分跳过时列出原因", policyMessage(1, [{ name: "b.exe", reason: "不支持的类型 .exe" }]).includes("已跳过 1 份"), true);
expect("全部被拒时说明未上传", policyMessage(0, [{ name: "b.exe", reason: "不支持的类型 .exe" }]).startsWith("未上传"), true);
expect(
  "超过 3 份只列前 3 并汇总",
  policyMessage(0, [
    { name: "1.exe", reason: "x" },
    { name: "2.exe", reason: "x" },
    { name: "3.exe", reason: "x" },
    { name: "4.exe", reason: "x" },
  ]).includes("等 4 份"),
  true,
);

// 服务端配置自洽：白名单非空、上限为正、常见业务类型都在白名单里
expect("白名单非空", allowedExtensions.length > 0, true);
expect("上限为正", maxUploadBytes > 0, true);

// 落区提示与逐份结果清单
expect("无策略时不给提示", policyHint(null), "");
expect(
  "类型过多时折叠计数",
  policyHint({ allowedExtensions: [".pdf", ".xlsx", ".xls", ".csv", ".docx", ".doc", ".txt"], maxUploadBytes: 1024 }),
  "支持 .pdf .xlsx .xls .csv .docx .doc 等 7 类 · 单文件 ≤ 1.0 KB",
);
expect(
  "类型不多时全部列出",
  policyHint({ allowedExtensions: ["xlsx", "pdf"], maxUploadBytes: 2048 }),
  "支持 .xlsx .pdf · 单文件 ≤ 2.0 KB",
);
expect(
  "服务端真实配置的提示含类数与上限",
  [
    policyHint({ allowedExtensions, maxUploadBytes }).includes(`等 ${allowedExtensions.length} 类`),
    policyHint({ allowedExtensions, maxUploadBytes }).includes("25.00 MB"),
  ],
  [true, true],
);
expect(
  "逐份结果保持入参顺序并标注原因",
  verdictItems(
    [
      { name: "a.xlsx", size: 1 },
      { name: "b.exe", size: 1 },
      { name: "c.pdf", size: 1 },
    ],
    [{ name: "b.exe", reason: "不支持的类型 .exe" }],
  ),
  [
    { name: "a.xlsx", ok: true, reason: "" },
    { name: "b.exe", ok: false, reason: "不支持的类型 .exe" },
    { name: "c.pdf", ok: true, reason: "" },
  ],
);
expect("空列表", verdictItems([], []), []);
expect(
  "常见业务类型按服务端真实配置可上传",
  ["底稿.xlsx", "政策.pdf", "扫描.png", "台账.csv"].every(
    (n) => checkFile({ name: n, size: 10 }, { allowedExtensions, maxUploadBytes }).ok,
  ),
  true,
);
expect(
  "服务端白名单带前导点也能匹配",
  checkFile({ name: "a.xlsx", size: 10 }, { allowedExtensions: [".xlsx"], maxUploadBytes: 100 }).ok,
  true,
);
expect(
  "服务端真实配置下 exe 被拒",
  checkFile({ name: "virus.exe", size: 10 }, { allowedExtensions, maxUploadBytes }).ok,
  false,
);

console.log(`[verify] 上传预检检查项=${checks} 失败=${failures.length}（服务端上限 ${maxUploadBytes} 字节 / 白名单 ${allowedExtensions.length} 类）`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 上传预检规则不符");
  process.exit(1);
}
console.log("[PASS] 上传预检规则正确（扩展名 / 大小 / 空文件 / 批量分组 / 提示文案）");
