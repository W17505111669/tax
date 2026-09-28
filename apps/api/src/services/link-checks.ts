/**
 * 引用链接可达性核验与持久化。
 * 分级判定（可访问 / 反爬拒绝 / 失效 / 无法核验）在前端纯函数 link-check.ts 中，
 * 这里只负责发起请求、套用内网地址拦截、以及按任务存取核验记录。
 */
import { db, nowIso } from "../db.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 只允许 http/https，拒绝 localhost、*.local 与常见内网网段（与阅读模式同一套校验） */
export function assertSafeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https 链接: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host)) {
    throw new Error(`禁止访问内网地址: ${raw}`);
  }
  return url;
}

export interface LinkCheck {
  url: string;
  ok: boolean;
  status: number | null;
  finalUrl: string;
  ms: number;
  error?: string;
  checkedAt?: string;
}

/**
 * 单条链接核验：用 GET（不少站点对 HEAD 返回 405），8 秒超时，
 * 只取状态与最终地址、立即取消响应体，避免为核验下载整页内容。
 */
export async function checkLink(raw: string): Promise<LinkCheck> {
  const started = Date.now();
  try {
    const target = assertSafeUrl(raw);
    const res = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel();
    return {
      url: raw,
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || target.toString(),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      url: raw,
      ok: false,
      status: null,
      finalUrl: raw,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function listLinkChecks(taskId: string): LinkCheck[] {
  const rows = db
    .prepare(
      // 按 URL 排序保证列表稳定：单个链接重新核验不会让整份清单跳序
      `SELECT url, ok, status, final_url, ms, error, checked_at FROM link_checks WHERE task_id = ? ORDER BY url ASC`,
    )
    .all(taskId) as unknown as Array<{
    url: string;
    ok: number;
    status: number | null;
    final_url: string | null;
    ms: number | null;
    error: string | null;
    checked_at: string;
  }>;
  return rows.map((r) => ({
    url: r.url,
    ok: r.ok === 1,
    status: r.status,
    finalUrl: r.final_url ?? r.url,
    ms: r.ms ?? 0,
    ...(r.error ? { error: r.error } : {}),
    checkedAt: r.checked_at,
  }));
}

/** 写入一批核验结果（同一 URL 覆盖为最新一次），返回本批的核验时间 */
export function saveLinkChecks(taskId: string, results: LinkCheck[]): string {
  const at = nowIso();
  const stmt = db.prepare(
    `INSERT INTO link_checks (task_id, url, ok, status, final_url, ms, error, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, url) DO UPDATE SET
       ok = excluded.ok, status = excluded.status, final_url = excluded.final_url,
       ms = excluded.ms, error = excluded.error, checked_at = excluded.checked_at`,
  );
  for (const r of results) {
    stmt.run(taskId, r.url, r.ok ? 1 : 0, r.status, r.finalUrl, r.ms, r.error ?? null, at);
  }
  return at;
}
