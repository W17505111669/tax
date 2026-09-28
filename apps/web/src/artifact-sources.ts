/**
 * 产物溯源：把「生成产物」列表里的文件与真正生成它的工具调用对应起来。
 * 工具结果里的 fileName / path / outputPath 等字段带文件名（可能是 Windows 绝对路径），
 * 取基名与产物名比对即可确定性归属，不需要按时间猜。
 * 纯函数，便于 apps/api/scripts/verify-artifact-sources.ts 直接校验。
 */

/** role=producer：该调用生成了产物；role=ref：产物只在该调用结果里被引用（例如作为比对输入） */
export type SourceCall = { id: string; toolName: string; at: string; role: "producer" | "ref" };

export type CallLike = { id: string; toolName: string; at: string; result: unknown; ok: boolean | null };

/** 只认这些键的字符串值为文件名，避免把工作表名等 name 字段误当成产物 */
const NAME_KEYS = new Set([
  "fileName",
  "filename",
  "path",
  "outputPath",
  "output_path",
  "file",
  "artifact",
  "artifactName",
  "savedTo",
]);

const MAX_DEPTH = 8;
const MAX_NODES = 4000;

/** 取路径基名：兼容 Windows 反斜杠与 POSIX 斜杠 */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const FILELIKE_RE = /\.[A-Za-z0-9]{1,5}$/;

/** 收集结果里所有「像文件名」的字符串基名，用于引用级溯源（键名不在白名单时的兜底） */
export function fileLikeNames(result: unknown, depth = 0, budget = { n: 0 }): string[] {
  const out: string[] = [];
  if (depth > MAX_DEPTH || result === null || typeof result !== "object") return out;
  if (Array.isArray(result)) {
    for (const v of result) {
      if (budget.n++ > MAX_NODES) break;
      out.push(...fileLikeNames(v, depth + 1, budget));
    }
    return out;
  }
  for (const v of Object.values(result as Record<string, unknown>)) {
    if (budget.n++ > MAX_NODES) break;
    if (typeof v === "string") {
      const s = v.trim();
      if (FILELIKE_RE.test(s)) out.push(basename(s));
      continue;
    }
    out.push(...fileLikeNames(v, depth + 1, budget));
  }
  return out;
}
/** 递归收集工具结果里出现过的文件名（命中白名单键的字符串值取基名） */
export function namesInResult(result: unknown, depth = 0, budget = { n: 0 }): string[] {
  const out: string[] = [];
  if (depth > MAX_DEPTH || result === null || typeof result !== "object") return out;
  if (Array.isArray(result)) {
    for (const v of result) {
      if (budget.n++ > MAX_NODES) break;
      out.push(...namesInResult(v, depth + 1, budget));
    }
    return out;
  }
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (budget.n++ > MAX_NODES) break;
    if (typeof v === "string") {
      if (NAME_KEYS.has(k)) {
        const b = basename(v.trim());
        if (b) out.push(b);
      }
      continue;
    }
    out.push(...namesInResult(v, depth + 1, budget));
  }
  return out;
}

/**
 * 产物名 → 相关工具调用。先按白名单键认定「生产者」（同一产物多次生成取最后一次，覆盖写），
 * 仍无生产者的产物再按「结果里出现过同名文件」认定为被引用（取最早一次引用）。
 * 只认未失败的调用（ok !== false）；两者都找不到的产物不出现在返回的 Map 里。
 */
export function artifactSources(artifactNames: string[], calls: CallLike[]): Map<string, SourceCall> {
  const out = new Map<string, SourceCall>();
  const wanted = new Set(artifactNames);
  for (const c of calls) {
    if (c.ok === false) continue;
    for (const n of namesInResult(c.result)) {
      if (wanted.has(n)) out.set(n, { id: c.id, toolName: c.toolName, at: c.at, role: "producer" });
    }
  }
  for (const c of calls) {
    if (c.ok === false) continue;
    for (const n of fileLikeNames(c.result)) {
      if (wanted.has(n) && !out.has(n)) out.set(n, { id: c.id, toolName: c.toolName, at: c.at, role: "ref" });
    }
  }
  return out;
}
