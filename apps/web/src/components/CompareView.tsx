import { useEffect, useMemo, useState } from "react";
import type { CompareRecord, CompareRef } from "../types.ts";
import { IconAlert, IconCheck, IconCopy, IconDownload } from "./Icons.tsx";

const KIND_META = {
  mismatch: { label: "差异", cls: "border-rose-400/40 bg-rose-400/10 text-rose-300" },
  only_a: { label: "仅系统", cls: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  only_b: { label: "仅人工", cls: "border-sky-400/40 bg-sky-400/10 text-sky-300" },
} as const;

function fmt(v: string | number | null): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(v);
}

/** 底稿比对视图：准确率 KPI + 差异高亮表，服务交付质检与答辩展示。 */
interface Props {
  compares: CompareRecord[];
  onOpenTarget: (ref: CompareRef) => void;
}

export function CompareView({ compares, onOpenTarget }: Props) {
  const [sel, setSel] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<"all" | "mismatch" | "only_a" | "only_b">(() => {
    const v = localStorage.getItem("taxai-compare-kind");
    return v === "mismatch" || v === "only_a" || v === "only_b" ? v : "all";
  });
  const [trendHover, setTrendHover] = useState<number | null>(null);
  const [addrQuery, setAddrQuery] = useState("");

  const matchFilter = (d: { kind: string; address: string }) =>
    (kindFilter === "all" || d.kind === kindFilter) &&
    (addrQuery.trim() === "" || d.address.toLowerCase().includes(addrQuery.trim().toLowerCase()));

  useEffect(() => {
    localStorage.setItem("taxai-compare-kind", kindFilter);
  }, [kindFilter]);

  const [onlyLatest, setOnlyLatest] = useState(false);
  const shownCompares = onlyLatest ? compares.slice(-1) : compares;
  const [baseId, setBaseId] = useState<string | null>(null);
  const baseRec = baseId ? shownCompares.find((c) => c.id === baseId) ?? compares.find((c) => c.id === baseId) : undefined;
  const flat = useMemo(
    () =>
      shownCompares.flatMap((rec) =>
        rec.result?.totals
          ? rec.result.sheets.flatMap((s) =>
              s.diffs.filter(matchFilter).map((d) => ({ rec, addr: d.address })),
            )
          : [],
      ),
    [shownCompares, kindFilter, addrQuery],
  );

  // ↑/↓ 选择差异行，Enter 在阅读器中打开双底稿定位
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || flat.length === 0) return;
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        setSel(e.key === "Home" ? 0 : flat.length - 1);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((prev) =>
          prev === null ? 0 : Math.min(flat.length - 1, Math.max(0, prev + (e.key === "ArrowDown" ? 1 : -1))),
        );
      } else if (e.key === "Enter" && sel !== null) {
        const item = flat[sel];
        if (item) openBoth(item.rec, item.addr);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, sel]);

  useEffect(() => {
    if (sel === null) return;
    document.querySelector(`[data-diffidx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const exportReport = (rec: CompareRecord) => {
    const t = rec.result.totals;
    const lines = [
      "# 底稿比对报告",
      "",
      `- 时间：${rec.at ?? "—"}`,
      `- 模式：${rec.result.sheets[0]?.mode === "address" ? "地址级" : "记录级"}`,
      `- 系统底稿 (A)：${rec.result.a?.name ?? "—"}`,
      `- 人工底稿 (B)：${rec.result.b?.name ?? "—"}`,
      `- 总准确率：${t.accuracyPercent}%（比对 ${t.compared}：一致 ${t.matched}、差异 ${t.mismatched}、仅A ${t.onlyA}、仅B ${t.onlyB}）`,
      "",
    ];
    for (const s of rec.result.sheets) {
      lines.push(`## 工作表「${s.sheetA}」 准确率 ${s.accuracyPercent}%`);
      lines.push("");
      lines.push("| 类型 | 位置 | 系统底稿 (A) | 人工底稿 (B) |");
      lines.push("| --- | --- | --- | --- |");
      for (const d of s.diffs) {
        lines.push(`| ${d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅系统" : "仅人工"} | ${d.address} | ${d.a ?? "∅"} | ${d.b ?? "∅"} |`);
      }
      lines.push("");
    }
    lines.push("## 操作与复现", "");
    lines.push("- 比对视图 ↑/↓ 选择差异行、Enter 在阅读器打开双底稿并定位；点击差异行同样联动。");
    lines.push("- 阅读器高亮行自动滚至视口中央；审查结论引用胶囊可在阅读器打开原文；Esc 收起阅读器/续跑面板。");
    lines.push("");
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `底稿比对报告-${(rec.at ?? "").slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 差异摘要纯文本版（与 CSV 互补，便于粘贴聊天/工单）
  const copySummary = (rec: CompareRecord) => {
    const t = rec.result.totals;
    const lines = [
      `比对准确率 ${t.accuracyPercent}%（比对 ${t.compared}：一致 ${t.matched}、差异 ${t.mismatched}、仅A ${t.onlyA}、仅B ${t.onlyB}）`,
    ];
    for (const s of rec.result.sheets) {
      for (const d of s.diffs) {
        const kind = d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅系统" : "仅人工";
        lines.push(`${kind} ${d.address}: A=${d.a ?? "∅"} B=${d.b ?? "∅"}`);
      }
    }
    void navigator.clipboard?.writeText(lines.join("\n")).catch(() => undefined);
  };

  // 基准对比报告：其余记录相对基准的 totals delta 表
  const exportBaseReport = () => {
    if (!baseRec) return;
    const bt = baseRec.result.totals;
    const sgn = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
    const lines = [
      "# 基准对比报告",
      "",
      `- 基准记录：${baseRec.at ?? baseRec.id}　准确率 ${bt.accuracyPercent}%`,
      "",
      "| 记录 | 时间 | 准确率 Δ(pp) | 差异 Δ | 仅系统 Δ | 仅人工 Δ |",
      "| --- | --- | --- | --- | --- | --- |",
    ];
    for (const rec of shownCompares) {
      if (rec.id === baseRec.id) continue;
      const t = rec.result?.totals;
      if (!t) continue;
      lines.push(
        `| ${rec.id.slice(0, 8)} | ${rec.at ?? "—"} | ${sgn(t.accuracyPercent - bt.accuracyPercent)} | ${sgn(
          t.mismatched - bt.mismatched,
        )} | ${sgn(t.onlyA - bt.onlyA)} | ${sgn(t.onlyB - bt.onlyB)} |`,
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `基准对比-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 仅复制当前筛选（类型+地址）下的差异
  const copyFiltered = (rec: CompareRecord) => {
    const t = rec.result.totals;
    const filterDesc = `${kindFilter === "all" ? "全部" : KIND_META[kindFilter].label}${
      addrQuery.trim() ? ` / 地址含「${addrQuery.trim()}」` : ""
    }`;
    const lines = [`比对准确率 ${t.accuracyPercent}%（筛选：${filterDesc}）`];
    for (const s of rec.result.sheets) {
      for (const d of s.diffs.filter(matchFilter)) {
        const kind = d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅系统" : "仅人工";
        lines.push(`${kind} ${d.address}: A=${d.a ?? "∅"} B=${d.b ?? "∅"}`);
      }
    }
    void navigator.clipboard?.writeText(lines.join("\n")).catch(() => undefined);
  };

  const openBoth = (rec: CompareRecord, addr: string) => {
    const key = addr.includes("/") && !/^[A-Za-z]{1,3}\d+$/i.test(addr) ? addr.slice(0, addr.indexOf("/")) : undefined;
    if (rec.result.a) onOpenTarget({ ...rec.result.a, highlight: key });
    if (rec.result.b) onOpenTarget({ ...rec.result.b, highlight: key });
  };

  // 差异表导出 CSV（BOM + 引号转义，Excel 中文可直接打开）
  const exportCsv = (rec: CompareRecord) => {
    const esc = (v: string | number | null | undefined) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["类型,位置,系统底稿(A),人工底稿(B)"];
    for (const s of rec.result.sheets) {
      for (const d of s.diffs) {
        const kind = d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅系统" : "仅人工";
        lines.push([esc(kind), esc(d.address), esc(d.a), esc(d.b)].join(","));
      }
    }
    const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `底稿比对差异-${(rec.at ?? "").slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (compares.length === 0) {
    return (
      <div className="glow-card px-5 py-6">
        <div className="flex items-center gap-2">
          <IconAlert className="h-4 w-4 text-glow-400" />
          <span className="text-[13px] font-medium text-mist-100">暂无比对记录</span>
        </div>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[12px] leading-5 text-mist-500">
          <li>让 Agent 解析资料并生成系统底稿（generate_workpaper / fill_land_vat_workpaper）；</li>
          <li>上传或指定人工底稿后调用 compare_workpapers 执行记录级 / 地址级比对；</li>
          <li>准确率、差异表与趋势图将自动出现在本页，并可联动阅读器高亮定位。</li>
        </ol>
        <p className="mt-3 text-[11px] text-mist-600">
          提示：在新任务指令中写明「请比对系统底稿与人工底稿并输出准确率」即可触发比对闭环。
        </p>
      </div>
    );
  }

  let cursor = -1;
  return (
    <div className="space-y-6">
      {flat.length > 0 && (
        <div className="text-[11px] text-mist-600">↑/↓ 选择差异行 · Enter 在阅读器中打开双底稿并定位</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["all", "全部"],
            ["mismatch", "差异"],
            ["only_a", "仅系统"],
            ["only_b", "仅人工"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setKindFilter(id);
              setSel(null);
            }}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              kindFilter === id
                ? "border-glow-500 bg-glow-500/15 text-glow-300"
                : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
            }`}
          >
            {label}
          </button>
        ))}
        <input
          value={addrQuery}
          onChange={(e) => {
            setAddrQuery(e.target.value);
            setSel(null);
          }}
          placeholder="地址过滤…"
          className="ml-auto w-32 rounded-full border border-line bg-night-850 px-2.5 py-0.5 text-[11px] text-mist-100 outline-none placeholder:text-mist-600 focus:glow-ring"
        />
        <button
          type="button"
          onClick={() => setOnlyLatest((v) => !v)}
          title="仅显示最近一次比对记录"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
            onlyLatest
              ? "border-glow-500 bg-glow-500/15 text-glow-300"
              : "border-line bg-night-850 text-mist-500 hover:text-mist-100"
          }`}
        >
          仅看最新
        </button>
        {baseRec && (
          <button
            type="button"
            onClick={exportBaseReport}
            className="rounded-full border border-glow-500/40 bg-glow-500/10 px-2.5 py-0.5 text-[11px] text-glow-300 transition-colors hover:border-glow-400"
          >
            导出基准报告
          </button>
        )}
      </div>
      {shownCompares.length > 1 &&
        (() => {
          const pts = shownCompares
            .map((rec) => rec.result?.totals?.accuracyPercent)
            .filter((v): v is number => typeof v === "number");
          if (pts.length < 2) return null;
          const min = Math.min(...pts);
          const max = Math.max(...pts);
          const range = Math.max(1, max - min);
          const coords = pts.map(
            (v, i) =>
              `${((i / (pts.length - 1)) * 100).toFixed(2)},${(26 - ((v - min) / range) * 22).toFixed(2)}`,
          );
          return (
            <div>
              <div className="kicker flex items-center justify-between">
                <span>准确率趋势 · {pts.length} 次比对</span>
                <span>
                  {trendHover !== null && pts[trendHover] !== undefined
                    ? `第 ${trendHover + 1} 次 · ${pts[trendHover]}%`
                    : `最低 ${min}% · 最高 ${max}%`}
                </span>
              </div>
              <svg
                viewBox="0 0 100 30"
                preserveAspectRatio="none"
                className="mt-2 h-9 w-full"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientX - rect.left) / rect.width;
                  setTrendHover(Math.max(0, Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1)))));
                }}
                onMouseLeave={() => setTrendHover(null)}
              >
                <polygon points={`0,30 ${coords.join(" ")} 100,30`} fill="rgba(52, 211, 153, 0.10)" />
                <polyline
                  points={coords.join(" ")}
                  fill="none"
                  stroke="#34d399"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                {coords.map((c, i) => {
                  const [x, y] = c.split(",");
                  return <circle key={i} cx={x} cy={y} r="1.4" fill="#34d399" />;
                })}
                {trendHover !== null && (
                  <line
                    x1={(trendHover / (pts.length - 1)) * 100}
                    y1="0"
                    x2={(trendHover / (pts.length - 1)) * 100}
                    y2="30"
                    stroke="rgba(230, 237, 247, 0.4)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
            </div>
          );
        })()}
      {(() => {
          const tot = shownCompares.reduce(
          (acc, r) => {
            const t = r.result?.totals;
            if (t) {
              acc.matched += t.matched;
              acc.mismatch += t.mismatched;
              acc.onlyA += t.onlyA;
              acc.onlyB += t.onlyB;
            }
            return acc;
          },
          { matched: 0, mismatch: 0, onlyA: 0, onlyB: 0 },
        );
        const sum = tot.matched + tot.mismatch + tot.onlyA + tot.onlyB;
        if (sum === 0) return null;
        const segs = [
          { v: tot.matched, c: "#34d399", label: "一致" },
          { v: tot.mismatch, c: "#fb7185", label: "差异" },
          { v: tot.onlyA, c: "#fbbf24", label: "仅系统" },
          { v: tot.onlyB, c: "#38bdf8", label: "仅人工" },
        ];
        const C = 2 * Math.PI * 12;
        let offset = 0;
        return (
          <div className="flex items-center gap-4">
            <svg viewBox="0 0 32 32" className="h-16 w-16 shrink-0" aria-hidden>
              {segs.map((s) => {
                const len = (s.v / sum) * C;
                const el = (
                  <circle
                    key={s.label}
                    cx="16"
                    cy="16"
                    r="12"
                    fill="none"
                    stroke={s.c}
                    strokeWidth="5"
                    strokeDasharray={`${len} ${C - len}`}
                    strokeDashoffset={-offset}
                    transform="rotate(-90 16 16)"
                  />
                );
                offset += len;
                return el;
              })}
            </svg>
            <ul className="space-y-1 text-[11px] text-mist-500">
              {segs.map((s) => (
                <li key={s.label} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.c }} />
                  {s.label}
                  <span className="font-mono text-mist-300">{s.v}</span>
                  <span className="text-mist-600">{Math.round((s.v / sum) * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}
      {shownCompares.map((rec, ri) => {
        const t = rec.result?.totals;
        if (!t) return null;
        const prevAcc = ri > 0 ? shownCompares[ri - 1]?.result?.totals?.accuracyPercent : undefined;
        const accDelta = typeof prevAcc === "number" ? t.accuracyPercent - prevAcc : undefined;
        const baseT = baseRec && baseRec.id !== rec.id ? baseRec.result?.totals : undefined;
        return (
          <section key={rec.id} className="glow-card px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="kicker">Workpaper Compare</span>
              <span className="text-[12px] text-mist-600">
                {rec.at ? new Date(rec.at).toLocaleString("zh-CN", { hour12: false }) : ""} ·{" "}
                {rec.result.sheets[0]?.mode === "address" ? "地址模式" : "记录级模式"}
              </span>
              <button
                type="button"
                className="action-btn"
                title="复制比对记录 ID"
                onClick={() => void navigator.clipboard?.writeText(rec.id).catch(() => undefined)}
              >
                <span className="font-mono text-[10px]">#{rec.id.slice(0, 8)}</span>
              </button>
              <span className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setBaseId((v) => (v === rec.id ? null : rec.id))}
                  className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                    baseId === rec.id
                      ? "border-glow-500 bg-glow-500/15 text-glow-300"
                      : "border-line bg-night-800 text-mist-300 hover:border-glow-500 hover:text-glow-300"
                  }`}
                  title="设为基准后，其余记录显示相对该次的变化"
                >
                  {baseId === rec.id ? "取消基准" : "设为基准"}
                </button>
                <button
                  type="button"
                  onClick={() => exportReport(rec)}
                  className="rounded border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
                >
                  <IconDownload className="mr-1 inline h-3 w-3" />
                  导出比对报告
                </button>
                <button
                  type="button"
                  onClick={() => exportCsv(rec)}
                  className="rounded border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
                >
                  <IconDownload className="mr-1 inline h-3 w-3" />
                  导出 CSV
                </button>
                <button
                  type="button"
                  onClick={() => copySummary(rec)}
                  className="rounded border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
                >
                  复制摘要
                </button>
                <button
                  type="button"
                  onClick={() => copyFiltered(rec)}
                  className="rounded border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
                >
                  复制筛选
                </button>
                {rec.result.a && (
                  <button
                    type="button"
                    onClick={() => onOpenTarget(rec.result.a!)}
                    className="rounded border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
                  >
                    查看系统底稿
                  </button>
                )}
                {rec.result.b && (
                  <button
                    type="button"
                    onClick={() => onOpenTarget(rec.result.b!)}
                    className="rounded border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300 transition-colors hover:border-glow-500 hover:text-glow-300"
                  >
                    查看人工底稿
                  </button>
                )}
              </span>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {baseT && (
                <div className="sm:col-span-3 xl:col-span-6">
                  <span className="rounded border border-glow-500/35 bg-glow-500/10 px-2 py-1 text-[11px] text-glow-300">
                    较基准：准确率 {t.accuracyPercent - baseT.accuracyPercent >= 0 ? "+" : ""}
                    {t.accuracyPercent - baseT.accuracyPercent}pp · 差异 {t.mismatched - baseT.mismatched >= 0 ? "+" : ""}
                    {t.mismatched - baseT.mismatched} · 仅系统 {t.onlyA - baseT.onlyA >= 0 ? "+" : ""}
                    {t.onlyA - baseT.onlyA} · 仅人工 {t.onlyB - baseT.onlyB >= 0 ? "+" : ""}
                    {t.onlyB - baseT.onlyB}
                  </span>
                </div>
              )}
              <div className="glow-card glow-ring px-4 py-3">
                <div className="text-[11px] text-mist-600">总准确率</div>
                <div className="mt-1 text-[26px] font-semibold tracking-tight text-glow-300">
                  {t.accuracyPercent}
                  <span className="ml-0.5 text-[12px] text-mist-600">%</span>
                  {accDelta !== undefined && accDelta !== 0 && (
                    <span
                      className={`ml-1.5 text-[11px] ${accDelta > 0 ? "text-jade-400" : "text-rose-300"}`}
                      title="较上次比对变化"
                    >
                      {accDelta > 0 ? `▲${accDelta}` : `▼${Math.abs(accDelta)}`}
                    </span>
                  )}
                </div>
              </div>
              {[
                { label: "比对项", value: t.compared, tone: "text-mist-100" },
                { label: "一致", value: t.matched, tone: "text-jade-400" },
                { label: "差异", value: t.mismatched, tone: "text-rose-300" },
                { label: "仅系统", value: t.onlyA, tone: "text-amber-300" },
                { label: "仅人工", value: t.onlyB, tone: "text-sky-300" },
              ].map((kpi) => (
                <div key={kpi.label} className="glow-card px-4 py-3">
                  <div className="text-[11px] text-mist-600">{kpi.label}</div>
                  <div className={`mt-1 text-[20px] font-semibold tracking-tight ${kpi.tone}`}>{kpi.value}</div>
                </div>
              ))}
            </div>

            {rec.result.sheets.map((s) => (
              <div key={`${s.sheetA}-${s.sheetB}`} className="mt-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] font-medium text-mist-100">工作表「{s.sheetA}」</span>
                  <span className="text-[11.5px] text-mist-600">
                    准确率 {s.accuracyPercent}% · 一致 {s.matched}/{s.compared} · 跳过公式格 {s.skippedFormulas}
                  </span>
                </div>
                {s.diffs.length === 0 ? (
                  <div className="mt-2 flex items-center gap-1.5 rounded-md border border-jade-400/30 bg-jade-400/10 px-3 py-2 text-[12.5px] text-jade-400">
                    <IconCheck className="h-3.5 w-3.5" />
                    该工作表全部比对项一致
                  </div>
                ) : s.diffs.filter(matchFilter).length === 0 ? (
                  <div className="mt-2 text-[12px] text-mist-600">当前筛选类型下无差异行</div>
                ) : (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr>
                          {["类型", "位置", "系统底稿 (A)", "人工底稿 (B)"].map((h) => (
                            <th
                              key={h}
                              className="border border-line bg-night-700 px-2.5 py-1.5 text-left font-medium text-glow-300"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                      {s.diffs.filter(matchFilter).map((d, i) => {
                        const meta = KIND_META[d.kind];
                        const idx = (cursor += 1);
                        return (
                          <tr
                            key={`${d.address}-${i}`}
                            data-diffidx={idx}
                            onClick={() => {
                              setSel(idx);
                              openBoth(rec, d.address);
                            }}
                            title="点击同时在阅读器中打开两份底稿并定位该行"
                            className={`group cursor-pointer transition-colors hover:bg-night-700 ${
                              idx === sel ? "bg-night-700 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.45)]" : ""
                            }`}
                          >
                            <td className="border border-line px-2.5 py-1.5">
                                <span className={`rounded border px-1.5 py-0.5 text-[10.5px] ${meta.cls}`}>
                                  {meta.label}
                                </span>
                              </td>
                              <td className="border border-line px-2.5 py-1.5 font-mono text-mist-300">
                                <span className="mr-1.5">{d.address}</span>
                                <button
                                  type="button"
                                  title="复制地址"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void navigator.clipboard?.writeText(d.address).catch(() => undefined);
                                  }}
                                  className="text-mist-600 opacity-0 transition-opacity hover:text-glow-300 focus:opacity-100 group-hover:opacity-100"
                                >
                                  <IconCopy className="inline h-3 w-3" />
                                </button>
                              </td>
                              <td className="border border-line px-2.5 py-1.5 text-mist-100">{fmt(d.a)}</td>
                              <td className="border border-line px-2.5 py-1.5 text-mist-100">{fmt(d.b)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}

            {(rec.result.unmatchedSheetsA.length > 0 || rec.result.unmatchedSheetsB.length > 0) && (
              <div className="mt-3 flex items-start gap-1.5 text-[12px] text-amber-300">
                <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                未配对工作表：A={rec.result.unmatchedSheetsA.join(", ") || "无"}；B=
                {rec.result.unmatchedSheetsB.join(", ") || "无"}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
