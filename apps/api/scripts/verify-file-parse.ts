/**
 * 验证脚本：上传资料解析摘要（状态中文化 / 表格与 OCR 两类摘要 / 按文件名汇总）。
 * 用例形态取自真实 parse_uploaded_files 返回。
 * 运行：pnpm verify:fileparse
 */
import { parsedByFileName, parseStatusText, summarizeParsed } from "../../web/src/file-parse.ts";
import { db } from "../src/db.ts";
import { listFiles, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 状态中文化
expect("已解析", parseStatusText("parsed"), "已解析");
expect("待解析", parseStatusText("pending"), "待解析");
expect("解析失败", parseStatusText("failed"), "解析失败");
expect("未知状态原样显示", parseStatusText("weird"), "weird");
expect("空状态显示未知", parseStatusText(""), "未知");

// 2) 表格类摘要（真实形态：sheets[].name/headers/rows/rowCount）
const xls = summarizeParsed({
  fileName: "研发费用辅助账-样例.xlsx",
  fileType: "xlsx",
  ok: true,
  sheets: [
    { name: "辅助账", rowCount: 12, headers: ["费用类别", "金额"] },
    { name: "汇总", rowCount: 3, headers: ["项目", "金额", "备注"] },
  ],
});
expect("表格类 kind", xls.kind, "sheets");
expect("表数", xls.sheetCount, 2);
expect("行数合计", xls.rowCount, 15);
expect("列数取最大", xls.columnCount, 3);
expect("表格类无 OCR 字段", [xls.ocrConfidence, xls.ocrProvider, xls.preview], [null, "", ""]);

// 3) 扫描件摘要（真实形态：textPreview/ocrProvider/ocrConfidence）
const img = summarizeParsed({
  fileName: "ocr-sample.png",
  fileType: "png",
  ok: true,
  textPreview: "研发支出辅助账\n人员人工 860000",
  ocrProvider: "tesseract",
  ocrConfidence: 92.31,
});
expect("扫描件 kind", img.kind, "ocr");
expect("OCR 置信度", img.ocrConfidence, 92.31);
expect("OCR 引擎", img.ocrProvider, "tesseract");
expect("摘录压平换行", img.preview, "研发支出辅助账 人员人工 860000");
expect(
  "摘录超过 80 字截断",
  summarizeParsed({ fileName: "a.png", textPreview: "字".repeat(120) }).preview.length,
  80,
);

// 4) 边界
expect("解析失败标记", summarizeParsed({ fileName: "x.pdf", ok: false }).ok, false);
expect("空结果归为 other", summarizeParsed({ fileName: "x.bin" }).kind, "other");
expect("缺文件名时为空串", summarizeParsed({}).fileName, "");

// 4b) 解析提示与页数（PDF 无文本层 / OCR 空白等情况要在资料栏可见）
expect(
  "解析提示被保留",
  summarizeParsed({ fileName: "a.pdf", ok: true, pages: 3, error: "PDF 无文本层，需 OCR 后才能解析" }).warning,
  "PDF 无文本层，需 OCR 后才能解析",
);
expect("页数被保留", summarizeParsed({ fileName: "a.pdf", pages: 3 }).pages, 3);
expect("无提示时为空串", summarizeParsed({ fileName: "a.xlsx", sheets: [] }).warning, "");
expect("无页数时为 null", summarizeParsed({ fileName: "a.xlsx", sheets: [] }).pages, null);
// 5) 按文件名汇总：只认 parse_uploaded_files，同名以后一次为准
const map = parsedByFileName([
  { toolName: "generate_workpaper", result: { parsed: [{ fileName: "不该被采纳.xlsx" }] } },
  { toolName: "parse_uploaded_files", result: { parsed: [{ fileName: "a.xlsx", ok: true, sheets: [{ rowCount: 1 }] }] } },
  { toolName: "parse_uploaded_files", result: { parsed: [{ fileName: "a.xlsx", ok: true, sheets: [{ rowCount: 9 }] }] } },
  { toolName: "parse_uploaded_files", result: { parsed: "不是数组" } },
  { toolName: "parse_uploaded_files", result: null },
]);
expect("只汇总解析工具的结果", map.has("不该被采纳.xlsx"), false);
expect("同名文件取最后一次", map.get("a.xlsx")?.rowCount, 9);
expect("坏结果被跳过", map.size, 1);

// 6) 真实数据走查：已解析的上传资料应当能在工具结果里找到摘要
let files = 0;
let withSummary = 0;
for (const t of listTasks()) {
  const rows = db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`).all(t.id) as Array<{
    tool_name: string;
    result: string | null;
  }>;
  const calls = rows.map((r) => {
    let result: unknown = null;
    try {
      result = r.result ? JSON.parse(r.result) : null;
    } catch {
      result = null;
    }
    return { toolName: r.tool_name, result };
  });
  const parsed = parsedByFileName(calls);
  for (const f of listFiles(t.id)) {
    files += 1;
    checks += 1;
    if (parsed.has(f.fileName)) withSummary += 1;
    else if (f.parseStatus === "parsed") failures.push(`${t.id.slice(0, 8)}/${f.fileName} 状态为已解析但工具结果里没有摘要`);
  }
}
console.log(`[verify] 上传资料=${files} 有解析摘要=${withSummary}`);
console.log(`[verify] 资料解析检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 资料解析摘要规则不符");
  process.exit(1);
}
console.log("[PASS] 资料解析摘要规则正确（状态中文化 / 表格与 OCR 摘要 / 按文件名汇总）");
