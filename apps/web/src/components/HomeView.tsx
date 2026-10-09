import { useMemo } from "react";
import { percentFrom, percentText } from "../format.ts";
import { loadTags } from "../tags.ts";
import { relTime } from "../time-format.ts";
import { taskStatusLabel } from "../task-status.ts";
import { STATUS_BARS, statusBreakdown } from "../status-breakdown.ts";
import type { AgentInfo, PlatformStats, TaskInfo } from "../types.ts";
import { IconAlert } from "./Icons.tsx";

/**
 * 主界面（门户页）：结构按 06 商业紫设计稿 final/home.html 落地——
 * 顶栏导航 + 英雄区（标题渐变词 + 证据可信度环卡）+ 数字信任带 +
 * 三卡（状态分布 / 运行总量 / 选择智能体）+ 最近任务表。
 *
 * 口径约束（与看板共用同一份实现，避免界面对、门禁红）：
 * - 任务状态分布用 status-breakdown.ts 的 statusBreakdown + STATUS_BARS，不自造标签与顺序；
 * - 百分比一律走 format.ts 的 percentText：分母为 0 显示「—」，不显示 0%；
 * - 本页不写死任何示例数字，全部来自 /api/tasks 与 /api/stats 的实时结果。
 */
interface HomeViewProps {
  agents: AgentInfo[];
  tasks: TaskInfo[];
  platform: PlatformStats | null;
  backendDown: boolean;
  onEnterAgent: (agentId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onOpenIntro: () => void;
}

/** 状态分布条填充色，顺序跟随 STATUS_BARS（与看板同一套语义色） */
const BAR_HEX: Record<string, string> = {
  completed: "#1f8a5b",
  processing: "#635bff",
  waiting_review: "#9a6b1f",
  failed: "#c2334d",
  interrupted: "#b98a44",
  created: "#7b8ea3",
};

/** 状态 → 最近任务表胶囊样式 */
const TAG_CLS: Record<string, string> = {
  completed: "ok",
  processing: "acc",
  waiting_review: "warn",
  created: "warn",
  failed: "bad",
};

export function HomeView({
  agents,
  tasks,
  platform,
  backendDown,
  onEnterAgent,
  onOpenTask,
  onOpenReview,
  onOpenIntro,
}: HomeViewProps) {
  const total = tasks.length;
  // 自定义标签是 localStorage 真实数据（工作台编辑、侧栏过滤），主页只读不写
  const tagMap = useMemo(() => loadTags(), []);
  const breakdown = statusBreakdown(tasks);
  const ev = platform?.evidence;
  const recent = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const agentOf = (id: string): AgentInfo | undefined => agents.find((a) => a.id === id);
  const rd = agents.find((a) => a.id === "rd-audit") ?? agents[0];
  const lv = agents.find((a) => a.id === "land-vat") ?? agents[1] ?? agents[0];
  const docTotal = ev?.docRefs ?? 0;
  const docTraced = ev ? docTotal - ev.docRefPending : 0;
  const docPct = docTotal > 0 ? (docTraced / docTotal) * 100 : 0;
  // 近 7 天新建任务数作迷你柱：数据来自任务 createdAt，不写死示例值
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = d.toISOString().slice(0, 10);
    return tasks.filter((t) => t.createdAt.slice(0, 10) === key).length;
  });
  const dayMax = Math.max(1, ...days);
  const pending = platform?.reviewPendingIssues ?? 0;
  const enter = (a: AgentInfo | undefined) => {
    if (a) onEnterAgent(a.id);
  };

  return (
    <div className="h6-page">
      <div className="h6-topbar">
        <span className="h6-brand">
          <span className="h6-logo">税</span>税务智能审查平台
        </span>
        <nav className="h6-nav">
          <button type="button" onClick={onOpenIntro}>
            新会话
          </button>
          <button type="button" data-on="true">
            主界面
          </button>
          <button type="button" onClick={() => enter(agents[0])}>
            效果看板
          </button>
          <button type="button" onClick={() => enter(rd)}>
            智研税审
          </button>
          <button type="button" onClick={() => enter(lv)}>
            土增智填
          </button>
          <button type="button" title="跨任务复核队列（#/review）" onClick={onOpenReview}>
            复核队列{pending > 0 ? <span className="h6-badge">{pending}</span> : null}
          </button>
        </nav>
        <span className="h6-right">
          {backendDown ? (
            <>
              <IconAlert className="h6-warn-i" />
              后端未连接
            </>
          ) : (
            <>
              <i className="h6-dot" />
              API 在线 · 8787
            </>
          )}
          <span className="h6-sep">|</span>
          <span className="h6-ava">税</span>
        </span>
      </div>

      <main className="h6-home">
        <section className="h6-hero">
          <div>
            <p className="h6-kicker">TAX AI NATIVE · 双智能体协同</p>
            <h1 className="h6-h1">
              让每一条税收结论
              <br />
              <em className="h6-emp">都能追溯到出处</em>
            </h1>
            <p className="h6-lede">
              智研税审负责研发费用加计扣除的政策核验与风险审查，土增智填负责土地增值税清算底稿的保留式填列。
              政策核验有快照、联网引用有原文、人工复核有处置记录 —— 结论经得起复核与质询。
            </p>
            <div className="h6-cta">
              <button type="button" className="h6-btn-p" onClick={() => enter(rd)}>
                进入智研税审
              </button>
              <button type="button" className="h6-btn-g" onClick={() => enter(lv)}>
                进入土增智填
              </button>
              <span className="h6-anno">数据实时来自 /api/stats，本页不写死示例值</span>
            </div>
          </div>
          <div className="h6-card">
            <div className="h6-card-h">
              <h2>证据可信度</h2>
              <span className="h6-meta">检索 {ev ? ev.searchCalls : "—"} 次 · 引用 {ev ? ev.citations : "—"} 条</span>
            </div>
            <div className="h6-card-b">
              <div className="h6-herorow">
                <div
                  className="h6-ring"
                  style={{
                    background: `conic-gradient(#635bff 0 ${docPct / 100}turn, rgba(10, 37, 64, 0.08) ${docPct / 100}turn 1turn)`,
                  }}
                >
                  <i>{docTotal > 0 ? percentFrom(Math.round(docPct)) : "—"}</i>
                </div>
                <div className="h6-herocol">
                  <div className="h6-rowline">
                    <span>政策文号有出处</span>
                    <b>
                      {docTraced} / {docTotal}
                    </b>
                  </div>
                  <div className="h6-bar">
                    <i style={{ width: `${docPct}%` }} />
                  </div>
                  <div className="h6-minis">
                    <div className="h6-mini">
                      <b>{ev?.citations ?? "—"}</b>
                      <span>结论引用</span>
                    </div>
                    <div className="h6-mini">
                      <b>{ev?.officialCitations ?? "—"}</b>
                      <span>官方原文</span>
                    </div>
                    <div className="h6-mini">
                      <b className="warn">{ev?.weakCitations ?? "—"}</b>
                      <span>弱证据</span>
                    </div>
                    <div className="h6-mini">
                      <b>
                        {ev ? ev.searchWithUrls : "—"}
                        {ev ? <span className="h6-sub">/{ev.searchCalls}</span> : null}
                      </b>
                      <span>检索留 URL</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="h6-trust">
          <div className="t">
            <b>{total}</b>
            <span>任务总数</span>
          </div>
          <div className="t">
            <b>{breakdown.completed}</b>
            <span>已完成</span>
          </div>
          <div className="t">
            <b className="warn">{breakdown.waiting_review}</b>
            <span>待复核</span>
          </div>
          <div className="t">
            <b>{platform ? platform.toolCalls : "—"}</b>
            <span>工具调用</span>
          </div>
          <div className="t">
            <b>{platform ? platform.artifacts : "—"}</b>
            <span>交付产物</span>
          </div>
          <div className="t">
            <b>{percentText(breakdown.completed, total)}</b>
            <span>完成率</span>
          </div>
        </section>

        <section className="h6-cols">
          <div className="h6-card">
            <div className="h6-card-h">
              <h2>任务状态分布</h2>
              <span className="h6-meta">共 {total} 件</span>
            </div>
            <div className="h6-card-b">
              <div className="h6-segbar">
                {STATUS_BARS.filter((s) => breakdown[s.key] > 0).map((s) => (
                  <i
                    key={s.key}
                    style={{ width: `${(breakdown[s.key] / Math.max(1, total)) * 100}%`, background: BAR_HEX[s.key] }}
                  />
                ))}
              </div>
              <div className="h6-legend">
                {STATUS_BARS.filter((s) => breakdown[s.key] > 0).map((s) => (
                  <span key={s.key}>
                    <i style={{ background: BAR_HEX[s.key] }} />
                    {s.label} {breakdown[s.key]}
                  </span>
                ))}
              </div>
              <hr className="h6-hr" />
              <div className="h6-anno">「已中断」不单列：服务重启打断的任务混入失败会误导复核人，此处按事件流拆出并在看板标注。</div>
            </div>
          </div>
          <div className="h6-card">
            <div className="h6-card-h">
              <h2>运行总量</h2>
              <span className="h6-meta">近 7 天新建任务</span>
            </div>
            <div className="h6-card-b">
              <div className="h6-herorow">
                <div>
                  <b className="h6-big">{platform ? platform.toolCalls : "—"}</b>
                  <div className="h6-anno">工具调用合计</div>
                </div>
                <div className="h6-spark">
                  {days.map((n, i) => (
                    <i key={i} className={i === 6 ? "hi" : ""} style={{ height: `${Math.max(6, (n / dayMax) * 100)}%` }} />
                  ))}
                </div>
              </div>
              <hr className="h6-hr" />
              <dl className="h6-kv">
                <dt>成功调用</dt>
                <dd>{platform ? `${platform.toolOk} 次` : "—"}</dd>
                <dt>失败调用</dt>
                <dd className="bad">{platform ? `${platform.toolFailed} 次` : "—"}</dd>
                <dt>未返回</dt>
                <dd>{platform ? `${platform.toolUnfinished} 次` : "—"}</dd>
              </dl>
            </div>
          </div>
          <div className="h6-card">
            <div className="h6-card-h">
              <h2>选择智能体</h2>
              <span className="h6-meta">{agents.length} 个作品</span>
            </div>
            <div className="h6-card-b h6-stack">
              {agents.map((a, i) => {
                const own = tasks.filter((t) => t.agentId === a.id);
                const b = statusBreakdown(own);
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`h6-agent${i === 0 ? " first" : ""}`}
                    onClick={() => onEnterAgent(a.id)}
                  >
                    <span className="h6-agentrow">
                      <b>{a.shortName}</b>
                      <span className="h6-badge acc">{own.length} 件</span>
                      <span className={`h6-tag ${b.waiting_review > 0 ? "warn" : "ok"}`}>
                        {b.waiting_review > 0 ? `${b.waiting_review} 待复核` : `${b.completed} 完成`}
                      </span>
                    </span>
                    <span className="h6-anno">{a.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="h6-card">
          <div className="h6-card-h">
            <h2>最近任务</h2>
            <span className="h6-meta">
              显示 {recent.length} / {total} · 点击进入工作台
            </span>
          </div>
          <table className="h6-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>作品</th>
                <th>状态</th>
                <th className="r">运行</th>
                <th className="r">工具</th>
                <th className="r" title="结论正文引用条数；平台总引用另含工具留存部分">引用</th>
                <th>标签</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id} className="h6-rowlink" onClick={() => onOpenTask(t.id)}>
                  <td className="k">{t.title}</td>
                  <td>{agentOf(t.agentId)?.shortName ?? t.agentId}</td>
                  <td>
                    <span className={`h6-tag ${TAG_CLS[t.status] ?? "warn"}`}>{taskStatusLabel(t.status, t.error)}</span>
                  </td>
                  <td className="r">{t.runCount ?? 0}</td>
                  <td className="r">{t.toolCount ?? 0}</td>
                  <td className="r">{t.citationCount ?? 0}</td>
                  <td>
                    {(tagMap[t.id] ?? []).length === 0 ? (
                      <span className="h6-muted">—</span>
                    ) : (
                      <>
                        {(tagMap[t.id] ?? []).slice(0, 2).map((tag) => (
                          <span key={tag} className="h6-tg">
                            #{tag}
                          </span>
                        ))}
                        {(tagMap[t.id] ?? []).length > 2 ? (
                          <span className="h6-muted">+{(tagMap[t.id] ?? []).length - 2}</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="h6-muted">{relTime(t.createdAt)}</td>
                </tr>
              ))}
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={8} className="h6-empty">
                    还没有任务。进入任一作品，用示例提示词建第一件任务。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <p className="h6-foot">
          本页数字全部来自 <code>/api/tasks</code> 与 <code>/api/stats</code>{" "}
          的实时统计，不含写死的示例值；分母为 0 时显示「—」而不是 0%，「未返回」的工具调用既不计成功也不计失败。
        </p>
      </main>
    </div>
  );
}
