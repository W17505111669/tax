import { db } from "./apps/api/src/db.ts";
import { listTasks, getTask } from "./apps/api/src/services/task-store.ts";
import { extractCitations } from "./apps/web/src/search-evidence.ts";
let inText = 0, covered = 0, missed = 0; const samples: string[] = [];
for (const t of listTasks()) {
  const text = getTask(t.id)?.result ?? "";
  if (!text.trim()) continue;
  const rows = db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`).all(t.id) as any[];
  const calls = rows.map(r => { try { return { toolName: r.tool_name, result: r.result ? JSON.parse(r.result) : null } } catch { return { toolName: r.tool_name, result: null } } });
  const cites = new Set(extractCitations(calls).map(c => c.url));
  const urls = new Set([...text.matchAll(/https?:\/\/[^\s)\]>"'，。；、]+/g)].map(m => m[0].replace(/[.,;]+$/, "")));
  for (const u of urls) {
    inText++;
    if (cites.has(u)) covered++;
    else { missed++; if (samples.length < 6) samples.push(`${t.id.slice(0,8)} ${u.slice(0, 84)}`); }
  }
}
console.log(`结论正文里的 URL：${inText} 条 · 已在引用清单 ${covered} · 未覆盖 ${missed}`);
for (const s of samples) console.log("  -", s);
