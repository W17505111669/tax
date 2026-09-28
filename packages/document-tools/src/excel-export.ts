import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

export interface WorkpaperSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
  /** 可选公式，如 { cell: "C10", formula: "SUM(C2:C9)" } */
  formulas?: Array<{ cell: string; formula: string }>;
}

export interface WorkpaperInput {
  fileName: string;
  title: string;
  meta?: Array<{ label: string; value: string }>;
  sheets: WorkpaperSheet[];
}

/** 生成可编辑 Excel 工作底稿：表头加粗填色、冻结首行、边框、自适应列宽、可选公式。 */
export async function generateWorkpaper(outputDir: string, input: WorkpaperInput): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "税务智能审查平台";
  workbook.created = new Date();

  for (const sheet of input.sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    let rowIdx = 1;

    const titleCell = ws.getCell(`A${rowIdx}`);
    titleCell.value = input.title;
    titleCell.font = { bold: true, size: 14 };
    ws.mergeCells(`A${rowIdx}:${String.fromCharCode(64 + Math.max(2, sheet.headers.length))}${rowIdx}`);
    rowIdx += 1;

    for (const meta of input.meta ?? []) {
      ws.getCell(`A${rowIdx}`).value = `${meta.label}：${meta.value}`;
      ws.getCell(`A${rowIdx}`).font = { size: 10, color: { argb: "FF666666" } };
      rowIdx += 1;
    }
    rowIdx += 1;

    const headerRow = ws.addRow(sheet.headers);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FF1F2937" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
    const headerLineNumber = headerRow.number;
    ws.views = [{ state: "frozen", ySplit: headerLineNumber }];

    for (const row of sheet.rows) {
      const r = ws.addRow(row.map((v) => (v === null ? undefined : v)));
      r.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: "FFE5E7EB" } },
          bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
          left: { style: "thin", color: { argb: "FFE5E7EB" } },
          right: { style: "thin", color: { argb: "FFE5E7EB" } },
        };
        if (typeof cell.value === "number") cell.numFmt = "#,##0.00";
      });
    }

    for (const f of sheet.formulas ?? []) {
      ws.getCell(f.cell).value = { formula: f.formula };
      ws.getCell(f.cell).numFmt = "#,##0.00";
    }

    ws.columns.forEach((col, i) => {
      const width = Math.max(
        10,
        (sheet.headers[i] ?? "").length * 2 + 4,
        ...sheet.rows.slice(0, 50).map((r) => String(r[i] ?? "").length + 4),
      );
      col.width = Math.min(48, width);
    });
  }

  const file = path.join(outputDir, input.fileName);
  await workbook.xlsx.writeFile(file);
  return file;
}
