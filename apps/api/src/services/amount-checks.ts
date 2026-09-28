/**
 * 结论金额的人工核对标记：金额溯源列为「待人工确认」的金额，税务师核对后可以标记，
 * 标记后不再计入交付自检的提醒项；标记可撤销，键为「值（分）|原文片段」。
 */
import { db, nowIso } from "../db.ts";

export interface AmountCheck {
  key: string;
  note: string;
  createdAt: string;
}

export function listAmountChecks(taskId: string): AmountCheck[] {
  const rows = db
    .prepare(`SELECT amount_key, note, created_at FROM amount_checks WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as unknown as Array<{ amount_key: string; note: string | null; created_at: string }>;
  return rows.map((r) => ({ key: r.amount_key, note: r.note ?? "", createdAt: r.created_at }));
}

/** checked=true 写入（重复写入更新备注与时间），false 撤销；返回写入后的记录或 null */
export function setAmountCheck(taskId: string, key: string, checked: boolean, note: string): AmountCheck | null {
  if (!checked) {
    db.prepare(`DELETE FROM amount_checks WHERE task_id = ? AND amount_key = ?`).run(taskId, key);
    return null;
  }
  const at = nowIso();
  db.prepare(
    `INSERT INTO amount_checks (task_id, amount_key, note, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (task_id, amount_key) DO UPDATE SET note = excluded.note, created_at = excluded.created_at`,
  ).run(taskId, key, note, at);
  return { key, note, createdAt: at };
}
