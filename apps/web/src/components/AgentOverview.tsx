import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, PlatformStats } from "../types.ts";
import { IconBuilding, IconCheck, IconExternal, IconFile, IconFlask, IconTool } from "./Icons.tsx";
import {
  baselineKey,
  deltas,
  recordSnapshot,
  trend,
  trendText,
  trendTitle,
  type DailySnapshot,
} from "../metric-trend.ts";
import {
  ledgerCells,
  ledgerCsv,
  ledgerMarkdown,
  ledgerTotals,
  LEDGER_COLUMNS,
} from "../evidence-ledger.ts";
import { downloadBlob, downloadText } from "../download.ts";
import { asSnapshotRecord, KEYS, readJson, writeJson } from "../local-store.ts";
import { needsUnitSpace, percentFrom, percentOf, percentValue } from "../format.ts";
import { dayStamp, relTime } from "../time-format.ts";
import { groupSummary } from "../review-queue.ts";
import {
  outcomeLine,
  outcomeOf,
  resolvedCalls,
  ringSegments,
  successRate,
  type RingSegmentKey,
} from "../tool-outcome.ts";
import { failureSummary, groupFailures } from "../tool-failures.ts";
import { STATUS_BARS, type StatusBreakdown } from "../status-breakdown.ts";
import { dayAvgOf, dayBuckets, runDaysOf, TREND_DAYS, weekHalves } from "../task-trend.ts";
import { UNTRACED_ORIGIN_HINT, UNTRACED_ORIGIN_TEXT } from "../amount-trace.ts";

/** 大数字 odometer：每位数字独立滚轮到目标值，对齐参考片数据页质感。 */
const DESC_KEYWORDS = ["整数分", "行级", "记录级", "OCR", "mermaid", "联网"];

const RING_C = 2 * Math.PI * 12;

/** 环图三段配色：未返回用琥珀，不用失败的玫红——它不是错误，颜色不该替它认错 */
const RING_COLOR: Record<RingSegmentKey, string> = {
  ok: "#34d399",
  failed: "#fb7185",
  unfinished: "#fbbf24",
};

/**
 * 台账里要标琥珀色的两列欠账（待复查 / 证据力弱）。
 * 按列名取下标而不是写死数字：新增「其中复查取得」一列后，硬编码的 4 与 8 当场错位到了
 * 「其中复查取得」和「官方原文」，欠账列反而不再高亮。与验证脚本同一套防错位做法。
 */
const LEDGER_GAP_COLS = new Set([LEDGER_COLUMNS.indexOf("待复查"), LEDGER_COLUMNS.indexOf("证据力弱")]);

/** 智能体描述中的能力关键词高亮。 */
function renderDesc(text: string) {
  const re = new RegExp(`(${DESC_KEYWORDS.join("|")})`, "g");
  return text.split(re).map((part, i) =>
    DESC_KEYWORDS.includes(part) ? (
      <mark key={i} className="rounded bg-glow-500/15 px-0.5 text-glow-300">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Odometer({ value }: { value: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setOn(true), 60);
    return () => window.clearTimeout(t);
  }, []);
  const text = value.toLocaleString("zh-CN");
  return (
    // role="img" + aria-label：数字位是 0-9 的滚动列，文本层读出来是「0\n1\n…\n9」两串，不是这个数
    //（实测 innerText 就是两串 0-9，aria-label / title / role 三个全为空）。读屏与任何按文本取数的
    // 消费者（含 scan:uimd 的数字核对）都靠 aria-label 拿真值；select-none 免得复制页面时把两串数字带走。
    <span className="stat-hero inline-flex select-none" role="img" aria-label={text}>
      {text.split("").map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} className="inline-block h-[1em] overflow-hidden">
            <span
              className="flex flex-col transition-transform duration-700 ease-out"
              style={{ transform: `translateY(-${on ? Number(ch) : 0}em)` }}
            >
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d} className="block h-[1em] leading-[1em]">
                  {d}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} className="inline-block">
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

interface Props {
  agents: AgentInfo[];
  activeAgentId: string;
  stats: { tasks: number; completed: number; platform: PlatformStats | null };
  /** 状态分布：口径与条目名单都在 status-breakdown.ts（App.tsx 算、这里渲染、门禁算期望值） */
  breakdown: StatusBreakdown;
  createdAts: string[];
  recent: Array<{
    id: string;
    title: string;
    status: string;
    at: string;
    runCount?: number;
    agentId: string;
    interrupted?: boolean;
  }>;
  lastAt: Record<string, string>;
  perAgentCreatedAts: Record<string, string[]>;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
  onShowAll: () => void;
  /** 批量把「已完成但仍有未复核问题」的任务改回待复核，返回成功数量 */
  onBatchReopen?: (ids: string[]) => Promise<number>;
  /** 跨任务批量处置同一类待复核问题，返回实际处置条数（服务端会重新核对每条是否仍待复核） */
  onBatchReview?: (
    items: Array<{ taskId: string; issueId: string }>,
    decision: "confirm" | "dismiss",
    comment: string,
  ) => Promise<number>;
  /** 批量联网复查：kinds 指定复查政策文号还是为弱证据引用找替代来源 */
  onBatchRefCheck?: (
    ids: string[],
    kinds: Array<"docref" | "citation">,
  ) => Promise<{ tasks: number; ran: number; matched: number; budget: number }>;
}

export function AgentOverview({
  agents,
  activeAgentId,
  stats,
  breakdown,
  createdAts,
  recent,
  onSelect,
  onOpenTask,
  onShowAll,
  onBatchReopen,
  onBatchReview,
  onBatchRefCheck,
  lastAt,
  perAgentCreatedAts,
}: Props) {
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const Icon = agent.id === "rd-audit" ? IconFlask : IconBuilding;
  const p = stats.platform;
  // 复核缺口按作品分组：跨作品时一眼看出各自欠账
  const backlogByAgent = useMemo(() => {
    const m = new Map<string, PlatformStats["reviewBacklog"]>();
    for (const b of p?.reviewBacklog ?? []) {
      const list = m.get(b.agentId);
      if (list) list.push(b);
      else m.set(b.agentId, [b]);
    }
    return [...m.entries()].sort((a, b2) => b2[1].length - a[1].length);
  }, [p?.reviewBacklog]);
  // 证据缺口按作品分组：弱证据引用与待复查文号，点击直达结果页处理
  const gapByAgent = useMemo(() => {
    const m = new Map<string, PlatformStats["evidence"]["gaps"]>();
    for (const g of p?.evidence?.gaps ?? []) {
      const list = m.get(g.agentId);
      if (list) list.push(g);
      else m.set(g.agentId, [g]);
    }
    return [...m.entries()].sort((a, b2) => b2[1].length - a[1].length);
  }, [p?.evidence]);
  // 两类弱证据不是待办：已在结论里声明「仅作背景参考，不作为政策依据」的，以及只在检索留存里、
  // 从未进入结论正文的。看板文案、缺口胶囊与批量按钮一律按待处置数说话，否则既虚报欠账，
  // 又会拿联网预算去复查一批做不出结果的项
  const weakOpen = (g: { weakCitations: number; weakDisclaimed: number; weakUncited: number }): number =>
    Math.max(0, g.weakCitations - g.weakDisclaimed - g.weakUncited);
  const weakOpenTotal = Math.max(
    0,
    (p?.evidence?.weakCitations ?? 0) - (p?.evidence?.weakDisclaimed ?? 0) - (p?.evidence?.weakUncited ?? 0),
  );
  // 文号侧同理：已在结论中标注「未取得公开原文，仅作背景参考」的不再算待复查
  const docOpen = (g: { docRefPending: number; docRefLabeled: number }): number =>
    Math.max(0, g.docRefPending - g.docRefLabeled);
  const docLabeledTotal = p?.evidence?.docRefLabeled ?? 0;
  const docOpenTotal = Math.max(0, (p?.evidence?.docRefPending ?? 0) - docLabeledTotal);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.shortName ?? id;
  // 缺口任务自身的未复核项合计（与「全平台待复核合计」不同：后者还包含待复核态任务）
  const backlogPending = (p?.reviewBacklog ?? []).reduce((s, b) => s + b.pending, 0);
  // hero 是这个作品自己的任务数。此前取 p?.tasks（全平台 40），于是同一屏上「累计审查任务 40」
  // 对着状态分布的「共 29 件」，右边「日均 2.1 件」又是 29/14——三个数两种口径，谁也对不上谁，
  // 而作品说明里写的「累计任务 29 个」跟这三个都不一样。全平台那个数在下面「平台应用效果」
  // 那排卡片里，标签已改成「平台累计任务」，两处不再共用一个说法。
  const heroValue = stats.tasks;
  // 条目与顺序取自 STATUS_BARS：分成两行是有意的（服务重启打断的续跑就行，与 Agent 执行报错
  // 混在一行会让人去查错方向），文案与顺序都只在那一份名单里存着
  const bars = STATUS_BARS.map((b) => ({ label: b.label, value: breakdown[b.key], hint: b.hint }));
  const barMax = Math.max(1, ...bars.map((b) => b.value));
  // 近 14 天任务创建分布（按本地日桶）：口径收在 task-trend.ts，门禁算期望值用的是同一份，
  // 窗口长度也只在那一处写着（此前 14 / 13 / 7 三个魔数散在下面五六处）
  const days = useMemo(() => dayBuckets(createdAts), [createdAts]);
  const dayMax = Math.max(1, ...days);
  const dayAvg = dayAvgOf(days);
  const runDays = useMemo(() => runDaysOf(createdAts), [createdAts]);
  const sparkPts = days
    .map((v, i) => `${((i / (TREND_DAYS - 1)) * 100).toFixed(2)},${(28 - (v / dayMax) * 24).toFixed(2)}`)
    .join(" ");
  const week = weekHalves(days);
  const weekNow = week.now;
  const weekPrev = week.prev;
  const weekDelta = week.delta;
  const [sparkHover, setSparkHover] = useState<number | null>(null);
  const [toolSort, setToolSort] = useState(false);
  const [capsOpen, setCapsOpen] = useState(false);
  const [weekDeltas, setWeekDeltas] = useState<Record<string, number>>({});
  // 环比基线是哪一天的快照，用于提示文案
  const [baseDay, setBaseDay] = useState<string | null>(null);
  // 批量「转为待复核」的两步确认：armed / busy 记的是范围标签（全平台或某个作品）
  const [batchArmed, setBatchArmed] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState("");
  const [batchMsg, setBatchMsg] = useState("");
  // 批量联网复查：同样是两步确认，避免误点触发一批外网请求；两类复查分开记录状态
  const [refBatchArmed, setRefBatchArmed] = useState<"docref" | "citation" | null>(null);
  const [refBatchBusy, setRefBatchBusy] = useState<"" | "docref" | "citation">("");
  const [refBatchMsg, setRefBatchMsg] = useState("");
  const armBatch = (label: string, ids: string[]) => {
    if (batchBusy !== "" || !onBatchReopen || ids.length === 0) return;
    if (batchArmed !== label) {
      setBatchArmed(label);
      setBatchMsg("");
      window.setTimeout(() => setBatchArmed((v) => (v === label ? null : v)), 3000);
      return;
    }
    setBatchArmed(null);
    setBatchBusy(label);
    void onBatchReopen(ids)
      .then((n) => setBatchMsg(`${label}：已把 ${n} 个任务转为待复核，状态事件已留痕`))
      .catch(() => setBatchMsg(`${label}：批量转换失败，请到各任务复核页逐个处理`))
      .finally(() => setBatchBusy(""));
  };

  // 跨任务同类待复核问题：同样两步确认，避免误点把一批问题一次判掉；处置意见共用一个输入框
  const [reviewArmed, setReviewArmed] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState("");
  const [reviewMsg, setReviewMsg] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewShowAll, setReviewShowAll] = useState(false);
  const reviewGroups = stats.platform?.reviewGroups ?? [];
  // 失败调用按归因分组：只有「失败 N」一个数字时，「改提示词」「换出处」「配抓取服务」三件
  // 处置方式完全不同的事混在一起，结果就是谁也不去处理
  const [failShowAll, setFailShowAll] = useState(false);
  const failures = stats.platform?.toolFailures ?? [];
  const failureGroups = useMemo(() => groupFailures(failures), [failures]);
  const failSummary = useMemo(() => failureSummary(failures), [failures]);
  const reviewSummary = groupSummary(reviewGroups);
  const armReviewBatch = (
    key: string,
    items: Array<{ taskId: string; issueId: string }>,
    decision: "confirm" | "dismiss",
  ) => {
    if (reviewBusy !== "" || !onBatchReview || items.length === 0) return;
    const armed = `${key}|${decision}`;
    if (reviewArmed !== armed) {
      setReviewArmed(armed);
      setReviewMsg("");
      window.setTimeout(() => setReviewArmed((v) => (v === armed ? null : v)), 3000);
      return;
    }
    setReviewArmed(null);
    setReviewBusy(key);
    void onBatchReview(items, decision, reviewComment.trim())
      .then(
        (n) =>
          setReviewMsg(
            `已${decision === "confirm" ? "确认列入底稿" : "判定无需处理"} ${n} 项（跨 ${
              new Set(items.map((i) => i.taskId)).size
            } 个任务）；每个任务都写了复核记录与状态事件${n < items.length ? `，另有 ${items.length - n} 项已被处置过或不在当前清单里，已跳过` : ""}`,
          ),
      )
      .catch(() => setReviewMsg("批量处置失败，请到各任务复核页逐个处理"))
      .finally(() => setReviewBusy(""));
  };

  /** 批量复查：两步确认，结果按任务落库并写入事件留痕 */
  const armRefBatch = (kind: "docref" | "citation", ids: string[]) => {
    if (refBatchBusy !== "" || !onBatchRefCheck || ids.length === 0) return;
    if (refBatchArmed !== kind) {
      setRefBatchArmed(kind);
      setRefBatchMsg("");
      window.setTimeout(() => setRefBatchArmed((v) => (v === kind ? null : v)), 4000);
      return;
    }
    setRefBatchArmed(null);
    setRefBatchBusy(kind);
    void onBatchRefCheck(ids, [kind])
      .then((r) =>
        setRefBatchMsg(
          kind === "docref"
            ? `已联网复查 ${r.ran} 处政策文号（本次预算 ${r.budget} 处，覆盖 ${r.tasks} 个任务）：找到公开出处 ${r.matched} 处，其余为候选待确认或未检索到，明细见各任务结果页的复查面板`
            : `已为 ${r.ran} 条弱证据引用检索替代来源（本次预算 ${r.budget} 条，覆盖 ${r.tasks} 个任务）：找到官方原文 ${r.matched} 条，需人工确认后写回结论并重新打包，明细见各任务结果页的联网引用区`,
        ),
      )
      .catch(() =>
        setRefBatchMsg(
          kind === "docref"
            ? "批量复查失败：请检查网络后重试，或到各任务结果页逐个复查"
            : "批量检索替代来源失败：请检查网络后重试，或到各任务结果页逐条检索",
        ),
      )
      .finally(() => setRefBatchBusy(""));
  };

  // 平台指标周环比：每日快照入 localStorage，与 7 天前（或最近可得）快照对比。
  // 快照、基线与差值口径统一走 metric-trend.ts，KPI 与证据类指标共用一套实现。
  useEffect(() => {
    if (!p) return;
    const today = dayStamp();
    try {
      const snap = readJson<DailySnapshot>(KEYS.snapshots, asSnapshotRecord, {});
      const values: Record<string, number> = {
        tasks: p.tasks,
        completed: p.completed,
        artifacts: p.artifacts,
        weakCitations: p.evidence?.weakCitations ?? 0,
        officialCitations: p.evidence?.officialCitations ?? 0,
        docRefPending: p.evidence?.docRefPending ?? 0,
      };
      const next = recordSnapshot(snap, today, values);
      writeJson(KEYS.snapshots, next);
      const base = baselineKey(next, today, 7);
      setBaseDay(base);
      setWeekDeltas(deltas(values, base ? next[base] : undefined, Object.keys(values)));
    } catch {
      /* 忽略存储不可用 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.tasks, p?.completed, p?.artifacts, p?.evidence]);

  const deltaBadge = (k: string) => {
    const v = weekDeltas[k];
    if (v === undefined || v === 0) return null;
    return (
      <span className={`ml-1 text-[10px] ${v > 0 ? "text-jade-400" : "text-rose-300"}`} title="较 7 天前快照">
        {v > 0 ? `▲${v}` : `▼${Math.abs(v)}`}
      </span>
    );
  };
  /** 证据类趋势：弱证据引用与待复查文号越低越好，官方原文越高越好（颜色按方向而非按正负） */
  const evidenceTrend = (k: string, lowerIsBetter: boolean) => {
    const v = weekDeltas[k];
    const text = trendText(v);
    if (text === "") return null;
    const dir = trend(v, lowerIsBetter);
    return (
      <span
        className={`text-[10px] ${dir === "better" ? "text-jade-400" : "text-amber-300"}`}
        title={trendTitle(baseDay, lowerIsBetter)}
      >
        {text}
      </span>
    );
  };
  const sparkDate = (idx: number) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - idx));
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const perTool = p?.perTool ?? [];
  const toolCount = (name: string) => perTool.find((t) => t.name === name)?.calls ?? 0;

  // 平台看板快照导出（MD 表格 / JSON 原始）
  const exportStats = (fmt: "json" | "md") => {
    if (!p) return;
    const stamp = dayStamp();
    if (fmt === "json") {
      downloadBlob(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }), `platform-stats-${stamp}.json`);
      return;
    }
    const lines = [
      "# 平台应用效果快照",
      "",
      `- 日期：${stamp}`,
      `- 平台累计任务：${p.tasks}（已完成 ${p.completed}）`,
      `- ${outcomeLine(outcomeOf(p))}`,
      `- 底稿产物：${p.artifacts} 份`,
      `- 记录级比对·与人工参考底稿的同行评审（共 ${p.compareRuns} 次，每任务取最近一次合计）：一致率 ${percentFrom(
        p.compareMatchRateOverall,
      )}（一致 ${p.compareMatched} / 差异 ${p.compareMismatched}，只看两边都有的项，回答「填得对不对」）· 覆盖率 ${percentFrom(
        p.compareCoverageOverall,
      )}（人工底稿有的 ${p.compareMatched + p.compareOnlyA} 项里自动填到 ${p.compareMatched} 项，回答「填得全不全」）· 仅自动底稿有 ${
        p.compareOnlyB
      } 项`,
      `- 记录级比对·与自己的原始模板核对（共 ${p.compareTemplateRuns} 次）：填列新增 ${p.compareFilledCells} 处 · 与模板既有内容冲突 ${
        p.compareTemplateMismatched
      } 处。不计入上面两个比率——模板本来是空的，只有一侧有的格子正是填进去的值，算成覆盖缺口等于把「填了多少」记成「漏了多少」`,
      `- 记录级比对总准确率（最近一次 ${percentFrom(p.compareAccuracy)} · 累计 ${percentFrom(
        p.compareAccuracyOverall,
      )}）：把「填错」与「范围没对上」混在一个数里，只作参考`,
      `- OCR 平均置信度：${percentFrom(p.ocrAvgConfidence)}（${p.ocrRuns} 次）`,
      `- 复核闭环：待复核问题合计 ${p.reviewPendingIssues} 项；已完成但仍有未复核问题的任务 ${p.reviewBacklog.length} 个`,
      `- 复核去重：待复核问题按「类型 + 描述」跨任务去重后 ${reviewSummary.groups} 类，其中 ${
        reviewSummary.recurringGroups
      } 类在多个任务里重复出现（涉及 ${reviewSummary.recurringItems} 项）；看板上可对同一类一次处置，各任务分别写复核记录与事件留痕`,
      ...(p.reviewBacklog.length > 0
        ? [
            "",
            "| 任务 | 智能体 | 未复核 |",
            "| --- | --- | --- |",
            ...p.reviewBacklog.map((b) => `| ${b.title} | ${b.agentId} | ${b.pending} |`),
          ]
        : []),
      "",
      "| 智能体 | 任务 | 已完成 | 工具调用 | 成功 | 失败 | 未返回 | 产物 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...p.perAgent.map(
        (a) =>
          `| ${a.agentId} | ${a.tasks} | ${a.completed} | ${a.toolCalls} | ${a.toolOk} | ${a.toolFailed} | ${a.toolUnfinished} | ${a.artifacts} |`,
      ),
      "",
      "| 工具 | 调用 | 成功 |",
      "| --- | --- | --- |",
      ...p.perTool.map((t) => `| ${t.name} | ${t.calls} | ${t.ok} |`),
    ];
    downloadBlob(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }), `platform-stats-${stamp}.md`);
  };

  // 概览全量快照：hero/状态分布/14 天桶/perAgent/perTool
  const exportOverview = () => {
    const lines = [
      `# 平台概览快照 · ${agent.shortName}`,
      "",
      `- 本作品累计任务：${heroValue} 件（近 ${TREND_DAYS} 天日均 ${dayAvg.toFixed(
        1,
      )} 件 · 今日 ${days[TREND_DAYS - 1] ?? 0} 件）`,
      `- 周环比：${weekDelta > 0 ? `+${weekDelta}` : weekDelta}（本周 ${weekNow} / 上周 ${weekPrev}）`,
      `- 状态分布：${bars.map((b) => `${b.label} ${b.value}`).join(" / ")}`,
      `- 近 14 天日桶：${days.join(", ")}`,
      "",
      "| 智能体 | 任务 | 已完成 | 完成率 |",
      "| --- | --- | --- | --- |",
      ...(p?.perAgent ?? []).map((pa) => {
        const rate = percentOf(pa.completed, pa.tasks, 0) ?? 0;
        return `| ${pa.agentId} | ${pa.tasks} | ${pa.completed} | ${rate}% |`;
      }),
      "",
      "| 工具 | 调用 | 成功 |",
      "| --- | --- | --- |",
      ...perTool.map((t) => `| ${t.name} | ${t.calls} | ${t.ok} |`),
      "",
      `- 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    ];
    downloadBlob(
      new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }),
      `概览快照-${dayStamp()}.md`,
    );
  };

  const exportOverviewJson = () => {
    downloadBlob(
      new Blob(
        [
          JSON.stringify(
            {
              agent: agent.id,
              hero: heroValue,
              week: { now: weekNow, prev: weekPrev, delta: weekDelta },
              statusBars: bars,
              days14: days,
              perAgent: p?.perAgent ?? [],
              perTool,
              review: {
                pendingIssues: p?.reviewPendingIssues ?? 0,
                backlog: p?.reviewBacklog ?? [],
              },
              exportedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      `概览快照-${dayStamp()}.json`,
    );
  };

  // 核心指标复制为 TSV，便于粘贴进表格软件
  const copyTsv = () => {
    if (!p) return;
    const lines = [
      "指标\t数值",
      `累计任务\t${p.tasks}`,
      `已完成\t${p.completed}`,
      `工具成功率\t${percentFrom(successRate(outcomeOf(p)))}`,
      `工具调用失败（工具返回错误）\t${p.toolFailed}`,
      `工具调用无结果（结果未落库）\t${p.toolUnfinished}`,
      `底稿产物\t${p.artifacts}`,
      `记录级比对准确率（最近一次）\t${percentFrom(p.compareAccuracy)}`,
      `记录级比对准确率（累计）\t${percentFrom(p.compareAccuracyOverall)}`,
      `记录级比对一致率（累计）\t${percentFrom(p.compareMatchRateOverall)}`,
      `记录级比对覆盖率（累计）\t${percentFrom(p.compareCoverageOverall)}`,
      `与原始模板核对次数\t${p.compareTemplateRuns}`,
      `填列新增单元格\t${p.compareFilledCells}`,
      `与模板既有内容冲突\t${p.compareTemplateMismatched}`,
      `记录级比对项合计\t${p.compareCompared}`,
      `记录级比对一致项\t${p.compareMatched}`,
      `记录级比对填错项\t${p.compareMismatched}`,
      `记录级比对仅人工底稿有\t${p.compareOnlyA}`,
      `记录级比对仅自动底稿有\t${p.compareOnlyB}`,
      `OCR 平均置信度\t${percentFrom(p.ocrAvgConfidence)}`,
      `待复核问题合计\t${p.reviewPendingIssues}`,
      `完成但未复核任务\t${p.reviewBacklog.length}`,
    ];
    void navigator.clipboard?.writeText(lines.join("\n")).catch(() => undefined);
  };

  // 键盘 ←/→ 切换作品（输入框内不触发）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (agents.length < 2) return;
      const idx = agents.findIndex((a) => a.id === activeAgentId);
      const next = e.key === "ArrowRight" ? Math.min(agents.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (next !== idx && next >= 0) onSelect(agents[next]!.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [agents, activeAgentId, onSelect]);
  const chips = [
    {
      label:
        p && p.toolCalls > 0
          ? `工具成功率 ${percentFrom(successRate(outcomeOf(p)))}`
          : `业务工具 ${agent.tools.length} 个`,
    },
    { label: p ? `底稿产物 ${p.artifacts} 份` : `核心能力 ${agent.capabilities.length} 项` },
    {
      label:
        p && p.compareMatchRateOverall !== null ? `比对一致率 ${p.compareMatchRateOverall}%` : `历史任务 ${stats.tasks} 个`,
    },
  ];

  return (
    <section key={agent.id} className="starfield rise-in relative border-b border-line">
      <div className="px-8 pb-6 pt-7">
        <div className="kicker flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: agent.accent }} />
          Tax AI Native · {agent.id}
        </div>
        <div className="mt-3 flex items-start gap-4">
          <span
            className="glow-card flex h-12 w-12 shrink-0 items-center justify-center text-glow-300"
            style={{ boxShadow: `0 0 0 2px ${agent.accent}66, 0 10px 34px rgba(2, 8, 20, 0.55)` }}
          >
            <Icon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold leading-snug tracking-tight text-mist-100">
              {agent.shortName}
              <span className="ml-2 text-glow-300">让每一笔涉税判断都有据可查</span>
            </h1>
            <p className="mt-2 max-w-3xl text-[13px] leading-6 text-mist-500">{renderDesc(agent.description)}</p>
          </div>
        </div>

        <div className="mt-7 grid gap-8 lg:grid-cols-[300px_1fr]">
          <div>
            <Odometer value={heroValue} />
            <div className="mt-1.5 text-[13px] font-medium text-mist-100">
              本作品累计任务
              <span className="ml-2 text-[11px] font-normal text-mist-600">逐条 OCR · 行级定位</span>
              {runDays > 0 && (
                <span className="ml-2 rounded-full border border-line bg-night-850 px-2 py-0.5 text-[10px] font-normal text-mist-500">
                  本作品运行 · 第 {runDays} 天
                </span>
              )}
              {weekDelta !== 0 && (
                <span className={`ml-2 text-[11px] font-normal ${weekDelta > 0 ? "text-jade-400" : "text-rose-300"}`}>
                  {weekDelta > 0 ? "▲" : "▼"} 较上周 {weekDelta > 0 ? `+${weekDelta}` : weekDelta}
                </span>
              )}
            </div>
            <div className="mt-3 inline-flex flex-wrap items-center rounded-full border border-glow-500/35 bg-glow-500/10 px-3 py-1 text-[11px] text-glow-300">
              {chips.map((c, i) => (
                <span key={c.label} className="flex items-center">
                  {i > 0 && <span className="mx-2 text-glow-500/60">·</span>}
                  {c.label}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="kicker flex items-center justify-between">
              <span>任务状态分布 · 件数</span>
              <span>共 {stats.tasks} 件</span>
            </div>
            {/* data-status-bars：scan:uimd 靠它定位这五条，逐个核对标签与件数 */}
            <ul className="mt-3 space-y-2.5" data-status-bars="1">
              {bars.map((b) => (
                <li key={b.label} title={b.hint ?? undefined} className="grid grid-cols-[56px_1fr_36px] items-center gap-3">
                  <span className="text-[11.5px] text-mist-500">{b.label}</span>
                  <span className="bar-track">
                    <span className="bar-fill block" style={{ width: `${(b.value / barMax) * 100}%` }} />
                  </span>
                  <span className="text-right font-mono text-[11.5px] text-mist-300">{b.value}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <div className="kicker flex items-center justify-between">
                <span>任务创建趋势 · 近 14 天</span>
                <span>
                  {sparkHover !== null
                    ? `${sparkDate(sparkHover)} · ${days[sparkHover] ?? 0} 件`
                    : `日均 ${dayAvg.toFixed(1)} 件 · 今日 ${days[TREND_DAYS - 1] ?? 0} 件`}
                </span>
              </div>
              <svg
                viewBox="0 0 100 30"
                preserveAspectRatio="none"
                className="mt-2 h-10 w-full"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientX - rect.left) / rect.width;
                  setSparkHover(Math.max(0, Math.min(13, Math.round(ratio * 13))));
                }}
                onMouseLeave={() => setSparkHover(null)}
              >
                <polygon points={`0,30 ${sparkPts} 100,30`} fill="rgba(34, 211, 238, 0.12)" />
                <line
                  x1="50"
                  y1="0"
                  x2="50"
                  y2="30"
                  stroke="rgba(230, 237, 247, 0.18)"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
                <polyline
                  points={sparkPts}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1="0"
                  y1={28 - (dayAvg / dayMax) * 24}
                  x2="100"
                  y2={28 - (dayAvg / dayMax) * 24}
                  stroke="rgba(230, 237, 247, 0.25)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
                {sparkHover !== null && (
                  <line
                    x1={(sparkHover / 13) * 100}
                    y1="0"
                    x2={(sparkHover / 13) * 100}
                    y2="30"
                    stroke="rgba(230, 237, 247, 0.4)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
              {/* data-week-compare：scan:uimd 靠它定位本周 / 上周两行，核对件数与环比增量 */}
              <div className="mt-3 grid grid-cols-[52px_1fr_40px] items-center gap-x-3 gap-y-1.5" data-week-compare="1">
                <span className="text-[11px] text-mist-500">本周</span>
                <span className="bar-track">
                  <span
                    className="bar-fill block"
                    style={{ width: `${(weekNow / Math.max(1, weekNow, weekPrev)) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-[11px] text-mist-300">
                  {weekNow}
                  {weekDelta !== 0 && (
                    <span className={`ml-1 ${weekDelta > 0 ? "text-jade-400" : "text-rose-300"}`} title="本周较上周增量">
                      {weekDelta > 0 ? `+${weekDelta}` : weekDelta}
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-mist-500">上周</span>
                <span className="bar-track">
                  <span
                    className="bar-fill block opacity-60"
                    style={{ width: `${(weekPrev / Math.max(1, weekNow, weekPrev)) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-[11px] text-mist-300">{weekPrev}</span>
              </div>
            </div>
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <span className="kicker">最近活动</span>
                <button type="button" className="action-btn" onClick={onShowAll} title="展开侧栏查看全部任务">
                  查看全部
                </button>
              </div>
              <ul className="mt-2 space-y-1">
                {recent.length === 0 && <li className="px-1.5 text-[11.5px] text-mist-600">暂无任务</li>}
                {recent.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onOpenTask(r.id)}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          window.open(
                            `${window.location.pathname}#/agent/${activeAgentId}/task/${r.id}/tab/result`,
                            "_blank",
                          );
                        }
                      }}
                      title={r.title}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-night-800"
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RECENT_DOT[r.status] ?? "bg-mist-600"}`} />
                      {(() => {
                        const RIcon = r.agentId === "rd-audit" ? IconFlask : IconBuilding;
                        return <RIcon className="h-3 w-3 shrink-0 text-glow-400" />;
                      })()}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-mist-300">{r.title}</span>
                      {(r.runCount ?? 1) > 1 && (
                        <span className="shrink-0 font-mono text-[9.5px] text-glow-300" title="运行次数（含续跑）">
                          ↻{r.runCount}
                        </span>
                      )}
                      <span
                        className="shrink-0 text-[10px] text-mist-600"
                        title={
                          r.status === "failed"
                            ? r.interrupted
                              ? "服务重启打断了执行，续跑即可，不是 Agent 出错"
                              : "Agent 执行报错，需要看错误原因"
                            : undefined
                        }
                      >
                        {r.status === "failed" ? (r.interrupted ? "已中断" : "执行失败") : (RECENT_TEXT[r.status] ?? r.status)}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-mist-600">{relTime(r.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {stats.platform && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <span className="kicker">平台应用效果 · 实时运行数据</span>
              <span className="no-print flex gap-1.5">
                <button type="button" className="action-btn" onClick={() => exportStats("md")} title="导出 Markdown 快照">
                  导出 MD
                </button>
                <button type="button" className="action-btn" onClick={() => exportStats("json")} title="导出 JSON 原始数据">
                  导出 JSON
                </button>
                <button type="button" className="action-btn" onClick={exportOverview} title="导出概览全量快照 MD">
                  导出概览
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={exportOverviewJson}
                  title="导出概览快照 JSON（机器可读）"
                >
                  概览 JSON
                </button>
                <button type="button" className="action-btn" onClick={copyTsv} title="复制核心指标为 TSV">
                  复制表格
                </button>
              </span>
            </div>
            {/* data-kpi-grid：scan:uimd 靠它定位这一排卡片，逐个核对数字与单位串 */}
            <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" data-kpi-grid="1">
              {[
                { label: "平台累计任务", key: "tasks", value: stats.platform.tasks.toLocaleString("zh-CN"), unit: "个", desc: "全平台已创建任务总数（含未完成）；本作品的任务数见页首 hero 与「任务状态分布 · 共 N 件」" },
                { label: "平台已完成", key: "completed", value: stats.platform.completed.toLocaleString("zh-CN"), unit: "个", desc: "全平台状态为 completed 的任务数；本作品的已完成数见「任务状态分布」第一条" },
                {
                  label: "工具成功率",
                  desc: `有返回结果的工具调用中 ok=1 的占比，分母 ${resolvedCalls(
                    outcomeOf(stats.platform),
                  )} 次（成功 ${stats.platform.toolOk} + 失败 ${stats.platform.toolFailed}）${
                    stats.platform.toolUnfinished > 0
                      ? `；另有 ${stats.platform.toolUnfinished} 次调用没有结果落库（result 与 ended_at 均为空：结束事件未配对回该行，或进程在工具返回前结束），既不进分子也不进分母，不与工具报错混为一谈`
                      : ""
                  }`,
                  value: percentValue(stats.platform.toolOk, resolvedCalls(outcomeOf(stats.platform))),
                  unit: "%",
                },
                { label: "底稿产物", key: "artifacts", value: stats.platform.artifacts.toLocaleString("zh-CN"), unit: "份", desc: "各任务 outputs 目录文件计数" },
                {
                  label: "记录级比对准确率",
                  desc: `最近一次记录级比对的准确率（同行评审共 ${stats.platform.compareRuns} 次，按调用时间取最新${
                    stats.platform.compareLatestAt ? `：${stats.platform.compareLatestAt}` : ""
                  }）；累计口径为各任务最近一次记录级比对的 一致项/比对项 合计 = ${stats.platform.compareMatched}/${
                    stats.platform.compareCompared
                  }。构成：差异 ${stats.platform.compareMismatched} 项、仅人工底稿有 ${stats.platform.compareOnlyA} 项、仅自动底稿有 ${
                    stats.platform.compareOnlyB
                  } 项。一致率 ${percentFrom(stats.platform.compareMatchRateOverall)} 只看两边都有的项（填得对不对），覆盖率 ${percentFrom(
                    stats.platform.compareCoverageOverall,
                  )} 看人工底稿有的项自动填到了多少（填得全不全）。总准确率把这两类问题混在一个数里，实测有过填错 0 项、仅范围差异 48 项却显示准确率 0% 的一次。另有「已填列底稿 vs 它自己的原始模板」核对 ${
                    stats.platform.compareTemplateRuns
                  } 次（填列新增 ${stats.platform.compareFilledCells} 处、与模板既有内容冲突 ${
                    stats.platform.compareTemplateMismatched
                  } 处），这一类不计入上面两个比率：模板本来是空的，只有一侧有的格子正是填进去的值`,
                  value: stats.platform.compareAccuracy !== null ? String(stats.platform.compareAccuracy) : "—",
                  // 单位串保持原长度量级：这张卡在 xl:grid-cols-6 的窄格里，写长了会折行挤动整排布局
                  unit:
                    stats.platform.compareMatchRateOverall !== null
                      ? `% · 累计一致率 ${stats.platform.compareMatchRateOverall}%`
                      : "%",
                },
                {
                  label: "OCR 平均置信度",
                  desc: "parse_uploaded_files 各文档 tesseract 置信度均值",
                  value:
                    stats.platform.ocrAvgConfidence !== null ? String(stats.platform.ocrAvgConfidence) : "—",
                  unit: stats.platform.ocrRuns > 0 ? `% · ${stats.platform.ocrRuns} 次` : "%",
                },
              ].map((kpi) => (
                <div key={kpi.label} className="glow-card px-4 py-3" title={kpi.desc}>
                  <div className="text-[11px] text-mist-600">{kpi.label}</div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-[22px] font-semibold tracking-tight text-jade-400">{kpi.value}</span>
                    {kpi.key ? deltaBadge(kpi.key) : null}
                    {/* % 一类符号单位紧贴数字：负边距抵掉 flex 的 gap-1，中文单位仍留一格 */}
                    <span className={`text-[11px] text-mist-600${needsUnitSpace(kpi.unit) ? "" : " -ml-1"}`}>
                      {kpi.unit}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {stats.platform.reviewPendingIssues > 0 && (
              <div className="mt-3 rounded-md border border-line bg-night-850 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-mist-300">
                  <span className="font-medium">全平台待复核问题</span>
                  <span className="text-[11.5px] text-mist-400">
                    {reviewSummary.items} 项 · 按「类型 + 描述」去重后 {reviewSummary.groups} 类
                    {reviewSummary.recurringGroups > 0
                      ? `，其中 ${reviewSummary.recurringGroups} 类在多个任务里重复出现（涉及 ${reviewSummary.recurringItems} 项）`
                      : ""}
                  </span>
                  <span className="text-[11px] text-mist-500">同一类问题一次处置，各任务分别写复核记录与事件留痕</span>
                  <label className="ml-auto flex items-center gap-1.5 text-[11px] text-mist-500">
                    复核意见
                    <input
                      value={reviewComment}
                      onChange={(e) => setReviewComment(e.target.value)}
                      placeholder="选填，随处置写入每个任务"
                      className="w-[210px] rounded border border-line bg-night-900 px-1.5 py-0.5 text-[11px] text-mist-200"
                    />
                  </label>
                </div>
                {reviewMsg && <div className="mt-1 text-[11px] text-jade-300">{reviewMsg}</div>}
                <div className="mt-1.5 space-y-1">
                  {(reviewShowAll ? reviewGroups : reviewGroups.slice(0, 8)).map((g) => {
                    const key = `${g.issueType}|${g.description}`;
                    const items = g.items.map((i) => ({ taskId: i.taskId, issueId: i.issueId }));
                    return (
                      <div
                        key={key}
                        className="flex flex-wrap items-center gap-1.5 rounded border border-line/70 px-2 py-1"
                      >
                        <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-mist-400">
                          {g.issueType}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-mist-200" title={g.description}>
                          {g.description}
                        </span>
                        <span className="shrink-0 text-[10.5px] text-mist-500">{g.items.length} 个任务</span>
                        {g.items.slice(0, 4).map((it) => (
                          <button
                            key={`${it.taskId}:${it.issueId}`}
                            type="button"
                            className="action-btn !text-[10.5px]"
                            title={`${it.taskTitle}：前往该任务复核页逐项查看`}
                            onClick={() => onOpenTask(it.taskId)}
                          >
                            {it.taskTitle.length > 10 ? `${it.taskTitle.slice(0, 10)}…` : it.taskTitle}
                          </button>
                        ))}
                        {g.items.length > 4 && (
                          <span className="shrink-0 text-[10.5px] text-mist-600">+{g.items.length - 4}</span>
                        )}
                        {onBatchReview && (
                          <span className="ml-auto flex shrink-0 gap-1.5">
                            <button
                              type="button"
                              className="action-btn !text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={reviewBusy !== ""}
                              title="把这一类问题在全部涉及的任务里判为「确认列入底稿」：每个任务各写一条复核记录与状态事件，待复核清零且处于待复核态的任务流转为已完成"
                              onClick={() => armReviewBatch(key, items, "confirm")}
                            >
                              {reviewBusy === key
                                ? "处理中…"
                                : reviewArmed === `${key}|confirm`
                                  ? `再点一次确认（${g.items.length} 项）`
                                  : "全部确认"}
                            </button>
                            <button
                              type="button"
                              className="action-btn !text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={reviewBusy !== ""}
                              title="把这一类问题在全部涉及的任务里判为「无需处理」：同样逐任务留痕"
                              onClick={() => armReviewBatch(key, items, "dismiss")}
                            >
                              {reviewArmed === `${key}|dismiss` ? `再点一次驳回（${g.items.length} 项）` : "全部驳回"}
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {reviewGroups.length > 8 && (
                  <button
                    type="button"
                    className="action-btn mt-1.5 !text-[11px]"
                    onClick={() => setReviewShowAll((v) => !v)}
                  >
                    {reviewShowAll ? "收起" : `展开其余 ${reviewGroups.length - 8} 类`}
                  </button>
                )}
              </div>
            )}
            {stats.platform.reviewBacklog.length > 0 ? (
              <div className="mt-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-amber-200">
                  <span className="font-medium">全平台复核闭环缺口</span>
                  <span className="text-[11.5px] text-amber-200/85">
                    {stats.platform.reviewBacklog.length} 个已完成任务仍有 {backlogPending} 项问题未复核（全平台待复核合计 {stats.platform.reviewPendingIssues} 项）
                    {backlogByAgent.length > 1 && `（${backlogByAgent.map(([id, l]) => `${agentName(id)} ${l.length}`).join(" / ")}）`}
                  </span>
                  <span className="text-[11px] text-mist-500">点击任务前往复核页逐项处理</span>
                  {onBatchReopen && (
                    <button
                      type="button"
                      className="action-btn ml-auto !text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={batchBusy !== ""}
                      title="把下列已完成但仍有未复核问题的任务批量改回待复核状态，每个任务都会写入状态事件留痕"
                      onClick={() => {
                        armBatch("全平台", (stats.platform?.reviewBacklog ?? []).map((b) => b.id));
                      }}
                    >
                      {batchBusy === "全平台"
                        ? "处理中…"
                        : batchArmed === "全平台"
                          ? `再点一次确认（${stats.platform.reviewBacklog.length} 个）`
                          : "批量转为待复核"}
                    </button>
                  )}
                </div>
                {batchMsg && <div className="mt-1 text-[11px] text-jade-300">{batchMsg}</div>}
                <div className="mt-1.5 space-y-1">
                  {backlogByAgent.map(([agentId, list]) => {
                    const label = agentName(agentId);
                    return (
                    <div key={agentId} className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="w-[72px] shrink-0 truncate text-[10.5px] text-mist-500"
                        title={`${label}：${list.length} 个任务，合计 ${list.reduce(
                          (s, b) => s + b.pending,
                          0,
                        )} 项未复核`}
                      >
                        {label}
                      </span>
                      {list.slice(0, 6).map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          className="action-btn !text-[11px]"
                          onClick={() => onOpenTask(b.id)}
                          title={`${b.title}（${agentName(agentId)}，${b.pending} 项未复核）`}
                        >
                          {b.title.length > 16 ? `${b.title.slice(0, 16)}…` : b.title} · {b.pending}
                        </button>
                      ))}
                      {list.length > 6 && (
                        <span className="self-center text-[10.5px] text-mist-500">等 {list.length} 个</span>
                      )}
                      {onBatchReopen && (
                        <button
                          type="button"
                          className="action-btn ml-auto !text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={batchBusy !== ""}
                          title={`只把「${label}」的 ${list.length} 个已完成任务改回待复核（两步确认，逐个写入状态事件）`}
                          onClick={() => armBatch(label, list.map((b) => b.id))}
                        >
                          {batchBusy === label
                            ? "处理中…"
                            : batchArmed === label
                              ? "再点确认"
                              : `转该组 ${list.length}`}
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-jade-400/30 bg-jade-400/5 px-3 py-2 text-[11.5px] text-jade-300">
                全平台复核闭环无缺口：没有「已完成但仍有未复核问题」的任务（待复核态任务尚有 {stats.platform.reviewPendingIssues} 项在处理中）
              </div>
            )}
            {failures.length > 0 && (
              <div className="mt-3 rounded-md border border-rose-400/35 bg-rose-400/5 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-rose-200">
                  <span className="font-medium">失败的工具调用</span>
                  <span className="text-[11.5px] text-rose-200/85">
                    {stats.platform.toolFailed} 次 · 归为 {failSummary.causes} 类
                    {failSummary.fixableByUs > 0 && `，其中 ${failSummary.fixableByUs} 次可以靠提示词或用法约束减少`}
                    {failures.length < stats.platform.toolFailed && `（清单只显示最新 ${failures.length} 条）`}
                  </span>
                  <span className="text-[11px] text-mist-500">按归因分类，因为几类的处置方式完全不同</span>
                </div>
                <div className="mt-2 space-y-2.5">
                  {(failShowAll ? failureGroups : failureGroups.slice(0, 2)).map((g) => (
                    <div key={g.cause}>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="shrink-0 rounded border border-rose-400/40 px-1.5 py-0.5 text-[10.5px] text-rose-200">
                          {g.label}
                        </span>
                        <span className="shrink-0 text-[10.5px] text-mist-500">{g.items.length} 次</span>
                        <span className="min-w-0 flex-1 text-[11px] text-mist-500" title={g.hint}>
                          {g.hint}
                        </span>
                      </div>
                      <div className="mt-1 space-y-1.5">
                        {g.items.map((f, i) => (
                          <div key={`${f.taskId}:${f.startedAt}:${i}`} className="min-w-0 pl-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="shrink-0 font-mono text-[10.5px] text-mist-400">{f.toolName}</span>
                              <button
                                type="button"
                                className="action-btn shrink-0 !text-[10.5px]"
                                title={`${f.taskTitle}：前往该任务查看这次调用的完整上下文`}
                                onClick={() => onOpenTask(f.taskId)}
                              >
                                {f.taskTitle.length > 10 ? `${f.taskTitle.slice(0, 10)}…` : f.taskTitle}
                              </button>
                              <span className="shrink-0 text-[10.5px] text-mist-600">{relTime(f.startedAt)}</span>
                              <span
                                className="min-w-0 flex-1 truncate text-[11px] text-rose-200/90"
                                title={`错误正文：${f.error}`}
                              >
                                {f.error}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[10.5px] text-mist-600" title={`入参：${f.args}`}>
                              入参 {f.args}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {failureGroups.length > 2 && (
                  <button
                    type="button"
                    className="action-btn mt-2 !text-[11px]"
                    onClick={() => setFailShowAll((v) => !v)}
                  >
                    {failShowAll ? "收起" : `展开其余 ${failureGroups.length - 2} 类`}
                  </button>
                )}
              </div>
            )}
            {p?.evidence &&
              (p.evidence.gaps.length > 0 ? (
                <div className="mt-3 rounded-md border border-sky-400/35 bg-sky-400/5 px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-sky-200">
                    <span className="font-medium">全平台证据缺口</span>
                    <span className="text-[11.5px] text-sky-200/85">
                      联网引用 {p.evidence.citations} 条（工具留存 {p.evidence.citationsFromTools} · 结论正文{" "}
                      {p.evidence.citationsFromConclusion}，其中官方来源 {p.evidence.officialCitations} 条{" "}
                      {evidenceTrend("officialCitations", false)}）·
                      {p.evidence.gaps.length} 个任务有待处置的弱证据引用或待复查文号：证据力弱{" "}
                      {p.evidence.weakCitations} 条
                      {p.evidence.weakDisclaimed + p.evidence.weakUncited > 0
                        ? `（其中 ${p.evidence.weakDisclaimed} 条已在结论中声明为背景参考、${p.evidence.weakUncited} 条未进入结论正文，待处置 ${weakOpenTotal} 条）`
                        : ""}{" "}
                      {evidenceTrend("weakCitations", true)} ·
                      {p.evidence.weakWithReplacement > 0 && (
                        <span className="text-jade-300">
                          其中 {p.evidence.weakWithReplacement} 条已找到官方替代来源、待人工写回结论 ·
                        </span>
                      )}
                      政策文号待复查 {docOpenTotal} 处 {evidenceTrend("docRefPending", true)}
                      {docLabeledTotal > 0 ? `（另有 ${docLabeledTotal} 处已在结论中标注为背景参考、不作为依据）` : ""}
                      （{p.evidence.docRefMatched} 处已复查到公开出处，其中 {p.evidence.docRefTracedByRecheck}{" "}
                      处已计入「有出处」）·
                      联网检索拦下 {p.evidence.searchDropped + p.evidence.searchDroppedReplay} 条无关结果与门户首页
                      {p.evidence.searchDropped === 0 && p.evidence.searchDroppedReplay > 0
                        ? "（历史记录按现行相关度规则回算）"
                        : ""}
                      {gapByAgent.length > 1 &&
                        `（${gapByAgent.map(([id, l]) => `${agentName(id)} ${l.length}`).join(" / ")}）`}
                    </span>
                    <span className="text-[11px] text-mist-500">
                      点击任务前往结果页：引用胶囊看证据力分级，文号徽章可一键联网复查
                    </span>
                    {onBatchRefCheck && (docOpenTotal > 0 || weakOpenTotal > 0) && (
                      <span className="ml-auto flex shrink-0 gap-1.5">
                        {docOpenTotal > 0 && (
                          <button
                            type="button"
                            className="action-btn !text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={refBatchBusy !== ""}
                            title="用自建检索通道（Bing RSS 优先 + 相关度过滤）批量复查各任务里没有出处、且还没在结论中标注为背景参考的政策文号，判定与证据链接按条落库并写入事件留痕；单次条数受服务端预算限制"
                            onClick={() =>
                              armRefBatch(
                                "docref",
                                (p?.evidence?.gaps ?? []).filter((g) => docOpen(g) > 0).map((g) => g.id),
                              )
                            }
                          >
                            {refBatchBusy === "docref"
                              ? "复查中…"
                              : refBatchArmed === "docref"
                                ? `再点一次确认（待复查 ${docOpenTotal} 处，单次按预算分批）`
                                : "批量复查文号"}
                          </button>
                        )}
                        {weakOpenTotal > 0 && (
                          <button
                            type="button"
                            className="action-btn !text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={refBatchBusy !== ""}
                            title="为各任务里判为「证据力弱」、且既没在结论中声明为背景参考、也确实写进了结论正文的引用（门户首页 / 百科词条 / 检索页）批量检索官方替代来源：检索词 = 去掉站点后缀的标题 + 该任务结论里的领域词，并排除引用自身；替代来源需人工确认后写回结论"
                            onClick={() =>
                              armRefBatch(
                                "citation",
                                (p?.evidence?.gaps ?? []).filter((g) => weakOpen(g) > 0).map((g) => g.id),
                              )
                            }
                          >
                            {refBatchBusy === "citation"
                              ? "检索中…"
                              : refBatchArmed === "citation"
                                ? `再点一次确认（待处置 ${weakOpenTotal} 条，单次按预算分批）`
                                : "批量找替代来源"}
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {refBatchMsg && <div className="mt-1 text-[11px] text-jade-300">{refBatchMsg}</div>}
                  <div className="mt-1.5 space-y-1">
                    {gapByAgent.map(([agentId, list]) => (
                      <div key={agentId} className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="w-[72px] shrink-0 truncate text-[10.5px] text-mist-500"
                          title={`${agentName(agentId)}：${list.length} 个任务，待处置弱证据引用 ${list.reduce(
                            (s, g) => s + weakOpen(g),
                            0,
                          )} 条 · 待复查文号 ${list.reduce((s, g) => s + docOpen(g), 0)} 处`}
                        >
                          {agentName(agentId)}
                        </span>
                        {list.slice(0, 6).map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            className="action-btn !text-[11px]"
                            onClick={() => onOpenTask(g.id)}
                            title={`${g.title}（${agentName(agentId)}）：待处置弱证据引用 ${weakOpen(g)} 条${
                              g.weakDisclaimed + g.weakUncited > 0
                                ? `（另有 ${g.weakDisclaimed} 条已在结论中声明为背景参考、${g.weakUncited} 条未进入结论正文）`
                                : ""
                            } · 待复查文号 ${docOpen(g)} 处${
                              g.docRefLabeled > 0 ? `（另有 ${g.docRefLabeled} 处已标注为背景参考）` : ""
                            }`}
                          >
                            {g.title.length > 16 ? `${g.title.slice(0, 16)}…` : g.title}
                            {weakOpen(g) > 0 ? ` · 弱${weakOpen(g)}` : ""}
                            {docOpen(g) > 0 ? ` · 文号${docOpen(g)}` : ""}
                          </button>
                        ))}
                        {list.length > 6 && (
                          <span className="self-center text-[10.5px] text-mist-500">等 {list.length} 个</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-md border border-jade-400/30 bg-jade-400/5 px-3 py-2 text-[11.5px] text-jade-300">
                  全平台证据链无缺口：{p.evidence.citations} 条联网引用中没有门户首页或百科词条（官方原文{" "}
                  {p.evidence.officialCitations} 条），政策文号 {p.evidence.docRefs} 处全部有出处或已复查到公开出处；联网检索累计拦下{" "}
                  {p.evidence.searchDropped + p.evidence.searchDroppedReplay} 条无关结果与门户首页
                </div>
              ))}
            {(() => {
              const rows = p?.evidence?.ledger ?? [];
              if (rows.length === 0) return null;
              const totals = ledgerTotals(rows);
              return (
                <details className="mt-3 rounded-md border border-line bg-night-850 px-3 py-2">
                  <summary className="cursor-pointer text-[12px] text-mist-300">
                    全平台证据核对台账（{rows.length} 个任务）
                    <span
                      className="ml-2 text-[11px] text-mist-600"
                      title={
                        "文号「有出处」按依据强度分三档，一档只算一次、相加恒等于有出处总数：\n" +
                        "· 元数据——文号出现在工具结果的结构化字段里（标题、文号列表、政策库条目），基本就是那条结果的主题。\n" +
                        "· 仅正文提到——结构化字段里没有，只在我们抓下来的网页正文里出现过。可能只是页面侧栏的相关文件列表，或正文里一句「同时废止 2020年第24号」，这几处值得再点开原文确认一次。\n" +
                        "· 复查取得——工具留存里没有，靠联网复查判定 matched，有可点开的原文与检索时间。\n" +
                        "此前只有一个「有出处」，看不出哪几处依据偏弱；拆开后复核人不必把所有文号都重查一遍。\n\n" +
                        // 两类的措辞取自 UNTRACED_ORIGIN_TEXT / UNTRACED_ORIGIN_HINT（任务页就地标注、
                        // 复核页徽章 title、交付 MD 表格都用那一份）。这里此前手写了一遍，而且已经漂开：
                        // 共享表的连接词是「客户指令**与**联网正文」、并以「但这正是需要人逐条看的那一类」
                        // 收尾，手写副本改了连接词又删了后半句；web 那一类同样少了「不是模型有没有口算」。
                        // 同一件事写两遍，改一处忘一处，看板与任务页就各说一套——所以改成引用共享表，
                        // 并由 verify:amounts 断言三个消费点都引用它、且不再出现手写副本的措辞。
                        "金额待确认分两类，含义不同：\n" +
                        `· ${UNTRACED_ORIGIN_TEXT.web}——${UNTRACED_ORIGIN_HINT.web}\n` +
                        `· ${UNTRACED_ORIGIN_TEXT.unexplained}——${UNTRACED_ORIGIN_HINT.unexplained}\n` +
                        "不拆开的话，检索类任务的大批量引文会把真正无出处的淹掉：实测正文留存上线后的 H 任务 28 处待确认里 27 处能在联网正文找到，仅 1 处（模型把 A 项目 90 万与 B 项目 100 万自己加成 190 万）真的无出处。"
                      }
                    >
                      文号 {totals.docRefTraced}/{totals.docRefTotal} 有出处（其中复查取得{" "}
                      {totals.docRefTracedByRecheck} · 仅正文提到 {totals.docRefTracedByBody}）· 待复查{" "}
                      {Math.max(0, totals.docRefPending - totals.docRefLabeled)}
                      {totals.docRefLabeled > 0 ? `（已标注 ${totals.docRefLabeled}）` : ""} · 引用{" "}
                      {totals.citations} 条（官方 {totals.official} · 弱 {totals.weak}
                      {totals.weakDisclaimed + totals.weakUncited > 0
                        ? `，待处置 ${Math.max(0, totals.weak - totals.weakDisclaimed - totals.weakUncited)}`
                        : ""}
                      ）· 金额待确认 {totals.amountPending}
                      {totals.amountPending > 0
                        ? `（引自联网正文 ${totals.amountPendingWeb} · 三处均无出处 ${totals.amountPendingUnexplained}）`
                        : ""}{" "}
                      · 欠账任务 {totals.withGaps} 个
                    </span>
                  </summary>
                  <div className="no-print mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="action-btn"
                      title="下载台账 Markdown（含合计行与口径说明，可直接进归档材料）"
                      onClick={() =>
                        downloadText(
                          "全平台证据核对台账.md",
                          `${ledgerMarkdown(rows, agentName, new Date().toLocaleString("zh-CN", { hour12: false })).join("\n")}\n`,
                          "text/markdown",
                        )
                      }
                    >
                      下载 MD
                    </button>
                    <button
                      type="button"
                      className="action-btn"
                      title="下载台账 CSV（UTF-8 带 BOM，Excel 直接打开不乱码）"
                      onClick={() => downloadText("全平台证据核对台账.csv", ledgerCsv(rows, agentName), "text/csv", true)}
                    >
                      下载 CSV
                    </button>
                    <button
                      type="button"
                      className="action-btn"
                      title="复制台账 Markdown 到剪贴板"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(ledgerMarkdown(rows, agentName).join("\n"))
                          .catch(() => undefined)
                      }
                    >
                      复制 MD
                    </button>
                    <span className="self-center text-[10.5px] text-mist-600">
                      行序按欠账（证据力弱 + 待复查文号）倒序；口径与任务页证据核对表一致
                    </span>
                  </div>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="text-left text-mist-500">
                          {LEDGER_COLUMNS.map((c) => (
                            <th key={c} className="whitespace-nowrap border-b border-line px-1.5 py-1 font-normal">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.taskId} className="align-top">
                            {ledgerCells(r, agentName).map((cell, i) =>
                              i === 0 ? (
                                <td key={i} className="max-w-[220px] truncate border-b border-line/60 px-1.5 py-1">
                                  <button
                                    type="button"
                                    className="text-mist-200 transition-colors hover:text-glow-300"
                                    title={`${r.title}（点击打开任务）`}
                                    onClick={() => onOpenTask(r.taskId)}
                                  >
                                    {cell}
                                  </button>
                                </td>
                              ) : (
                                <td
                                  key={i}
                                className={`whitespace-nowrap border-b border-line/60 px-1.5 py-1 ${
                                    LEDGER_GAP_COLS.has(i) && cell !== "0" ? "text-amber-300" : "text-mist-500"
                                  }`}
                                >
                                  {cell}
                                </td>
                              ),
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })()}
            {stats.platform.perAgent.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {stats.platform.perAgent.map((pa) => {
                  const rate = percentOf(pa.completed, pa.tasks, 0) ?? 0;
                  const info = agents.find((a) => a.id === pa.agentId);
                  return (
                    <div key={pa.agentId} className="glow-card flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 truncate text-[12px] text-mist-300">{info?.shortName ?? pa.agentId}</span>
                      <span className="bar-track flex-1">
                        <span className="bar-fill block" style={{ width: `${rate}%` }} />
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[11px] ${rate >= 80 ? "text-jade-400" : "text-mist-500"}`}
                        title={`已完成 ${pa.completed}/${pa.tasks}`}
                      >
                        {rate}%
                      </span>
                      {(() => {
                        const b = buckets14(perAgentCreatedAts[pa.agentId] ?? []);
                        const mx = Math.max(1, ...b);
                        const pts = b
                          .map((v, i) => `${((i / 13) * 100).toFixed(2)},${(28 - (v / mx) * 24).toFixed(2)}`)
                          .join(" ");
                        return (
                          <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-5 w-14 shrink-0" aria-hidden>
                            <polyline
                              points={pts}
                              fill="none"
                              stroke="#22d3ee"
                              strokeWidth="2"
                              vectorEffect="non-scaling-stroke"
                            />
                          </svg>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {(() => {
          if (!p || p.toolCalls === 0) return null;
          const c = outcomeOf(p);
          const rate = successRate(c);
          return (
            <div className="mt-4 flex items-center gap-4">
              <svg viewBox="0 0 32 32" className="h-14 w-14 shrink-0" aria-hidden>
                {ringSegments(c, RING_C).map((seg) =>
                  seg.length > 0 ? (
                    <circle
                      key={seg.key}
                      cx="16"
                      cy="16"
                      r="12"
                      fill="none"
                      stroke={RING_COLOR[seg.key]}
                      strokeWidth="5"
                      strokeDasharray={`${seg.length} ${RING_C}`}
                      strokeDashoffset={seg.offset}
                      transform="rotate(-90 16 16)"
                    />
                  ) : null,
                )}
                <text x="16" y="18" textAnchor="middle" fill="#e6edf7" style={{ fontSize: 8.5, fontWeight: 600 }}>
                  {rate === null ? "—" : `${Math.round(rate)}%`}
                </text>
              </svg>
              <div className="space-y-0.5 text-[11px] text-mist-500">
                <div>
                  工具调用 <span className="font-mono text-mist-300">{c.calls}</span> 次 · 成功率{" "}
                  <span className="font-mono text-jade-400">{percentFrom(rate)}</span>
                </div>
                <div>
                  成功 <span className="font-mono text-jade-400">{c.ok}</span> · 失败{" "}
                  <span className="font-mono text-rose-300">{c.failed}</span>
                  {c.unfinished > 0 ? (
                    <>
                      {" · 无结果 "}
                      <span className="font-mono text-amber-300">{c.unfinished}</span>
                    </>
                  ) : null}
                </div>
                <div className="text-[10.5px] text-mist-600">
                  成功率分母为有返回结果的 {resolvedCalls(c)} 次
                  {c.unfinished > 0 ? `；${c.unfinished} 次调用没有结果落库（结束事件未配对回该行），不计入` : ""}
                </div>
              </div>
            </div>
          );
        })()}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="kicker">核心业务能力</div>
            <ul className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {(capsOpen ? agent.capabilities : agent.capabilities.slice(0, 8)).map((c) => (
                <li key={c} className="flex items-start gap-2 text-[13px] text-mist-300">
                  {(() => {
                    const I = capIcon(c);
                    return <I className={`mt-1 h-3.5 w-3.5 shrink-0 ${I === IconCheck ? "text-jade-400" : "text-glow-400"}`} />;
                  })()}
                  {c}
                </li>
              ))}
            </ul>
            {agent.capabilities.length > 8 && (
              <button type="button" className="action-btn mt-1.5" onClick={() => setCapsOpen((v) => !v)}>
                {capsOpen ? "收起" : `展开全部 ${agent.capabilities.length} 项`}
              </button>
            )}
          </div>

          <div className="hidden lg:block">
            <div className="flex items-center gap-1.5 kicker">
              <IconTool className="h-3.5 w-3.5" />
              已注册工具
              <button
                type="button"
                className="action-btn ml-auto"
                data-on={toolSort}
                onClick={() => setToolSort((v) => !v)}
                title="按历史调用数排序"
              >
                按调用排序
              </button>
            </div>
            <ul className="mt-2.5 space-y-2">
              {(toolSort
                ? [...agent.tools].sort((a, b) => toolCount(b.name) - toolCount(a.name))
                : agent.tools
              ).map((tool) => (
                <li key={tool.name} className="glow-card px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[11.5px] text-glow-300">{tool.name}</span>
                    {toolCount(tool.name) > 0 && (
                      <span
                        className="ml-auto shrink-0 rounded border border-glow-500/35 bg-glow-500/10 px-1.5 py-0.5 font-mono text-[10px] text-glow-300"
                        title={`历史调用 ${toolCount(tool.name)} 次`}
                      >
                        {toolCount(tool.name)} 次
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12px] text-mist-500">{tool.label}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {agents.length > 1 && (
        <div className="flex items-center gap-2 border-t border-line px-8 py-2.5">
          <span className="text-[12px] text-mist-600">切换作品（←/→）：</span>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                a.id === activeAgentId
                  ? "border-glow-500 bg-night-700 text-glow-300"
                  : "border-line bg-night-850 text-mist-500 hover:border-glow-500 hover:text-mist-100"
              }`}
              >
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: a.accent }} />
                {a.shortName}
                {lastAt[a.id] && <span className="ml-1 text-[10px] opacity-70">{relTime(lastAt[a.id]!)}</span>}
              </button>
          ))}
        </div>
      )}
    </section>
  );
}
const RECENT_DOT: Record<string, string> = {
  processing: "bg-amber-400",
  waiting_review: "bg-sky-400",
  completed: "bg-jade-400",
  failed: "bg-rose-400",
  created: "bg-mist-600",
};

const RECENT_TEXT: Record<string, string> = {
  processing: "执行中",
  waiting_review: "待复核",
  completed: "已完成",
  failed: "执行失败",
  created: "待执行",
};

/** 近 14 天日桶计数（按智能体子集复用）。 */
function buckets14(dates: string[]): number[] {
  const buckets = Array.from({ length: 14 }, () => 0);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  for (const c of dates) {
    const d = new Date(c);
    const diff = Math.floor((today - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff >= 0 && diff < 14) buckets[13 - diff] = (buckets[13 - diff] ?? 0) + 1;
  }
  return buckets;
}

/** 能力清单按关键词分类配图标 */
function capIcon(c: string) {
  if (/测算|计算|整数|限额|填列/.test(c)) return IconTool;
  if (/检索|联网|核验|政策/.test(c)) return IconExternal;
  if (/底稿|导出|文档|报告|版式/.test(c)) return IconFile;
  return IconCheck;
}
