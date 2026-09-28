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
  const flat = useMemo(
    () =>
      compares.flatMap((rec) =>
        rec.result?.totals
          ? rec.result.sheets.flatMap((s) =>
              s.diffs.filter(matchFilter).map((d) => ({ rec, addr: d.address })),
            )
          : [],
      ),
    [compares, kindFilter, addrQuery],
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
      <div className="py-10 text-center text-[13px] text-mist-600">
        暂无比对记录。Agent 调用 compare_workpapers 后，准确率与差异将自动显示在此。
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
      </div>
      {compares.length > 1 &&
        (() => {
          const pts = compares
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
      {compares.map((rec) => {
        const t = rec.result?.totals;
        if (!t) return null;
        return (
          <section key={rec.id} className="glow-card px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="kicker">Workpaper Compare</span>
              <span className="text-[12px] text-mist-600">
                {rec.at ? new Date(rec.at).toLocaleString("zh-CN", { hour12: false }) : ""} ·{" "}
                {rec.result.sheets[0]?.mode === "address" ? "地址模式" : "记录级模式"}
              </span>
              <span className="ml-auto flex gap-1.5">
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
              <div className="glow-card glow-ring px-4 py-3">
                <div className="text-[11px] text-mist-600">总准确率</div>
                <div className="mt-1 text-[26px] font-semibold tracking-tight text-glow-300">
                  {t.accuracyPercent}
                  <span className="ml-0.5 text-[12px] text-mist-600">%</span>
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
