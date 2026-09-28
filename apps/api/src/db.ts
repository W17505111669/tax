import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { dirs } from "./config.ts";

export const db = new DatabaseSync(path.join(dirs.database, "tax-agent.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    instruction TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    business_category TEXT,
    parse_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    payload TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args TEXT,
    result TEXT,
    ok INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_files_task ON files(task_id);
  CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
  CREATE INDEX IF NOT EXISTS idx_toolcalls_task ON tool_calls(task_id);

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    comment TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, issue_id)
  );

  CREATE TABLE IF NOT EXISTS amount_checks (
    task_id TEXT NOT NULL,
    amount_key TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, amount_key)
  );

  CREATE TABLE IF NOT EXISTS link_checks (
    task_id TEXT NOT NULL,
    url TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    final_url TEXT,
    ms INTEGER,
    error TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (task_id, url)
  );

  CREATE TABLE IF NOT EXISTS ref_checks (
    task_id TEXT NOT NULL,
    ref_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    query TEXT NOT NULL,
    verdict TEXT NOT NULL,
    note TEXT,
    evidence_title TEXT,
    evidence_url TEXT,
    evidence_grade TEXT,
    evidence_snippet TEXT,
    attempts TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (task_id, ref_key)
  );

  CREATE INDEX IF NOT EXISTS idx_refchecks_task ON ref_checks(task_id);
`);

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 轻量迁移：给已存在的旧表补上新增列。
 * CREATE TABLE IF NOT EXISTS 不会改动已建好的表，开发库升级时会缺列；
 * 本项目表结构仍在演进，逐列补齐比整库重建安全。
 */
export function ensureColumn(table: string, column: string, ddl: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (rows.length === 0 || rows.some((r) => r.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

ensureColumn("ref_checks", "evidence_snippet", "evidence_snippet TEXT");
