/**
 * 上传资料的解析摘要：把 parse_uploaded_files 的结果按文件汇总，
 * 供「业务资料」面板显示解析状态、工作表/行数、OCR 置信度与文本摘录，
 * 不必再去时间线里翻工具返回。
 * 纯函数，便于 apps/api/scripts/verify-file-parse.ts 直接校验。
 */

import { fmtBytes } from "./run-artifacts.ts";
import { mdCell } from "./run-tools.ts";

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
  kind: "sheets" | "ocr" | "text" | "other";
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
  // 只有真的走了 OCR（有引擎或置信度）才算扫描件；纯文本文件另归一类，避免显示「OCR 置信度 —」
  const hasOcr = typeof doc.ocrConfidence === "number" || Boolean(doc.ocrProvider);
  const hasText = typeof doc.textPreview === "string" && doc.textPreview.trim() !== "";
  return {
    fileName: doc.fileName ?? "",
    ok: doc.ok !== false,
    kind: sheets.length > 0 ? "sheets" : hasOcr ? "ocr" : hasText ? "text" : "other",
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

/** 解析结果的一句话描述：资料行与交付清单共用同一措辞，避免两处说法不同 */
export function parseDetail(s: ParseSummary | undefined): string {
  if (!s) return "尚无解析结果";
  if (s.kind === "sheets") return `${s.sheetCount} 个工作表 · ${s.rowCount} 行 · 最多 ${s.columnCount} 列`;
  if (s.kind === "ocr") {
    return `OCR ${s.ocrProvider || "引擎"} · 置信度 ${
      s.ocrConfidence !== null ? `${s.ocrConfidence.toFixed(1)}%` : "—"
    }`;
  }
  if (s.kind === "text") return s.preview ? "已解析（含文本摘录）" : "已解析";
  return s.ok ? "已解析" : "解析失败";
}

export type FileRow = {
  fileName: string;
  fileType: string;
  byteSize: number;
  createdAt?: string;
  parseStatus: string;
};

/** 交付包里的「业务资料清单」表：输入侧证据，与产物溯源表一前一后 */
export function fileTable(files: FileRow[], summaries: Map<string, ParseSummary>): string[] {
  if (files.length === 0) return ["（本任务未上传业务资料）", ""];
  return [
    "| # | 文件 | 类型 | 大小 | 上传时间 | 解析状态 | 解析结果 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...files.map((f, i) => {
      const s = summaries.get(f.fileName);
      const at = f.createdAt && !Number.isNaN(Date.parse(f.createdAt))
        ? new Date(f.createdAt).toLocaleString("zh-CN", { hour12: false })
        : "—";
      const detail = `${mdCell(parseDetail(s))}${s?.warning ? `（提示：${mdCell(s.warning)}）` : ""}`;
      return `| ${i + 1} | ${mdCell(f.fileName)} | ${f.fileType || "—"} | ${fmtBytes(f.byteSize)} | ${at} | ${parseStatusText(
        f.parseStatus,
      )} | ${detail} |`;
    }),
    "",
  ];
}
