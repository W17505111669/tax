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
`);

export function nowIso(): string {
  return new Date().toISOString();
}
