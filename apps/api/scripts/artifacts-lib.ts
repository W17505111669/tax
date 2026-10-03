/**
 * 产物与工具调用的真实取数：`verify:artsrc`（产物溯源率）与 `verify:delivart`（交付 MD 的
 * 「生成产物与溯源」节）共用这一份。两处各写一遍就会各写歪一遍——本项目已经为此吃过亏
 *（修订素材的取数曾在写回脚本与界面各一份，算出两个数）。
 *
 * 形状与界面同源：`/api/reader` 列产物用的就是 `{ name, byteSize: stat.size,
 * updatedAt: stat.mtime.toISOString() }`（routes/reader.ts），所以这里走查到的行，与界面上
 * 「生成产物」区块、交付 MD 的产物节、manifest 的 artifacts 数组是同一批数据。
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";

export type TaskArtifact = { name: string; byteSize: number; updatedAt: string };
export type ToolCallLike = {
  id: string;
  toolName: string;
  at: string;
  ok: boolean | null;
  result: unknown;
};

export function taskIds(): string[] {
  return (db.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>).map((t) => t.id);
}

/** 没有产物目录、或目录里没有文件时返回 null（与既有走查的跳过条件一致） */
export function taskArtifacts(taskId: string): { artifacts: TaskArtifact[]; calls: ToolCallLike[] } | null {
  const dir = path.join(dirs.outputs, taskId);
  if (!fs.existsSync(dir)) return null;
  const artifacts = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      return { name: e.name, byteSize: stat.size, updatedAt: stat.mtime.toISOString() };
    });
  if (artifacts.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT id, tool_name, result, ok, started_at FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`,
    )
    .all(taskId) as Array<{
    id: string;
    tool_name: string;
    result: string | null;
    ok: number | null;
    started_at: string;
  }>;
  const calls = rows.map((c) => {
    let result: unknown = null;
    try {
      result = c.result ? JSON.parse(c.result) : null;
    } catch {
      result = null;
    }
    return {
      id: c.id,
      toolName: c.tool_name,
      at: c.started_at,
      ok: c.ok === 1 ? true : c.ok === 0 ? false : null,
      result,
    };
  });
  return { artifacts, calls };
}
