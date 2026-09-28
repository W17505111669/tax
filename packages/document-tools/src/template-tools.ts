import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";
import { yuanToCents } from "@tax/shared-schemas";
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

function isFormulaValue(value: unknown): value is { formula: string } {
  return typeof value === "object" && value !== null && typeof (value as { formula?: unknown }).formula === "string";
}

function mergedRangesOf(ws: ExcelJS.Worksheet): string[] {
  const model = (ws as unknown as { model?: { merges?: string[] } }).model;
  return [...new Set(model?.merges ?? [])];
}

/** 读取模板结构：工作表、合并单元格、公式单元格分布与非空单元格清单。 */
export async function inspectTemplate(filePath: string, maxCells = 150): Promise<TemplateInspection> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets: TemplateSheetInfo[] = workbook.worksheets.map((ws) => {
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
      mergedRanges: mergedRangesOf(ws),
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

async function saveWithStats(
  workbook: ExcelJS.Workbook,
  outputDir: string,
  outputName: string,
  written: number,
): Promise<FillResult> {
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

/**
 * 保留式填列（地址模式）：在原始模板副本上按单元格地址写入，保留全部公式、合并与样式；
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
      throw new Error(`拒绝覆盖公式单元格 ${w.sheet}!${w.cell}，请改填数据单元格`);
    }
    cell.value = w.value === null ? (undefined as unknown as ExcelJS.CellValue) : w.value;
    written += 1;
  }
  return saveWithStats(workbook, outputDir, outputName, written);
}

export interface MappedFillSpec {
  sheet: string;
  headerRow?: number;
  startRow?: number;
  columns: {
    contractNo?: string;
    contractName?: string;
    contractAmount?: string;
    invoiceTotal?: string;
  };
  rows: Array<{
    contractNo: string;
    contractName?: string;
    contractAmountYuan: string;
    invoiceTotalYuan: string;
  }>;
}

export interface MappedFillResult extends FillResult {
  headerRow: number;
  startRow: number;
  columnIndexes: Record<string, number>;
  writtenCells: Array<{ address: string; field: string; value: string | number }>;
  skippedFormulaCells: string[];
}

/** 元字符串 → 两位小数数值（整数分换算，避免浮点误差）。 */
function yuanNumber(value: string): number {
  return Number((yuanToCents(value) / 100).toFixed(2));
}

/**
 * 保留式填列（映射模式）：模型只提供表头列名与数据行，
 * 表头行定位、列定位、写入地址计算、金额换算与公式避让全部由本函数确定性完成。
 */
export async function fillTemplateMapped(
  templatePath: string,
  outputDir: string,
  outputName: string,
  spec: MappedFillSpec,
): Promise<MappedFillResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const ws = workbook.getWorksheet(spec.sheet);
  if (!ws) throw new Error(`工作表不存在: ${spec.sheet}`);

  const wanted = (Object.entries(spec.columns) as Array<[string, string | undefined]>).filter(
    (entry): entry is [string, string] => Boolean(entry[1]),
  );
  if (wanted.length === 0) throw new Error("映射模式至少需要一个列映射");

  const rowTexts = (r: number): string[] => {
    const out: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
      out[col] = String(cell.value ?? "");
    });
    return out;
  };

  let headerRow = spec.headerRow ?? 0;
  if (!headerRow) {
    for (let r = 1; r <= 40; r += 1) {
      const texts = rowTexts(r);
      const hits = wanted.filter(([, name]) => texts.some((t) => t && t.includes(name))).length;
      if (hits >= Math.min(2, wanted.length)) {
        headerRow = r;
        break;
      }
    }
  }
  if (!headerRow) throw new Error("未找到表头行，请显式指定 headerRow");

  const texts = rowTexts(headerRow);
  const columnIndexes: Record<string, number> = {};
  for (const [field, name] of wanted) {
    const idx = texts.findIndex((t) => t && t.includes(name));
    if (idx < 1) throw new Error(`表头行未找到列「${name}」`);
    columnIndexes[field] = idx;
  }

  const startRow = spec.startRow ?? headerRow + 1;
  const writtenCells: Array<{ address: string; field: string; value: string | number }> = [];
  const skippedFormulaCells: string[] = [];

  spec.rows.forEach((row, i) => {
    const r = startRow + i;
    const put = (field: string, value: string | number) => {
      const col = columnIndexes[field];
      if (col === undefined) return;
      const cell = ws.getCell(r, col);
      if (isFormulaValue(cell.value)) {
        skippedFormulaCells.push(cell.address);
        return;
      }
      cell.value = value as ExcelJS.CellValue;
      writtenCells.push({ address: cell.address, field, value });
    };
    put("contractNo", row.contractNo);
    if (row.contractName !== undefined) put("contractName", row.contractName);
    put("contractAmount", yuanNumber(row.contractAmountYuan));
    put("invoiceTotal", yuanNumber(row.invoiceTotalYuan));
  });

  const result = await saveWithStats(workbook, outputDir, outputName, writtenCells.length);
  return { ...result, headerRow, startRow, columnIndexes, writtenCells, skippedFormulaCells };
}

const MappedRowSchema = Type.Object({
  contractNo: Type.String(),
  contractName: Type.Optional(Type.String()),
  contractAmountYuan: Type.String({ description: "合同金额（元）字符串" }),
  invoiceTotalYuan: Type.String({ description: "关联发票合计（元）字符串，来自 match 工具汇总" }),
});

/** 土增智填专属：模板检查与安全填列工具（地址模式 + 映射模式）。 */
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
      "读取上传的 Excel 工作底稿模板结构：工作表、行列范围、合并单元格、公式单元格分布与非空单元格清单（含地址）。填表前必须先调用本工具确定表头行与列名，不得猜测单元格位置。",
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
      "在原始 Excel 模板副本上保留式填列（保留全部公式、合并与样式，另存为新文件，原始模板不修改）。优先使用 mapped 映射模式：提供工作表名、表头列名与数据行，由工具自动定位表头行、列与写入地址并换算金额；仅当模板无规则表头时才使用 writes 地址模式。两种模式均拒绝覆盖公式单元格。金额必须来自 match/check 工具的确定性结果。",
    promptSnippet: "fill_land_vat_workpaper: 映射式/地址式保留填列底稿并归档产物",
    parameters: Type.Object({
      fileName: Type.Optional(Type.String({ description: "模板文件名，默认第一个上传的 Excel" })),
      outputName: Type.Optional(Type.String({ description: "输出文件名，默认 已填列-<模板名>" })),
      writes: Type.Optional(
        Type.Array(
          Type.Object({
            sheet: Type.String(),
            cell: Type.String({ description: "单元格地址，如 B4" }),
            value: Type.Union([Type.String(), Type.Number(), Type.Null()]),
          }),
          { minItems: 1, maxItems: 500 },
        ),
      ),
      mapped: Type.Optional(
        Type.Object({
          sheet: Type.String(),
          headerRow: Type.Optional(Type.Integer({ description: "表头行号，缺省自动探测" })),
          startRow: Type.Optional(Type.Integer({ description: "首行数据行号，缺省为表头行+1" })),
          columns: Type.Object({
            contractNo: Type.Optional(Type.String({ description: "合同编号列的表头文字，如 合同编号" })),
            contractName: Type.Optional(Type.String()),
            contractAmount: Type.Optional(Type.String({ description: "合同金额列的表头文字" })),
            invoiceTotal: Type.Optional(Type.String({ description: "发票合计列的表头文字" })),
          }),
          rows: Type.Array(MappedRowSchema, { minItems: 1, maxItems: 200 }),
        }),
      ),
    }),
    async execute(_id, params: { fileName?: string; outputName?: string; writes?: FillWrite[]; mapped?: MappedFillSpec }) {
      const file = findTemplate(params.fileName);
      const outputName = params.outputName ?? `已填列-${file.fileName}`;

      if (params.mapped) {
        const result = await fillTemplateMapped(file.storagePath, ctx.outputsDir, outputName, params.mapped);
        return {
          content: [
            {
              type: "text",
              text: `底稿映射填列完成：${result.fileName}（表头行 ${result.headerRow}，数据自第 ${result.startRow} 行，写入 ${result.written} 格，跳过公式格 ${result.skippedFormulaCells.length} 个，保留公式 ${result.preservedFormulas} 个、合并区域 ${result.mergedRangeCount} 处）。原始模板未修改。`,
            },
          ],
          details: result,
        };
      }

      if (!params.writes || params.writes.length === 0) {
        throw new Error("必须提供 mapped 或 writes 之一");
      }
      const result = await fillTemplate(file.storagePath, ctx.outputsDir, outputName, params.writes);
      return {
        content: [
          {
            type: "text",
            text: `底稿填列完成：${result.fileName}（写入 ${result.written} 个单元格，保留公式 ${result.preservedFormulas} 个、合并区域 ${result.mergedRangeCount} 处），已存入产物目录。原始模板未修改。`,
          },
        ],
        details: result,
      };
    },
  };

  return [inspectTool, fillTool];
}
