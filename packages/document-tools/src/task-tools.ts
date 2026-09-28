import fs from "node:fs/promises";
import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";
import type { BusinessFile } from "@tax/shared-schemas";
import { parseCsvText, parseExcelFile, type ParsedDocument } from "./excel-parser.ts";
import { parsePdfFile } from "./pdf-parser.ts";
import { generateWorkpaper, type WorkpaperSheet } from "./excel-export.ts";

export interface TaskDocumentContext {
  taskId: string;
  files: BusinessFile[];
  outputsDir: string;
}

export async function parseOne(file: BusinessFile): Promise<ParsedDocument> {
  const ext = file.fileType.toLowerCase();
  try {
    if (ext === "xlsx" || ext === "xls") {
      const sheets = await parseExcelFile(file.storagePath);
      return { fileName: file.fileName, fileType: ext, ok: true, sheets };
    }
    if (ext === "csv") {
      const text = await fs.readFile(file.storagePath, "utf8");
      return { fileName: file.fileName, fileType: ext, ok: true, sheets: parseCsvText(text) };
    }
    if (ext === "pdf") {
      const { pages, text } = await parsePdfFile(file.storagePath);
      const doc: ParsedDocument = {
        fileName: file.fileName,
        fileType: ext,
        ok: true,
        pages,
        textPreview: text.slice(0, 4000),
      };
      if (text.trim() === "") doc.error = "PDF 无文本层，需 OCR 后才能解析（OCR 待接入）";
      return doc;
    }
    if (ext === "txt" || ext === "md") {
      const text = await fs.readFile(file.storagePath, "utf8");
      return { fileName: file.fileName, fileType: ext, ok: true, textPreview: text.slice(0, 4000) };
    }
    return { fileName: file.fileName, fileType: ext, ok: false, error: `暂不支持解析 .${ext} 文件` };
  } catch (err) {
    return {
      fileName: file.fileName,
      fileType: ext,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 任务级文档工具：解析本任务上传资料、生成 Excel 工作底稿到产物目录。 */
export function createTaskDocumentTools(ctx: TaskDocumentContext): ToolDefinition[] {
  const parseTool: ToolDefinition = {
    name: "parse_uploaded_files",
    label: "解析上传资料",
    description:
      "解析本任务已上传的业务资料（Excel/CSV/PDF/TXT），返回工作表名、表头、行记录或 PDF 文本等结构化数据。金额保持原样不做换算。任务存在上传资料时必须先调用本工具再开展核查。",
    promptSnippet: "parse_uploaded_files: 解析本任务上传的 Excel/CSV/PDF/TXT 资料",
    parameters: Type.Object({
      fileNames: Type.Optional(
        Type.Array(Type.String(), { description: "指定要解析的文件名，默认解析全部" }),
      ),
    }),
    async execute(_id, params: { fileNames?: string[] }) {
      const targets = ctx.files.filter((f) => !params.fileNames || params.fileNames.includes(f.fileName));
      if (targets.length === 0) {
        return {
          content: [{ type: "text", text: "本任务没有上传资料，或指定文件名不匹配。" }],
          details: { parsed: [] },
        };
      }
      const parsed: ParsedDocument[] = [];
      for (const f of targets) parsed.push(await parseOne(f));

      const lines: string[] = [];
      for (const doc of parsed) {
        if (!doc.ok) {
          lines.push(`- ${doc.fileName}：解析失败 ${doc.error ?? ""}`);
          continue;
        }
        if (doc.sheets) {
          for (const s of doc.sheets) {
            lines.push(`- ${doc.fileName} / 工作表「${s.name}」：${s.rowCount} 行，表头：${s.headers.join("、")}`);
            for (const row of s.rows.slice(0, 8)) lines.push(`    ${JSON.stringify(row)}`);
            if (s.rowCount > 8) lines.push(`    …其余 ${s.rowCount - 8} 行省略，完整数据见 details`);
          }
        }
        if (doc.pages !== undefined) {
          lines.push(`- ${doc.fileName}：PDF 共 ${doc.pages} 页${doc.error ? `（${doc.error}）` : ""}`);
        }
        if (doc.textPreview) lines.push(`  文本摘录：${doc.textPreview.slice(0, 800)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") || "（无内容）" }], details: { parsed } };
    },
  };

  const workpaperTool: ToolDefinition = {
    name: "generate_workpaper",
    label: "生成 Excel 工作底稿",
    description:
      "生成可编辑的 Excel 专业工作底稿（表头样式、冻结首行、边框、数字格式与可选公式），保存到本任务产物目录，前端「生成产物」栏可预览与下载。金额必须使用工具已确认的数值，不得虚构。",
    promptSnippet: "generate_workpaper: 生成 Excel 专业工作底稿并归档到产物目录",
    parameters: Type.Object({
      title: Type.String(),
      sheets: Type.Array(
        Type.Object({
          name: Type.String(),
          headers: Type.Array(Type.String()),
          rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Null()]))),
          formulas: Type.Optional(
            Type.Array(Type.Object({ cell: Type.String(), formula: Type.String() })),
          ),
        }),
        { minItems: 1 },
      ),
      meta: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))),
    }),
    async execute(_id, params: { title: string; sheets: WorkpaperSheet[]; meta?: Array<{ label: string; value: string }> }) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = `底稿-${params.title.slice(0, 12)}-${stamp}.xlsx`;
      const file = await generateWorkpaper(ctx.outputsDir, {
        fileName,
        title: params.title,
        meta: params.meta,
        sheets: params.sheets,
      });
      const rowCount = params.sheets.reduce((a, s) => a + s.rows.length, 0);
      return {
        content: [
          {
            type: "text",
            text: `工作底稿已生成：${fileName}（${params.sheets.length} 张工作表、${rowCount} 行数据），已存入产物目录，可在前端「生成产物」栏预览与下载。`,
          },
        ],
        details: { fileName, path: file, sheets: params.sheets.map((s) => ({ name: s.name, rows: s.rows.length })) },
      };
    },
  };

  return [parseTool, workpaperTool];
}
