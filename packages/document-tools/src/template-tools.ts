import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";
import type { TaskDocumentContext } from "./task-tools.ts";

export interface TemplateSheetInfo {
  name: string;
  rowCount: number;
  columnCount: number;
  mergedRanges: string[];
  formulaCells: Array<{ cell: string; formula: string }>;
  cells: Array<{ cell: string; value: string | number }>;
}

export interface TemplateInspection {
  fileName: string;
  sheets: TemplateSheetInfo[];
}

function mergedRangesOf(ws: ExcelJS.Worksheet): string[] {
  const model = (ws as unknown as { model?: { merges?: string[] } }).model;
  return [...new Set(model?.merges ?? [])];
}

function isFormulaValue(value: unknown): value is { formula: string } {
  return typeof value === "object" && value !== null && typeof (value as { formula?: unknown }).formula === "string";
}

/** 读取模板结构：工作表、合并单元格、公式单元格分布与非空单元格清单。 */
export async function inspectTemplate(filePath: string, maxCells = 150): Promise<TemplateInspection> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets: TemplateSheetInfo[] = workbook.worksheets.map((ws) => {
    const mergedRanges = mergedRangesOf(ws);
    const formulaCells: Array<{ cell: string; formula: string }> = [];
    const cells: Array<{ cell: string; value: string | number }> = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (isFormulaValue(cell.value)) {
          if (formulaCells.length < 60) formulaCells.push({ cell: cell.address, formula: cell.value.formula });
          return;
        }
        const v = cell.value;
        if (typeof v === "string" || typeof v === "number") {
          if (cells.length < maxCells) cells.push({ cell: cell.address, value: v });
        }
      });
    });
    return {
      name: ws.name,
      rowCount: ws.actualRowCount,
      columnCount: ws.actualColumnCount,
      mergedRanges,
      formulaCells,
      cells,
    };
  });
  return { fileName: path.basename(filePath), sheets };
}

export interface FillWrite {
  sheet: string;
  cell: string;
  value: string | number | null;
}

export interface FillResult {
  outputPath: string;
  fileName: string;
  written: number;
  preservedFormulas: number;
  mergedRangeCount: number;
}

/**
 * 保留式填列：在原模板副本上按单元格地址写入，保留全部公式、合并单元格与样式；
 * 拒绝覆盖公式单元格；原始上传模板永不修改。
 */
export async function fillTemplate(
  templatePath: string,
  outputDir: string,
  outputName: string,
  writes: FillWrite[],
): Promise<FillResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  let written = 0;
  for (const w of writes) {
    const ws = workbook.getWorksheet(w.sheet);
    if (!ws) throw new Error(`工作表不存在: ${w.sheet}`);
    const cell = ws.getCell(w.cell);
    if (isFormulaValue(cell.value)) {
      throw new Error(`拒绝覆盖公式单元格 ${w.sheet}!${w.cell}（公式 ${(cell.value as { formula: string }).formula}），请改填数据单元格`);
    }
    cell.value = w.value === null ? (undefined as unknown as ExcelJS.CellValue) : w.value;
    written += 1;
  }

  let preservedFormulas = 0;
  let mergedRangeCount = 0;
  for (const ws of workbook.worksheets) {
    mergedRangeCount += mergedRangesOf(ws).length;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (isFormulaValue(cell.value)) preservedFormulas += 1;
      });
    });
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, outputName);
  await workbook.xlsx.writeFile(outputPath);
  return { outputPath, fileName: outputName, written, preservedFormulas, mergedRangeCount };
}

/** 土增智填专属：模板检查与安全填列工具。 */
export function createTemplateTools(ctx: TaskDocumentContext): ToolDefinition[] {
  const findTemplate = (fileName?: string) => {
    const list = ctx.files.filter((f) => /^(xlsx|xls)$/i.test(f.fileType));
    if (fileName) {
      const hit = list.find((f) => f.fileName === fileName);
      if (!hit) throw new Error(`上传资料中找不到 Excel 文件: ${fileName}`);
      return hit;
    }
    if (list.length === 0) throw new Error("本任务未上传 Excel 模板");
    return list[0]!;
  };

  const inspectTool: ToolDefinition = {
    name: "inspect_workpaper_template",
    label: "检查工作底稿模板",
    description:
      "读取上传的 Excel 工作底稿模板结构：工作表、行列范围、合并单元格、公式单元格分布与非空单元格清单（含地址）。填表前必须先调用本工具确定写入地址，不得猜测单元格位置。",
    promptSnippet: "inspect_workpaper_template: 读取底稿模板结构与公式/合并单元格分布",
    parameters: Type.Object({
      fileName: Type.Optional(Type.String({ description: "模板文件名，默认第一个上传的 Excel" })),
    }),
    async execute(_id, params: { fileName?: string }) {
      const file = findTemplate(params.fileName);
      const inspection = await inspectTemplate(file.storagePath);
      const lines = inspection.sheets.map((s) => {
        const head = `- 工作表「${s.name}」：${s.rowCount} 行 × ${s.columnCount} 列；合并区域 ${s.mergedRanges.join(", ") || "无"}；公式单元格 ${s.formulaCells.length} 个`;
        const formulas = s.formulaCells.slice(0, 12).map((f) => `    公式 ${f.cell} = ${f.formula}`).join("\n");
        const cells = s.cells.slice(0, 40).map((c) => `    ${c.cell} = ${c.value}`).join("\n");
        return [head, formulas, cells].filter(Boolean).join("\n");
      });
      return {
        content: [{ type: "text", text: `模板 ${inspection.fileName} 结构：\n${lines.join("\n")}` }],
        details: inspection,
      };
    },
  };

  const fillTool: ToolDefinition = {
    name: "fill_land_vat_workpaper",
    label: "填列土增清算底稿",
    description:
      "在原始 Excel 模板的副本上按单元格地址填列数据，保留模板全部公式、合并单元格与样式，另存为新文件到产物目录（原始模板不被修改）。拒绝覆盖公式单元格。金额必须来自 match/check 工具的确定性结果。",
    promptSnippet: "fill_land_vat_workpaper: 按单元格地址保留式填列底稿并归档产物",
    parameters: Type.Object({
      fileName: Type.Optional(Type.String({ description: "模板文件名，默认第一个上传的 Excel" })),
      outputName: Type.Optional(Type.String({ description: "输出文件名，默认 已填列-<模板名>" })),
      writes: Type.Array(
        Type.Object({
          sheet: Type.String(),
          cell: Type.String({ description: "单元格地址，如 B4" }),
          value: Type.Union([Type.String(), Type.Number(), Type.Null()]),
        }),
        { minItems: 1, maxItems: 500 },
      ),
    }),
    async execute(_id, params: { fileName?: string; outputName?: string; writes: FillWrite[] }) {
      const file = findTemplate(params.fileName);
      const outputName = params.outputName ?? `已填列-${file.fileName}`;
      const result = await fillTemplate(file.storagePath, ctx.outputsDir, outputName, params.writes);
      return {
        content: [
          {
            type: "text",
            text: `底稿填列完成：${result.fileName}（写入 ${result.written} 个单元格，保留公式 ${result.preservedFormulas} 个、合并区域 ${result.mergedRangeCount} 处），已存入产物目录，可在前端「生成产物」预览与下载。原始模板未修改。`,
          },
        ],
        details: result,
      };
    },
  };

  return [inspectTool, fillTool];
}
