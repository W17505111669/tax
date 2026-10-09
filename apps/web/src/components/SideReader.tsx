import { useCallback, useEffect, useMemo, useRef, useState, type Ref, type ReactNode } from "react";
import { api } from "../api.ts";
import type { SheetPreview } from "../types.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { usePaperTheme } from "../hooks/usePaperTheme.ts";
import { IconAlert, IconDownload, IconExternal, IconFile, IconRefresh, IconSpinner, IconX } from "./Icons.tsx";
import { currentHitRow, locateSheet, sheetLocate } from "../sheet-locate.ts";
import { dateTimeStamp } from "../time-format.ts";
import {
  asSortRecord,
  asStringRecord,
  KEYS,
  readEnum,
  readJson,
  readText,
  writeJson,
  writeRaw,
} from "../local-store.ts";
import { countMatches, findRanges, matchLabel, splitForHighlight, stepIndex, wrapIndex } from "../text-find.ts";

export type ReaderTarget =
  | { kind: "url"; url: string }
  | {
      kind: "file";
      taskId: string;
      fileId: string;
      name: string;
      highlight?: string;
      /** 比对侧期望值（差异行的 A/B 值），用于表格定位时做值校验 */
      highlightValue?: string | number | null;
    }
  | {
      kind: "artifact";
      taskId: string;
      name: string;
      highlight?: string;
      highlightValue?: string | number | null;
    };

export function readerKey(target: ReaderTarget): string {
  if (target.kind === "url") return `url:${target.url}`;
  if (target.kind === "file") return `file:${target.taskId}:${target.fileId}`;
  return `artifact:${target.taskId}:${target.name}`;
}

type PreviewKind = "markdown" | "text" | "pdf" | "image" | "binary" | "sheets";

interface ReaderState {
  loading: boolean;
  error: string | null;
  kind: PreviewKind;
  title: string;
  markdown: string;
  text: string;
  src: string;
  sheets?: SheetPreview[];
  loadedAt?: string | null;
}

interface ViewState {
  zoom?: number;
  rot?: number;
  fitWidth?: boolean;
  showLines?: boolean;
  find?: string;
  sort?: Record<string, { col: string; dir: 1 | -1 }>;
}

const INITIAL: ReaderState = {
  loading: false,
  error: null,
  kind: "text",
  title: "",
  markdown: "",
  text: "",
  src: "",
  sheets: [],
  loadedAt: null,
};

function previewKind(headerKind: string | null, name: string): PreviewKind {
  if (headerKind === "pdf") return "pdf";
  if (headerKind === "image") return "image";
  if (headerKind === "text") return name.toLowerCase().endsWith(".md") ? "markdown" : "text";
  return "binary";
}

function fallbackTitle(target: ReaderTarget): string {
  if (target.kind === "url") {
    try {
      return new URL(target.url).hostname;
    } catch {
      return target.url;
    }
  }
  return target.name;
}

interface Props {
  tabs: ReaderTarget[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onCloseTab: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onCloseAll: (keepKeys: string[]) => void;
  onClose: () => void;
  /** 比对页「双栏定位」请求：开启对照并把副栏指向另一份底稿（nonce 变化即生效） */
  splitRequest?: { secondKey: string; nonce: number } | null;
}

/** 侧边可折叠阅读器：支持多文档标签页，网页阅读模式、任务资料与生成产物统一预览。 */
/** 搜索命中包裹 mark 节点（主栏与对照副栏共用）。 */
function highlightNodes(text: string, q: string): ReactNode {
  if (!q) return text;
  const parts = splitForHighlight(text, q);
  if (parts.length === 1 && !parts[0]!.hit) return text;
  return parts.map((p, i) =>
    p.hit ? (
      <mark key={i} className="rounded-sm bg-amber-200 px-0.5 text-gray-900">
        {p.text}
      </mark>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}

/** 双栏对照的简化副栏：支持 markdown/text/image/pdf/表格简化视图，二进制引导回主栏。 */
function MiniPane({
  st,
  title,
  innerRef,
  find,
  mainSort,
  highlight,
  highlightValue,
  hitIndex,
}: {
  st: ReaderState;
  title: string;
  innerRef?: Ref<HTMLDivElement>;
  find?: string;
  /** 主栏当前文件的排序状态（按工作表名索引），副栏跟随以保证双栏行序一致 */
  mainSort?: Record<string, { col: string; dir: 1 | -1 }>;
  /** 比对定位关键字，与主栏同源；副栏同步标出命中行与单元格 */
  highlight?: string;
  /** 该侧差异值，与主栏同源；用于命中校验 */
  highlightValue?: string | number | null;
  /** 主栏当前命中序号；副栏按自身命中序列表取同序号处（不足则取最后一处） */
  hitIndex?: number;
}) {
  const [z, setZ] = useState(1);
  const [mfind, setMfind] = useState("");
  const [msheet, setMsheet] = useState(0);
  const localRef = useRef<HTMLDivElement | null>(null);
  // 副栏滚动容器同时挂到父级传入的 ref（滚动同步用）与本地 ref（自动定位用）
  const attachRef = (el: HTMLDivElement | null) => {
    localRef.current = el;
    if (!innerRef) return;
    if (typeof innerRef === "function") innerRef(el);
    else innerRef.current = el;
  };

  // 表格派生数据（渲染与自动定位共用）：当前工作表、跟随主栏的行序、命中结果
  const sheetView = (() => {
    if (st.kind !== "sheets" || st.loading || st.error) return null;
    const list = st.sheets ?? [];
    const idx = Math.min(msheet, Math.max(0, list.length - 1));
    const s = list[idx];
    if (!s) return null;
    const spec = mainSort?.[s.name];
    const hl = (highlight ?? "").trim();
    const located = locateSheet(s, spec, hl, highlightValue);
    // 主栏走到第几处，副栏就标自己第几处（命中数不同则夹到最后一处）
    const currentRow = currentHitRow(located.hits, hitIndex ?? 0);
    return {
      list,
      idx,
      s,
      spec,
      rows: located.rows,
      hl,
      hlHits: located.hits,
      hlCount: located.count,
      currentRow,
    };
  })();

  // 定位关键字变化时，副栏自动切到首个命中的工作表（多表底稿不用手工翻）
  useEffect(() => {
    const hl = (highlight ?? "").trim();
    if (!hl || st.kind !== "sheets" || st.loading || st.error) return;
    const list = st.sheets ?? [];
    if (list.length < 2) return;
    const hitIdx = list.findIndex((sh) => {
      const sorted = Boolean(mainSort?.[sh.name]);
      return sh.rows
        .slice(0, 100)
        .some((row, i) => sheetLocate(row, sh.headers, i, hl, sh.name, sorted, highlightValue).hit);
    });
    if (hitIdx >= 0) setMsheet(hitIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.sheets, st.loading, st.error, highlight, highlightValue]);

  // 副栏把自己的首个命中行滚到视口中央；rAF 让位给主栏定位滚动与滚动同步
  const hlCount = sheetView?.hlCount ?? 0;
  const hlKey = sheetView?.hl ?? "";
  const hlSheet = sheetView?.s.name ?? "";
  useEffect(() => {
    if (hlCount === 0) return;
    const id = requestAnimationFrame(() => {
      const root = localRef.current;
      const row = root?.querySelector<HTMLElement>("tr.hl-current") ?? root?.querySelector<HTMLElement>("tr.row-hl");
      if (!root || !row) return;
      // 表格自带内层滚动容器（max-h-[60vh]），要滚的是它而不是外层副栏
      let scroller: HTMLElement = root;
      for (let el = row.parentElement; el && el !== root; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1) {
          scroller = el;
          break;
        }
      }
      const rr = scroller.getBoundingClientRect();
      const br = row.getBoundingClientRect();
      scroller.scrollTop += br.top - rr.top - (scroller.clientHeight - br.height) / 2;
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlCount, hlKey, hlSheet, st.loading, hitIndex]);
  return (
    <div ref={attachRef} className="min-h-0 flex-1 overflow-y-auto border-l border-line px-3 py-3">
      <div className="mb-2 truncate text-[11px] text-mist-500" title={title}>
        对照：{title}
      </div>
      {st.kind === "text" && !st.loading && !st.error && (
        <input
          value={mfind}
          onChange={(e) => setMfind(e.target.value)}
          placeholder="副栏搜索…"
          className="mb-2 w-full rounded border border-line bg-night-850 px-2 py-0.5 text-[10.5px] text-mist-100 outline-none focus:glow-ring"
        />
      )}
      {(st.kind === "image" || st.kind === "pdf") && !st.loading && !st.error && (
        <div className="mb-2 flex items-center gap-1">
          <button type="button" className="action-btn" onClick={() => setZ((v) => Math.max(0.5, v - 0.25))} title="缩小">
            −
          </button>
          <span className="min-w-[38px] text-center font-mono text-[10px] text-mist-500">{Math.round(z * 100)}%</span>
          <button type="button" className="action-btn" onClick={() => setZ((v) => Math.min(3, v + 0.25))} title="放大">
            ＋
          </button>
        </div>
      )}
      {st.loading && <div className="py-6 text-center text-[11.5px] text-mist-600">加载中…</div>}
      {st.error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">{st.error}</div>
      )}
      {!st.loading && !st.error && (st.kind === "markdown" || st.kind === "text") && (
        <div className="paper-sheet theme-minimal px-3 py-2">
          {st.kind === "markdown" ? (
            <MarkdownView text={st.markdown} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-gray-700">
              {highlightNodes(st.text, mfind || (find ?? ""))}
            </pre>
          )}
        </div>
      )}
      {!st.loading && !st.error && st.kind === "image" && (
        <img
          src={st.src}
          alt={title}
          style={{ width: `${z * 100}%` }}
          className="max-w-none rounded border border-line"
        />
      )}
      {!st.loading && !st.error && st.kind === "pdf" && (
        <iframe
          src={st.src}
          title={title}
          style={{ height: `${50 * z}vh` }}
          className="w-full rounded border border-line bg-white"
        />
      )}
      {sheetView &&
        (() => {
          const { list, idx, s, spec, rows, hl, hlHits, hlCount, currentRow } = sheetView;
          return (
            <div className="paper-sheet theme-minimal px-2 py-2">
              {list.length > 1 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {list.map((sh, i) => (
                    <button
                      key={sh.name}
                      type="button"
                      className={`action-btn !text-[10px] ${i === idx ? "!text-gray-900" : "!text-gray-500"}`}
                      data-on={i === idx}
                      onClick={() => setMsheet(i)}
                      title={`${sh.name}（${sh.rowCount} 行）`}
                    >
                      {sh.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[11.5px] font-semibold text-gray-900">{s.name}</span>
                <span className="text-[10px] text-gray-500">{s.rowCount} 行</span>
                {spec && (
                  <span
                    className="ml-auto max-w-[45%] truncate text-[10px] text-gray-500"
                    title="跟随主栏排序，在主栏点击列头可切换列与升降序"
                  >
                    排序 {spec.col} {spec.dir === 1 ? "↑" : "↓"}
                  </span>
                )}
                {hl && (
                  <span
                    className={`rounded px-1 py-0.5 text-[9.5px] ${spec ? "" : "ml-auto"} ${
                      hlCount > 0 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-600"
                    }`}
                    title={
                      hlCount > 0
                        ? `副栏同步定位：命中 ${hlCount} 行（统计范围为本表已加载的前 ${rows.length} 行）`
                        : "副栏本表未匹配到定位关键字，可切换工作表查看"
                    }
                  >
                    定位 {hlCount > 0 ? `${hlCount} 行` : "未命中"}
                  </span>
                )}
              </div>
              <div className="max-h-[60vh] overflow-auto rounded border border-gray-200">
                <table
                  className="table-fixed border-collapse text-[10.5px] leading-4"
                  style={{ width: s.headers.length > 5 ? `${s.headers.length * 92}px` : "100%" }}
                >
                  <thead className="sticky top-0 z-10 bg-gray-100">
                    <tr>
                      {s.headers.map((h) => (
                        <th
                          key={h}
                          className="truncate border-b border-gray-200 px-1.5 py-1 text-left font-medium text-gray-700"
                          title={h}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const hits = hlHits[i] ?? { hit: false, cols: [] as string[] };
                      return (
                        <tr
                          key={i}
                          data-hlrow={hits.hit ? "" : undefined}
                          className={`${i % 2 ? "bg-gray-50" : ""} ${hits.hit ? "row-hl" : ""} ${
                            i === currentRow ? "hl-current" : ""
                          }`}
                        >
                          {s.headers.map((h) => {
                            const v = row[h];
                            const txt = v === null || v === undefined ? "" : String(v);
                            return (
                              <td
                                key={h}
                                className={`truncate border-b border-gray-100 px-1.5 py-0.5 text-gray-700 ${
                                  hits.cols.includes(h) ? "cell-hl" : ""
                                }`}
                                title={txt}
                              >
                                {txt}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {s.rowCount > rows.length && (
                <p className="mt-1 text-[10px] text-gray-500">
                  副栏仅显示前 {rows.length} 行（行序跟随主栏）；冻结首列 / 复制 TSV 请在主栏操作。
                </p>
              )}
            </div>
          );
        })()}
      {!st.loading && !st.error && st.kind === "binary" && (
        <div className="rounded border border-line bg-night-850 px-2 py-3 text-center text-[11px] text-mist-600">
          该类型请在主栏查看
        </div>
      )}
    </div>
  );
}

export function SideReader({
  tabs,
  activeIndex,
  onSelect,
  onCloseTab,
  onReorder,
  onCloseAll,
  onClose,
  splitRequest,
}: Props) {
  const [states, setStates] = useState<Record<string, ReaderState>>({});
  const { theme } = usePaperTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const retriedRef = useRef<Set<string>>(new Set());
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [fitWidth, setFitWidth] = useState(true);
  const [showRowNum, setShowRowNum] = useState(false);
  const [freezeFirst, setFreezeFirst] = useState(() => readText(KEYS.readerFreeze) === "1");

  useEffect(() => {
    writeRaw(KEYS.readerFreeze, freezeFirst ? "1" : "0");
  }, [freezeFirst]);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [vsPresent, setVsPresent] = useState(() => new URLSearchParams(window.location.search).has("vs"));
  const [vsError, setVsError] = useState<string | null>(null);
  const [splitView, setSplitView] = useState(false);
  const [secondIdx, setSecondIdx] = useState(0);
  const [syncScroll, setSyncScroll] = useState(false);
  const miniRef = useRef<HTMLDivElement>(null);
  const [showLines, setShowLines] = useState(false);
  const [aliases, setAliases] = useState<Record<string, string>>(() =>
    readJson(KEYS.readerAliases, asStringRecord, {}),
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [matchCounts, setMatchCounts] = useState<Record<string, number>>({});
  // markdown 的命中数以 DOM 里真实的 mark 数为准：渲染会吃掉 #、*、表格竖线一类标记，
  // 按原始 markdown 文本数出来的次数跟用户看得见的高亮对不上
  const [mdMarks, setMdMarks] = useState(0);
  const [sort, setSort] = useState<Record<string, { col: string; dir: 1 | -1 }>>(() =>
    readJson(KEYS.readerSort, asSortRecord, {}),
  );

  useEffect(() => {
    writeJson(KEYS.readerSort, sort);
  }, [sort]);

  const commitAlias = (key: string) => {
    const v = editValue.trim();
    setAliases((prev) => {
      const next = { ...prev };
      if (v) next[key] = v;
      else delete next[key];
      writeJson(KEYS.readerAliases, next);
      return next;
    });
    setEditingKey(null);
  };

  const active = tabs[activeIndex] ?? null;
  const activeKey = active ? readerKey(active) : "";
  const state = states[activeKey] ?? INITIAL;
  const activeName = active && "name" in active ? active.name : "";

  const stateObj = (): ViewState => ({
    zoom,
    rot,
    fitWidth,
    showLines,
    find: findQuery,
    sort: Object.fromEntries(Object.entries(sort).filter(([k]) => k.startsWith(`${activeKey}:`))),
  });

  // 恢复视图状态（粘贴 / ?vs= 短码共用；排序键重映射到当前标签）
  const applyStateObj = (s: ViewState) => {
    if (typeof s.zoom === "number") setZoom(Math.min(3, Math.max(0.5, s.zoom)));
    if (typeof s.rot === "number") setRot(wrapIndex(s.rot, 360));
    if (typeof s.fitWidth === "boolean") setFitWidth(s.fitWidth);
    if (typeof s.showLines === "boolean") setShowLines(s.showLines);
    if (typeof s.find === "string") setFindQuery(s.find);
    const sortEntries = s.sort && typeof s.sort === "object" ? Object.entries(s.sort) : [];
    if (sortEntries.length > 0) {
      setSort((prev) => {
        const next = { ...prev };
        for (const [k, v] of sortEntries) {
          const sheetPart = k.slice(k.indexOf(":") + 1);
          next[`${activeKey}:${sheetPart}`] = v;
        }
        return next;
      });
    }
  };

  const pasteState = async () => {
    try {
      applyStateObj(JSON.parse(await navigator.clipboard.readText()) as ViewState);
    } catch {
      /* 剪贴板内容非法时忽略 */
    }
  };

  // 打开带 ?vs= 短码的链接时自动应用视图状态（每个标签一次）
  const vsAppliedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const vs = new URLSearchParams(window.location.search).get("vs");
    if (!vs || !activeKey || vsAppliedRef.current.has(activeKey)) return;
    vsAppliedRef.current.add(activeKey);
    try {
      applyStateObj(JSON.parse(decodeURIComponent(atob(vs))) as ViewState);
      setVsError(null);
    } catch {
      setVsError("短码无效，已按默认视图打开");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Text preview in-page search highlight
  const findTrim = findQuery.trim();
  const highlight = (text: string) => {
    return highlightNodes(text, findTrim);
  };
  const secondIdxSafe = tabs.length > 0 ? Math.min(secondIdx, tabs.length - 1) : 0;
  const secondTab = tabs[secondIdxSafe] ?? null;
  const secondKey = secondTab ? readerKey(secondTab) : "";
  const secondLabel = secondTab ? states[secondKey]?.title || fallbackTitle(secondTab) : "";
  // 副栏用「副栏那份 target」自己的定位信息：差异行 A/B 两侧的值不同，混用会校验失败
  const secondHl = secondTab && "highlight" in secondTab ? (secondTab.highlight ?? "") : "";
  const secondHlValue = secondTab && "highlightValue" in secondTab ? secondTab.highlightValue : undefined;

  // 比对页差异行联动：自动开启双栏对照，并把副栏指向另一份底稿
  useEffect(() => {
    if (!splitRequest) return;
    const idx = tabs.findIndex((t) => readerKey(t) === splitRequest.secondKey);
    if (idx < 0 || idx === activeIndex) return;
    setSecondIdx(idx);
    setSplitView(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitRequest?.nonce]);
  const baseText = state.kind === "text" ? state.text : state.kind === "markdown" ? state.markdown : "";
  const matchCount =
    state.kind === "markdown" ? (findTrim ? mdMarks : 0) : findTrim ? countMatches(baseText, findTrim) : 0;

  // 当前命中滚动到视口中央并加描边
  useEffect(() => {
    if (!findTrim || matchCount === 0) return;
    const marks = scrollRef.current?.querySelectorAll("mark") ?? [];
    if (marks.length === 0) return;
    const idx = wrapIndex(findIdx, marks.length);
    marks[idx]?.scrollIntoView({ block: "center" });
    marks.forEach((m, i) => m.classList.toggle("outline outline-2 outline-rose-400", i === idx));
  }, [findIdx, findTrim, matchCount, state.text, showLines]);

  // markdown 预览搜索高亮：DOM 后处理包裹命中文本节点
  useEffect(() => {
    if (state.kind !== "markdown" || state.loading) return;
    const root = scrollRef.current;
    if (!root) return;
    root.querySelectorAll("mark[data-find]").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
      parent.normalize();
    });
    const q = findTrim;
    if (!q) {
      setMdMarks((prev) => (prev === 0 ? prev : 0));
      return;
    }
    root.querySelectorAll(".md-body").forEach((body) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      for (const node of nodes) {
        const text = node.nodeValue ?? "";
        // 一个文本节点里的每一处都要包上，只标第一处会让计数器与「下一处」对不上
        const ranges = findRanges(text, q);
        if (ranges.length === 0) continue;
        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const r of ranges) {
          if (r.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, r.start)));
          const mark = document.createElement("mark");
          mark.setAttribute("data-find", "1");
          mark.className = "rounded-sm bg-amber-200 px-0.5 text-gray-900";
          mark.textContent = text.slice(r.start, r.end);
          frag.appendChild(mark);
          cursor = r.end;
        }
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
        node.parentNode?.replaceChild(frag, node);
      }
    });
    const found = root.querySelectorAll("mark[data-find]").length;
    setMdMarks((prev) => (prev === found ? prev : found));
  }, [findTrim, state.kind, state.markdown, state.loading]);

  // 记录各标签页的搜索命中数，用于标签徽标
  useEffect(() => {
    if (!activeKey) return;
    setMatchCounts((prev) => ({ ...prev, [activeKey]: matchCount }));
  }, [matchCount, activeKey]);
  const [group, setGroup] = useState<"refs" | "gens">(() =>
    readEnum(KEYS.readerGroup, ["refs", "gens"] as const, "refs"),
  );
  const chooseGroup = (g: "refs" | "gens") => {
    setGroup(g);
    writeRaw(KEYS.readerGroup, g);
  };
  const indexed = tabs.map((t, i) => ({ t, i }));
  const refs = indexed.filter((x) => x.t.kind !== "artifact");
  const gens = indexed.filter((x) => x.t.kind === "artifact");
  const visible = group === "refs" ? refs : gens;

  // 活动标签切换时自动归入对应分组
  useEffect(() => {
    if (!active) return;
    chooseGroup(active.kind === "artifact" ? "gens" : "refs");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // 表格预览加载完成后，把比对定位的高亮行滚到视口中央
  const activeHl = active && "highlight" in active ? (active.highlight ?? "") : "";
  const activeHlValue = active && "highlightValue" in active ? active.highlightValue : undefined;
  // 跨工作表的命中总数与当前序号：按渲染顺序编号，与 DOM 上的 data-hlrow 一一对应
  const hitTotal = useMemo(() => {
    if (state.kind !== "sheets" || activeHl.trim() === "") return 0;
    return (state.sheets ?? []).reduce(
      (n, s) => n + locateSheet(s, sort[`${activeKey}:${s.name}`], activeHl, activeHlValue).count,
      0,
    );
  }, [state.kind, state.sheets, activeHl, activeHlValue, sort, activeKey]);
  const [hitIdx, setHitIdx] = useState(0);
  const gotoHit = useCallback(
    (delta: number) => {
      if (hitTotal === 0) return;
      setHitIdx((prev) => stepIndex(prev, delta, hitTotal));
    },
    [hitTotal],
  );

  // 表格定位的键盘导航：Enter 下一处 / Shift+Enter 上一处（输入框内不抢按键）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || hitTotal === 0) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      // 输入框与按钮上保留 Enter 的默认行为（按钮激活 / 表单提交），只在阅读区空白处接管
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || el?.isContentEditable) {
        return;
      }
      e.preventDefault();
      gotoHit(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hitTotal, gotoHit]);

  // 加载完成或切换命中处时：滚到视口中央，并用玫红底标出「当前处」
  useEffect(() => {
    if (state.loading || state.kind !== "sheets") return;
    const rows = scrollRef.current?.querySelectorAll("[data-hlrow]") ?? [];
    if (rows.length === 0) return;
    const idx = Math.min(Math.max(0, hitIdx), rows.length - 1);
    (rows[idx] as HTMLElement | undefined)?.scrollIntoView({ block: "center" });
    rows.forEach((r, i) => r.classList.toggle("hl-current", i === idx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loading, state.kind, activeKey, activeHl, activeHlValue, state.sheets, hitTotal, hitIdx]);

  // 切换标签时重置缩放
  useEffect(() => {
    setZoom(1);
    setShowLines(false);
    setFindQuery("");
    setFindIdx(0);
    setRot(0);
    setFitWidth(true);
    setVsError(null);
  }, [activeKey]);

  // Ctrl+Tab 切换标签（Shift 反向）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== "Tab") return;
      if (tabs.length < 2) return;
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
    onSelect(wrapIndex(activeIndex + dir, tabs.length));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs.length, activeIndex, onSelect]);

  // Ctrl+Shift+1..9 直跳第 N 个标签
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || !/^[1-9]$/.test(e.key)) return;
      const idx = Number(e.key) - 1;
      if (idx >= tabs.length) return;
      e.preventDefault();
      onSelect(idx);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs.length, onSelect]);

  useEffect(() => {
    let cancelled = false;
    // 双栏对照时副栏那份也要预载，否则从未被激活过的底稿会一直空白
    const targets: ReaderTarget[] = [];
    if (active) targets.push(active);
    if (splitView && secondTab && secondKey !== activeKey) targets.push(secondTab);

    for (const target of targets) {
      const key = readerKey(target);
      if (states[key]) continue;
      setStates((prev) => ({ ...prev, [key]: { ...INITIAL, loading: true } }));

      void (async () => {
        try {
          if (target.kind === "url") {
            const result = await api.readUrl(target.url);
            if (cancelled) return;
            if ((result.contentType ?? "").includes("application/pdf")) {
              setStates((prev) => ({
                ...prev,
                [key]: {
                  loading: false,
                  error: null,
                  kind: "pdf",
                  title: result.title || target.url,
                  markdown: "",
                  text: "",
                  src: target.url,
                  loadedAt: dateTimeStamp(new Date()),
                },
              }));
              return;
            }
            setStates((prev) => ({
              ...prev,
              [key]: {
                loading: false,
                error: null,
                kind: "markdown",
                title: result.title || target.url,
                markdown: result.markdown || result.excerpt || "（该网页未提取到正文）",
                text: "",
                src: target.url,
                loadedAt: dateTimeStamp(new Date()),
              },
            }));
            return;
          }

          const url =
            target.kind === "file"
              ? api.fileContentUrl(target.taskId, target.fileId)
              : api.artifactContentUrl(target.taskId, target.name);
          // Excel 优先走工作表结构化预览
          if (/\.xlsx?$/i.test(target.name)) {
            try {
              const sheetsUrl =
                target.kind === "file"
                  ? api.fileSheetsUrl(target.taskId, target.fileId)
                  : api.artifactSheetsUrl(target.taskId, target.name);
              const sheets = await api.readSheets(sheetsUrl);
              if (!cancelled) {
                setStates((prev) => ({
                  ...prev,
                  [key]: {
                    loading: false,
                    error: null,
                    kind: "sheets",
                    title: target.name,
                    markdown: "",
                    text: "",
                    src: "",
                    sheets,
                  },
                }));
              }
              return;
            } catch {
              // 回退到二进制预览
            }
          }
          const res = await fetch(url);
          if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
          const kind = previewKind(res.headers.get("X-Preview-Kind"), target.name);
          if (kind === "text" || kind === "markdown") {
            const text = await res.text();
            if (cancelled) return;
            setStates((prev) => ({
              ...prev,
              [key]: { loading: false, error: null, kind, title: target.name, markdown: text, text, src: url },
            }));
          } else {
            if (cancelled) return;
            setStates((prev) => ({
              ...prev,
              [key]: { loading: false, error: null, kind, title: target.name, markdown: "", text: "", src: url },
            }));
          }
        } catch (err) {
          if (!cancelled) {
            // 首次失败自动重试一次（网络抖动/冷启动）
            if (!retriedRef.current.has(key)) {
              retriedRef.current.add(key);
              setStates((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
              setReload((r) => r + 1);
              return;
            }
            setStates((prev) => ({
              ...prev,
              [key]: { ...INITIAL, error: err instanceof Error ? err.message : "读取失败" },
            }));
          }
        }
      })();
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, secondKey, splitView, reload]);

  return (
    <aside className="no-print flex w-[440px] shrink-0 flex-col border-l border-line bg-night-950">
      <header className="border-b border-line">
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="seg-tabs">
            <button type="button" className="seg-tab" data-on={group === "refs"} onClick={() => chooseGroup("refs")}>
              引用文件{refs.length > 0 ? ` ${refs.length}` : ""}
            </button>
            <button type="button" className="seg-tab" data-on={group === "gens"} onClick={() => chooseGroup("gens")}>
              文件生成{gens.length > 0 ? ` ${gens.length}` : ""}
            </button>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {vsError && <span className="text-[10px] text-rose-300">{vsError}</span>}
            {vsPresent && (
              <button
                type="button"
                className="action-btn"
                title="清除 URL 中的视图短码参数"
                onClick={() => {
                  const u = new URL(window.location.href);
                  u.searchParams.delete("vs");
                  window.history.replaceState(null, "", u.toString());
                  setVsPresent(false);
                }}
              >
                清除短码
              </button>
            )}
            <button
              type="button"
              className="action-btn"
              data-on={splitView}
              onClick={() => setSplitView((v) => !v)}
              title="双栏对照（主栏全功能 + 简化副栏）"
            >
              双栏
            </button>
            {splitView && tabs.length > 1 && (
              <select
                value={secondIdxSafe}
                onChange={(e) => setSecondIdx(Number(e.target.value))}
                className="rounded border border-line bg-night-850 px-1 py-0.5 text-[10.5px] text-mist-300 outline-none"
                title="对照栏标签"
              >
                {tabs.map((t, i) => (
                  <option key={readerKey(t)} value={i}>
                    {(states[readerKey(t)]?.title || fallbackTitle(t)).slice(0, 18)}
                  </option>
                ))}
              </select>
            )}
            {splitView && tabs.length > 1 && (
              <button
                type="button"
                className="action-btn"
                data-on={syncScroll}
                onClick={() => setSyncScroll((v) => !v)}
                title="主栏滚动时按比例同步副栏"
              >
                同步滚动
              </button>
            )}
            {state.kind === "sheets" && hitTotal > 0 && (
              <span className="flex items-center gap-0.5 rounded border border-line bg-night-850 px-1 py-0.5">
                <button type="button" className="action-btn !px-1" title="上一处命中" onClick={() => gotoHit(-1)}>
                  ‹
                </button>
                <span
                  className="min-w-[46px] text-center font-mono text-[10.5px] text-mist-400"
                  title={`「${activeHl}」在本文件共命中 ${hitTotal} 行（跨工作表按显示顺序编号），当前第 ${hitIdx + 1} 处以玫红底标出`}
                >
                  {hitIdx + 1}/{hitTotal}
                </span>
                <button type="button" className="action-btn !px-1" title="下一处命中" onClick={() => gotoHit(1)}>
                  ›
                </button>
              </span>
            )}
            {tabs.length > 1 && (
              <button
                type="button"
                className="action-btn"
                onClick={() => onCloseAll([...pinned])}
                title="关闭全部标签（保留已固定）"
              >
                关闭全部
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="收起阅读器"
              className="rounded p-1 text-mist-600 hover:bg-night-900 hover:text-mist-100"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex min-w-0 items-stretch overflow-x-auto">
          {visible.map(({ t: tab, i }) => {
            const key = readerKey(tab);
            const tabState = states[key];
            const label = aliases[key] || tabState?.title || fallbackTitle(tab);
            const isActive = i === activeIndex;
            return (
              <div
                key={key}
                draggable
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i);
                  setDragIdx(null);
                }}
                onDragEnd={() => setDragIdx(null)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(i);
                  }
                }}
                className={`group flex shrink-0 items-center gap-1.5 border-r border-line px-3 py-2 ${
                  isActive ? "bg-night-800 text-mist-100" : "text-mist-600 hover:bg-night-900 hover:text-mist-300"
                }`}
              >
                {editingKey === key ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => commitAlias(key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitAlias(key);
                      if (e.key === "Escape") setEditingKey(null);
                    }}
                    className="w-[120px] rounded border border-glow-500/50 bg-night-800 px-1 py-0.5 text-[12px] text-mist-100 outline-none"
                  />
                ) : (
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  onDoubleClick={() => {
                    setEditingKey(key);
                    setEditValue(aliases[key] ?? label);
                  }}
                  className="flex min-w-0 items-center gap-1.5 text-[12px]"
                  title={`${label}（双击重命名）`}
                >
                  {tabState?.loading ? (
                    <IconSpinner className="h-3 w-3 shrink-0 animate-spin text-glow-400" />
                  ) : tab.kind === "url" ? (
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-glow-500/20 text-[8px] font-bold text-glow-300">
                      {(fallbackTitle(tab).slice(0, 1) || "?").toUpperCase()}
                    </span>
                  ) : tab.kind === "artifact" ? (
                    <IconFile className="h-3.5 w-3.5 shrink-0 text-jade-400" />
                  ) : (
                    <IconFile className="h-3.5 w-3.5 shrink-0 text-glow-400" />
                  )}
                  <span className="max-w-[140px] truncate">{label}</span>
                  {states[key]?.error && (
                    <button
                      type="button"
                      title="读取失败，点击重试"
                      onClick={(e) => {
                        e.stopPropagation();
                        retriedRef.current.delete(key);
                        setStates((prev) => {
                          const next = { ...prev };
                          delete next[key];
                          return next;
                        });
                        setReload((r) => r + 1);
                        onSelect(i);
                      }}
                      className="rounded bg-rose-400/15 px-1 text-[9.5px] text-rose-300 transition-colors hover:bg-rose-400/25"
                    >
                      !重试
                    </button>
                  )}
                  {findTrim && (matchCounts[key] ?? 0) > 0 && (
                    <span
                      role="button"
                      title="跳到该标签首处命中"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(i);
                        setFindIdx(0);
                      }}
                      className="cursor-pointer rounded bg-amber-400/15 px-1 text-[9.5px] text-amber-300"
                    >
                      {matchCounts[key]}
                    </span>
                  )}
                </button>
                )}
                <button
                  type="button"
                  title={pinned.has(key) ? "取消固定" : "固定标签（关闭全部时保留）"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinned((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                  className={`rounded p-0.5 text-[10px] transition-opacity ${
                    pinned.has(key)
                      ? "text-glow-300 opacity-100"
                      : "text-mist-600 opacity-0 hover:text-mist-100 group-hover:opacity-100"
                  }`}
                >
                  ⚑
                </button>
                {!pinned.has(key) && (
                <button
                  type="button"
                  onClick={() => {
                    const needsGuard = tab.kind === "artifact" && !pinned.has(key);
                    if (needsGuard && armedKey !== key) {
                      setArmedKey(key);
                      window.setTimeout(() => setArmedKey((v) => (v === key ? null : v)), 2000);
                      return;
                    }
                    setArmedKey(null);
                    onCloseTab(i);
                  }}
                  title={armedKey === key ? "再点一次确认关闭（产物标签）" : "关闭标签"}
                  className={`rounded p-0.5 transition-opacity hover:text-rose-300 ${
                    armedKey === key ? "text-rose-300 opacity-100" : "text-mist-600 opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <IconX className="h-3 w-3" />
                </button>
                )}
              </div>
            );
          })}
          {visible.length === 0 && (
            <span className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-mist-600">
              <IconFile className="h-3.5 w-3.5 shrink-0" />
              {group === "refs"
                ? "暂无引用网页或任务资料，点击结论引用胶囊或任务资料即可打开"
                : "暂无生成产物，导出底稿后自动出现"}
            </span>
          )}
        </div>
      </header>

      {(state.kind === "markdown" || state.kind === "text") && !state.loading && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-1.5">
          <span className="kicker">版式</span>
          <ThemeSwitch />
          <button
            type="button"
            className="action-btn ml-auto shrink-0 whitespace-nowrap"
            title="复制正文全文"
            onClick={() =>
              void navigator.clipboard?.writeText(state.kind === "markdown" ? state.markdown : state.text).catch(() => undefined)
            }
          >
            复制全文
          </button>
          <span className="shrink-0 whitespace-nowrap text-[10.5px] text-mist-600">
            {(state.kind === "text" ? state.text : state.markdown).split("\n").length} 行 ·{" "}
            {(state.kind === "text" ? state.text : state.markdown).length} 字
          </span>
          {(state.kind === "text" || state.kind === "markdown") && (
            <>
              <input
                value={findQuery}
                onChange={(e) => {
                  setFindQuery(e.target.value);
                  setFindIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setFindIdx((v) => (e.shiftKey ? v - 1 : v + 1));
                  }
                }}
                placeholder="页内搜索…"
                className="w-28 rounded border border-line bg-night-850 px-2 py-0.5 text-[11px] text-mist-100 outline-none focus:glow-ring"
              />
              <button
                type="button"
                className="action-btn"
                onClick={() => setFindIdx((v) => v - 1)}
                title="上一处"
                disabled={matchCount === 0}
              >
                ‹
              </button>
              <button
                type="button"
                className="action-btn"
                onClick={() => setFindIdx((v) => v + 1)}
                title="下一处"
                disabled={matchCount === 0}
              >
                ›
              </button>
              <span className="shrink-0 font-mono text-[10.5px] text-mist-600">
                {matchLabel(findIdx, matchCount)}
              </span>
            </>
          )}
          {state.kind === "text" && (
            <button
              type="button"
              className="action-btn"
              data-on={showLines}
              onClick={() => setShowLines((v) => !v)}
              title="切换行号显示"
            >
              行号
            </button>
          )}
          <button
            type="button"
            className="action-btn"
            title="复制当前视图状态（缩放/旋转/行号/搜索/排序）"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(
                  JSON.stringify({
                    key: activeKey,
                    zoom,
                    rot,
                    fitWidth,
                    showLines,
                    find: findQuery,
                    sort: Object.fromEntries(Object.entries(sort).filter(([k]) => k.startsWith(`${activeKey}:`))),
                  }),
                )
                .catch(() => undefined)
            }
          >
            复制状态
          </button>
          <button
            type="button"
            className="action-btn"
            title="复制带视图状态短码的链接（?vs=…）"
            onClick={() => {
              const code = btoa(encodeURIComponent(JSON.stringify(stateObj())));
              void navigator.clipboard
                ?.writeText(`${window.location.origin}${window.location.pathname}?vs=${code}${window.location.hash}`)
                .catch(() => undefined);
            }}
          >
            复制短链
          </button>
          <button type="button" className="action-btn" title="从剪贴板恢复视图状态" onClick={() => void pasteState()}>
            粘贴状态
          </button>
        </div>
      )}

      {active?.kind === "url" && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-600">{active.url}</span>
          {state.loadedAt && (
            <span className="shrink-0 text-[10.5px] text-mist-600" title="网页读取时间">
              读取于 {state.loadedAt}
            </span>
          )}
          <a
            href={active.url}
            target="_blank"
            rel="noreferrer"
            title="在新标签页打开原文"
            className="shrink-0 rounded p-1 text-mist-600 hover:bg-night-800 hover:text-glow-300"
          >
            <IconExternal className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {!state.loading && !state.error && (state.kind === "image" || state.kind === "pdf") && (
        <div className="flex items-center gap-1 border-b border-line px-4 py-1.5">
          <span className="kicker mr-1">缩放</span>
          <button type="button" className="action-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} title="缩小">
            −
          </button>
          <span className="min-w-[42px] text-center font-mono text-[11px] text-mist-300">{Math.round(zoom * 100)}%</span>
          <button type="button" className="action-btn" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} title="放大">
            ＋
          </button>
          <button type="button" className="action-btn" onClick={() => setZoom(1)} title="重置缩放">
            重置
          </button>
          {state.kind === "image" && (
            <button type="button" className="action-btn" onClick={() => setRot((r) => (r + 90) % 360)} title="顺时针旋转 90°">
              ⟳ {rot}°
            </button>
          )}
          {state.kind === "image" && (
            <button
              type="button"
              className="action-btn"
              data-on={!fitWidth}
              onClick={() => setFitWidth((v) => !v)}
              title="切换适应宽度 / 实际大小（横向可滚）"
            >
              {fitWidth ? "适应宽度" : "实际大小"}
            </button>
          )}
          {state.kind === "pdf" && (
            <>
            <a className="action-btn ml-auto shrink-0 whitespace-nowrap" href={state.src} target="_blank" rel="noreferrer" title="在新标签页打开 PDF">
              <IconExternal className="h-3.5 w-3.5" />
              新窗口
            </a>
            <a className="action-btn" href={state.src} download title="下载 PDF">
              <IconDownload className="h-3.5 w-3.5" />
              下载
            </a>
            </>
          )}
        </div>
      )}

      <div className={`min-h-0 flex-1 ${splitView && tabs.length > 1 ? "flex" : ""}`}>
      <div
        ref={scrollRef}
        onScroll={() => {
          if (!splitView || !syncScroll) return;
          const el = scrollRef.current;
          const other = miniRef.current;
          if (!el || !other) return;
          const r1 = el.scrollHeight - el.clientHeight;
          const r2 = other.scrollHeight - other.clientHeight;
          if (r1 > 0 && r2 > 0) other.scrollTop = (el.scrollTop / r1) * r2;
        }}
        className="min-h-0 flex-1 overflow-auto px-4 py-4"
      >
        {state.loading && !/\.xlsx?$/i.test(activeName) && (
          <div className="flex flex-col items-center gap-4 py-14">
            <div className="dot-grid" aria-hidden>
              {Array.from({ length: 25 }, (_, i) => (
                <span
                  key={i}
                  style={{ animationDelay: `${(i % 5) * 0.12 + Math.floor(i / 5) * 0.12}s` }}
                />
              ))}
            </div>
            <span className="text-[12px] text-mist-600">正在读取内容…</span>
          </div>
        )}
        {state.loading && /\.xlsx?$/i.test(activeName) && (
          <div className="space-y-2 py-2" aria-hidden>
            {Array.from({ length: 6 }, (_, r) => (
              <div key={r} className="flex gap-2">
                {Array.from({ length: 4 }, (_, c) => (
                  <span
                    key={c}
                    className="h-5 flex-1 animate-pulse rounded bg-night-800"
                    style={{ animationDelay: `${(r * 4 + c) * 0.06}s` }}
                  />
                ))}
              </div>
            ))}
            <div className="pt-2 text-center text-[11.5px] text-mist-600">正在解析工作表结构…</div>
          </div>
        )}
        {state.error && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-300">
            <div className="flex items-start gap-2">
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {state.error}
            </div>
            {active?.kind === "url" && (
              <a
                href={active.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-night-800 px-2.5 py-1 text-[12px] text-mist-100 hover:border-glow-500"
              >
                <IconExternal className="h-3 w-3" />
                目标站拒绝抓取时，可在新标签页打开原文
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                const key = activeKey;
                retriedRef.current.delete(key);
                setStates((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                });
                setReload((r) => r + 1);
              }}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-night-800 px-2.5 py-1 text-[12px] text-mist-100 hover:border-glow-500"
            >
              <IconRefresh className="h-3 w-3" />
              重试读取
            </button>
          </div>
        )}
        {!state.loading && !state.error && (state.kind === "markdown" || state.kind === "text") && (
          <div className={`paper-sheet theme-${theme} px-6 py-5`}>
            {state.kind === "markdown" ? (
              <MarkdownView text={state.markdown} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-gray-700">
                {showLines
                  ? state.text.split("\n").map((ln, i) => (
                      <div key={i} className="grid grid-cols-[3ch_1fr] gap-2">
                        <span className="select-none text-right text-gray-400">{i + 1}</span>
                        <span className="whitespace-pre-wrap">{highlight(ln)}</span>
                      </div>
                    ))
                  : highlight(state.text)}
              </pre>
            )}
          </div>
        )}
        {!state.loading && !state.error && state.kind === "image" && (
          <img
            src={state.src}
            alt={state.title}
            style={{
              width: fitWidth ? `${zoom * 100}%` : undefined,
              transform: rot ? `rotate(${rot}deg)` : undefined,
            }}
            className={`rounded-md border border-line transition-transform ${fitWidth ? "mx-auto max-w-none" : "max-w-none"}`}
          />
        )}
        {!state.loading && !state.error && state.kind === "pdf" && (
          <iframe
            src={state.src}
            title={state.title}
            style={{ height: `${70 * zoom}vh` }}
            className="w-full rounded-md border border-line bg-white"
          />
        )}
        {!state.loading && !state.error && state.kind === "binary" && (
          <div className="glow-card px-4 py-6 text-center">
            <p className="text-[12.5px] text-mist-500">该文件类型暂不支持在线预览</p>
            <a
              href={state.src}
              download={state.title}
              className="mt-2 inline-block rounded-md border border-line bg-night-800 px-3 py-1.5 text-[12.5px] text-mist-100 hover:border-glow-500"
            >
              下载文件
            </a>
          </div>
        )}
        {!state.loading && !state.error && state.kind === "sheets" && (
          <div className="paper-sheet px-5 py-4">
            {(state.sheets ?? []).map((s) => (
              <section key={s.name} className="mb-5 last:mb-0">
                {(() => {
                  const sortKey = `${activeKey}:${s.name}`;
                  const st = sort[sortKey];
                  const hl = activeHl.trim();
                  const located = locateSheet(s, st, hl, activeHlValue);
                  const rows = located.rows;
                  const hlHits = located.hits;
                  const hlCount = located.count;
                  return (
                    <>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-gray-900">{s.name}</span>
                  <span className="text-[11px] text-gray-500">{s.rowCount} 行</span>
                  <button
                    type="button"
                    className="action-btn ml-auto !text-gray-600 hover:!text-gray-900"
                    data-on={showRowNum}
                    onClick={() => setShowRowNum((v) => !v)}
                    title="切换行号列"
                  >
                    行号
                  </button>
                  <button
                    type="button"
                    className="action-btn !text-gray-600 hover:!text-gray-900"
                    title="复制当前表 TSV（含排序与行号状态）"
                    onClick={() => {
                      const esc = (v: unknown) => {
                        const s = v === null || v === undefined ? "" : String(v);
                        return /[\t\n]/.test(s) ? s.replace(/[\t\n]/g, " ") : s;
                      };
                      const lines = [
                        (showRowNum ? ["#"] : []).concat(s.headers).join("\t"),
                        ...rows.map((row, i) =>
                          (showRowNum ? [String(i + 1)] : []).concat(s.headers.map((h) => esc(row[h]))).join("\t"),
                        ),
                      ];
                      void navigator.clipboard?.writeText(lines.join("\n")).catch(() => undefined);
                    }}
                  >
                    复制 TSV
                  </button>
                  <button
                    type="button"
                    className="action-btn !text-gray-600 hover:!text-gray-900"
                    data-on={freezeFirst}
                    onClick={() => setFreezeFirst((v) => !v)}
                    title="冻结首列（横向滚动时常驻）"
                  >
                    冻首列
                  </button>
                  {hl && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                        hlCount > 0 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-600"
                      }`}
                      title={
                        hlCount > 0
                          ? "命中行以琥珀底标出，命中单元格加深，并已自动滚入视口；支持「记录名/列名」与 A1 地址，并按该侧差异值校验"
                          : "本表未匹配到定位关键字；A1 地址在排序状态下不生效，可取消排序或改用页内搜索"
                      }
                    >
                      定位：{hl}
                      {hlCount > 0 ? `（${hlCount} 行命中）` : "（未命中）"}
                    </span>
                  )}
                </div>
                <div className="max-h-[62vh] overflow-auto">
                  <table className="w-full border-collapse text-[11.5px]">
                    <thead>
                      <tr>
                        {showRowNum && (
                          <th
                            className={`sticky top-0 z-10 border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-800 ${
                              freezeFirst ? "left-0 z-30" : ""
                            }`}
                          >
                            #
                          </th>
                        )}
                        {s.headers.map((h, hi) => (
                          <th
                            key={h}
                            onClick={() =>
                              setSort((prev) => {
                                const cur = prev[sortKey];
                                const dir = cur?.col === h ? ((cur.dir === 1 ? -1 : 1) as 1 | -1) : 1;
                                return { ...prev, [sortKey]: { col: h, dir } };
                              })
                            }
                            title="点击排序（再点反向）"
                            className={`sticky top-0 z-10 cursor-pointer select-none border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-800 hover:bg-gray-200 ${
                              freezeFirst && hi === 0 && !showRowNum ? "left-0 z-30" : ""
                            }`}
                          >
                            {h}
                            {st?.col === h && <span className="ml-0.5 text-gray-500">{st.dir === 1 ? "↑" : "↓"}</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const hits = hlHits[i] ?? { hit: false, cols: [] as string[] };
                        return (
                          <tr
                            key={i}
                            data-hlrow={hits.hit ? "" : undefined}
                            className={hits.hit ? "row-hl" : undefined}
                          >
                            {showRowNum && (
                              <td
                                className={`border border-gray-200 px-2 py-1 text-right font-mono text-[10.5px] text-gray-400 ${
                                  freezeFirst ? "sticky left-0 z-20 bg-inherit" : ""
                                }`}
                              >
                                {i + 1}
                              </td>
                            )}
                            {s.headers.map((h, hi) => (
                              <td
                                key={h}
                                onDoubleClick={() => {
                                  const v = row[h];
                                  if (v !== null && v !== undefined) {
                                    void navigator.clipboard?.writeText(String(v)).catch(() => undefined);
                                  }
                                }}
                                title="双击复制单元格"
                                className={`border border-gray-200 px-2 py-1 align-top text-gray-700 ${
                                  freezeFirst && hi === 0 && !showRowNum ? "sticky left-0 z-20 bg-inherit" : ""
                                } ${hits.cols.includes(h) ? "cell-hl" : ""}`}
                              >
                              {row[h] === null || row[h] === undefined ? "" : String(row[h])}
                            </td>
                          ))}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                    </>
                  );
                })()}
              </section>
            ))}
          </div>
        )}
        {!state.loading && !state.error && active?.kind === "url" && (
          <p className="mt-4 border-t border-line pt-3 text-[11px] text-mist-600">
            阅读模式正文由服务端 Readability 提取，仅供参考；原文以
            <a href={active.url} target="_blank" rel="noreferrer" className="ml-1 underline">
              来源链接
            </a>
            为准。
          </p>
        )}
      </div>
      {splitView && tabs.length > 1 && (
        <MiniPane
          st={states[secondKey] ?? INITIAL}
          title={secondLabel}
          innerRef={miniRef}
          find={findTrim}
          highlight={secondHl}
          highlightValue={secondHlValue}
          hitIndex={hitIdx}
          mainSort={Object.fromEntries(
            Object.entries(sort)
              .filter(([k]) => k.startsWith(`${activeKey}:`))
              .map(([k, v]) => [k.slice(activeKey.length + 1), v]),
          )}
        />
      )}
      </div>
    </aside>
  );
}
