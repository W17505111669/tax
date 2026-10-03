/**
 * 运行时间窗与产物归属：时间线导出（按次运行 / 全量视图）与运行头部的「产物 N」角标共用。
 * 事件时间与产物 updatedAt 都是后端 nowIso() 产出的 UTC ISO 字符串，可直接按字典序比较。
 * 纯函数，便于 apps/api/scripts/verify-run-artifacts.ts 直接校验。
 */

import { trimZeros } from "./format.ts";

export type ArtifactLike = { name: string; byteSize: number; updatedAt: string };

/** end 为 null 表示区间开放：任务仍在执行，或历史数据缺结束事件 */
export type RunWindow = { run: number; start: string; end: string | null };

type ItemLike = { kind: string; at: string };

const END_KINDS = new Set(["run_completed", "run_failed"]);

/**
 * 从时间线事件推导每次运行的时间窗（run 从 1 开始）。
 * run_started 之前的事件不属于任何运行；结束事件之后的事件不会再把 end 往后推。
 */
export function runWindows(items: ItemLike[]): RunWindow[] {
  const out: RunWindow[] = [];
  for (const it of items) {
    if (it.kind === "run_started") {
      out.push({ run: out.length + 1, start: it.at, end: null });
      continue;
    }
    const cur = out[out.length - 1];
    if (!cur || cur.end !== null) continue;
    if (END_KINDS.has(it.kind)) cur.end = it.at;
  }
  return out;
}

/** 归属某次运行的产物：updatedAt 落在 [start, end] 内（含端点）；end 为 null 时只看下界 */
export function artifactsOfRun(artifacts: ArtifactLike[], win: RunWindow | undefined): ArtifactLike[] {
  if (!win) return [];
  return artifacts.filter((a) => a.updatedAt >= win.start && (win.end === null || a.updatedAt <= win.end));
}

/** 未归属到任何运行的产物：首次 run_started 之前生成，或落在两次运行之间 */
export function unattributedArtifacts(artifacts: ArtifactLike[], windows: RunWindow[]): ArtifactLike[] {
  return artifacts.filter(
    (a) => !windows.some((w) => a.updatedAt >= w.start && (w.end === null || a.updatedAt <= w.end)),
  );
}

/**
 * 某个产物属于第几次运行：取第一个「时间窗包含它」的运行。归不到任何一次时返回 null，
 * 由调用方如实写成「—」，不猜。
 *
 * 此前这段逻辑是 TaskWorkbench 里的一个闭包，而交付 MD 的「所属运行」列与 manifest 的 run
 * 字段都靠它——两个对外声称共用一份取数，却谁也测不到它。搬到这里与 artifactsOfRun /
 * unattributedArtifacts 作伴，三个函数共用同一套时间窗判据。
 */
export function runOfArtifact(
  artifacts: ArtifactLike[],
  windows: RunWindow[],
  name: string,
): number | null {
  const a = artifacts.find((x) => x.name === name);
  if (!a) return null;
  const w = windows.find((x) => artifactsOfRun([a], x).length > 0);
  return w ? w.run : null;
}

/** 字节数格式化：导出表格与角标 tooltip 共用；整数不带小数（25 MB 而不是 25.00 MB） */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${trimZeros((n / 1024).toFixed(1))} KB`;
  return `${trimZeros((n / 1024 / 1024).toFixed(2))} MB`;
}

/** 产物清单的 Markdown 表格；空清单给出明确说明，避免看起来像漏了内容 */
export function artifactTable(artifacts: ArtifactLike[], emptyHint: string): string[] {
  if (artifacts.length === 0) return [emptyHint, ""];
  return [
    "| 文件 | 大小 | 更新时间 |",
    "| --- | --- | --- |",
    ...artifacts.map((a) => `| ${a.name} | ${fmtBytes(a.byteSize)} | ${a.updatedAt} |`),
    "",
  ];
}
