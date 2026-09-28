import fs from "node:fs";
import path from "node:path";
import { db } from "../db.ts";
import { dirs } from "../config.ts";

export interface AgentStats {
  agentId: string;
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
}

export interface PlatformStats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  ocrRuns: number;
  ocrAvgConfidence: number | null;
  perAgent: AgentStats[];
  perTool: Array<{ name: string; calls: number; ok: number }>;
}

/** 平台级应用效果统计：全部来自数据库真实运行记录。 */
export function computePlatformStats(): PlatformStats {
  const tasks = db.prepare(`SELECT id, agent_id, status FROM tasks`).all() as unknown as Array<{
    id: string;
    agent_id: string;
    status: string;
  }>;

  const perAgentMap = new Map<string, AgentStats>();
  const perToolMap = new Map<string, { name: string; calls: number; ok: number }>();
  let toolCalls = 0;
  let toolOk = 0;
  let artifacts = 0;
  let compareAccuracy: number | null = null;
  let compareRuns = 0;
  let ocrConfSum = 0;
  let ocrRuns = 0;

  for (const task of tasks) {
    let agent = perAgentMap.get(task.agent_id);
    if (!agent) {
      agent = { agentId: task.agent_id, tasks: 0, completed: 0, toolCalls: 0, toolOk: 0, artifacts: 0 };
      perAgentMap.set(task.agent_id, agent);
    }
    agent.tasks += 1;
    if (task.status === "completed") agent.completed += 1;

    const calls = db
      .prepare(`SELECT ok, tool_name, result FROM tool_calls WHERE task_id = ?`)
      .all(task.id) as unknown as Array<{ ok: number | null; tool_name: string; result: string | null }>;
    agent.toolCalls += calls.length;
    toolCalls += calls.length;
    const okCount = calls.filter((c) => c.ok === 1).length;
    agent.toolOk += okCount;
    toolOk += okCount;
    for (const call of calls) {
      let bucket = perToolMap.get(call.tool_name);
      if (!bucket) {
        bucket = { name: call.tool_name, calls: 0, ok: 0 };
        perToolMap.set(call.tool_name, bucket);
      }
      bucket.calls += 1;
      if (call.ok === 1) bucket.ok += 1;
    }

    const dir = path.join(dirs.outputs, task.id);
    if (fs.existsSync(dir)) {
      const n = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).length;
      agent.artifacts += n;
      artifacts += n;
    }

    for (const call of calls) {
      if (call.tool_name === "parse_uploaded_files" && call.ok === 1 && call.result) {
        try {
          const parsed = JSON.parse(call.result) as { parsed?: Array<{ ocrConfidence?: number }> };
          for (const doc of parsed.parsed ?? []) {
            if (typeof doc.ocrConfidence === "number") {
              ocrRuns += 1;
              ocrConfSum += doc.ocrConfidence;
            }
          }
        } catch {
          // 忽略坏记录
        }
      }
      if (call.tool_name !== "compare_workpapers" || call.ok !== 1 || !call.result) continue;
      try {
        const parsed = JSON.parse(call.result) as {
          sheets?: Array<{ mode?: string }>;
          totals?: { accuracyPercent?: number };
        };
        if (parsed.sheets?.[0]?.mode === "record" && parsed.totals?.accuracyPercent !== undefined) {
          compareAccuracy = parsed.totals.accuracyPercent;
          compareRuns += 1;
        }
      } catch {
        // 忽略坏记录
      }
    }
  }

  return {
    tasks: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    toolCalls,
    toolOk,
    artifacts,
    compareAccuracy,
    compareRuns,
    ocrRuns,
    ocrAvgConfidence: ocrRuns > 0 ? Math.round((ocrConfSum / ocrRuns) * 100) / 100 : null,
    perAgent: [...perAgentMap.values()],
    perTool: [...perToolMap.values()].sort((a, b) => b.calls - a.calls),
  };
}
