/**
 * 上传资料的解析摘要：把 parse_uploaded_files 的结果按文件汇总，
 * 供「业务资料」面板显示解析状态、工作表/行数、OCR 置信度与文本摘录，
 * 不必再去时间线里翻工具返回。
 * 纯函数，便于 apps/api/scripts/verify-file-parse.ts 直接校验。
 */

export type ParsedSheet = { name?: string; rowCount?: number; headers?: unknown[]; rows?: unknown[] };

export type ParsedDoc = {
  fileName?: string;
  fileType?: string;
  ok?: boolean;
  textPreview?: string;
  ocrProvider?: string;
  ocrConfidence?: number;
  sheets?: ParsedSheet[];
  /** 解析成功但需要注意的情况，例如 PDF 无文本层、OCR 未识别到文字 */
  error?: string;
  pages?: number;
};

export type ParseSummary = {
  fileName: string;
  ok: boolean;
  kind: "sheets" | "ocr" | "other";
  sheetCount: number;
  rowCount: number;
  columnCount: number;
  ocrConfidence: number | null;
  ocrProvider: string;
  preview: string;
  /** 解析提示（PDF 无文本层 / OCR 空白等），为空表示没有需要说明的情况 */
  warning: string;
  pages: number | null;
};

export const PARSE_STATUS_TEXT: Record<string, string> = {
  pending: "待解析",
  parsing: "解析中",
  parsed: "已解析",
  failed: "解析失败",
};

/** 解析状态中文化；未知状态原样显示，空值显示「未知」，不把英文枚举直接甩给用户 */
export function parseStatusText(status: string): string {
  if (!status) return "未知";
  return PARSE_STATUS_TEXT[status] ?? status;
}

/** 单份解析结果的摘要：表格类给出表数/行数/最大列数，扫描件给出 OCR 置信度与摘录 */
export function summarizeParsed(doc: ParsedDoc): ParseSummary {
  const sheets = Array.isArray(doc.sheets) ? doc.sheets : [];
  const rowCount = sheets.reduce((n, s) => n + (typeof s.rowCount === "number" ? s.rowCount : 0), 0);
  const columnCount = sheets.reduce((m, s) => Math.max(m, Array.isArray(s.headers) ? s.headers.length : 0), 0);
  const hasOcr = typeof doc.ocrConfidence === "number" || typeof doc.textPreview === "string";
  return {
    fileName: doc.fileName ?? "",
    ok: doc.ok !== false,
    kind: sheets.length > 0 ? "sheets" : hasOcr ? "ocr" : "other",
    sheetCount: sheets.length,
    rowCount,
    columnCount,
    ocrConfidence: typeof doc.ocrConfidence === "number" ? doc.ocrConfidence : null,
    ocrProvider: doc.ocrProvider ?? "",
    preview: (doc.textPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    warning: doc.error ?? "",
    pages: typeof doc.pages === "number" ? doc.pages : null,
  };
}

/**
 * 从工具调用结果里按文件名汇总解析摘要：只认 parse_uploaded_files，
 * 同名文件以后一次解析为准（重新上传/重新解析覆盖旧结果）。
 */
export function parsedByFileName(
  calls: Array<{ toolName: string; result: unknown }>,
): Map<string, ParseSummary> {
  const out = new Map<string, ParseSummary>();
  for (const c of calls) {
    if (c.toolName !== "parse_uploaded_files") continue;
    const parsed = (c.result as { parsed?: unknown } | null)?.parsed;
    if (!Array.isArray(parsed)) continue;
    for (const raw of parsed) {
      const s = summarizeParsed((raw ?? {}) as ParsedDoc);
      if (s.fileName) out.set(s.fileName, s);
    }
  }
  return out;
}
