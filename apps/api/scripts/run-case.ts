/**
 * 案例回归运行器：按 data/cases/<caseId>/case.json 上传资料、执行 Agent、
 * 将生成底稿与人工参考底稿比对，产出案例报告。
 * 运行：pnpm case:run <caseId>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareWorkbooks, type CompareResult } from "@tax/document-tools";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const API = process.env.API_BASE ?? "http://127.0.0.1:8787";

const caseId = process.argv[2];
if (!caseId) {
  console.error("用法: pnpm case:run <caseId>");
  process.exit(1);
}

interface CaseMeta {
  agentId: string;
  title: string;
  instruction: string;
  inputs: string[];
  expectedFile?: string;
  minAccuracy?: number;
}

const caseDir = path.join(root, "data", "cases", caseId);
if (!fs.existsSync(caseDir)) {
  console.error(`案例不存在: ${caseDir}`);
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(path.join(caseDir, "case.json"), "utf8")) as CaseMeta;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[case] ${caseId}: 创建任务…`);
  const created = (await (
    await fetch(`${API}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: meta.agentId, caseId, title: meta.title, instruction: meta.instruction }),
    })
  ).json()) as { task: { id: string } };
  const taskId = created.task.id;

  for (const rel of meta.inputs) {
    const file = path.join(caseDir, rel);
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(fs.readFileSync(file))]), path.basename(rel));
    await fetch(`${API}/api/tasks/${taskId}/files`, { method: "POST", body: form });
    console.log(`[case] 已上传 ${rel}`);
  }

  await fetch(`${API}/api/tasks/${taskId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log(`[case] 任务 ${taskId} 开始执行，轮询中…`);

  let status = "processing";
  for (let i = 0; i < 70; i += 1) {
    await sleep(6000);
    const detail = (await (await fetch(`${API}/api/tasks/${taskId}`)).json()) as { task: { status: string } };
    status = detail.task.status;
    if (status === "completed" || status === "failed") break;
  }

  const results = (await (await fetch(`${API}/api/tasks/${taskId}/results`)).json()) as {
    task: { result: string | null; error: string | null };
    toolCalls: Array<{ toolName: string; ok: boolean }>;
  };
  const chain = results.toolCalls.map((c) => `${c.toolName}:${c.ok ? "ok" : "FAIL"}`).join(" → ");

  // 取最新 xlsx 产物与人工参考底稿比对
  let compare: CompareResult | null = null;
  let artifactName: string | null = null;
  const outDir = path.join(root, "data", "outputs", taskId);
  if (fs.existsSync(outDir)) {
    const xlsx = fs
      .readdirSync(outDir)
      .filter((f) => /\.xlsx$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (xlsx.length > 0 && meta.expectedFile) {
      artifactName = xlsx[0]!.f;
      compare = await compareWorkbooks(path.join(outDir, xlsx[0]!.f), path.join(caseDir, meta.expectedFile));
    } else if (xlsx.length > 0) {
      artifactName = xlsx[0]!.f;
    }
  }

  const accuracy = compare?.totals.accuracyPercent ?? null;
  const pass =
    (status === "completed" || status === "waiting_review") &&
    results.toolCalls.every((c) => c.ok) &&
    (meta.minAccuracy === undefined || (accuracy !== null && accuracy >= meta.minAccuracy));

  const lines = [
    `# 案例回归报告：${caseId}`,
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 任务：${meta.title}（${taskId}）`,
    `- 状态：${status}`,
    `- 工具链：${chain || "—"}`,
    `- 系统底稿产物：${artifactName ?? "无"}`,
    `- 与人工参考底稿比对准确率：${accuracy === null ? "未比对" : `${accuracy}%`}`,
    "",
    "## 差异明细",
    "",
  ];
  if (compare) {
    for (const s of compare.sheets) {
      lines.push(`### 工作表「${s.sheetA}」 准确率 ${s.accuracyPercent}%`);
      lines.push("");
      lines.push("| 类型 | 位置 | 系统 | 人工 |");
      lines.push("| --- | --- | --- | --- |");
      for (const d of s.diffs) {
        lines.push(`| ${d.kind} | ${d.address} | ${d.a ?? "∅"} | ${d.b ?? "∅"} |`);
      }
      lines.push("");
    }
  } else {
    lines.push("（本案例未配置人工参考底稿或无产物）");
    lines.push("");
  }
  lines.push(`**结论：${pass ? "PASS" : "FAIL"}**`);

  const reportPath = path.join(caseDir, `report-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(reportPath, lines.join("\n"), "utf8");
  console.log(`[case] status=${status} accuracy=${accuracy === null ? "n/a" : accuracy + "%"} pass=${pass}`);
  console.log(`[case] report: ${reportPath}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error("[case] ERROR:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
