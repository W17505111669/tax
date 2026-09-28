/**
 * 上传预检：扩展名白名单与大小上限都来自服务端 /api/upload-policy，
 * 前后端共用同一份配置，避免「前端放行、服务端 400」或反之。
 * 纯函数，便于 apps/api/scripts/verify-upload-policy.ts 直接校验。
 */
import { fmtBytes } from "./run-artifacts.ts";

export type UploadPolicy = { allowedExtensions: string[]; maxUploadBytes: number };

export type FileLike = { name: string; size: number };

export type FileVerdict = { ok: boolean; reason: string };

/** 取小写扩展名；没有扩展名（或以点开头）返回空串 */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 服务端白名单可能带前导点（".xlsx"）也可能不带，统一成不带点的小写形式再比较 */
export function normalizeAllowed(list: string[]): string[] {
  return list.map((e) => e.replace(/^\.+/, "").trim().toLowerCase()).filter((e) => e !== "");
}

/** 单份文件预检：类型白名单 → 大小上限 → 空文件 */
export function checkFile(file: FileLike, policy: UploadPolicy): FileVerdict {
  const ext = extensionOf(file.name);
  if (!ext) return { ok: false, reason: "缺少扩展名" };
  if (!normalizeAllowed(policy.allowedExtensions).includes(ext)) {
    return { ok: false, reason: `不支持的类型 .${ext}` };
  }
  if (file.size > policy.maxUploadBytes) {
    return { ok: false, reason: `超过上限 ${fmtBytes(policy.maxUploadBytes)}` };
  }
  if (file.size <= 0) return { ok: false, reason: "空文件" };
  return { ok: true, reason: "" };
}

/** 批量预检：分成可上传与被拒绝两组，被拒绝的带原因 */
export function partitionFiles<T extends FileLike>(
  files: T[],
  policy: UploadPolicy,
): { accepted: T[]; rejected: Array<{ name: string; reason: string }> } {
  const accepted: T[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const f of files) {
    const v = checkFile(f, policy);
    if (v.ok) accepted.push(f);
    else rejected.push({ name: f.name, reason: v.reason });
  }
  return { accepted, rejected };
}

/** 预检结果提示：最多列 3 份，其余汇总计数；全部通过时返回空串（不打扰） */
export function policyMessage(accepted: number, rejected: Array<{ name: string; reason: string }>): string {
  if (rejected.length === 0) return "";
  const detail = rejected
    .slice(0, 3)
    .map((r) => `${r.name}（${r.reason}）`)
    .join("、");
  const more = rejected.length > 3 ? ` 等 ${rejected.length} 份` : "";
  return accepted > 0
    ? `已跳过 ${rejected.length} 份不符合要求的文件：${detail}${more}`
    : `未上传，${rejected.length} 份文件不符合要求：${detail}${more}`;
}
