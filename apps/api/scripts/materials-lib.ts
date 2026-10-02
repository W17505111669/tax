/** 比赛材料共享内容：背景/目标/创新点/流程图与真实运行统计，供作品说明与 PPT 大纲生成器复用。 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import {
  aggregatePeerCompares,
  buildDerivedFrom,
  isTemplateCompare,
  summarizeTaskCompares,
  type PeerCompare,
} from "../src/services/compare-stats.ts";
import { BATCH_REF_BUDGET, BATCH_REF_MAX } from "../src/services/ref-checks.ts";
import { compareRates, rateText } from "@tax/document-tools";
import { MAX_RETAINED_TEXT } from "@tax/agent-core";

/**
 * 作品说明里引用的那串全平台实测数字，直接取自 computePlatformStats。
 *
 * 原先这些数字写死在散文里（「检索 31 次…文号 31 处（可溯源 10 · 待复查 18）」），
 * 而同一句话承诺的恰恰是「看板与交付材料不会对不上」——平台口径一改，交付材料就成了反例。
 * 生成时取数，文档才可能永远与看板同源。
 */
export function evidenceSnapshotText(): string {
  const ev = computePlatformStats().evidence;
  return [
    `检索 ${ev.searchCalls} 次（留来源 ${ev.searchWithUrls} / 仅元数据 ${ev.searchMetadataOnly}）`,
    `引用 ${ev.citations} 条（官方 ${ev.officialCitations} · 弱 ${ev.weakCitations}${
      ev.weakDisclaimed > 0 ? `，其中 ${ev.weakDisclaimed} 条已在结论中声明为背景参考、不作为依据` : ""
    }${
      ev.weakUncited > 0 ? `，${ev.weakUncited} 条只在检索留存里、未进入结论正文` : ""
    }）`,
    `拦下 ${ev.searchDropped + ev.searchDroppedReplay} 条`,
    `文号 ${ev.docRefs} 处（有出处 ${ev.docRefTraced}，其中复查取得 ${ev.docRefTracedByRecheck} · 仅留存正文提到 ${
      ev.docRefTracedByBody
    } · 待复查 ${Math.max(
      0,
      ev.docRefPending - ev.docRefLabeled,
    )}${
      ev.docRefLabeled > 0 ? `（另有 ${ev.docRefLabeled} 处已在结论中标注「未取得公开原文，仅作背景参考」）` : ""
    } · 复查判定 matched ${ev.docRefMatched}）`,
    `缺口任务 ${ev.gaps.length} 个`,
  ].join("、");
}

/**
 * 文号复查的当前口径，与看板同源、生成时取数。
 *
 * 这一串数字曾以「实测一次点按覆盖 4 个任务 12 处文号：找到公开出处 9 处、候选待确认 1 处、
 * 未检索到 2 处，平台口径随即从待复查 18 变为 12」的形式写死在作品说明里，而平台口径随后就变了
 *（待复查一路降到 0），写死的那句立刻成了同一份文档里的反例——上一行还承诺「看板与交付材料不会对不上」。
 */
export function docRefSnapshotText(): string {
  const ev = computePlatformStats().evidence;
  return `文号 ${ev.docRefs} 处（有出处 ${ev.docRefTraced}，其中复查取得 ${ev.docRefTracedByRecheck} · 仅留存正文提到 ${ev.docRefTracedByBody} · 待复查 ${ev.docRefPending} · 复查判定 matched ${ev.docRefMatched}）`;
}

/**
 * 批量复查的预算口径：直接取服务端的真常量，文档里不写死数字。
 * 常量一改文档自动跟着改，不会出现「说明写 12 处、代码已经改成 20 处」。
 */
export function batchBudgetText(): string {
  return `默认 ${BATCH_REF_BUDGET} 处、硬上限 ${BATCH_REF_MAX} 处`;
}
export const BACKGROUND: Record<string, string> = {
  "rd-audit":
    "面向企业研发费用加计扣除专项审查业务。事务所需要从研发项目资料、费用辅助账和企业财务记录中识别关键业务信息，检查费用归集情况，结合税收政策形成专业审查意见。传统方式下资料来源分散、辅助账与财务账需人工核对、不同费用类型涉及不同归集要求、专项审查底稿编制工作量大。",
  "land-vat":
    "面向土地增值税清算过程中工作底稿的资料采集、数据匹配与自动填列环节。事务所需要阅读工程合同提取关键条款、逐张查看发票、在账簿中寻找对应业务记录、建立合同-发票-账簿对应关系并核对金额后填入 Excel 底稿。一份合同对应多张发票和多笔账面记录时，人工处理容易出现重复、遗漏或错误匹配。",
};

export const GOALS: Record<string, string[]> = {
  "rd-audit": [
    "研发项目资料与辅助账的结构化解析与信息提取",
    "辅助账与财务明细账的账账比对、差异与缺失识别",
    "按费用年度与企业类型确定性确认加计扣除比例及政策依据",
    "其他相关费用限额与加计扣除额的程序化测算（整数分计算）",
    "专项审查底稿生成、与人工底稿比对、税务师复核闭环",
  ],
  "land-vat": [
    "工程合同、发票、账簿的结构化解析",
    "一对一/一对多关联匹配与金额一致性核验",
    "歧义与差异事项的人工确认闭环",
    "事务所原始 Excel 模板的保留式自动填列（公式/合并/样式不破坏）",
    "已填列底稿与人工底稿的逐格比对与准确率输出",
  ],
};

/**
 * 创新点文案的**原始模板**。凡是描述「当前平台状态」的数字一律写成 `{占位符}`，由 innovations()
 * 在生成时取数填入；描述某次修复当时效果的历史数字保留原值，但必须写明是当时（否则读起来像
 * 当前口径）。此前它是导出常量、数字直接写死，于是「全平台 612 处结论金额零待确认」这句话在
 * 库里已经变成 995 处、92 处待确认之后仍然原样印在对外交付件上——不是取数漏了，是压根没取数。
 */
const INNOVATIONS_RAW: Record<string, string[]> = {
  "rd-audit": [
    "金额零口算：限额、基数、加计额全部由 TypeScript 工具以整数分确定性计算，模型只解释不计算。工具给全每一个数——需要比较两个归集口径时，calculate_rd_adjustment 的 alternative 参数一次返回两口径的完整测算与七项逐行差额，正文直接给出可整段照抄的对照表，顶层字段与对照表主口径列同源同值；差额一律由程序相减，结论里不出现手算的算术。金额溯源会把工具结果里找不到出处的金额判为待人工确认：全平台 {amountTotal} 处结论金额中 {amountPending} 处待确认（引自联网正文 {amountPendingWeb} 处，要核对的是引用抄得准不准；三处均无出处 {amountPendingUnexplained} 处，这才是「模型可能口算」要拦的那一类）。补的是工具能力而不是放宽判据——此前那 4 处待确认全部是模型手算的第二口径与两口径差额，工具补齐后那 4 处归零；此后的待确认来自联网正文摘引与历史任务未留存正文，逐条在台账与任务页可查",
    "政策双保险：本地版本化政策快照给出比例与文号，正式引用前强制联网核验并记录核验时间",
    "证据链贯穿：每项结论可追溯到文件、记录、字段与工具执行记录",
    "复核状态机：存在待复核问题时任务进入 waiting_review，税务师逐项确认后才流转为已完成；问题清单由工具结果实时提取，且只列**当前还需要人看**的项——没有结论的任务不列（失败或中断那次运行留下的差异是残渣，不是欠账）、与自己原始模板的比对不列（模板本来是空的，只有一侧有的格子正是填进去的值）、被后续运行取代的旧结果也不列（底稿比对只取最近一次与人工底稿的比对；凡是返回完整问题清单的业务工具——归集核查、合同发票关联、发票账面关联、金额一致性——只取同名工具最近一次成功调用，否则重跑后新旧两轮并存，同一件事会因为描述里带了合同名与发票张数而绕过去重键）。取代判定按工具名动态分组，不写死工具清单，新增同类工具自动适用；实测这几道过滤把全平台待复核问题从 135 条收敛到 57 条，其中比对类只剩 2 条真差异。若完成后才发现遗留问题，复核页「转为待复核」可重新打开复核",
    "复核可跨任务合并处置：看板把待复核问题按「类型 + 描述原文」跨任务去重分组（实测 58 条去重后 42 类，其中 7 类在多个任务里重复出现，最多一类涉及 6 个任务），同一类可一次「全部确认」或「全部驳回」并附一条共用复核意见——服务端按任务重新核对每条是否仍待复核，已处置或已不在清单里的逐条跳过并说明原因，每个任务各写一条复核记录与状态事件，待复核清零且处于待复核态的任务按同一条规则流转为已完成。任务内仍保留逐项确认与「全部确认／全部驳回」，跨任务合并只是把同一个判断从点六遍变成点一遍。已实际用掉：6 类 20 项一次处置，待复核 57 → 37、分组 42 → 36、已完成 8 → 12，20 项零跳过（服务端重算的清单与传来的 issueId 完全一致）。处置范围是挑过的——只判「确认列入底稿」无争议的类（资料缺失清单本身就是交付项、账账与票账差异属已列入底稿的待核查事项），「底稿差异 系统=420000 / 人工=425000」这类两份底稿的实质分歧留着逐项判断，一键判掉正是这个功能最该防的用法；要撤回走反向的 reopen-review-batch",
    "留正文顺带修掉一处文号溯源的假阴性：文号溯源的字符串池是通用遍历，所以留存正文一进来，「文号有出处」的判据就从「出现在标题、地址等元数据里」放宽为「出现在我们真的抓下来的页面正文里」。这是有意的放宽且方向明确——实测某任务 2 处文号里有 1 处（2023年第8号）只靠留存正文才溯到，此前会被判成无出处，可页面就在手上，这比联网复查所接受的「检索摘要里出现过该文号」更强。放宽就写明并守住：verify:policytrace 补 5 项断言，含「只有元数据时该文号溯不到」的对照基线、「留存后文号总数不变」，以及一条反向保险——正文里出现的其它地址不得混进引用清单（extractCitations 只读 results[] / url / urls[] 三个结构化字段、不对整段 JSON 盲扫），否则一页 18000 字的正文里随便一个链接都会变成一条结论引用，把引用分级与官方来源计数一起污染。尚未做的是区分「该文号是该页主题」与「只是在页面里被顺带提到」，那需要让溯源回传依据（元数据／正文）并在台账分列",
    "交付可签字：结果页一页「证据核对表」把九项证据口径收成可签字的一页（含交付前待办与核对人签字行），平台层再给一张全平台证据核对台账并可导出 MD/CSV，文号无出处、证据力弱、金额待确认逐项列明，不填占位数字",
    `引文可核对：联网检索与网页读取类工具的结果除了元数据，还留存**有上限的网页正文**（单次 ${MAX_RETAINED_TEXT} 字，不假装存全了。截断分两层、都如实记：联网扩展自己截断返回内容时在 details 里自报 truncated，实测 202 次联网类调用里 22 次被工具截断、其中 20 次连正文都没交给我们，平台手里只有查询元数据；平台留存撞上限时把截掉的字数记在 omittedChars，实测 1 条 10173 字。两层曾共用一个字段名而互相覆盖，已在源头把工具那份保留为 toolOmittedChars。工具层截掉的字数各工具口径不同，界面上只报条数、不推算字数），所以结论里摘引的政策原文能被平台自己核对。此前只存 details、正文一个字不留——实测 51 条 get_search_content 结果里最长字符串字段仅 110 字、22 条 fetch_public_document 仅 93 字（就是 URL），模型读到了原文、也把它摘进了结论，平台却既证明不了是忠实引用、也证明不了是编造。留存的正文**只用于分类、不进可溯源池**：金额待确认因此拆成「引自联网正文」（该核对引用抄得准不准）与「三处均无出处」（工具结果、客户指令、联网正文都找不到）两类，溯源判定本身依旧严格，否则任何金额都能声称有出处。对照实测同一份《2021年第28号公告》官方解读摘录：留存上线前两个任务 23 处待确认全部落在「无出处」、引文类 0 处；上线后的新任务 28 处里 27 处对上留存正文，只剩 1 处真正无出处——而那 1 处正是模型把 A 项目 90 万与 B 项目 100 万自己加成 190 万，原文里没有这个数。第二类列名叫「三处均无出处」而不叫「疑似口算」，因为它还混着「该任务运行时尚未留存正文、无从核对」的情况，不断言我们不知道的事；历史任务不回填`,
    "界面不露 Markdown 记号：结论正文由 marked + DOMPurify 渲染成 HTML、mermaid 按需动态加载出图；而目录条目、上次结论预览、结论差异行、关键词命中段落、摘要首段这些「一句话展示位」统一走 md-text.ts 转成可读纯文本——去井号与列表记号、去成对的粗体斜体删除线、反引号行内代码只留文字、链接留锚文本、表格竖线换成中点、围栏代码块（含 mermaid 源码）整块丢掉。工具名里的单个下划线不动，check_rd_expenses 不会被当成斜体啃掉。表格计数按分隔行逐格判定，认得 | :--- | ---: | 与 | :--: | 这类带对齐冒号的写法（旧口径只认三个短横开头，全库 94 张表漏数了 21 张）。任务指令面板刻意保留原文：那是用户提交的输入逐字回显，与对话流里的用户气泡同一口径，转成富文本反而篡改了「当时提交的是什么」",
    "失败可归因、可处置：看板不只给「失败 N」一个数字，还给出逐条清单（任务、工具名、错误正文、入参摘要、时间，可点回原始上下文）并按错误正文归成五类——模型传错参数 / 用法不支持 / 工具内部异常 / 外部服务拒绝或未配置 / 外部资源不存在，每类附一句处置建议，判不出的老实归入未归类不硬塞；展示顺序把「改提示词或用法约束就能减少」的排在前，汇总行直接给出这类条数。分类有意义是因为各类的负责人和动作完全不同：实测 11 条失败里，5 条是模型猜错 get_search_content 的参数组合、1 条是拿 file:// 本地路径去调远程抓取（这两类共 6 条已由系统提示词治理，复测首次尝试即正确）、1 条是社区扩展 fetch_content 自己抛的未捕获异常（处置是换 fetch_public_document，模型已按提示词自动回退并成功）、1 条 HTTP 412 是本机抓取通道未配置、3 条 HTTP 404 是页面真的不存在。归因规则本身也有门禁：verify:tfails 41 项，断言用的错误正文全部取自库里真实出现过的失败而不是编的样例，并走查全库失败确保没有「未归类」——一旦出现未归类，说明遇到了没见过的错误模式，该补一条规则而不是放着不管",
    "提示词改完即生效：系统提示词用惰性 getter 按「mtime + 大小」缓存读取，而不是在模块顶层 readFileSync 一次了事。顶层读的话提示词只在进程启动时读一遍，改完 .md 不重启就不生效、而且没有任何提示——实测 API 进程 23:07:31 启动、两份 system-prompt.md 23:28 才改，之后 21 分钟跑的都是旧提示词（tsx watch 盯的是 import 图，readFileSync 读的 .md 不在里面），调提示词的人只会得出「写了没用」的错误结论。改成 getter 后 agent-factory 里 systemPromptOverride 每次建会话都重新取值，改完下一个任务即生效，不必重启服务；已用真实任务验证：进程未重启、提示词改动晚于进程启动 9 分钟，新任务立刻按新契约调用。verify:agents 断言两个作品的 systemPrompt 都是 getter、缓存在文件变动后确实失效（同时比 mtime 与大小，避免同一毫秒内改写分辨不出），并锁住照着真实失败写进提示词的联网工具约束不被悄悄删掉",
    "指标不替数据认错：工具调用按三态统计——成功（ok=1）、失败（ok=0，工具确实返回了错误）、无结果（ok IS NULL，调用行在工具发起时落了库但 result 与 ended_at 都是空）。成功率的分母只取有返回结果的调用，无结果的次数单独摆出来，既不进分子也不进分母；一次有结果的调用都没有时显示「—」，不填 0% 也不填 100%。此前平台看板用「总数 − 成功数」当失败数，把没有结果的调用算成工具报错，成功率被压到 86.3%，还让人去查一个根本不存在的错误——任务页早就把 ok===null 单列，平台侧没接上，同一个判据两个消费点漏改一个。现在收成 tool-outcome.ts 一份共用口径，看板、导出 MD、TSV、作品说明与 PPT 大纲同源，并由 verify:toutcome 与 verify:stats 双向断言三态互斥且穷尽。环图相应画成三段，无结果那段用琥珀色而不是失败的玫红：它不是错误，颜色不该替它认错",
    "工具失败此前根本记不下来，两处一起修：其一，归一化事件时读的是 result.isError，而 SDK 的 ToolExecutionEndEvent 把 isError 放在**事件顶层**，于是 270 次 tool_end 全部记成 ok=true——「失败 0」不是没有失败，是没有能力记录失败；社区联网工具还会把失败写在 details.error 里而不置 isError（HTTP 404、HTTP 412、No query specified 等），这类同样按失败计。其二，运行器按**工具名**配对开始与结束事件，同名工具在上一次还没结束就再次开始时，后一次的行 id 覆盖前一次：前一行永远停在 ok IS NULL，结束时取到的又是另一次的行 id，结果被挂到错误的调用上（工具可以并发执行，executionMode 支持 parallel，按名配对根本站不住）。改为按 SDK 的 toolCallId 配对。证据是事件表里 tool_start 与 tool_end 各 270 条一一成对——每次调用都收到了结束事件，丢的 37 行恰好等于「同名工具未结束就再次开始」的次数。存量数据用 repair:toolcalls 恢复：结果都在 tool_end 事件的 payload 里，所以是**恢复被错配的数据**而不是回填编造的数值；配对用两级——硬证据优先（calculate_rd_adjustment / check_rd_expenses 回显 projectName、search_public_cases 回显 query、fetch_public_document 回显 url，按该字段精确命中唯一一行），其余顺序兜底。「按开始顺序结束」这条直觉在试算时当场被推翻：14 条回显入参与所在行 args 不符且都是成对互换，说明同名工具的结束顺序与开始顺序不一致，硬证据因此不是可选项而是必需项。修复后 67 行归位（37 行补回从未落库的结果、7 行 ok 由 1 改 0、23 行的结果挪回正确的行），脚本幂等、默认只试算、遇到无法解释的配对就拒绝写库。修复当时（2026-09-30）平台口径为成功 263 · 失败 7 · 无结果 0、成功率 97.41%，引用 169 → 170（多出的 1 条是官方原文），其余证据口径逐项未变——这几个数是那次修复的即时效果，不是当前口径，当前值见第七节「应用效果（真实运行统计）」，那一节全部取数生成",
  ],
  "land-vat": [
    "映射式填列：模型只给表头列名与数据行，地址定位/金额换算/公式避让由工具确定性完成",
    "保留式写盘：在模板副本上写入，公式、合并单元格与样式零破坏，原始模板 sha256 校验不变",
    "记录级比对：跨版式底稿按表头与主键对齐逐格比对，输出可直接入测试报告的准确率",
    "异常不认定：差异只形成待核查事项并给出可能原因，不直接认定企业申报错误。未注明合同编号的发票按执业规则不得自行归属，但底稿要说明「若归某合同还剩多少差异」——match_contract_invoice 的 allocationScenarios 参数按假设演算该合同的残余差异、全项目差异合计并判定 cleared / difference_pending / over_invoiced，且只输出演算结果，不改动实际关联结论：发票仍留在未匹配清单与待人工确认里，演算不能成为推定归属的后门",
    "交付可签字：清算底稿与填列结果附一页「证据核对表」（含交付前待办与核对人签字行），平台层再给一张全平台证据核对台账并可导出 MD/CSV，扣除项目金额与政策依据的欠账逐项列明，不填占位数字",
  ],
};

/**
 * 创新点文案（占位符已按当前平台取数填好）。
 *
 * 占位符只认下面这张表里的键，认不出的**原样留着**——留着比悄悄替换成空串好，因为
 * `verify:materials` 会断言生成出来的作品说明里不残留 `{xxx}`，写错键名当场就红。
 */
export function innovations(): Record<string, string[]> {
  const e = computePlatformStats().evidence;
  const vals: Record<string, string | number> = {
    amountTotal: e.amountTotal,
    amountPending: e.amountPending,
    amountPendingWeb: e.amountPendingWeb,
    amountPendingUnexplained: e.amountPendingUnexplained,
  };
  const out: Record<string, string[]> = {};
  for (const [agentId, list] of Object.entries(INNOVATIONS_RAW)) {
    out[agentId] = list.map((line) =>
      line.replace(/\{(\w+)\}/g, (m, key: string) => (key in vals ? String(vals[key]) : m)),
    );
  }
  return out;
}

export const FLOWS: Record<string, string> = {
  "rd-audit": `flowchart TD
  A["上传研发项目资料/辅助账/财务明细"] --> B["parse_uploaded_files 结构化解析"]
  B --> C["check_rd_expenses 账账比对与缺失识别"]
  C --> D["search_rd_policy 政策适用与比例确认"]
  D --> E["calculate_rd_adjustment 确定性测算"]
  E --> F{"存在待复核问题?"}
  F -->|是| G["waiting_review 税务师复核"]
  G --> H["generate_workpaper 专项审查底稿"]
  F -->|否| H
  H --> I["compare_workpapers 与人工底稿比对"]
  I --> J["交付：底稿/引用清单/测试报告"]`,
  "land-vat": `flowchart TD
  A["上传合同/发票/账簿/原始模板"] --> B["parse_uploaded_files 结构化解析"]
  B --> C["match_contract_invoice 合同发票关联"]
  C --> D["match_invoice_ledger 发票账簿匹配"]
  D --> E["check_amount_consistency 金额核验"]
  E --> F{"存在歧义或差异?"}
  F -->|是| G["waiting_review 人工确认"]
  G --> H["inspect_workpaper_template 模板结构检查"]
  F -->|否| H
  H --> I["fill_land_vat_workpaper 映射式保留填列"]
  I --> J["compare_workpapers 与人工底稿比对"]
  J --> K["交付：已填列模板/差异清单/测试报告"]`,
};

export interface Stats {
  tasks: number;
  completed: number;
  toolCalls: number;
  toolOk: number;
  /** ok=0：工具确实返回了错误 */
  toolFailed: number;
  /** ok IS NULL：调用发起了但从未返回（服务重启打断），不是失败，口径见 web/src/tool-outcome.ts */
  toolUnfinished: number;
  artifacts: number;
  compareAccuracy: number | null;
  compareRuns: number;
  /** 最近一次记录级比对的构成与两个拆分比率：总准确率会把「填错」与「范围没对上」混成一个数 */
  compareMatched: number;
  compareMismatched: number;
  compareOnlyA: number;
  compareOnlyB: number;
  compareMatchRate: number | null;
  compareCoverage: number | null;
  /** 与自己的原始模板核对：次数 / 填列新增的单元格数 / 与模板既有内容冲突的单元格数 */
  compareTemplateRuns: number;
  compareFilledCells: number;
  compareTemplateMismatched: number;
}

export function statsFor(agentId: string): Stats {
  const tasks = db.prepare(`SELECT id, status FROM tasks WHERE agent_id = ?`).all(agentId) as unknown as Array<{
    id: string;
    status: string;
  }>;
  // 任务数 / 已完成 / 工具调用三态 / 产物数这七项**不在这里再算一遍**：看板（computePlatformStats
  // 的 perAgent）已经算过一份。两边各跑一遍 SQL 就是同一件事写两遍——本文件的比对口径曾因此与
  // 看板对不上（09-28 的旧比对压过 09-29 的最新一次，见下面那段注释）。取同一份就不可能各说一套；
  // 取不到就报错，不猜数字。实测合并前两边 2 个智能体 × 7 个字段逐项相等（0 处不一致）。
  const board = computePlatformStats().perAgent.find((a) => a.agentId === agentId);
  if (!board) throw new Error(`看板取数里没有智能体 ${agentId}：作品说明不猜数字`);
  let compareAccuracy: number | null = null;
  let compareRuns = 0;
  let compareAt = "";
  let compareMatched = 0;
  let compareMismatched = 0;
  let compareOnlyA = 0;
  let compareOnlyB = 0;
  let compareMatchRate: number | null = null;
  let compareCoverage: number | null = null;
  let compareTemplateRuns = 0;
  let compareFilledCells = 0;
  let compareTemplateMismatched = 0;
  // 比对口径与平台看板、测试报告共用 compare-stats.ts 那一份实现：本文档曾自己写过一遍
  //「取最近一次」，结果作品说明的准确率与看板对不上（09-28 的旧比对压过了 09-29 的最新一次）
  const peers: PeerCompare[] = [];
  let peerRuns = 0;
  let latestPeer: PeerCompare | null = null;
  for (const t of tasks) {
    const calls = db.prepare(`SELECT ok, tool_name, args, result, started_at FROM tool_calls WHERE task_id = ?`).all(t.id) as unknown as Array<{
      ok: number | null;
      tool_name: string;
      args: string | null;
      result: string | null;
      started_at: string | null;
    }>;
    const cmp = summarizeTaskCompares(calls);
    peerRuns += cmp.peerRuns;
    compareTemplateRuns += cmp.template.runs;
    compareFilledCells += cmp.template.filledCells;
    compareTemplateMismatched += cmp.template.mismatched;
    if (cmp.peer !== null) {
      peers.push(cmp.peer);
      if (latestPeer === null || cmp.peer.at >= latestPeer.at) latestPeer = cmp.peer;
    }
  }
  const agg = aggregatePeerCompares(peers);
  compareRuns = peerRuns;
  compareAccuracy = latestPeer?.accuracyPercent ?? null;
  compareMatched = agg.matched;
  compareMismatched = agg.mismatched;
  compareOnlyA = agg.onlyA;
  compareOnlyB = agg.onlyB;
  compareMatchRate = agg.matchRatePercent;
  compareCoverage = agg.coveragePercent;
  return {
    tasks: board.tasks,
    completed: board.completed,
    toolCalls: board.toolCalls,
    toolOk: board.toolOk,
    toolFailed: board.toolFailed,
    // 三态互斥且穷尽：未返回的那部分不能用「总数 - 成功数」冒充失败数（口径在看板那一份里）
    toolUnfinished: board.toolUnfinished,
    artifacts: board.artifacts,
    compareAccuracy,
    compareRuns,
    compareMatched,
    compareMismatched,
    compareOnlyA,
    compareOnlyB,
    compareMatchRate,
    compareCoverage,
    compareTemplateRuns,
    compareFilledCells,
    compareTemplateMismatched,
  };
}

/** 比率展示：null 说「无可比对项」，不写成 0% 也不写成 100% */
export { rateText };

export function recentTaskLinks(agentId: string, limit = 3): Array<{ title: string; status: string; link: string }> {
  const rows = db
    .prepare(`SELECT id, title, status FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(agentId, limit) as unknown as Array<{ id: string; title: string; status: string }>;
  return rows.map((r) => ({
    title: r.title,
    status: r.status,
    link: `#/agent/${agentId}/task/${r.id}/tab/result`,
  }));
}

export interface CompareLike {
  totals: {
    compared: number;
    matched: number;
    mismatched: number;
    onlyA: number;
    onlyB: number;
    accuracyPercent: number;
  };
  sheets: Array<{ diffs: Array<{ kind: string; address: string; a: unknown; b: unknown }> }>;
}

/** 取该智能体最近一次记录级比对结果，供作品说明附录展示差异明细。 */
export type LatestCompare = { compare: CompareLike; bName: string };

/**
 * 演示用的人工参考底稿样例：由 packages/document-tools/scripts/make-compare-sample.ts 生成，
 * 其中「直接投入」被故意写成与案例输入不同的数，用来验证比对确实抓得出差异。
 * 作品说明据此说明该差异是预埋的演示差异，而不是系统取数错误。
 */
export const DEMO_REFERENCE_SAMPLE = "人工参考底稿-样例.xlsx";

/**
 * 取该智能体最近一次**与人工底稿的记录级比对**，供作品说明附录展示差异明细。
 *
 * 两道筛选与平台统计同源：逐格（address）模式与记录级不是同一个量纲，不能当记录级比对展示；
 * 「填列产物 vs 它自己的原始模板」也不是与人工底稿比对。此前只取时间上最后一条、不是记录级就返回
 * null——实测土增智填最后一次是逐格比对，附录于是整段消失，明明有可用的记录级结果。
 */
export function latestCompareFor(agentId: string): LatestCompare | null {
  const rows = db
    .prepare(
      `SELECT tc.task_id AS taskId, tc.args AS args, tc.result AS result FROM tool_calls tc
         JOIN tasks t ON t.id = tc.task_id
       WHERE t.agent_id = ? AND tc.tool_name = 'compare_workpapers' AND tc.ok = 1 AND tc.result IS NOT NULL
       ORDER BY tc.started_at DESC`,
    )
    .all(agentId) as unknown as Array<{ taskId: string; args: string | null; result: string }>;
  const argsCache = new Map<string, Array<{ args: string | null }>>();
  for (const row of rows) {
    let parsed: CompareLike & { sheets?: Array<{ mode?: string }> };
    try {
      parsed = JSON.parse(row.result) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.sheets?.[0]?.mode !== "record") continue;
    let taskCalls = argsCache.get(row.taskId);
    if (!taskCalls) {
      taskCalls = (db.prepare(`SELECT args FROM tool_calls WHERE task_id = ?`).all(row.taskId) ?? []) as Array<{
        args: string | null;
      }>;
      argsCache.set(row.taskId, taskCalls);
    }
    if (isTemplateCompare(row.args, buildDerivedFrom(taskCalls))) continue;
    let bName = "";
    try {
      bName = String((JSON.parse(row.args ?? "{}") as { b?: { name?: unknown } }).b?.name ?? "");
    } catch {
      bName = "";
    }
    return { compare: parsed as CompareLike, bName };
  }
  return null;
}
