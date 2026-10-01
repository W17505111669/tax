/**
 * 交付 MD 的「政策文号溯源」节。
 *
 * 为什么抽出来：这一节此前写在 TaskWorkbench 的 `bundleLines()` 里，那是个组件内闭包，任何单测
 * 都碰不到它——新加的「留存正文出处」表因此一条断言都没有：列数对不对、链接能不能点开、依据档位
 * 有没有写、超出上限时有没有如实说明，全靠肉眼。搬进模块就能直接喂假数据跑断言（verify:docrefmd）。
 *
 * 顺带修一处口径混淆：原来复查表用 `Object.values(refChecks)`，把**引用复查**（kind='citation'）
 * 也列进了「政策文号溯源」节，而同节上面的计数走的是文号复查汇总（refSummary 只统计 docref 类），
 * 于是「已复查 N 处」与表里实际行数对不上。这一节只列 kind='docref' 的记录，引用复查归「联网引用」节。
 */
import { DOC_REF_TABLE_LIMIT, SOURCE_VIA_TEXT, type RefTraceResult } from "./policy-trace.ts";
import { REF_VERDICT_TEXT, type RefCheckSummary } from "./ref-check.ts";
import { mdCell } from "./run-tools.ts";
import type { RefCheckRecord } from "./types.ts";

export interface DocRefSectionInput {
  refTrace: RefTraceResult;
  /** 文号复查汇总（summarizeRefChecks 对 kind='docref' 的结果） */
  refSummary: RefCheckSummary;
  /** 本任务全部复查记录；节内只取文号类，引用复查不在这一节出现 */
  refChecks: RefCheckRecord[];
}

/** 交付 MD「政策文号溯源」一节的行（不含节前的空行，末尾自带一个空行收尾） */
export function docRefSection(input: DocRefSectionInput): string[] {
  const { refTrace, refSummary, refChecks } = input;
  const docChecks = refChecks.filter((c) => c.kind === "docref");
  return [
    "## 政策文号溯源",
    "",
    // 三类依据分开写：元数据（结构化字段里有）是最强的一档，剩下的两档各报一个数，
    // 相加恒等于「有公开出处」。复核人据此知道哪几处需要再点开原文确认一次。
    `- 结论中出现政策文号 ${refTrace.total} 处：有公开出处 ${refTrace.traced} 处（其中联网复查取得 ${
      refTrace.tracedByRecheck
    } 处 · 仅留存正文提到 ${
      refTrace.tracedByBody
    } 处，其余出自工具结果的结构化字段）· 无法从留存数据核验 ${refTrace.unverifiable} 处 · 待人工确认 ${
      refTrace.untraced.length
    } 处`,
    ...(refTrace.untraced.length > 0
      ? [
          "",
          "| # | 文号 | 结论中的上下文 |",
          "| --- | --- | --- |",
          ...refTrace.untraced.slice(0, DOC_REF_TABLE_LIMIT).map(
            (r, i) => `| ${i + 1} | ${mdCell(r.text)} | ${mdCell(r.context)} |`,
          ),
          // 超出上限要如实说明，不静默截断：交付 MD 是签字归档件，少列几处就等于少几处待办
          ...(refTrace.untraced.length > DOC_REF_TABLE_LIMIT
            ? [`（另有 ${refTrace.untraced.length - DOC_REF_TABLE_LIMIT} 处待人工确认的文号未列出）`]
            : []),
          "",
        ]
      : [
          "",
          refTrace.unverifiable > 0
            ? "（联网检索扩展只持久化查询元数据，上述「无法核验」的文号建议改用政策快照检索或附检索页面截图）"
            : "（全部政策文号都能在工具结果中找到出处）",
        ]),
    // 「仅留存正文提到」单独列一张表：这几处**有**出处，但依据只在我们抓下来的网页正文里，
    // 可能只是被顺带提到（页面侧栏的相关文件列表、正文里一句「同时废止 2020年第24号」）。
    // 混在「有出处」的总数里就看不见了，交付时也就没人会去点开原文再确认一次。
    ...(refTrace.bodyTracedRefs.length > 0
      ? [
          "",
          `- 其中 ${refTrace.bodyTracedRefs.length} 处仅在留存网页正文中出现（工具结果的结构化字段里没有），依据弱于元数据，建议再点开原文确认：`,
          "",
          "| # | 文号 | 结论中的上下文 | 留存正文出处 | 依据 |",
          "| --- | --- | --- | --- | --- |",
          // 出处那一列给可点开的地址：这一档要能行动，复核人点开就能判断文号是该页主题还是被顺带提到
          ...refTrace.bodyTracedRefs.slice(0, DOC_REF_TABLE_LIMIT).map((r, i) => {
            const link =
              r.sourceUrl === ""
                ? "（这份留存正文里认不出可归属的来源行，宁可不给地址也不猜）"
                : `[${mdCell(r.sourceTitle === "" ? r.sourceUrl : r.sourceTitle)}](${r.sourceUrl})`;
            // 命中份数一起给：多份互不相关的来源同时提到，比孤零零一份更站得住
            const src = r.sourceCount > 1 ? `${link} · 共 ${r.sourceCount} 份留存正文提到` : link;
            return `| ${i + 1} | ${mdCell(r.text)} | ${mdCell(r.context)} | ${src} | ${SOURCE_VIA_TEXT[r.sourceVia]} |`;
          }),
          ...(refTrace.bodyTracedRefs.length > DOC_REF_TABLE_LIMIT
            ? [`（另有 ${refTrace.bodyTracedRefs.length - DOC_REF_TABLE_LIMIT} 处仅正文提到的文号未列出）`]
            : []),
          "",
          `- 依据档位：${SOURCE_VIA_TEXT.structured} = 地址来自工具结果的结构化字段；${
            SOURCE_VIA_TEXT["body-line"]
          } = 地址来自留存正文里该条结果末尾的来源行，按命中位置归属，弱一档；${
            SOURCE_VIA_TEXT[""]
          } = 认不出可归属的来源行，地址留空。`,
        ]
      : []),
    ...(refSummary.total > 0
      ? [
          "",
          `- 联网复查：已复查 ${refSummary.total} 处 · 找到公开出处 ${refSummary.matched} 处 · 候选待确认 ${
            refSummary.candidate
          } 处 · 未检索到 ${refSummary.empty} 处 · 检索失败 ${refSummary.error} 处${
            refSummary.checkedAt
              ? `（${new Date(refSummary.checkedAt).toLocaleString("zh-CN", { hour12: false })}）`
              : ""
          }`,
          "",
          "| # | 文号 | 复查判定 | 检索词 | 证据 |",
          "| --- | --- | --- | --- | --- |",
          ...docChecks.map(
            (c, i) =>
              `| ${i + 1} | ${mdCell(c.text)} | ${REF_VERDICT_TEXT[c.verdict]} | ${mdCell(c.query)} | ${
                c.evidence ? `[${mdCell(c.evidence.title)}](${c.evidence.url})` : "—"
              } |`,
          ),
          "",
          ...docChecks.flatMap((c) => (c.note ? [`- ${mdCell(c.text)}：${c.note}`] : [])),
        ]
      : []),
    "",
  ];
}
