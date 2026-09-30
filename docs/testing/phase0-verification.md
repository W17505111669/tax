# Phase 0 / Phase 1 验证记录

日期：2026-09-23
环境：Windows 11 / Node v25.9.0 / pnpm 9.15.9 / git 2.45.2
模型端点：`http://127.0.0.1:15721/v1`（OpenAI Responses 兼容网关），模型 `qwen3.8-max`
SDK：`@earendil-works/pi-coding-agent@0.87.1`（已锁定精确版本）

以下输出均为本机真实执行结果。

## P0-1 项目目录

Monorepo 已建立：`apps/web`、`apps/api`、`packages/agent-core`、`packages/shared-schemas`、`agents/rd-audit`、`agents/land-vat`、`data/`、`docs/`。

## P0-2 可运行前端

`pnpm dev:web` 启动 Vite，`http://127.0.0.1:5173/` 返回 200。
浏览器实测：智能体列表、任务历史、新建任务表单、执行工作台（时间线 / 工具调用 / 执行结论）均正常渲染。

## P0-3 可运行 Fastify 服务

`pnpm dev:api` 启动：

```
{"level":30,"msg":"Server listening at http://127.0.0.1:8787"}
{"level":30,"msg":"API 已启动: http://127.0.0.1:8787"}
```

## P0-4 Pi Agent 调用自定义工具

`pnpm verify:pi` 实际输出：

```
[verify] 模型解析成功: taxai/qwen3.8-max
[verify] 会话已创建，可用工具: probe_echo
[verify] 工具已执行 -> TAX AGENT
[verify] Agent 回复: 工具返回了大写的字符串 `TAX AGENT`（即把输入的 "tax agent" 转成了全大写）。
[verify] 工具事件: tool_start:probe_echo | tool_end:probe_echo:ok

[PASS] Pi SDK 已可调用自定义工具并回传执行事件。
```

## P0-5 前端实时显示执行结果

浏览器内创建任务后，SSE 事件实时到达页面。实测事件序列（节选）：

```
data: {"seq":1,"kind":"task_created","message":"任务已创建，智能体：土增智填——合同发票账簿智能核验填表",...}
data: {"seq":2,"kind":"run_started","message":"开始执行任务：合同发票关联核验验证",...}
data: {"seq":3,"kind":"agent_status","message":"已加载智能体「土增智填」，可用工具：match_contract_invoice、match_invoice_ledger、check_amount_consistency",...}
data: {"seq":4,"kind":"agent_text_delta","message":"我先调用关联工具",...}
```

页面「工具调用」页签展示了真实工具入参与返回 JSON；「执行结论」页签展示了 Agent 基于工具结果生成的专业意见。

## Phase 1：双 Agent 独立性

`pnpm verify:agents` 实际输出：

```
[verify] 智研税审工具: calculate_rd_adjustment, check_rd_expenses
[verify] 土增智填工具: match_contract_invoice, match_invoice_ledger, check_amount_consistency
[verify] 工具集重叠: 无（符合独立性要求）
[verify] 系统提示词是否不同: true
[verify] 智研税审 会话工具: calculate_rd_adjustment, check_rd_expenses | 与配置一致=true | 已禁用内置编码工具=true
[verify] 土增智填 会话工具: check_amount_consistency, match_contract_invoice, match_invoice_ledger | 与配置一致=true | 已禁用内置编码工具=true

[PASS] 两个 Agent 相互独立，且未启用 Pi 内置系统操作工具。
```

## 业务工具确定性计算核对

智研税审 `calculate_rd_adjustment`（输入：人员人工 860000、直接投入 420000、折旧 150000、无形资产摊销 60000、新产品设计费 90000、其他相关费用 180000，比例 100%）：

```
firstFiveTotal=1580000.00  otherActual=180000.00  otherLimit=175555.55
otherExceeded=4444.45      base=1755555.55        deduction=1755555.55
```

与独立手算一致：限额 = 1,580,000 × 10% ÷ 90% = 175,555.55（整数分向下取整）。

土增智填 `match_contract_invoice`（3 份合同、5 张发票）：

```
HT-001 | 合同 12000000.00 | 发票2张 11900000.00 | 差异 100000.00  | difference_pending
HT-002 | 合同  3500000.00 | 发票1张  3500000.00 | 差异 0.00       | consistent
HT-003 | 合同  6800000.00 | 发票1张  4800000.00 | 差异 2000000.00 | difference_pending
summary: {"consistent":1,"differencePending":2,"noInvoice":0,"unmatchedInvoiceCount":1,"duplicateCount":0}
unmatched: FP-005(发票未注明合同编号)
```

一对多汇总、差异标记、未匹配识别均符合交接文档 5.8 的行为约定。

## 类型检查

`pnpm -r typecheck`：6 个包全部 Done，无错误。

## 执行进度推导口径（2026-09-28 增补）

列表接口附带的 `progress`（0-5）由 `apps/api/src/services/task-store.ts` 的 `computeProgress` 依据 events 与 tool_calls 推导：

1. 提问：存在 `run_started` 事件 → 1；
2. 工具核验：存在非联网工具调用且 `ok` 已落定 → 2；
3. 联网检索：存在联网类工具调用且 `ok` 已落定 → 3；
4. 结论生成：存在 `agent_text` 事件 → 4；
5. 交付：任务状态 `completed` → 5。

非执行且非完成的任务恒为 0；执行中任务取值 [0,4]。断言脚本 `pnpm verify:progress`（qa 矩阵第 10 条）覆盖上述规则与 completed 必含 `run_completed` 事件的不变量。

## 已知限制（待开发）

- 文件解析（PDF / Excel / OCR）尚未接入，上传文件目前仅归档。
- Excel 底稿模板填列尚未实现，等待客户原始模板。
- 政策知识库检索尚未实现，Agent 会明确声明未检索政策而不虚构文号。
- 任务会话为内存态，进程重启后可通过事件回放查看历史，但不支持断点续跑。
- 任务会话为内存态，进程重启后可通过事件回放查看历史，但不支持断点续跑。

## 联网检索与 Markdown/mermaid 输出（2026-09-23 增补）

新增共用工具 `search_public_cases`（Bing 主、百度兜底，异常降级为空结果）与 `fetch_public_document`（带内网地址拦截）。

真实任务「缺失资料联网检索与图表输出验证」中 Agent 实际调用：

```
check_rd_expenses(ok) → search_public_cases(ok) → calculate_rd_adjustment(ok)
→ fetch_public_document(ok) → search_public_cases(ok)
```

检索词示例：`研发费用加计扣除 研发人员名单 缺失 案例`，返回 8 条公开结果（含标题、URL、摘要、检索引擎）。

前端已接入 Markdown 阅读器（marked + DOMPurify）与 mermaid 渲染。浏览器实测该任务结论页：
`mermaid svg=1 tables=5 h3=5`，差异传导 flowchart 正常出图，表格与分节标题按报告样式渲染。

`pnpm verify:agents` 复测：两个 Agent 会话工具分别为
`calculate_rd_adjustment, check_rd_expenses, fetch_public_document, search_public_cases` 与
`check_amount_consistency, fetch_public_document, match_contract_invoice, match_invoice_ledger, search_public_cases`，
业务工具仍无重叠，内置编码工具仍禁用。

## 社区网搜扩展接入（pi-web-access）

选型：`pi-web-access@0.31.0`（MIT，npm 现成包，社区最成熟的检索+正文提取扩展）；零配置走 Exa MCP，无需 API key。
加载方式：`DefaultResourceLoader({ additionalExtensionPaths: [pi-web-access/dist/index.js] })`，配置写入隔离 agentDir 的 `web-search.json`（开启 fetch_content / get_search_content）。

`pnpm verify:agents` 实测会话工具增量：`web_search, fetch_content, source_check, get_search_content, web_enable`，两个 Agent 均加载成功，内置编码工具仍禁用。

真实任务「社区扩展 web_search 实测」工具调用序列：

```
web_search:True → check_rd_expenses:True → web_search:True → fetch_content:False → fetch_content:True
```

`web_search` 通过 Exa MCP 零配置返回结果；`fetch_content` 首次失败为目标页拒绝抓取，换页后成功，符合扩展自身降级设计。自建 `search_public_cases` 保留为兜底 provider。

## 侧边阅读器（网页 / 文件 / 产物）

服务端：`GET /api/reader`（linkedom + @mozilla/readability + turndown 转 Markdown，10 分钟内存缓存，SSRF 内网拦截，PDF 返回 contentType 供前端 iframe 预览）；`GET /api/tasks/:id/files/:fileId/content` 与 `GET /api/tasks/:id/artifacts[/:name/content]` 提供资料与产物预览流。

前端：`SideReader` 可折叠侧栏；Markdown 输出中的外部链接点击被拦截并在阅读器内以阅读模式打开；业务资料与生成产物列表项点击同样进入阅读器；阅读器展开时自动收起中间信息栏以保证主区域宽度。

浏览器实测：点击结论中 12366 链接，侧栏标题显示「国家税务总局12366纳税服务平台」，正文为 Readability 提取的阅读模式内容，并附「原文以来源链接为准」提示。

## Phase 2：文件解析与底稿生成（2026-09-28）

新增 `packages/document-tools`（ExcelJS + unpdf，均为成熟开源库）：

- `parse_uploaded_files` 任务级工具：解析 Excel（自动表头识别、合并标题行排除）、CSV、PDF 文本、TXT；
- `generate_workpaper` 任务级工具：生成带样式（表头填色、冻结首行、边框、千分位数字格式、公式）的可编辑 Excel 底稿，落入 `data/outputs/<taskId>/`，前端「生成产物」栏可预览（工作表表格化渲染）与下载；
- 解析成功后任务资料 `parse_status` 自动置为 `parsed`。

`pnpm verify:docs` 实际输出：

```
[verify] sheet=辅助账 rows=2 headers=类别,金额（元）
[verify] parseExcel=true parseCsv=true workpaperTitle=true formula=true frozen=true

[PASS] 文档解析与 Excel 底稿生成可用。
```

端到端实测（任务「上传资料解析与底稿生成闭环」）：上传合成样例辅助账 xlsx 后，Agent 依次调用
`parse_uploaded_files:True → check_rd_expenses:True → calculate_rd_adjustment:True → web_search:True → generate_workpaper:True`，
产物 `底稿-研发费用加计扣除专项审查-*.xlsx`（14.2KB）归档成功，阅读器中以白纸表格预览「归集比对」工作表，行列与金额与工具输出一致。

## Phase 3：土增原始模板保留式填列（2026-09-28）

新增任务级工具（仅土增智填启用，`taskToolKits: ["documents","template"]`）：

- `inspect_workpaper_template`：读取模板工作表、行列范围、合并区域（`ws.model.merges`）、公式单元格分布与非空单元格地址清单；
- `fill_land_vat_workpaper`：在模板副本上按地址写值，保留全部公式/合并/样式，另存到产物目录；拒绝覆盖公式单元格；原始上传模板以 sha256 校验确认未被修改。

`pnpm verify:template` 实际输出：

```
[verify] inspect merged=A1:E1 formulas=E4,E5,E6,C7
[verify] inspect=true fill=true values=true formulaKept=true mergeKept=true rejectFormulaWrite=true originalUntouched=true

[PASS] 模板检查与保留式填列可用。
```

端到端实测（任务「模板保留式填列闭环」，上传合成模板）：Agent 调用链
`parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → web_search → check_amount_consistency → generate_workpaper` 全部 True；
产物 `已填列-土增清算底稿-合成模板.xlsx` 回读校验：HT-001/HT-002/HT-003 三行合同金额与发票汇总（12,000,000/11,900,000、3,500,000/3,500,000、6,800,000/4,800,000）与 match 工具输出一致，差异列与合计公式、合并备注行均保留。

### 映射模式填列（2026-09-28 增补）

`fill_land_vat_workpaper` 新增 mapped 映射模式：模型只提供工作表名、表头列名与数据行，表头行探测、列定位、写入地址计算、元→数值换算（整数分）与公式避让全部由工具确定性完成；writes 地址模式保留为无规则表头时的兜底。

`pnpm verify:template` 映射模式断言：

```
[verify] mapped header=3 start=4 cols={"contractNo":1,"contractAmount":3,"invoiceTotal":4} written=6 | headerOk=true valuesOk=true noFormulaHit=true formulaKept=true
```

端到端实测（任务「映射模式填列验证」）：Agent 自主选择映射模式，`fill_land_vat_workpaper` 返回 header=3、start=4、written=12、skipped=0、保留公式 8 个；产物 `土增清算底稿-已填列.xlsx` 回读三行合同金额与发票汇总与 match 工具输出一致，差异列公式未触碰。

## 底稿比对与准确率（2026-09-28）

新增 `compare_workpapers` 工具（两个 Agent 共用）：默认记录级比对——按表头行与主键列对齐记录，系统底稿与人工底稿版式不同（标题行/行偏移）仍可比；`align=address` 保留同版式逐地址比对。输出一致、数值差异、单方缺失与准确率，差异只报告不修改。

`pnpm verify:compare` 实际输出：

```
[verify] compared=5 matched=2 mismatched=1 onlyA=0 onlyB=2 accuracy=40%
[verify] totals=true accuracy=true mismatchCell=true(直接投入/金额（元）) tolerance=true
[verify] addressMode mismatched=1 mode=address ok=true

[PASS] 底稿逐格比对统计口径正确。
```

端到端实测（任务「记录级底稿比对闭环」）：Agent 生成底稿后调用 `compare_workpapers` 与上传的人工参考底稿比对，返回
`mode=record accuracy=66.67% compared=3 matched=2 mismatched=1`，唯一差异 `直接投入/金额（元） A=420000 B=425000` 与预埋差异一致；最终结论报告了准确率并将差异列为待核查事项。

前端新增「底稿比对」页签（`/api/tasks/:id/compares` 聚合工具调用历史）：总准确率发光 KPI 卡、比对/一致/差异/仅系统/仅人工计数、按工作表分组的差异高亮表（差异=红、仅系统=琥珀、仅人工=蓝）、未配对工作表警告。浏览器实测该页签渲染 4 条历史比对记录（含地址模式时期的 0% 记录与修复后的记录级记录），KPI 与差异表数据与工具返回一致。

## 人工复核闭环（2026-09-28）

补齐交接文档流程图中的「税务师复核」节点：

- `GET /api/tasks/:id/issues`：从工具结果（`details.issues`）与比对差异中确定性提取待复核问题（跨调用去重），返回问题、复核记录与待办数；
- `POST /api/tasks/:id/review`：提交 confirm/dismiss + 意见；全部复核完成后任务自 `waiting_review` 流转为 `completed`；
- 运行结束时若存在待复核问题，任务状态置为 `waiting_review` 并推送事件；
- 前端「人工复核」页签：问题卡（类型徽章、来源工具、证据 chips、意见输入、确认/驳回按钮）、待办计数徽章、复核完成横幅。

状态机实测：任务「人工复核状态机验证」运行结束 `status=waiting_review、pending=2`；提交两条复核后 `status=completed、pending=0`。浏览器实测复核页签渲染两条问题卡与「已确认列入底稿」徽章、意见回显正常。

## 续跑接口（2026-09-28）

交接文档 6.3 的最后一个接口 `POST /api/tasks/:id/resume` 已实现：

- 会话持久化：每个任务使用 `SessionManager.continueRecent(taskCwd, data/sessions/<taskId>)`，首轮创建会话文件，续跑恢复完整对话历史；
- 续跑提示词带「续跑补充」前缀，要求 Agent 结合此前结论与产物继续处理，新增上传资料先解析；
- 前端工作台新增「续跑任务」面板：补充说明文本 + 补充资料上传（先走文件上传接口再续跑）；执行中禁用。

实测（任务「续跑会话历史验证」）：首轮运行结束 `waiting_review`；续跑提问「上一轮确认的直接投入差异是多少」，
Agent 未重新调用工具，直接答「**直接投入费用差异为 40,000.00 元**」并引用上一轮 `check_rd_expenses` 的返回原文，
证明会话历史真实恢复而非重开新会话。

## OCR 适配器（2026-09-28）

`packages/document-tools/src/ocr.ts`：可替换 OCR 适配器，默认本地引擎 tesseract.js（chi_sim+eng），语言包预置于 `data/ocr-tessdata`（tessdata_fast 4.1.0，jsdelivr 镜像下载），缓存目录可用 `TAXAI_OCR_CACHE` 覆盖；脚本场景须调用 `shutdownOcr()` 释放 worker 子进程。

`parse_uploaded_files` 对 png/jpg/jpeg/bmp 自动走 OCR，返回 `ocrProvider` 与 `ocrConfidence`；PDF 无文本层仍提示需 OCR 或转图片。

`pnpm verify:ocr` 实际输出：

```
[verify] provider=tesseract.js(chi_sim+eng) confidence=93%
[verify] text="研发费用辅助账\n人员人工 860000 元\n直接投入 420000 元"
[verify] chinese=true number860000=true confidenceOk=true

[PASS] OCR 适配器可识别中文与数字。
```

端到端实测（任务「OCR 扫描件解析验证」）：上传扫描件图片后 `parse_uploaded_files:True`，返回 provider=tesseract.js(chi_sim+eng)、conf=93、文本与样张一致；Agent 据此整理出表格结论，任务 completed。

新环境部署语言包（约 6.5MB）：

```bash
mkdir -p data/ocr-tessdata
curl -L -o data/ocr-tessdata/chi_sim.traineddata https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0/chi_sim.traineddata
curl -L -o data/ocr-tessdata/eng.traineddata https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@4.1.0/eng.traineddata
```

## Phase 4：研发政策快照库与比例规则（2026-09-28）

新增 `agents/rd-audit/knowledge/rd-policies.json`（10 条版本化政策快照：119 号、97 号、40 号、99 号、2021 年 6/13/28 号、2022 年 16 号、2023 年 7/44 号）与 `search_rd_policy` 工具：

- 按费用年度筛选适用政策、按关键词检索条文要点；
- 确定性比例规则表 `rateFor(year, enterpriseType)`：50%/75%/100%/120% 四档，返回比例与政策依据文号；
- 系统提示词强制：测算前必须先取快照比例与文号，正式成果引用前须联网核验并记录核验时间。

`pnpm verify:policy` 实际输出（节选）：

```
[verify] rate(2025,general) = 100% 财政部 税务总局公告2023年第7号 | expect 100% ... | ok
[verify] rate(2025,ic_imt) = 120% ...2023年第44号 | ok
[verify] keyword(辅助账)=cs2015-119,sta2015-97,sta2021-28 ok=true | year2025=8条 ok=true

[PASS] 政策快照与比例规则验证通过。
```

端到端实测（任务「政策依据检索与测算闭环」）：Agent 调用链
`parse_uploaded_files → search_rd_policy → calculate_rd_adjustment → search_rd_policy → web_search ×2 → search_public_cases`；
快照返回 `rate=100% basis=财政部 税务总局公告2023年第7号`，最终结论以表格列明文号、适用年度，并注明政策法规库核验状态「全文有效」。
## 本机网关自带搜索实测结论（不启用）

对 `http://127.0.0.1:15721/v1`（Responses API）做了三组对照实测：

| 组 | 请求 | 结果 |
| --- | --- | --- |
| A | `tools:[{type:"web_search"}]`，查询过去日期公告 | 200，`output` 仅 `reasoning,message`，无 `web_search_call`；模型自述「我当前没有可用的联网检索/浏览工具」 |
| B | 顶层 `enable_search:true` | 90-100s 超时无响应 |
| C | 不带任何搜索参数（对照） | 与 A 同样拒答或超时 |

结论：`/v1/models` 中的 `supports_search_tool=true` 只是网关目录元数据，代理并未真正执行搜索工具。**网关自带搜索不启用**，联网检索继续使用本项目自建引擎（Bing 主、百度兜底，`TAXAI_SEARCH_ENGINES` 可调顺序）。后续如取得 Bocha / 智谱 / Bing API key，可在 `search_public_cases` 内增加 `api` provider。

## 平台应用效果看板与比对联动（2026-09-28）

- `GET /api/stats`：平台级真实运行统计（任务数、完成数、工具调用成功率、产物数、记录级比对准确率、分智能体明细），首页新增「平台应用效果 · 实时运行数据」KPI 带，15 秒周期刷新；浏览器实测显示 17 任务 / 93.59% 工具成功率 / 11 份产物 / 66.67% 比对准确率。
- 比对记录携带 a/b 文件引用，「底稿比对」页签每条记录提供「查看系统底稿 / 查看人工底稿」按钮，一键在侧边阅读器打开对应产物或上传件（Excel 以工作表表格预览）。

## 比对差异联动与比对报告导出（2026-09-28）

- 差异行可点击：同时在阅读器打开系统底稿 (A) 与人工底稿 (B) 两个标签，并按主键高亮定位差异行（琥珀色行 + 「定位：xxx」徽章）；
- 比对记录新增「导出比对报告」按钮，客户端生成 Markdown 报告（模式、A/B 文件名、总准确率、分工作表差异表）并下载。

浏览器实测（任务「比对联动验证」，准确率 50%、差异 1 项）：点击差异行后阅读器出现两个标签（系统/人工底稿），高亮行 `.row-hl` 计数 1，定位徽章显示「直接投入」；KPI 卡与差异表数值（420,000.00 vs 425,000.00）与工具返回一致。

## 哈希路由深链（2026-09-28）

前端新增哈希路由 `#/agent/<agentId>/task/<taskId>/tab/<timeline|result|compare|review>`：

- 状态变化经 `history.replaceState` 写回哈希；`hashchange` 与挂载时解析恢复智能体、任务与页签；深链任务归属与当前智能体不一致时自动纠正；
- 录屏/答辩可直接贴链接定位到任意任务的指定页签，刷新不再丢失上下文。

浏览器实测：直接打开 `#/agent/rd-audit/task/<id>/tab/compare` 落地即为目标任务的「底稿比对」页签（`task=true compare=true`），整页刷新后状态保持不变（`afterReload: task=true compare=true`）。

## 案例回归套件（2026-09-28）

新增 `data/cases/<caseId>/` 约定（case.json + inputs/ + expected/ + report-*.md，见 data/cases/README.md）与 `pnpm case:run <caseId>`：自动创建任务、上传资料、执行 Agent、取最新 xlsx 产物与人工参考底稿做记录级比对、生成案例报告并按 minAccuracy 判 PASS/FAIL（`waiting_review` 视为合法终态）。

实测 `pnpm case:run case-rd-basic`：

```
[case] status=waiting_review accuracy=66.67% pass=true
```

报告含工具链 `parse_uploaded_files:ok → check_rd_expenses:ok → generate_workpaper:ok`、产物文件名与差异明细（直接投入 420000 vs 425000，与预埋差异一致）。真实脱敏案例接入时只需替换 inputs/ 与 expected/ 并重写 instruction。

## 录屏分镜表生成器（2026-09-28）

`pnpm demo:script` 从数据库真实任务自动挑选每幕代表任务（按工具链/文件类型/复核记录/续跑事件匹配，标题hint 优先），生成 `docs/competition/录屏分镜表.md`：10 幕、合计 450 秒（≤8 分钟符合附件4），每幕含深链、旁白要点与画面验收标准；缺示例任务的幕会标注一键创建提示。实测输出 `scenes=10 totalSeconds=450 missing=0`，深链均指向 completed/waiting_review 的真实任务。

## 报告版式选择器（2026-09-28）

新增四套纸张版式主题（经典固实 / 极简商务 / 黑白打印 / 现代蓝紫），以 CSS 变量驱动，作用于侧边阅读器的白纸预览与打印导出（`body[data-paper-theme]`），选择经 localStorage 持久化；切换器出现在阅读器版式行与审查结论「打印版式」行。浏览器实测切换器渲染与选中态正常，抓取失败（403）时阅读器的「新标签页打开原文」兜底按钮同屏可见。

## PPT 大纲生成器与材料共享库（2026-09-28）

新增 `pnpm gen:ppt`：每作品 10 页答辩大纲（封面/背景/目标/架构/流程/工具/创新/演示/效果/边界），每页含讲稿要点与画面元素；演示页自动列入该智能体最近 3 个真实任务深链，效果页数字来自数据库统计。背景/目标/创新点/流程图与统计函数抽至 `scripts/materials-lib.ts`，作品说明与 PPT 大纲共用，`pnpm gen:materials` 回归输出不变。

## 合同/发票字段抽取（2026-09-28）

新增 `parse_contract` / `parse_invoice` 任务级工具（仅土增智填，`taskToolKits` 增加 `extract`）：数据源为上传文件（PDF 文本层 / 图片 OCR / txt），正则确定性抽取票面与合同字段，返回缺失清单与置信度；置信度 low 或缺关键字段时提示词要求列为待人工补录，不得猜测补全。

`pnpm verify:extract` 实际输出：

```
[verify] invoice=true contract=true emptyDegraded=true
[verify] invoiceFields={"invoiceNo":"08654321","invoiceCode":"1100213130","date":"2025-06-18","sellerName":"江苏某建筑工程有限公司","amountYuan":"5000000.00","taxAmountYuan":"450000.00","totalYuan":"5450000.00","contractNo":"HT-001","confidence":"high","missing":[]}

[PASS] 合同/发票字段抽取可用。
```

端到端实测（任务「票面字段抽取闭环」）：上传合同/发票 txt 后 Agent 调用链
`parse_uploaded_files → parse_contract → parse_invoice → match_contract_invoice → check_amount_consistency → generate_workpaper` 全部 True；
抽取字段与样张逐字一致（发票号码 08654321、金额 5,000,000.00、税额 450,000.00、价税合计 5,450,000.00；合同编号 HT-001、金额 12,000,000.00），合同-发票差异 7,000,000.00 正确进入待核查并触发 waiting_review。

## 确定性关联关系图与打印页眉（2026-09-28）

新增 `render_matching_diagram`（土增智填）：读取本任务最近一次 match_contract_invoice / match_invoice_ledger 结果，确定性生成 mermaid 源码（合同→发票实线边带差异金额标签、发票→账面记录虚线边、未匹配/差异节点琥珀虚线 classDef）；提示词要求结论原样嵌入、禁止手画。`pnpm verify:diagram` 七项断言全过。

端到端实测（任务「关系图工具嵌入验证」）：Agent 调用 `render_matching_diagram:True` 后，结论中的 mermaid 与工具输出逐字一致（CHT001/IFP001/IFP002/CHT002/IFP003 节点、`-->|差异 100000.00|` 边标签、classDef pending）。

打印导出新增页眉块（仅打印可见）：平台名 + 任务标题 + 案例号 + 状态 + 打印时间，交付纸张自带标识。

## 联网检索可信度加固与引用证据力分级（2026-09-29）

问题实证：回放库里 6 次 `search_public_cases` 调用的落库结果，35 条结果只有 7 条与检索词相关——检索「土地增值税清算 建安成本 合同金额与发票金额不一致」返回的是「土地（自然经济综合体）_百度百科」「自然资源部首页」「中华人民共和国国情」，检索「研发费用加计扣除」返回「研发_百度百科」「MBA 智库百科-研发」。这些地址已顺着工具结果进入 4 个任务结论的联网引用：29 条引用中 19 条是门户首页或百科词条，等于「拿百科词条当政策依据」，交付材料可信度被直接拉低。

检索层（`packages/business-tools/src/web-search.ts`）：

- 词元切分：中文按二元组、ASCII 与数字按整词，虚词不计；
- 相关度门槛：命中词元数低于门槛（默认 2，`TAXAI_SEARCH_MIN_RELEVANCE` 可调）即丢弃，政府与税务机关域名放宽一档；标题、摘要、百分号解码后的 URL 任一命中即算；
- 入口页过滤：站点首页、单级栏目页、`index/main/login/search` 一类地址一律丢弃（没有具体文件内容，引用等于没有依据），重复地址去重，保留结果按命中数降序；
- 验证页识别：`百度安全验证`、`unusual traffic`、`请输入验证码` 等判为该引擎不可用并降级下一引擎；
- 如实回报：`searchWebDetailed` 逐引擎记录尝试（`ok / irrelevant / empty / blocked / error` + fetched/kept/dropped + HTTP 状态），工具文本在没有可用结果时逐引擎说明原因并明确要求「不得据此编造政策口径」，`details.attempts` 一并落库。

本机实测（2026-09-29）：检索「财税〔2015〕119号 研发费用加计扣除 政策原文」→ Bing 返回 8 条全部与检索词无关（已过滤）、百度触发安全验证，工具如实回报「可用 0 条」而不是把无关网页塞给模型。历史数据回放：6 次调用 35 条 → 过滤后 7 条（其中入口页 14 条被丢弃）。

引用层（`apps/web/src/citation-grade.ts`）：每条联网引用按证据力分为官方原文（政府/税务机关站点的具体文件页）/ 专业来源（机构或社区的具体文章页）/ 证据力弱（门户首页、百科词条、检索结果页、地址无法解析）。弱证据在引用胶囊上转琥珀色并给出判定理由，进入交付自检提醒（「N 条联网引用指向门户首页、百科词条或检索结果页，证据力不足，交付前请替换为政策原文的具体文件页」）、整页 MD 的「联网引用」节与 `manifest.json` 的 `citationGrades` 汇总；manifest 自校验新增四条不变量（分级四类之和等于总数、总数等于引用条数、有引用必须有汇总、分级取值合法）。真实任务走查：29 条引用 → 官方 4 / 专业 6 / 证据力弱 19。

口径一致性：检索层与引用层是两套实现（Node 工具 / 浏览器纯函数），`pnpm verify:citegrade` 用同一批真实地址交叉断言 `isEntryUrl === isEntryPage`、`isEncyclopediaUrl` 一致、`isOfficialUrl === isAuthoritativeUrl`，防止两处规则漂移。

新增验证：`pnpm verify:websearch`（41 项，含历史数据回放与实网冒烟不变量：保留项必定过门槛）、`pnpm verify:citegrade`（89 项）；`verify:dcheck` 扩到 73 项、`verify:manifest` 扩到 42 项（真实走查改为按前端同一口径从工具结果提取引用并分级，不再固定传 0 条）。两项已并入 `pnpm qa:all`（现 29 项 verify）。

## 联网检索留痕与引用提取统一（2026-09-29）

两个口径问题：其一，引用清单只从 `result.results` 取地址，而社区扩展 `fetch_content` 落库的形状是 `{urls:[...], title}`——Agent 真正读过的政策法规库原文页（如 `fgk.chinatax.gov.cn/zcfgk/...`）根本没进联网引用，最有证据力的那一条反而看不见；其二，`web_search` 只写回 `queries / queryCount / totalResults / searchId / providers`（实测 0 个 http 地址），任务明明检索过，界面与交付自检却报「无联网引用，请确认是否已完成在线核验」，把「证据没留存」误报成「没有核验」。

新增 `apps/web/src/search-evidence.ts`（纯函数，浏览器可用）统一提取口径：`urlsOfCall` 覆盖 `results[]`（自建检索）、`url + title`（fetch_public_document）、`urls[] + title`（fetch_content，多地址时标题不可归属则退回用地址）三种形状，只接受 http/https；`queriesOfCall` 收集 `query` / `queries` / `queryProviders[].providers`；`extractCitations` 按 URL 去重、上限 20 条并记录来源工具 `via`；`searchEvidence` 输出 `calls / withUrls / metadataOnly / reportedResults / queries / providers / tools`；`searchEvidenceNote` 只在「检索过且全部只留元数据且没有引用清单」时给出如实说明与补救动作。前端引用清单、整页 MD、manifest 与验证脚本共用这一份实现，`verify-manifest` 里原先自己写的一套提取逻辑已删除。

界面与交付：结果页在有引用时增加「检索 N 次 · 仅元数据 M 次」徽章（悬停看工具、provider、自报命中数与前 6 条检索词）；没有引用但检索过时时改为独立的「联网检索留痕」小节，正文如实说明并给出补救建议，不再显示空的引用区；时间线结论行的「无联网引用」改为「联网检索已执行，扩展未留存来源清单」。交付自检三分支：有引用 → ok（另有元数据检索时追加 info）、检索过但无清单 → info（含次数与自报命中数）、完全没检索 → 仍是 warn。manifest 新增 `searches` 与 citations 的 `via` 字段，自校验新增 5 条不变量（两类之和等于调用数、有检索必须有工具名、有引用必须有留下来源的调用、有引用必须有留痕汇总、引用必须有来源工具）。

真实数据效果（24 个任务）：用过联网检索 12 个；引用清单 29 条 → 40 条，其中政府/税务机关站点 4 条 → 23 条；带引用的任务 4 个 → 7 个；只留元数据的检索 19 次现在都有如实说明而不是被当成「没核验」。

新增验证：`pnpm verify:searchev`（103 项：三种结果形状 / 非 http 与相对地址拒绝 / 去重与上限 / 来源工具 / 检索词与 provider 去重与 12 条上限 / 说明的触发条件与内容 / 24 个真实任务走查断言「留存过的 URL 必定进入清单」）；`verify:dcheck` 扩到 78 项、`verify:manifest` 扩到 71 项。已并入 `pnpm qa:all`（现 30 项 verify）。

## Bing 改用 RSS 取数与相关度门槛自适应（2026-09-29 第二轮）

定位过程中发现检索层的根因不止「解析不够严」：本机 Bing HTML 结果页返回的条目与检索词完全无关——检索「财税〔2015〕119号 研发费用加计扣除」时页面 `<title>` 正确、正文含「119」「研发费用」，但 10 个 `b_algo` 块的标题是「抖音」「双人成行」「含羞草」「115 网盘」「腾讯企业邮箱」，且每次刷新都不同；同一检索词改走 RSS 输出（`&format=rss`）返回的却是真实对应结果（研发费用加计扣除政策执行指引 2.0 版，来自 most.gov.cn 与上海/天津税务）。因此 `fetchEngine` 对 Bing 先取 RSS（XML 结构稳定，不受推荐位、广告位与页面改版干扰），RSS 失败或为空时退回 HTML 解析，`SearchAttempt.via` 记录本次用的是 RSS 还是 HTML，随工具结果落库。

相关度门槛同时改为随检索词长度自适应（`relevanceThreshold`）：普通站点取词元数的 20%、政府与税务机关站点取 12%，并分别不低于 `TAXAI_SEARCH_MIN_RELEVANCE`（默认 2）与 1。原因是固定门槛对长检索词太松——实测检索「土地增值税清算 建筑安装工程费 扣除口径 国家税务总局公告2017年第40号」时，RSS 返回的「中华人民共和国土地管理法」「土地管理法实施条例」只命中「土地」一个词元，却因为落在 gov.cn 被放宽放行，等于把同名法规当成土增清算依据。改为比例门槛后这 4 条被正确过滤（该检索词如实回报「可用 0 条」），而「研发费用加计扣除 政策执行指引」仍保留 9 条官方原文（命中 12 个词元）。历史数据回放相应从「35 条 → 7 条」收紧到「35 条 → 2 条」。

`pnpm verify:websearch` 扩到 52 项：新增 RSS 解析（CDATA、空链接条目跳过、引擎标记、解析结果同样接受相关度过滤）、门槛自适应（短检索词不低于设定值 / 长检索词按比例提高 / 权威域名低于普通站点 / 空检索词为 0 / 至少 1）、同一条百科结果在短检索词下保留而在长检索词下被过滤、实网冒烟增加「取数方式只能是 RSS 或 HTML」。

## 政策文号联网复查闭环（2026-09-29）

「无法核验」此前是个死标签：联网检索扩展只留元数据，文号既证不实也证不伪，交付自检只能给一句建议。现在它变成可执行、可留痕的动作。

新增 `apps/web/src/ref-check.ts`（纯函数，服务端与验证脚本共用同一份实现）：`refPrefix` 从上下文里取出文号前面的发文机关并裁掉「按 / 根据 / 依据」一类前导虚词（实测「按国税函〔2010〕220 号」→「国税函」，「国家税务总局公告2017年第40号」的前缀原样保留）；`contextKeywords` 取裁掉虚词后最长的一段中文（≥4 字）作补充关键词，条款项一类有意义的名词不裁；`refQueryVariants` 给出两种检索词——「发文机关 + 文号 + 关键词」与去掉内部空格的紧凑写法（「国税发〔2006〕187 号 …」→「国税发〔2006〕187号」）。`gradeRefCheck` 四级判定：标题或摘要里确实出现归一化后的文号才算 matched；检索到相关页面但没出现文号只给 candidate，不把候选当依据；引擎正常但结果全被过滤是 empty；全部引擎请求失败才是 error。

服务端 `apps/api/src/services/ref-checks.ts` 逐条复查并落库（新表 `ref_checks`，主键 task_id + ref_key，同一文号覆盖为最新一次），检索实现通过参数注入以便离线验证；第一种检索词空手而归时自动换紧凑写法再查，记录里保存「得出结论所用的检索词」、逐引擎尝试过程（含 RSS / HTML 取数方式）与证据的标题、地址、摘要、证据力分级（分级理由读取时按同一口径重算，不存两份可能不一致的文案）。路由 `GET / POST /api/tasks/:id/ref-checks`：单次上限 10 条，主键由服务端计算而不信任客户端传入，复查写入 `agent_status` 事件留痕，交付包因此自动提示重新打包。开发库缺列由 `db.ts` 新增的 `ensureColumn` 轻量补齐（`CREATE TABLE IF NOT EXISTS` 不会改动已建好的表，本次就撞上了这个坑）。

界面：结论要点区的「文号溯源」徽章由 span 改为按钮，点开复查面板——待复查条数、四级汇总与最近复查时间、逐条文号（上下文 + 判定徽章 + 证据按钮 + 单条「复查 / 重新复查」），证据点按直接在侧边阅读器打开；徽章配色改由「复查后仍没有出处的处数」驱动，全部查到出处即转翠绿。交付自检：已复查到公开出处的「待人工确认」由 warn 降为 info，另加 matched（ok）、candidate（info）、empty + error（info）三条独立条目。整页 MD 的「政策文号溯源」节新增复查统计与复查表（文号 / 判定 / 检索词 / 证据链接）与逐条判定说明；`manifest.json` 新增 `refChecks` 汇总与两条不变量（四类之和等于总数、有复查必须有时间）。

真实数据实测（任务 eb75f4fb，土增清算）：3 处「无法核验」文号，第一种检索词（带上下文关键词）在 Bing RSS 只返回税务门户首页、百度触发安全验证，自动换紧凑写法后 3 处全部 matched——国税函〔2010〕220 号、国税发〔2006〕187 号、国税发〔2009〕91 号分别命中税屋（shui5.cn）的原文页，证据链接可直接点开核对。全库 8 个任务共 21 处文号待复查。

新增验证：`pnpm verify:refcheck`（83 项：发文机关前缀与虚词裁剪 / 检索词两种候选与去重 / 四级判定含归一化后不同写法命中与「候选不当依据」/ 请求体规范化与服务端算主键 / 假检索器跑通落库往返、覆盖与异常 / 换写法重试的留痕 / 真实任务走查断言主键与判定自洽）；`verify:dcheck` 扩到 86 项、`verify:manifest` 扩到 122 项（真实走查改为读取已落库的复查记录并校验四类之和与待处理数不增）。已并入 `pnpm qa:all`（现 31 项 verify）。

## 平台看板增加「全平台证据缺口条」（2026-09-29）

证据口径此前只落在单个任务的结果页与交付材料里，平台层面看不出欠账。现在 `computePlatformStats` 增加 `evidence` 一节，直接复用前端那套纯函数（`extractCitations` / `summarizeGrades` / `searchEvidence` / `searchFiltering` / `traceDocRefs` / `summarizeRefChecks`），保证看板、结果页、整页 MD 与 manifest 出自同一份实现，不会出现两处数字对不上。

口径包括：检索调用数与其中「留下来源 / 只留查询元数据」两类、检索留下并可引用的来源数、被过滤掉的无关结果与门户首页数、引用总数与官方原文 / 证据力弱条数、政策文号总数与「有出处（工具留存结果或联网复查记录，其中复查取得的单独给出）/ 仍无出处 / 复查判定 matched」，以及仍有缺口的任务清单（弱引用或待复查文号大于 0，按缺口大小倒序）。

其中「拦下多少条无关结果」有个诚实性问题：相关度过滤上线前的历史检索记录没有落库 `dropped`，直接统计会是 0，看起来像过滤没起作用。因此拆成两个字段——`searchDropped`（新记录落库的实时拦截数）与 `searchDroppedReplay`（历史记录按现行规则回算会被拦下的条数），界面在实时数为 0 时明确标注「历史记录按现行相关度规则回算」，不把回算说成实时拦截。

界面：平台效果带在复核闭环缺口条之后增加证据缺口条，按作品分组列出缺口任务（`标题 · 弱N · 文号M`），点击直达结果页（引用胶囊看证据力、文号徽章可一键联网复查）；无缺口时转为翠绿并给出正向口径。

实测当前全平台数字：检索 31 次（留来源 12 / 仅元数据 19）· 引用 40 条（官方 9 · 弱 25）· 拦下 33 条（当前全部来自历史回算）· 文号 31 处（可溯源 10 · 待复查 18 · 已复查到公开出处 3）· 缺口任务 10 个。

`pnpm verify:stats` 从 16 项扩到 31 项：检索调用数与 SQL 独立聚合一致、两类之和等于调用数、复查到出处数与 `ref_checks` 表 SQL 计数一致、引用/官方/弱证据不超过总数、文号可溯源与待复查不超过总数、缺口任务都确有缺口且按缺口倒序且都属于本平台、回算数只在存在「未落库 dropped 的历史记录」时才非零。`verify:dcheck` 现为 88 项（新增「全部复查到出处后不再建议改用快照」与「未复查时仍建议改用快照或联网复查」两条文案断言）。

### 缺口条一键批量复查

看板能看见缺口还得能处理，因此补了跨任务批量入口 `POST /api/tasks/ref-checks-batch`：待复查清单由服务端按任务重新计算（`pendingRefTargets`，与结果页面板同一口径，不信任前端传清单），`planBatchRefChecks` 按候选顺序切分预算（默认 12 处、硬上限 30，没有待办的任务不进计划也不占预算），逐个任务复查并各自写入 `agent_status` 事件留痕，返回逐任务的四级计数。前端沿用「批量转为待复核」的两步确认交互，复查完自动刷新平台统计，缺口条数字随之更新。

实测一次点按（预算 12 处，覆盖 4 个任务）：12 处全部完成，**找到公开出处 9 处、候选待确认 1 处、未检索到 2 处**；平台口径随即从「待复查 18 · 已复查到出处 3 · 缺口任务 10」变为「待复查 12 · 已复查到出处 9 · 缺口任务 9」。

`pnpm verify:refcheck` 扩到 133 项：新增批量计划的预算切分（跳过无待办任务 / 顺序切分 / 预算 0 与负数 / 硬上限截断 / 保留标题），以及真实任务走查中「服务端 `pendingRefTargets` 的清单条数与主键顺序必须与前端口径逐条一致」。

## 弱证据引用一键找官方原文（2026-09-29）

证据分级的另一半：标出「证据力弱」只是指出问题，还得给出可执行的补救。现在结果页的联网引用区在存在弱证据时多出一块「弱证据引用找官方原文」，一键为这些条目检索替代来源，复用文号复查同一条落库通道（`kind = "citation"`）。

检索词构造是关键：百科词条的标题往往只有一两个词（「研发_百度百科」「中华人民共和国国情」），单独拿去检索命不中任何有用页面。因此检索词 = 去掉站点后缀的标题（`stripSiteSuffix`）+ 结论里出现最多的领域词，并把这条引用自身作为 `excludeUrl` 排除，避免「找到自己当作替代来源」。领域词表抽到新的 `apps/web/src/domain-keywords.ts`，与结论要点区的关键词芯片共用同一份（`topDomainWords` / `topicHint`），服务端从任务结论重算补充词而不信任前端传词。检索词候选同样是两条：带领域词的完整式，拿不到结果再退回只用清理后的标题。

判定沿用四级但口径按引用改写：找到政府或税务机关站点的具体文件页记 `matched`（说明「可替换原弱证据引用」）；只有专业文章时记 `candidate`；只检索到同类门户首页或百科词条时记 `empty` 而不是把另一条弱证据当候选——换一条同样没有证据力的链接没有意义。交付自检只在当前确实还有弱证据引用时才谈替代来源（替换完成后这条说明自然消失），且弱证据的 warn 不因找到替代来源而消失：人工替换并重新打包之前，结论里挂着的仍然是那条弱证据。整页 MD 的「联网引用」节附替代来源表，`manifest.json` 新增 `citationChecks` 汇总与两条不变量。界面上明确写着「替代来源需人工确认后写回结论并重新打包，平台不会自动改写 Agent 的结论」。

实测（任务 4bb22d34「缺失资料联网检索与图表输出验证」，3 条弱证据引用）：`研发_百度百科` 与 `研发 - MBA智库百科` 均命中科技部《研发费用加计扣除政策执行指引（2.0 版）》PDF（`most.gov.cn/xxgk/.../P020250926369462261750.pdf`），`中华人民共和国国情` 如实回报未找到（Bing RSS 10 条结果与检索词无关、百度触发安全验证，两种检索词都试过）。

落库结构补了一列 `subject_url`（由 `ensureColumn` 对已建好的开发库补列）：引用类复查的主键按原地址计算，如果记录里不留原地址，落库之后既无法自校验主键，也无法在交付材料里回溯「替换的是哪一条引用」。整页 MD 的替代来源表因此同时给出原标题与原地址。

`pnpm verify:refcheck` 扩到 170 项：只挑弱证据、主键用地址而非标题、领域补充词与排除地址、检索词两种候选、上限截断、找到官方页判 matched、排除自身后只剩原页面判 empty、只剩同类百科不算候选、专业文章作为候选、`toTargets` 对引用条目的主键/补充词优先级/非法地址/同地址去重、引用复查的原地址落库往返与主键自校验、真实走查按 kind 分别校验主键（文号按文本、引用按原地址）并要求引用类记录必须带原地址。`verify:dcheck` 扩到 93 项（替代来源只作说明、弱证据在人工替换前仍是提醒、只有候选页与全部未找到的文案、当前无弱证据时不产生替代来源条目）、`verify:manifest` 扩到 155 项（`citationChecks` 两条不变量，真实走查按 kind 分别汇总文号与引用复查记录，并逐条校验主键可由落库字段推回）。

### 平台层批量找替代来源与补救进度可见

任务层入口之外，证据缺口条上现在有「批量复查文号」与「批量找替代来源」两个批量入口：`POST /api/tasks/ref-checks-batch` 增加 `kinds` 参数（`docref` / `citation`，缺省只复查文号），待办清单分别由 `pendingRefTargets` 与新增的 `pendingCitationTargets` 在服务端按任务重算——引用提取走 `extractCitations`、分级走 `gradeCitation`、领域补充词走 `topicHint(结论)`，与结果页完全同一口径，同一预算下文号优先（政策依据比引用替换更影响结论成立与否）。交互仍是两步确认，单次默认 12 项、硬上限 30，逐任务落库并写事件留痕；确认文案写明「共 N 条，单次按预算分批」，不让人以为一次能跑完。

批量点完看板必须有反馈，否则看不出补救进度：`evidence` 增加 `weakWithReplacement`——当前仍判为弱证据、但已经检索到 matched 替代来源的条数（按 `refKey("citation", url)` 与落库记录对齐），缺口条上显示为「其中 N 条已找到官方替代来源、待人工写回结论」。结论没改之前这些引用仍然算弱证据、仍然进交付自检提醒，看板只是把「补救已就绪」显性化，不提前把问题算作已解决。

实测一次点按（预算 12 条，覆盖 4 个任务）：12 条弱证据引用中 **11 条找到官方原文替代来源**、1 条给出专业来源候选；平台口径随即显示「引用 40 条（官方 9 · 弱 25，其中 12 条已找到替代来源）」（含此前任务层检索的 1 条）。

`pnpm verify:refcheck` 扩到 236 项（真实走查新增：服务端 `pendingCitationTargets` 的条数、主键与领域补充词必须与前端口径逐条一致，且每条目标自洽——kind 为 citation、主键可由原地址推出、原地址是 http(s)）；`verify:stats` 扩到 33 项（`weakWithReplacement` 不超过弱证据条数、不超过落库的 matched 引用记录数，文号 matched 的 SQL 交叉核对排除引用类记录）；`verify:manifest` 扩到 177 项。

### 修订指令：把复查结果写回结论

找到替代来源只是中间态，结论里挂着的仍然是那条百科链接。因此补上最后一环：`buildRevisionInstruction`（`apps/web/src/ref-check.ts`）把复查记录整理成一条可直接提交的续跑指令，分三段——【补文号出处】（matched 的文号 → 公开原文标题、URL、检索时间）、【替换弱证据引用】（原标题与原地址 → 官方原文）、【标注未取得原文】（candidate / empty 的项目，要求在结论中写明「未取得公开原文，仅作背景参考，不作为政策依据」，候选页标注需人工确认）。指令开头限定「只改依据与引用部分，不要改动金额、测算过程、差异认定与结论意见」，结尾三条要求：重新输出完整结论（保留原有表格与 mermaid 图）、每条引用给出标题 URL 与检索时间、不得新增未经工具计算或联网核验的口径文号与金额。

`toRevisionItems` 先做两道过滤：`error`（检索失败）不进指令——重试即可，不该让模型据此改结论；素材只取与**当前**结论对得上的记录（文号 key 在本轮待复查清单里、引用 key 在本轮弱证据清单里），避免上一版结论留下的复查记录被写进指令。界面上「生成修订指令（N）」按钮同时出现在文号复查面板与弱证据引用块，点按只把指令填进「续跑任务」输入框并展开面板，由税务师核对后提交——平台不自动改写 Agent 的结论，修订过程留在会话历史与事件记录里。

真实数据实测（任务 4bb22d34）：3 条复查记录生成 2 段指令——2 条百科引用替换为科技部《研发费用加计扣除 政策执行指引（2.0 版）》PDF（各自带检索时间），1 条「中华人民共和国国情」进入【标注未取得原文】段。

`pnpm verify:refcheck` 扩到 250 项：检索失败不进素材、文号类排在引用类之前、素材计数、空素材返回空指令、指令限定只改依据与引用、三段各自出现且内容正确（含原地址与检索时间）、只有未解决项时不出现替换段、只有替换项时不出现未取得原文段、候选页标注需人工确认、要求段含「重新输出完整结论」与「不得新增未经工具计算或联网核验」。

## 联网引用清单覆盖结论正文（2026-09-29）

做修订指令时发现一个更大的漏洞：引用清单只从工具结果提取，而结论正文里直接写出的地址一条都没进清单。实测 24 个任务：结论正文里有 50 条 URL，只有 18 条同时出现在工具留存里，**32 条完全没被覆盖**，而漏掉的恰恰是最该核验的官方原文——`fgk.chinatax.gov.cn/zcfgk/...`（政策法规库）、`guangdong.chinatax.gov.cn/...`（地方税务），它们由政策快照工具给出或由模型直接写进正文，都不在 `search_public_cases` / `fetch_content` 的落库结果里。后果是这些地址既不进链接核验、也不进证据力分级，交付材料的「联网引用 N 条」严重低估了官方依据。

`search-evidence.ts` 增加 `extractTextCitations`（markdown 链接优先取链接文字作标题；裸链接用 `labelFromUrl` 兜底——末段是有意义的文件名就用它，`index/content/main/t469200` 一类无意义末段退回域名；去掉结尾的中英文标点与括号；按 URL 去重）与 `mergeCitations`（工具留存优先、按 URL 去重、合并上限 24 条），来源标记写在 `via`（工具名或 `conclusion`）。任务结果页、平台看板、整页 MD、manifest 与验证脚本全部改用合并后的清单，界面胶囊悬停显示「来源：工具留存（工具名）/ 结论正文引用」。

口径连带修正（旧的不变量在合并后不再成立，逐条改成按来源区分）：manifest 的「有引用必须有检索留痕」「有引用必须有留下来源的检索调用」两条，改为只对 `via !== "conclusion"` 的引用生效；`PlatformStats.evidence` 增加 `citationsFromTools` / `citationsFromConclusion`（两者之和等于 citations），看板显示拆分，验证脚本改为断言「工具留存的引用不多于检索留下的来源数」；交付自检新增一条 info——任务没有任何联网检索调用却仍有引用时，如实说明「引用取自结论正文，请用核验链接确认可达性并核对依据来源」，不把正文里的地址当作已联网核验。

效果（同一批真实数据）：引用清单 40 → 72 条，其中政府与税务机关站点 **9 → 46 条**，带引用的任务 7 → 10 个；平台看板显示「工具留存 40 + 结论正文 32」。`verify:searchev` 扩到 169 项（markdown 链接取标题、裸链接域名兜底与文件名标签、结尾句读与全角括号清理、去重、markdown 优先于裸链接、表格内链接、非 http 不取、上限、合并去重与来源标记、合并上限，真实走查新增「结论正文里的每条 URL 都必须进入合并后的清单」）；`verify:stats` 扩到 35 项、`verify:dcheck` 扩到 95 项、`verify:manifest` 177 项（走查改为按合并口径组装清单）。

## 修订前后的证据对比（2026-09-29）

修订指令让 Agent 重写依据之后，还得能核对结果：这次修订到底把证据质量改好了没有。新增 `apps/web/src/revision-impact.ts`——`evidenceSnapshot(text)` 用与界面同一套纯函数算出一段结论的证据快照（结论正文里的引用地址按证据力分级 + 政策文号按核心去重），`evidenceDelta(before, after)` 给出四项差值与总体判断，`deltaText` 输出一行可读结论，结果页与整页交付 MD 共用同一份实现。

口径上有两个刻意的选择。其一，只比结论正文、不比工具留存：工具结果是跨运行累积的（后一次运行能看到前一次的结果），拿它对比会把「越攒越多」当成证据变好。其二，总体判断只看弱证据与官方原文两项——第一版把 `unchanged` 定义成「四项全部持平」，真实数据立刻暴露空档：任务 17a56468 只多了一条专业来源引用，弱证据与官方原文都没变，结果 improved / regressed / unchanged 三种判断全为假，界面没有任何结论可显示。改为 `unchanged = !improved && !regressed` 后三种判断穷尽，引用合计与文号数的变化仍在明细里如实给出。

走查还纠正了一个容易踩的坑：事件表里的 `agent_text` 存的是过程播报（「我先解析上传资料并检查模板结构」一类，74 条、最长 359 字），真正的结论在 13781 条 `agent_text_delta` 里。因此验证脚本按前端 `useTaskEvents` 同样的规则重组每次运行的结论（delta 累积、遇到 `agent_text` 收口），而不是直接读 `agent_text.message`；并断言重组出的最新结论与 `tasks.result` 一致。

另一个由测试暴露出来的正确行为：把百科链接的地址换成政策法规库、但链接文字仍写「研发_百度百科」时，分级仍判为弱证据——因为 `isEncyclopediaUrl` 有标题兜底。这是对的（标题还在声称自己是百科词条），已固化为断言，避免以后被当成 bug 改掉。

界面：结果页在「结论较上次运行变化」之后增加「本次修订对证据的影响」卡片（改善转翠绿、退步转琥珀、持平与有增有减为中性色），卡片里写明对比口径；整页交付 MD 的「联网引用」节开头写入同一行与口径说明。

实测（24 个任务中 20 个有可对比的两轮结论）：改善 4 · 退步 0 · 持平 15 · 有增有减 1。新增 `pnpm verify:revimpact` 185 项：快照口径（分级之和等于引用数、空文本、无链接文本只算文号）、差值算术与四种总体判断、只换地址不换标题仍判弱证据、引用数变化但质量持平时的判断、数字格式（正数带加号、零不加符号），以及真实续跑走查（按事件流重组结论、四项差值与快照一致、三种判断至少一种成立、快照自洽、重组结论与 `tasks.result` 一致）。已并入 `pnpm qa:all`（现 32 项 verify）。

## 交付自检接入修订影响 + 看板证据指标环比（2026-09-29）

修订效果算出来之后还有两个下游缺口：改坏了没人拦，改善了也看不出趋势。

其一，交付自检新增 `revision` 输入（本次修订的四项差值与 improved / regressed）：退步（弱证据引用增加或官方原文减少）给 warn「本次修订让证据质量退步（弱证据引用 +N · 官方原文 −M），请核对修订内容后再交付」，有增有减给 info，改善给 ok，质量持平或没有可对比的上一轮结论时不产生条目。`manifest.json` 记录修订前后两个完整快照与总体判断，并新增自校验：判断必须能由前后快照重新推出（`deltaVerdict(evidenceDelta(before, after))`），两份快照各自的分级之和必须等于引用数、计数不得为负——避免交付包里出现「判断说改善、数值说退步」的自相矛盾。

其二，看板的环比机制原本内联在组件里、只覆盖任务数 / 完成数 / 产物数三个指标，证据类指标既接不进去也没法验证。抽成 `apps/web/src/metric-trend.ts`：`recordSnapshot`（同一天重复打开取最新值、保留最近 60 天、不改动传入对象）、`baselineKey`（优先正好 7 天前，否则取该日之前最近一次；基线日之后的快照不算基线）、`deltas`（只算基线里也有的指标，老快照没有证据字段时不会算出假的巨大差值）、`trend` / `trendText` / `trendTitle`（方向按「越低越好 / 越高越好」判断，颜色跟着方向走而不是跟着正负号走）。KPI 与证据指标共用这一套，弱证据引用与待复查文号下降显示翠绿、上升显示琥珀，官方原文相反，提示里写明基线是哪一天的快照。

顺带把「按运行重组结论」的逻辑从验证脚本里提到 `apps/api/src/services/task-store.ts` 的 `listConclusions`：修订影响验证与交付清单走查共用一份，不再各写一套 delta 累积规则。

`pnpm verify:trend` 37 项（跨月与跨年回退、非法日期、同一天合并且不改动入参、按 keepDays 裁剪并保留最近的日子、四种基线选择、差值只算共有指标、八种方向判断、文案）；`verify:dcheck` 扩到 103 项（改善不降级、退步转提醒并含带符号差值、有增有减只作说明、持平与无可对比时不产生条目）；`verify:manifest` 扩到 205 项（修订影响判断与数值不符、快照不自洽、计数为负、null 不算问题；真实走查改为用 `listConclusions` 重组最后两轮结论算出修订影响后一并校验）。已并入 `pnpm qa:all`（现 33 项 verify）。

## 证据核对表：一页可签字的交付汇总（2026-09-29）

证据口径做到现在出现一个新问题：信息散在结论要点区徽章、联网引用区、检索留痕、复查面板、修订影响卡片与交付自检里，交付时要翻一整份 MD 才能回答「依据到底核过没有」。新增 `apps/web/src/evidence-sheet.ts`，把这些口径收成一页九项核对表：政策文号溯源、政策文号联网复查、联网引用证据力、弱证据替代来源检索、引用链接可达性、联网检索留痕、结论金额溯源、本次修订对证据的影响、交付自检。每项一句可核对的结论（如「有出处 10/31」「官方原文 32/40」「可访问 3/5」）加一句说明（三类计数、来源拆分、最近复查/核验时间与口径），表末是「交付前待办」分组清单（仍无出处的文号、待替换的弱证据引用、已失效链接，各列具体条目，超过 8 条写「等 N 项」）与核对人签字行。

界面渲染在结果页交付区末尾（表格 + 待办 + 签字行，随打印版式一起出纸），整页交付 MD 在「交付自检」之后插入同内容的「## 证据核对表」一节；两处共用 `evidenceSheetRows` / `evidenceSheetTodoGroups` / `evidenceSheetMarkdown`，待办分组也抽成共用函数，避免界面与 MD 各写一套分组与文案。空输入一律如实兜底而不是填占位数字：未复查 / 未检索 / 未核验 / 无检索调用 / 无可对比轮次 / 结论未出现金额，并在说明里写清下一步动作（例如「尚有 12 处没有出处，可在文号复查面板一键联网复查」）。

真实数据：24 个任务全部能生成核对表，其中 8 个仍有交付前待办。新增 `pnpm verify:sheet` 252 项：九项名称与顺序、每项都有结论与说明、逐项链路回输入数字（文号溯源、引用证据力、交付自检结论必须与输入一致）、八种空输入兜底文案、待办分组只列非空项与上限提示、MD 含表头/元信息/全部核对项/待办小节/签字行、表格单元格竖线转义（待办在表外故不转义但原样保留）、真实任务走查（核对项恒为 9、无空缺、结论可由输入推回、待办条数与分组一致、复查后仍无出处的处数不多于待办清单条数、MD 含全部核对项）。已并入 `pnpm qa:all`（现 34 项 verify）。

## 核对表单页导出与金额核对备注模板（2026-09-29）

核对表此前只随整页交付 MD 一起走，纸质归档要打印整份材料才能拿到这一页。新增 `evidenceSheetDocument`（H1 + 与 MD 节完全相同的正文），结果页核对表标题行加「下载核对表」与「复制」两个动作，导出文件名 `<任务标题>-证据核对表.md`。断言 `doc.slice(2)` 与 `evidenceSheetMarkdown(full)` 逐项相等，保证单页导出与整页 MD 里的那一节不会各写一份。

复核页「结论金额核对」的备注此前是自由输入，实际使用中最常见的结果是懒得写、留空——而备注是要进整页交付 MD 与交付包的核对依据。新增 `apps/web/src/amount-note.ts`：6 条常用核对依据模板（与辅助账一致 / 与底稿合计一致 / 与申报表一致 / 工具计算已复核 / 差异已列待核查 / 客户已说明），`composeNote` 点一下填入——空备注直接填、已有内容按中文分号追加、同一条已在备注里就不重复追加（反复点不会堆出同一句话）、兼容英文分号并统一为中文分号；`dropLastNoteSegment` 删掉最近一段用于回退误点；`noteIsMeaningful` 判断备注是否足以作为留痕（至少一段 ≥6 字），不满足时在输入框下方就地提示「备注会进整页交付 MD 与交付包，空着等于没有留痕」。

顺带把端口踩到的坑写进 `.env.example`：本机 5173 被另一个项目占用时，Vite 会自动换端口，但浏览器里的旧地址会打开别的应用（本次排查就是这样发现的），因此注明可固定 `WEB_PORT`，并说明 `/api` 代理始终指向 `API_PORT`、改端口不影响联调。

新增 `pnpm verify:amtnote` 26 项（模板数量与标签/文案唯一、每条模板本身就构成有效依据、模板不含分段符、标签短于文案；填入与追加 9 项含去重与英文分号归一；撤销 5 项含删空与删后重填；留痕有效性 6 项）；`verify:sheet` 扩到 257 项（单页文档以 H1 开头、正文与 MD 节逐项相等、含签字行/全部核对项/任务元信息）。已并入 `pnpm qa:all`（现 35 项 verify）。

补记（同日）：模板改为按作品给出（`amountNoteTemplates(agentId)`）。第一版把「与研发支出辅助账明细逐笔核对一致」放在通用清单第一条，土增智填的复核页也会显示研发口径的模板，属于口径串味——点一下就写进交付包留痕，不能给错。现在研发与土增各有专属第一条（研发支出辅助账明细 / 土地增值税清算底稿及合同发票台账），其余五条通用，未知作品与空 `agentId` 只给通用模板；`ReviewView` 增加 `agentId` 入参，由工作台传入当前作品。`pnpm verify:amtnote` 扩到 35 项：两个作品各自标签与文案唯一、专属模板排最前且贴合各自口径、通用部分两个作品逐项一致、未知作品不含专属模板。

## 全平台证据核对台账（可导出归档）

单任务的核对表解决了「这一份交付能不能签字」，但评委和事务所质控要问的是另一件事：整个平台上还有哪些欠账、分别欠在哪个任务。因此把九项口径按任务汇成一张台账，落在平台总览页（可折叠），并支持导出 MD / CSV 与一键复制。

实现分三层，避免口径各写一份：`apps/web/src/evidence-ledger.ts` 是纯函数层，定义 `LedgerRow`、表头 `LEDGER_COLUMNS` 与取值 `ledgerCells`（表头与取值分开定义但成对使用，MD 与 CSV 共用同一份列序，杜绝两份表对不上；列数一律以 `LEDGER_COLUMNS.length` 为准——验证脚本按列名取下标、生成的交付文档插值取数，增删列不会让文字与测试各说一套）；`rowGap = 弱证据引用 + 仍无出处的文号`，`ledgerSort` 按欠账倒序、再按作品与标题，保证同一批数据每次导出行序一致；`ledgerCsv` 带 UTF-8 BOM 且逐格走 `csvField` 转义，Excel 直接打开不乱码、含逗号与引号的标题不串列。数据层在 `apps/api/src/services/stats.ts`：沿用已有的逐任务循环顺手累积 `evidence.ledger`（累加器写成 `Omit<EvidenceStats, "ledger">`，让类型检查盯着新增字段不漏初始化），返回前统一 `ledgerSort`，实测 24 个任务 59ms，不额外查库。

交叉核对是这次的重点：台账每列求和后必须与平台统计的对应聚合逐项相等（`sum(citations) === evidence.citations`、`withGaps === evidence.gaps.length` 等），否则就是「看板一个数、台账另一个数」，评审现场最容易被问倒。新增 `pnpm verify:ledger` 62 项：固定夹具校验合计（`[9,3,15,30,6]`）、排序稳定性、CSV 合计行文案（`合计（2 个任务）`）与转义、MD 表格行数与列数、空台账如实兜底，再对 24 个真实任务走查一遍与 `computePlatformStats()` 的一致性。已并入 `pnpm qa:all`（现 36 项 verify）。

真实数据下台账给出：24 行、欠账任务 9 个、文号 10/31 有出处、引用 72 条（官方 32、证据力弱 25）、金额待确认 11 处。这些数字不好看，但和核对表一样按「如实兜底、不填占位数字」的口径呈现——台账导出后就是整改清单，每行都能点「打开任务」跳回原始证据。

## 录屏分镜表：深链端口与时长文案两处修正

启动项目时发现浏览器里开着的 `http://127.0.0.1:5173/` 不是本项目，而是本机另一个 Next.js 应用——5173 被占用后 Vite 自动换到 5174，而分镜表里的深链是生成时写死的 `127.0.0.1:5173`。这意味着按分镜表录屏，粘贴深链会打开别人的应用，属于会直接毁掉一份交付材料的错误。修正分三步：`vite.config.ts` 改用 `loadEnv` 显式读取（`defineConfig` 求值那一刻 Vite 还没加载 `.env`，原先直接写 `process.env.WEB_PORT` 在只放了 `.env` 文件的情况下读不到），读取顺序为真实环境变量 > `apps/web/.env` > 仓库根 `.env`；`gen-demo-script.ts` 用同一套顺序解析出 `BASE`，所有深链由它拼接；生成器出稿前自检——文档里出现的每个 `127.0.0.1:端口` 都必须等于解析出的端口，否则直接抛错不出稿。本机已放 `apps/web/.env`（`WEB_PORT=5174`，`.env` 不入版本库），重新生成后 11 幕深链全部为 5174，文档内已无 5173。

时长文案另有一处算术错误：`Math.ceil(total / 60)` 分 + `total % 60` 秒，450 秒会被写成「8 分 30 秒」，看着超出附件4 的 8 分钟上限，实际是 7 分 30 秒；而同一行的 `total <= 480` 判定用的是真实秒数，于是出现「文案说 8 分 30、结论说符合要求」的自相矛盾。改为 `Math.floor` 并在文案里带上幕数，自检再把渲染出的「N 分 M 秒」换算回秒数与 `scenes` 合计比对，两者不一致同样抛错。

补一幕「交付留痕：核对表 / 备注模板 / 全平台台账」（30 秒），把这一轮新增的三个交付面串成一个镜头：平台总览展开台账并演示三个导出出口 → 任务结果页的证据核对表与「下载核对表 / 复制」→ 复核页按作品区分的备注模板与空备注提示。合计 11 幕 480 秒，正好压在 8 分钟上限内，`pnpm demo:script` 输出 `scenes=11 totalSeconds=480 missing=0`。

## 备注模板支持按作品自定义（存本机）

内置 6 条模板覆盖不了每个事务所自己的口径，而备注是要进交付包的留痕，写不顺就会有人干脆空着。因此在 `amount-note.ts` 里加了一层自定义模板：按作品分组存在浏览器 `localStorage`（键 `taxai.amountNote.custom.v1`），不进数据库、不参与统计、不影响其他人；复核页「结论金额核对」右上角「自定义模板」展开编辑区，标签与内容两个输入框，保存后胶囊立刻出现在同一行，编辑区里列出已有自定义模板并逐条可删。

规则都收在纯函数里，便于验证：`validateCustomTemplate` 拦下达到上限（每作品 8 条）、空标签、标签超过 8 字、空内容、内容少于 6 字（与 `noteIsMeaningful` 的留痕门槛一致）、内容含分号（分号是备注分段符，会把一句话拆成两段）、与已有标签同名、与已有内容重复，返回的每条文案都能直接显示给用户；`mergeTemplates` 固定「作品专属内置 → 自定义 → 通用」的顺序并按标签去重，同名时保留内置那条，保证每次点出来的胶囊顺序一致；`parseCustomStore` 对坏 JSON、顶层不是对象、条目缺字段、类型不对、标签过长、内容过短、含分隔符的情况只丢掉那一条并 trim，不会让一条脏数据把整个模板区弄没；`saveCustomTemplates` 在某作品清空后删掉该键、整份空了连键一起删，不在 localStorage 里留空壳，写入异常（隐私模式、配额满）只降级为本次会话有效。存储通过 `TemplateStorage` 接口注入，验证脚本用内存假件跑，不依赖浏览器。

`amountNoteTemplates(agentId)` 改为委托 `mergeTemplates(agentId)`，对外行为不变；`noteIsMeaningful` 的 6 字门槛统一引用 `TEXT_MIN`，避免两处各写一个数字。`pnpm verify:amtnote` 从 35 项扩到 85 项（新增存储解析 12 项、按作品读写往返 16 项、新增校验 10 项、合并与删除 12 项），前端 `ReviewView` 在 `agentId` 变化时重读一次并收起编辑区，避免换作品时看到上一个作品的模板。

## CSV 导出统一口径与公式注入防护

台账导出做完后回头数了一遍，全平台其实有三处 CSV：台账、底稿比对差异（`CompareView` 的「全部差异」与「当前筛选」两个入口）、任务清单（`Sidebar`）。三份转义各写一遍且不一致——台账那份处理了 `\r`，另两份只处理 `[",\n]`；三处都没有防公式注入。任务标题、底稿单元格都来自用户输入或客户上传的文件，以 `=`、`+`、`-`、`@` 或制表符开头时 Excel/WPS 会当公式执行（`=cmd|' /C calc'!A0` 一类 DDE 载荷），这种口子不能留在要交给客户与评委的导出件里。

收成 `apps/web/src/csv.ts`：`csvField` 先做注入防护（命中公式起头且整体不是纯数字时前置单引号；纯数字保留原样，否则合计与计数拿到表里变成文本、没法再求和），再做引号转义（含逗号、引号、LF、CR 时加引号并把引号翻倍）；`csvRow` / `csvBody` 统一用 CRLF（RFC 4180，Excel 与记事本对纯 LF 的分行处理并不一致），`CSV_BOM` 由下载侧前置。浏览器部分单独放 `csv-download.ts`，原因是 `apps/api` 的 tsconfig 不带 DOM lib，而验证脚本要直接 import `csv.ts`——把 `document` 关进一个文件，纯函数模块才能被 api 侧引用与验证（第一次没拆时 `pnpm -r typecheck` 就在 `apps/api` 上报了 `Cannot find name 'document'`）。三处调用方改为只给二维数据与文件名，`CompareView` 顺带把重复两遍的 `kind` 三元表达式换成已有的 `KIND_META` 标签；`Sidebar` 那份连 `\r` 都没处理的本地 `esc` 一并删掉。

`pnpm verify:csv` 55 项：基础转义 11（含 `null`/`undefined` 变空串、数字 `0` 不能被当成空）、注入防护 15（DDE 载荷、制表符与 CR 起头、纯负数与正号数字豁免、`--合计` 仍拦、前置引号与逗号/引号转义叠加、正文中间的等号不误伤、全角等号不误伤）、行与整篇 11（CRLF、字段内 LF 不算分行、每行列数一致、BOM 码位）、按 RFC 4180 解析回来的往返 6（含公式格解析后只多一个单引号）、调用方口径静态走查 12（三处不再各写一份转义、`csv.ts` 不碰 DOM、台账仍转出 `csvField` 与 `CSV_BOM` 以兼容既有导入）。`verify:ledger` 的 CSV 断言同步改按 `CSV_EOL` 分行并加一条 CRLF 检查，扩到 63 项。`qa:all` 现 37 项 verify。

## 下载实现收口：11 处 createObjectURL 变 1 处

顺着 CSV 这条线数了一遍，前端一共有 11 处各自手写「`Blob` → `createObjectURL` → `a[download]` → `click` → `revokeObjectURL`」：平台总览两处（文本下载助手 + 快照 Blob 下载）、比对视图两处 MD、复核记录一处 MD、mermaid 图一处 SVG、工作台五处（交付包 zip、通用 MD 下载助手、整页 MD、单次运行时间线 MD、全部时间线 MD）。六行代码抄十一遍，charset、BOM、有没有回收临时 URL 全靠抄的人记得——抄漏 charset 就是中文乱码，漏 `revokeObjectURL` 就是每次下载泄漏一个 blob URL。

收成 `apps/web/src/download.ts` 三个函数：`downloadBlob(blob, filename)` 存已构造好的 Blob（zip / JSON / SVG），`downloadText(filename, text, mime, bom)` 统一拼 `charset=utf-8` 并按需前置 BOM，`downloadCsv(filename, rows)` 走 `csvBody`。`downloadBlob` 的参数顺序沿用平台总览原有调用方（blob 在前），这样那四处调用点一行都不用改；`csv-download.ts` 并入后删除。仍然单独一个文件而不并进 `csv.ts`，理由同上：`apps/api` 的 tsconfig 没有 DOM lib，验证脚本要直接 import `csv.ts`。

防回归靠静态走查而不是靠自觉：`verify:csv` 扫 `apps/web/src/components` 下所有 `.ts`/`.tsx`，只要出现 `createObjectURL` 就失败（断言结果是空数组，新增组件抄一份立刻红），并核对 `download.ts` 里 `URL.createObjectURL(` 与 `URL.revokeObjectURL(` 各一处、成对出现。检查项从 55 增到 58。`pnpm -r typecheck`、`pnpm --filter @tax/web build` 通过。

## 答辩 PPT 大纲：写死的「7 项验证」与缺失的交付创新点

检查 PPT 大纲时发现第 9 页写着「自动化验证 7 项全部 PASS（见测试报告）」，而测试报告里实际是 37 项——答辩时评委对着两份材料就能看出矛盾。改成生成时从根 `package.json` 的 `qa:all` 里数 `pnpm verify:` 出现次数，数字随质量门自动走，不再需要人记得回来改。第 7 页画面注记同样写死「四条创新点」，改为按 `INNOVATIONS` 实际条数生成。

`materials-lib.ts` 的 `INNOVATIONS` 每个作品补第 5 条「交付可签字」：结果页一页证据核对表（九项口径 + 交付前待办 + 签字行），平台层一张全平台证据核对台账并可导出 MD/CSV，欠账逐项列明不填占位数字。这份常量同时被作品说明与 PPT 大纲使用，两处口径一次对齐。第 10 页「边界、合规与展望」补一条导出件合规：CSV 前置 BOM、防公式注入（标题或单元格以等号一类起头时不会在 Excel 里变成可执行公式），自定义备注模板只存本机浏览器。第 9 页另加一条台账要点，作为可现场复算的效果证据。

## 图表导出：补 PNG，文件名不再互相覆盖

结论里的 mermaid 图原先只有一个「下载 SVG」按钮，两个问题：一是文件名写死 `diagram.svg`，一段结论里有三张图就连下三次同名文件、互相覆盖；二是 SVG 在不少 Office/WPS 版本里插不进去，评委要拿图进答辩材料时没有退路。

现在每张图给「下载 PNG」和「下载 SVG」两个入口，文件名按序号与图类型生成（`图1-流程图.png`、`图2-时序图.svg`）。PNG 这条路不是把页面上的 SVG 直接画进 canvas：页面渲染开着 `htmlLabels`，标签是 `foreignObject` 里的 HTML，栅格化时不继承页面样式，容易掉字号甚至不显示。导出时用 `%%{init: {"flowchart":{"htmlLabels":false},"sequence":{"useMaxWidth":false}}}%%` 重新渲一份纯 `text` 标签的图，按 viewBox 的自然尺寸放大 2 倍画进 canvas，先铺 `#04070d` 背景（暗色主题放白底会看不见文字）再画图；原文已经带 init 指令时不覆盖，尊重作者写的配置。导出的 SVG 会离开平台进客户 PPT，因此统一过一遍脱敏：去掉 `script` 标签、`on*` 事件属性与 `javascript:` 链接，保留 `xmlns`、`viewBox`、样式与 `data-*` 属性。失败不静默——栅格化任何一步出错都在按钮上就地显示「PNG 导出失败，请改用 SVG」，3 秒后恢复，不让人以为下载成功了却没文件。

拆成两个模块沿用 CSV 那次的做法：`diagram-export.ts` 是不碰 DOM 的纯逻辑（`diagramKind` / `diagramFilename` / `withExportInit` / `svgSize` / `sanitizeSvgForExport` / `svgToDataUrl` 与两个常量），`diagram-download.ts` 只装栅格化与下载，`apps/api` 没有 DOM lib 也能验证纯逻辑那半。

`pnpm verify:diaexport` 77 项：15 种图类型识别（含 `stateDiagram-v2`、`xychart-beta`、`sankey-beta` 这类带后缀的）、认不出来只叫「图表」不猜、大写关键字不硬认、带 init 指令与 frontmatter 仍能识别；文件名序号与兜底（负数、NaN、小数取整）、三张图两两不同名、不含路径分隔符；导出指令是合法 JSON、重复调用不叠加；`svgSize` 从 viewBox 取尺寸（负偏移、逗号分隔、小数）、百分比宽度且无 viewBox 时如实返回 null 而不是猜一个数；脱敏 12 项（去脚本与事件、保留样式与文字、脱敏后尺寸仍可解析）；data URL 不含裸尖括号与井号。最后用 `docs/competition/*.md` 里的 4 个真实 mermaid 块走查：全部认得出类型、加导出指令后类型不变、文件名互不相同。`qa:all` 现 38 项 verify。

## 本地存储收口：32 处直接读写变一个入口

数了一遍，`apps/web/src` 里有 32 处直接读写 `localStorage`，散在 8 个文件、13 个键上。两个真问题：一是 `taxai-starred`（收藏）被侧栏与工作台各写一遍，两边各自 `JSON.parse` + `new Set` + 序列化，任何一边改了写法另一边就会把对方的数据抹掉；二是多数读取只做 `try/catch` 兜住解析异常，形状却直接用 `as` 断言过去——存进去一个旧版本或别的结构，界面拿到的就不是数组而是对象，后面 `.includes`/`.filter` 会在 render 里抛错，整页白屏。答辩现场最怕这种：不是功能没做，是打开就白。

新增 `apps/web/src/local-store.ts` 作为唯一入口：13 个键集中登记在 `KEYS`（备注模板那个键直接引用 `amount-note.ts` 的 `CUSTOM_NOTE_STORE_KEY`，不另写一份字符串）；`readJson(key, revive, fallback)` 一律带形状校验，解析失败或形状不对都回落，绝不把异常抛给调用方；`readEnum` 只接受白名单值，旧值与大小写不符一律回落（字号、比对筛选、阅读器分组、版式主题都用它）；`writeJson`/`writeRaw` 内部吞掉配额与隐私模式异常，并同步写一份内存镜像，存储不可用时本次会话行为仍然一致。`backing()` 走 `globalThis` 且只声明三个方法的结构化接口，不引 DOM 的 `Storage` 类型，因此 `apps/api`（tsconfig 无 DOM lib）能直接 import 验证——Node 里没有 `localStorage`，正好把降级路径一起测了。

跨组件共享的键给了领域访问器而不是裸读写：`readStarred`/`writeStarred`/`isStarred`/`toggleStarred`/`clearStarred` 与 `readTaskOrder`/`writeTaskOrder`（空清单用 remove 而不是写空数组，不留空壳）。工作台的状态改成 `setStarred(toggleStarred(task.id))`，以存储为准，不再出现「界面亮着、存储里没有」。`tags.ts`、`usePaperTheme.ts`、`Sidebar`、`SideReader`、`TaskWorkbench`、`AgentOverview`、`CompareView`、`ReviewView` 全部改为走这个入口，键名沿用原值，用户既有数据不作废。

`pnpm verify:localstore` 70 项：原始读写与删除、六个形状校验器（字符串数组剔除非字符串、字典拒绝数组与 null、排序方向只认 1/-1、快照剔除非有限数）、`readJson` 五种回落（缺失/空串/坏 JSON/形状不对/只留合规部分）、循环引用写入不抛错、`readEnum` 白名单、收藏的去重与两次翻转回到原状、脏数据与旧格式（对象）下收藏回落为空集合而不是抛错、排序空清单删键、标签往返与脏数据回落、键登记（值两两不同、都带 tax 前缀、四个沿用旧键名）。最后一段是静态走查：递归扫 `apps/web/src` 全部 46 个 `.ts`/`.tsx`，除 `local-store.ts` 外任何文件出现 `localStorage.` 或 `localStorage[` 即失败，`"taxai-starred"` 与 `"taxai-tags"` 的字面量也只准出现在入口文件里——新增组件想绕过就会当场红。`qa:all` 现 39 项 verify。

## 数字与单位的排版口径统一

这一轮先在浏览器里把平台总览整页读了一遍渲染结果，发现的问题都不是功能缺失而是口径不一致：同一张 KPI 卡里「50 %」带空格而「累计 60%」不带；同一个「工具成功率」在 hero 芯片是 94.64%、在作品卡是 94.6%（两处 `Math.round` 的精度不同）；上传提示写「单文件 ≤ 25.00 MB」；OCR 那格是「93 %·1次」，分隔点两侧没有空格；导出的快照 MD 与 TSV 在没有比对记录时会写出「—%」。

根因有两类。一是百分比各处自己算：`AgentOverview.tsx` 里有 6 处 `Math.round(... * 10000) / 100` 与 `Math.round(... * 1000) / 10`，精度不同、兜底也不同（`?? "—"` 后面又拼了个 `%`）。二是 KPI 卡把数值与单位放在两个 `span` 里、容器用 `gap-1`，这个 4px 对「24 个」是对的，对「50%」就多了个空格。

新增 `apps/web/src/format.ts` 收口：`percentOf(part, total, digits)` 返回数值，分母为 0、非有限数、分子为负时如实返回 `null`（不返回 0——「成功率 0%」与「没有调用」是两件事）；`percentValue` 给不带百分号的数值文案、`percentText` 给完整文案，两者在算不出来时都返回「—」而不是「—%」；`percentFrom` 处理后端已经算好的数值；`trimZeros` 去掉小数末尾多余的零且不动整数（`100` 不会被削成 `1`），`fmtBytes` 改用它，于是 25 MB 不再写成 25.00 MB；`needsUnitSpace(unit)` 判断数字与单位之间要不要留空隙，中文单位留、`%` 与 `％` 紧贴，KPI 卡据此给单位 span 加 `-ml-1` 抵消容器的 `gap-1`（实测计算样式为 `-4px`，「个」仍是 `0px`）。6 处自算百分比全部改为调用这套函数，OCR 单位补上分隔空格。

`pnpm verify:format` 61 项：去零 9 项（含 `100`、`0.00`、负数、空串）、百分比取值 13 项（两位/一位/整数精度、`0/5` 是 0、分母为 0 与负分子与 NaN 与 Infinity 都给 null、与文档里旧公式逐值相等）、百分比文案 12 项（「—」不带百分号、百分号紧贴数字）、单位空隙 8 项、字节数 11 项（含上传提示里不出现 `25.00`）、静态走查 8 项（组件不再自己 `* 10000) / 100`、KPI 单位按 `needsUnitSpace` 决定空隙、不再拼出「—%」）。

改完在浏览器里复核了渲染结果：上传提示为「单文件 ≤ 25 MB」，hero 为「工具成功率 94.64%」，三张百分比 KPI 的单位分别是「%」「% · 累计 60%」「% · 1 次」，`-ml-1` 的计算值为 `-4px`，与容器 `gap: 4px` 正好抵消；「累计任务」的单位「个」保持 `0px` 不留负边距。`qa:all` 现 40 项 verify。

## 时长口径统一：四种写法收成三个函数

顺着排版这条线继续查，时长比百分比还乱：`TaskWorkbench.tsx` 里有 8 处自己拼时长，同一个「工具单次耗时」在时间线角标是 `1.5s`、在整页交付 MD 里是 `1.5 s`（`run-tools.ts` 的 `fmtDuration`），总耗时角标又是 `toFixed(0)}s`，运行总时长与实时计时各写一份 `s >= 90 ? 分钟 : 秒`，两份的小数位还不一样（一份 1 位、一份 0 位）。

`format.ts` 里按场合分成三个函数，每种场合只允许一份实现：`fmtDurationZh(seconds, digits)` 给页面正文与状态条（满 90 秒进位到整数分钟，否则按 `digits` 位小数，实时计时传 0）；`fmtDurationShort(seconds)` 给时间线角标（满 90 秒用 `m`，否则整数 `s`，单位紧贴数字，角标位置太窄）；`fmtSecondsShort(seconds, digits)` 给 tooltip 与统计行（保留小数但单位紧贴）；`fmtMs(ms)` 是文档口径（不足 1 秒用 `ms`，否则一位小数 `s`，单位前留一个空格，与 `fmtBytes` 的 SI 写法一致）。时长这里不做去零，`1.0 s` 保留一位——和字节数不同，耗时对齐小数位更好横向比较。`run-tools.ts` 的 `fmtDuration` 改为委托 `fmtMs`，8 处内联写法全部换成函数调用，输出与改前逐字一致（`verify:format` 里加了「run-tools 与统一口径逐项相等」这条守着）。

`pnpm verify:format` 从 61 项扩到 89 项：中文时长的一位小数与取整、90 秒进位、0 秒如实写 `0.0 秒`、负数与 NaN 给「—」；紧凑角标的四舍五入（89.6 秒 → `90s`）与 90 秒换 `m`；tooltip 写法可指定小数位；`fmtMs` 的 `320 ms` / `3.5 s` / `1.0 s` / null / 负数 / NaN；三种口径的单位空格各自正确（文档留空格、角标紧贴、中文留空格）；静态走查断言工作台不再出现 `Math.round(s / 60)} 分钟`、`toFixed(0)}s`、`toFixed(1)}s`。第一轮跑就靠这条抓出两处漏改的单次耗时（工具调用清单复制与折叠行标题）。

## 本机数据可复位：偏好与用户数据分开清

本地存储收口之后，13 个键都登记在 `KEYS` 里，于是「一键回到默认」第一次变得可做。但复位不能一刀切：分组折叠、字号、筛选这些是界面偏好，清掉没有代价；收藏、任务标签、自定义备注模板、平台指标快照是人工写下的内容与历史数据，清掉不可恢复。因此分成 `UI_PREFERENCE_KEYS`（9 个）与 `USER_DATA_KEYS`（4 个），`resetUiPreferences()` 只清前者，`resetAllLocal()` 才动后者，两个函数都返回实际清掉的键，界面就地报「已复位 N 项」而不是让人猜。`localFootprint()` 给出键数与字节量级，弹层里直接显示「现有 N 项 · 约 X KB」。验证脚本断言两类键合起来正好覆盖 `KEYS` 全部登记项且互不重复——以后新增键忘了归类会当场红。

入口放在侧栏页脚（「复位排序」旁边）的「本机数据」按钮，弹层里两个动作都是两步确认：第一次点变成「再点一次：复位偏好」/「再点一次：全部清空」，4 秒不点自动解除武装；「全部清空」的 title 明说会清掉收藏、标签、自定义备注模板与指标快照且不可恢复。清完延迟 700ms 刷新页面——偏好是在各组件初始化时读的，不刷新会出现「存储清了、界面还是旧字号」的假象。`pnpm verify:localstore` 从 70 项扩到 94 项，覆盖复位只清偏好不动用户数据、全部清空后统计归零、键分类完整性，以及入口存在与两步确认的静态走查。

## 时间显示口径：三份相对时间、十处日期戳

相对时间有三份实现：侧栏与平台总览各一份 `relTime`（逐字相同），`link-check.ts` 的 `ageText` 是第三份且分档不同——不足 1 小时一律「刚刚」，没有分钟档。也就是说同一条 30 分钟前的核验记录，在引用列表里写「刚刚」，在任务行里写「30 分钟前」。新增 `apps/web/src/time-format.ts`：`relTime(iso, now?, fallback?)` 统一四档（刚刚 / 分钟 / 小时 / 天），`now` 可注入，验证脚本用固定时钟断言而不依赖跑脚本的时间；解析不出来一律给 `fallback`（默认「—」），不猜一个「刚刚」把坏数据藏起来；时间在未来（本机与服务端有轻微时钟偏差）按「刚刚」处理，不显示负数。`ageText` 改为委托 `relTime(iso, now, "")`，只保留自己「没有核验时间 / 时间在未来返回空串」的语义，`verify:link-check` 里那条「不足 1 小时显示刚刚」相应改成「30 分钟前」——这是有意提高精度，不是回归。

顺手发现文件名时间戳更乱：`new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")` 只删了冒号与 T，连字符还在，导出文件名实际是「时间线-2026-09-28120000.md」这种既不是日期也不是时间的写法；另有十处 `slice(0, 10)` 各写各的日期戳（快照键、概览导出、复核记录、任务清单、比对报告与差异 CSV、整页 MD、BibTeX 的 Accessed 字段）。`fileStamp()` 改为连字符一起去掉（`20260928120000`，14 位纯数字，Windows 与压缩包路径都安全），`dayStamp(when?)` 统一日期戳（`2026-09-28`，可接受 `Date` 或 ISO 字符串，空串如实返回空串）。

`pnpm verify:reltime` 47 项：十二个分档边界（0 / 30 秒 / 59.9 秒 / 1 分钟 / 59 分钟 / 60 分钟 / 23 小时 / 23 小时 59 分 / 24 小时 / 8 天 / 400 天不换月 / 未来 5 分钟按刚刚且不出现负号）、六种坏数据兜底、**与旧实现在 15 个偏移量上逐值一致**（侧栏与看板那份必须一字不差，改的只是 link-check 的分档）、`ageText` 的空串语义、`fileStamp` 与 `dayStamp` 的格式与同一天一致性、以及静态走查（两份 `function relTime` 已删、四个组件都从 `time-format.ts` 导入、`link-check` 委托、工作台不再自己 `slice(0, 19).replace`、全部组件扫一遍不再出现 `new Date().toISOString().slice(0, 10)`）。`qa:all` 现 41 项 verify。

## 阅读器查找：markdown 里「下一处」点不动的真 bug

查找这件事之前有三份互不相干的实现：计数用 `baseText.toLowerCase().split(q).length - 1`，文本高亮用 `RegExp` 的捕获组 `split`，markdown 的 DOM 包裹用 `indexOf` **且只取每个文本节点的第一处**。第三份是实打实的功能缺陷：一段结论里出现三次「金额」，DOM 里只包了一个 `mark`，计数器却写着 3，「下一处」按 3 取模在 1 个 mark 上跳——用户看到的就是按钮点了没反应。

计数本身也有口径问题：markdown 的 `baseText` 是原始源码，含 `#`、`*`、表格竖线与代码围栏，而用户看到的高亮发生在渲染后的文本上，两者天然对不齐（搜「##」或搜被标记切开的词时尤其明显）。修法是把 markdown 的命中数改成以 DOM 里真实的 `mark[data-find]` 数量为准（高亮 effect 跑完写回 `mdMarks`，查询为空时归零），text 类文档仍按文本计数——两种文档各自的「N/M」都等于用户看得见的高亮数。

新增 `apps/web/src/text-find.ts`：`findRanges(text, query)` 一次扫描给出全部命中区间（大小写不敏感、不重叠、查询前后空格 trim、空查询返回空数组），`countMatches` 是它的长度，`splitForHighlight` 按区间切出「命中/非命中」分段供渲染包 `mark`（保留原文大小写），DOM 后处理与文本渲染因此共用同一份区间口径。另外把环形取模这个惯用法收进来：`wrapIndex(i, len)` 与 `stepIndex(cur, delta, len)`，此前在 mark 导航、表格命中导航、标签页切换、旋转角恢复四处各写一遍 `((x % n) + n) % n`；`matchLabel(current, total)` 统一计数文案，没有命中如实写「0 处」而不是「1/0」。

`pnpm verify:textfind` 58 项：命中区间（重叠只算一次、紧邻两次都算、trim、中文多处、`.` `(` `\` 等正则特殊字符当普通文本、每个区间切回原文等于查询词、区间不重叠且递增）；**与旧的 split 计数在 8 段文本 × 7 个查询词上逐例一致**，保证 text 类文档的行为一字不变；分段拼接后与原文完全相同、命中段数等于计数；环形序号 19 项（越界回绕、负数多圈、长度为 0 或负、NaN 与 Infinity 给 0、小数截断、旋转角 -90 → 270）；计数文案 7 项；静态走查 8 项（不再用正则 split 高亮、不再 `indexOf` 只标一处、markdown 命中数以 DOM 为准、四处不再手写环形取模、全部组件扫一遍不再用 `.toLowerCase().split(` 数命中）。`qa:all` 现 42 项 verify。

## 批量复查会把已找到的证据覆盖掉（点一次按钮，看板证据变少）

按台账把 12 处待复查文号真跑了一遍批量复查，跑完看板数字反而变差：待复查 12 → 14、复查到出处 9 → 7。查下来是两条叠加的缺陷。一是 `pendingRefTargets` / `pendingCitationTargets` 只按「工具留痕里没有出处」挑目标，不看这条是否已经复查到出处，于是批量预算重复花在已解决的项目上；二是 `saveRefCheck` 用 `ON CONFLICT (task_id, ref_key) DO UPDATE` 无条件覆盖，而联网检索通道本身有波动，一次没命中就把之前找到的公开出处抹掉了。合起来的后果是最坏的那类：用户点了正确的按钮，平台的证据反而变少，而且没有任何提示。

修法分两层。目标筛选加纯函数 `unresolvedTargets(targets, checks)`，把已有 `matched` 记录的 key 排除，预算只留给真正没解决的（`candidate` 与 `empty` 仍算未解决，因为它们还没有可点击核对的出处）。落库加不降级护栏：`shouldOverwrite(prev, next)` 只在「旧的已 matched 而新的没有」时返回 false，此时保留原有的 verdict、证据标题/地址/分级/摘要，把这次重试如实写进 note（`preservedNote` 生成「YYYY-MM-DD HH:MM:SS 再次检索为「未检索到相关公开来源」，保留此前已找到的公开出处」，接在旧 note 后面而不是替换），`attempts` 追加、`checkedAt` 更新到最新——失败不藏起来，证据也不丢。反向（`empty`/`candidate` → `matched`）照常升级，`matched` → `matched` 也照常覆盖成更新的那次。

修完重跑：14 处待复查文号全部跑完，12 处找到公开出处；6 条弱证据引用跑完，4 条找到官方替代来源。看板从「待复查 12 · 复查到出处 9 · 已找到替代 12 · 欠账任务 9」变成「待复查 2 · 复查到出处 19 · 已找到替代 19 · 欠账任务 5」。要说明的是「文号有出处 10/31」没有变——那一栏统计的是工具留痕里可直接溯源的文号，只有把复查到的出处写回结论（结果页的「生成修订指令」→ 续跑）才会增加；这 19 条属于「已找到公开出处、待人工写回」，看板与台账都如实这么标，不冒充已溯源。

`pnpm verify:refcheck` 从 232 项扩到 270 项。落库演练自成一回合（先删假任务记录，避免受前面小节留下的状态影响）：先检索命中写入 `matched`，再用返回空结果的假检索器复查同一条，断言库里 verdict 仍是 `matched`、证据地址与分级没被抹掉、note 含「保留此前已找到的公开出处」与「再次检索为」、`attempts` 条数增加、`checkedAt` 不早于原来、记录数仍是 1；随后清空重跑「先未命中、后命中」，断言能正常升级。纯函数层补 7 条 `shouldOverwrite` 真值表、3 条 `unresolvedTargets`、2 条 `preservedNote`。真实任务走查里「服务端口径 vs 前端口径」的两处比对同步套上 `unresolvedTargets`，否则过滤后两边清单必然对不上；走查结果也从「12 处待复查」变成过滤后的真实待办数。

## 门户入口页被当成官方原文，以及不降级护栏不能把误判锁死

准备把 19 条已找到出处写回结论之前，先机械检查了一遍「生成修订指令」的实际输出，发现替代来源里赫然出现「国家数据 → 《国家数据局》 https://www.nda.gov.cn/sjj/index_pc.html」。项目自己的口径里门户首页算弱证据（检索相关度过滤专门拦它），却被当成官方原文写进了要交给 Agent 重写结论的指令。

根因是入口页识别漏了变体：`ENTRY_LAST_SEGMENT` 只认 `index|main|home|default|login|logout|register|search` 加可选扩展名，`index_pc.html`、`index-m.asp`、`default.aspx`、`homepage.htm` 全都不算入口页；而引用类复审判 `matched` 的条件是「结果池里有 official 分级的页面」，于是政府域名下的门户入口页直接通过。修法是把这个正则在两处同步收紧（`apps/web/src/citation-grade.ts` 与 `packages/business-tools/src/web-search.ts`）——两边本来就各有一份实现，`verify:citegrade` 会对同一批真实地址逐条比对两边判定，只改一边就会当场红。

紧接着暴露出与上一轮「不降级护栏」的相互作用：护栏让 `matched` 永不被覆盖，那么规则收紧之前误判的记录就被永久锁死，再也纠正不回来。因此护栏的判定不能只看旧 verdict，还要看旧证据按**当前**规则是否仍然成立，于是有了 `matchedStillValid(kind, evidence, gradeOf)`，而且门槛必须按复查类型分开：文号复查承诺的是「公开页面里出现了这个文号」，专业来源（税务实务库、法规 PDF）同样算出处，只有掉到「证据力弱」才失效；引用替换承诺的是「找到官方原文」，因此必须仍是官方站点。这一步是实测逼出来的——库里 19 条文号 `matched` 有 13 条证据分级是 `professional`（如 shui5.cn 的法规页、ohmi.net.cn 的法规 PDF），一刀切要求 `official` 会让它们全部失去保护、每次批量都重查一遍，白烧检索预算。

批量清单也改成能自我修复：`unresolvedTargets` 接受 `stillValid` 回调，已 `matched` 但证据按新规则失效的目标重新进入待办。于是不需要写数据迁移脚本去清理历史误判，跑一次批量就纠正了——「国家数据」那条现在是 `candidate`（证据是一个图书馆页面，需人工确认），不再冒充官方原文。重跑后看板为「待复查 2 · 复查到出处 19 · 已找到替代 19 · 欠账任务 5」，与上一轮持平：这一轮纠正的是错误的 matched，不是新增证据。

`verify:citegrade` 87 → 99 项（`index_pc.html`、`index-m.html`、`default.aspx`、`homepage.htm`、栏目下的 `index.shtml` 判为入口页且不再分级成官方；真实文件页、`search2024.html`、`index-cpi-report.htm` 不误判）。`verify:refcheck` 279 → 300 项：`shouldOverwrite` 三态（旧证据仍有效时保护、失效时放行、默认保护）、`matchedStillValid` 两种类型六种地址（含专业来源在文号口径下受保护、在引用口径下不受保护）、DB 级演练（把门户入口页证据的 `matched` 落库，再用 `candidate` 覆盖，断言被纠正、失效证据不保留、note 与 checkedAt 更新、不新增记录）、批量清单自我修复、以及不传判定函数时按原样保护全部 matched。

遗留问题（下一步）：替代来源目前只校验「官方域名 + 非入口页」，不校验主题相关性，实测出现把「国家政务服务平台」替换成 app 下载页、把「12366 纳税服务平台」替换成 `tools.html` 的情况，都判成了 matched。应当在 `gradeRefCheck` 的引用分支加主题相关性门槛（原引用标题与命中页标题/摘要的分词重合），不达标的降为 `candidate` 交人工确认，而不是让 Agent 直接写回结论。

## 替代来源的两道门槛：功能页识别 + 主题相关性

上一节记的遗留问题这一轮做掉了，拆成两道互补的门槛。第一道是功能页识别：`isEntryUrl` 除了入口页文件名，再检查路径里是否出现 `download / down / app / apps / apk / tool(s) / login / logout / register / signup / search / query / help / faq / feedback / sitemap / wap / mobile` 开头的路径段（大小写不敏感、允许尾随字母数字，因此 `downloadApp`、`tools.html`、`/wap/` 都算）。这条直接命中实测的两个坏例子：`app.gjzwfw.gov.cn/fwmhapp/downloadApp/android.html` 与 `12366.chinatax.gov.cn/wap/pages/tools.html`，它们从 `official` 掉到 `weak`，于是既不能再被判成 matched，也因为 `matchedStillValid` 失效而重新进入批量待办、被自动纠正。规则同样在两处同步（web 的 `citation-grade.ts` 与 `packages/business-tools` 的 `web-search.ts`），`verify:citegrade` 的逐条比对会盯住一致性。反向也测了不误伤：政策原文页、税务实务库法规页、12366 详情页、`research-report-2024.html`（含 search 字样但不在词首）都仍算内容页。

第二道是主题相关性。官方域名 + 内容页仍不足以说明「谈的是同一件事」，因此 `gradeRefCheck` 的引用分支要求原引用标题与命中页标题/摘要有共同主题词才判 matched，否则降为 `candidate` 并在说明里写清「没有共同主题词，看不出谈的是同一件事，需人工确认后再替换」。分词是粗粒度的：中文取二字滑窗、英文与数字取 3 字以上，先剔掉一份通用词表（国家 / 中华 / 人民 / 政府 / 政务 / 服务 / 平台 / 系统 / 百科 / 词条 / 下载 / 工具 / 数据 / 查询 / 税务 / 纳税 / 12366 与 www、gov、html 一类 URL 碎片），因为两边都出现的通用词不构成相关性。这套做法的已知局限是二字滑窗会保留跨词组合（「国家政务服务平台」与「国家税务总局12366纳税服务平台」会共享「务平」），这一点写成了一条断言明记在验证脚本里，实际由第一道功能页规则兜住。

门槛松紧是用真实数据量的，不是拍脑袋：先对库里 19 条 `matched` 引用逐条回算 `topicOverlap`，结果 keep=19 / drop=0，说明门槛没有误伤已有正确结论，才把它接进判定。重跑批量后 4 条历史误判被重新检查，只有 1 条仍站得住：「国家政务服务平台」换成了真正的内容页 `gjzwfw.www.gov.cn/fwmh/item/indexGR.do`，「12366 纳税服务平台」如实变成「未检索到可替换的官方原文」，「国家数据」是 candidate（图书馆页面，需人工确认）。看板「已找到替代」从 19 变成 18——数字变小是纠正，不是退步。

`verify:citegrade` 99 → 106 项（App 下载页与工具页判弱、政策原文页与实务库法规页与 12366 详情页不误伤、`search2024.html` 按检索页处理、`research-report-2024.html` 不误判）。`verify:refcheck` 300 → 318 项：分词与通用词剔除、去重、空标题、同主题有共同词、不同主题无共同词、摘要里的共同词也算、原引用全是通用词时不给相关性、跨词组合的已知局限；判定层四条（官方但主题不相关 → candidate 且说明写清原因、官方且相关 → matched、同域名 App 下载页 → empty 且说明「没有可替换的官方原文」）。

## 写回结论跑通：文号有出处 10/31 → 34/50，顺带修掉修订影响的空基线

先确认本机模型网关（`127.0.0.1:15721/v1`）在线，然后对四个任务真跑了「生成修订指令 → 续跑」：`aabd138a` 记录级底稿比对闭环、`ff4c9a3c` 模板保留式填列闭环、`17a56468` 上传资料解析与底稿生成闭环、`4bb22d34` 缺失资料联网检索与图表输出验证，每个 250–380 秒。效果：平台「政策文号有出处」从 10/31 涨到 **34/50**，联网引用 72 → 91 条、其中官方原文 32 → **43** 条；四个任务的结论正文里都能查到复查时找到的证据地址（逐条 `includes` 验过）。

这条链路做成了可复用工具 `apps/api/scripts/writeback-evidence.ts`（`pnpm writeback:evidence`）：默认只列出计划（哪些任务、几条素材、其中文号出处与官方替代各多少、指令多少字），`--print` 打印完整修订指令供人工核对，`--task <id前缀> --run` 才真跑，跑完打印每个任务的前后对比与平台级变化，并在「证据反而变少」时给出警告。已经写回的素材不会重复进指令（结论正文里出现过该证据地址即视为已写回），因此脚本可以反复运行；这一条当场生效——`aabd138a` 写回后再列计划就从清单里消失了。

跑第一个任务就暴露了修订影响的缺陷：`ff4c9a3c` 的官方引用从 3 条变成 0 条，平台官方计数确实 −3，但台账上的修订影响写着「证据质量持平」。查下来是**比对基线取错**：`listConclusions` 把一次运行里每一段 `agent_text` 都当成一条结论（过程播报也在内），于是「上一轮结论」拿到的是同一次运行里的一段播报，证据快照全是 0——跟任何东西比都是持平。改为按 `run_started` 分组、每次运行只取最后一段非空文本，跨运行对比才是真的跨运行。

顺带补全判定口径：`evidenceDelta` 原来只看弱证据与官方原文，文号出处从 0 变成 3 也算「持平」，而写回结论这条链路补的恰恰是文号出处。现在文号出处增加算改善、减少算退步，引用总条数仍不计入（多引几条同样强度的来源不是质量变化）。四句判定文案一字未改，因为「持平」成立时三项差值都是 0，原文案依然准确。

修完立刻在真实数据上验证：`ff4c9a3c` 的修订影响变成「证据质量退步，请核对本次修订」（这就是它该有的结论——官方引用被改没了），`17a56468` 与 `4bb22d34` 分别是「有增有减」与「改善」；真实续跑走查从 4 个可对比任务变成 5 个（改善 2 · 退步 1 · 无变化 1 · 有增有减 1），退步这一类以前是被空基线吃掉的。

还有一个统计不变量被这轮数据推翻：`verify:stats` 里断言「复查到出处 ≤ 无出处文号数」，写回之后变成 19 > 16——因为写回成功的文号转为可溯源、不再计入无出处，而复查记录仍在。改成断言真正成立的那条（待复查 ≤ 无出处总数、可溯源 ≤ 文号总数），并把看板文案从「已复查到公开出处 N 处」改为「累计复查到公开出处 N 处，含已写回结论、现已可直接溯源的」，避免评委拿两个数字对不上来质疑。`verify:revimpact` 105 → 127 项（文号出处增减的三条判定与文案；按运行分组的走查：结论条数不超过 `run_started` 次数、最后一条与 `tasks.result` 一致、上一轮结论不能是空快照——正是最后这条把本次 bug 变成可自动发现的）；`verify:stats` 35 → 37 项。

遗留：`ff4c9a3c`（土增·模板保留式填列闭环）这次续跑把 3 条官方引用改没了，修订影响已如实标为退步，需要人工再续跑一次把引用补回去，或直接在结论里补引用后重新核对；平台欠账任务从 5 个变成 6 个，也是这轮改写带进来的新弱引用，台账里逐条可见。

## 写回续跑的副作用：底稿被重新生成，比对准确率一度从 60% 掉到 1.79%

三个写回续跑跑完后，`qa:all` 的测试报告里 `recordCompareOverall` 从 60%（一致 3 / 比对 5）掉到 1.79%（一致 1 / 比对 56）。追查发现续跑时 Agent 不只改了引用：「记录级底稿比对闭环」重新调用了 `generate_workpaper`，新底稿结构与原始要求不符（三行归集数变成了 54 行明细），随后那次记录级比对 0/54 命中（48 行仅系统有、6 行仅人工有）；「模板保留式填列闭环」则顺手把「已填列模板」与它自己的空白模板做了一次记录级比对（4/16，12 行仅系统有），这本身不是一次有意义的准确率样本。指令里原先只写了「不要改动金额、测算过程、差异认定与结论意见」，没有禁止重新调用业务工具，Agent 于是把上一轮的交付证据一起换掉了。

分两步处理。**定点修复**：给「记录级底稿比对闭环」发一条只允许做两件事的续跑指令（按原始要求重新生成三行归集底稿、再与「人工参考底稿-样例.xlsx」做一次记录级比对），并明确要求原样保留上一轮结论全文、不要重新联网检索。190 秒跑完，比对记录回到 3 项比对 2 项一致（66.67%），写回成果一条没丢（文号 7/9、引用 10 条其中官方 8 条），修订影响如实显示「持平」。**堵住源头**：`buildRevisionInstruction` 的开头加一句硬约束——「本轮只修订文字：不要重新调用解析、底稿生成、模板填列或底稿比对一类业务工具，也不要重新生成产物；已有工具结果与比对记录是上一轮的交付证据，重跑会把它们替换掉」，`verify:refcheck` 加两条断言盯住这句话必须在指令里。给「模板保留式填列闭环」补回三条官方引用的那次续跑用的就是新指令：跑完官方引用 0 → 4 条、修订影响转为「证据质量改善」，而**这次运行期间新增的比对调用数为 0**，约束确实生效。

同时修了一个被这次数据暴露出来的统计口径问题：记录级比对的「累计」原来是把所有历史记录相加，同一任务反复比对时，一次失败的重复比对会永久拉低准确率，而且和「最近一次」并列展示时容易被理解成同一批数据。改成**每个任务只取最近一次记录级比对再合计**，看板 tooltip 与 `types.ts` 注释同步改为「各任务最近一次」，`verify:stats` 独立按同一口径重算并断言（存在重复比对时累计必须小于全部相加），35 → 40 项。

最终数据如实记在这里：政策文号有出处 **10/31 → 34/50**，联网引用 **72 → 95** 条、其中官方原文 **32 → 47** 条，弱证据已找到替代 12 → 18 条；记录级比对「最近一次」66.67%，「累计」33.33%（7/21 = 记录级底稿比对闭环 2/3 + 比对联动验证 1/2 + 模板保留式填列闭环 4/16），比写回前的 60%（3/5）低。低的原因就是上面那条 4/16——写回续跑顺手做的「已填列模板 vs 它自己的空白模板」，不是一次有意义的准确率样本，但它是真实发生过的工具调用，本轮没有删记录、也没有为了好看改口径。要把它清出样本有两条路：按原始案例把该任务重跑一遍生成干净的比对记录，或在报告里注明这条样本不代表与人工底稿的比对。平台欠账任务 5 → 6，也是这轮改写带进来的新弱引用，台账里逐条可见。

## 修订模式：把「不要重跑业务工具」从嘱咐变成机制

上一轮靠指令里那句话把副作用压住了（实测新增比对调用 0 次），但嘱咐终究是嘱咐，模型可以不听。这一轮做成机制：新增 `apps/web/src/revision-mode.ts`，`REVISION_BLOCKED_TOOLS` 列出修订模式下要摘掉的工具——会重新生成产物的 `generate_workpaper`、`fill_land_vat_workpaper`、`render_matching_diagram`，会新增比对记录的 `compare_workpapers`，会重写解析与抽取记录的 `parse_uploaded_files`、`parse_invoice`、`parse_contract`，以及会改变测算与差异认定的 `check_rd_expenses`、`calculate_rd_adjustment`、`match_invoice_ledger`、`match_contract_invoice`、`check_amount_consistency`。`runTask` 增加 `revisionOnly` 选项，命中时**同时**过滤任务工具与智能体自带工具（`{ ...agent, tools: revisionAllowedTools(agent.tools) }`），模型这一轮根本调不到；续跑接口接受并回显 `revisionOnly`，`writeback:evidence` 默认开启。检索与读取类工具保留（`web_search`、`fetch_public_document`、`search_rd_policy`、`search_public_cases`、`inspect_workpaper_template`），补出处时仍需要打开原文核对标题。`run_started` 事件写明本轮是修订模式，被停用的完整清单进服务端日志，便于事后追查「为什么这一轮没有底稿产物」。

实测：对「关系图工具嵌入验证」（8 条素材：3 处文号出处 + 5 条官方替代）跑修订模式写回，157 秒完成，本轮工具调用只有 `fetch_public_document` 与 `fetch_content` 两条读取类调用，底稿生成、比对、解析、关系图渲染一次都没发生（对照上一轮无约束时它把底稿重新生成了）；该任务引用 12 → 17 条、官方 5 → 7 条，平台引用 95 → 100 条、官方原文 47 → 49 条。同一轮还把剩余检索待办跑完：待复查文号 7 处跑完 0 处找到出处（这些文号在公开检索里确实找不到原文，如实记为未检索到），弱证据引用 3 条跑完 1 条找到官方替代。

没达成的部分也记下：该任务「文号有出处」仍是 0/3——模型把找到的原文放进了联网引用清单，却没写到政策依据处与文号相邻的位置，`traceDocRefs` 因此仍判为无出处，修订影响判为「有增有减」。这说明修订指令还得再明确一层：要求把出处写在文号所在的那一句或那一行表格里，而不是只堆在引用清单末尾。

`verify:refcheck` 319 → 337 项：黑名单覆盖底稿生成/比对/模板填列/解析/测算与核查，检索与读取类不在黑名单，白名单与黑名单不相交，黑名单无重复，过滤函数只留检索类且不改动原数组，被摘掉的工具名可用于留痕；静态走查断言运行时对任务工具与智能体自带工具都做了过滤、`run_started` 写明修订模式、续跑接口透传 `revisionOnly`、写回脚本默认开启。

## 复查不到出处的真因：不是文件不公开，是检索通道与检索词都坏了

上一轮把「待复查文号 7 处跑完 0 处找到出处」记成「这些文号在公开检索里确实找不到原文」。这个结论是错的，本轮逐条查 `attempts` 后推翻，真因有三层。

第一层，RSS 通道退化成兜底噪声，而且会永久挡住 HTML。`fetchEngine` 原来只判断「解析出条数」，本机 Bing RSS 对中文查询整批返回与检索词无关的条目：检索「土地增值税清算」返回微软 Windows 帮助页，检索「科技部公告2022年第28号」返回 USPS 首页，检索公告全称返回 Google 首页，条数照样是 10。条数不为 0 就采用 RSS，HTML 通道于是永远轮不到，百度又被安全验证拦住，7 处最终全部 `empty`。新增 `rssWorthUsing`：用与下游完全相同的 `filterSearchResults` 判定，留不下一条可用结果就退回 HTML 解析。哪种取数方式可用会随本机网络环境变化（上一轮恰好相反，是 HTML 返回无关条目、RSS 真实对应），因此按结果判定，不把优先级写死。

第二层，Bing HTML 的结果地址是 `www.bing.com/ck/a?...&u=a1<base64url>` 跳转包装。直接当证据存下来，来源域名会显示成 bing.com：既拿不到 gov.cn 的权威判定与 12% 低门槛，链接本身也可能失效。新增 `unwrapBingRedirect` 在解析阶段还原（实测域名已从 bing.com 变成 baike.baidu.com / www.gov.cn / fgk.chinatax.gov.cn），解不出来时原样返回，不猜。

第三层，检索词构造有三处缺陷，全部取自这 7 处的真实上下文：联合发文只取紧邻的最后一个机关，「财政部 税务总局 科技部公告2022年第28号」被截成「科技部公告2022年第28号」，指向一份不存在的文件；前缀会吞掉前导副词，「已按国家税务总局公告2019年第41号」整串进了检索词；上下文里没有机关时只剩光杆公告号加一段残句（「2019年第41号 项同时废止」）。现在机关沿空格与顿号往左连取，但仅在紧邻部分以公文种类词（公告/通知/令/决定…）结尾、且左边那段以机关结尾字（部/委/局/署/院…）收尾时才延伸——两个条件缺一不可，否则会把「同时废止」当成机关名。`LEAD_WORDS` 补上「已/并/且/该/其/同时」一类前导词；光杆公告号（除年份序号外不含机关信息）退回用任务主题词兜底，与引用复查共用同一套 `topicHint`，前端单条复查与批量入口的检索词因此一致。

实测：修完后同一批 7 处重跑，matched 0 → 1（「财政部 税务总局 科技部公告2022年第28号」命中国家税务总局政策法规库原文页 `fgk.chinatax.gov.cn/zcfgk/...`），平台文号有出处 43/50 → 44/50、其中复查取得 9 → 10、待复查 7 → 6。

剩下 6 处仍未解决，但原因已查清且不在本项目代码里：Bing 对长中文查询严重退化，`site:` 运算符被完全忽略（「site:chinatax.gov.cn 2019年第41号」返回的是「2019 - Wikipedia」「What Happened in 2019 - On This Day」一类英文兜底页），「国家税务总局公告2019年第41号 年度汇算清缴起废止」只命中「国家」二字，返回百度百科与维基百科的「国家」词条；百度持续返回安全验证页。相关度过滤如实拒绝这些结果正是设计意图——宁可回报「未检索到」，也不把无关网页当成政策出处。下一步是接官方政策法规库（`fgk.chinatax.gov.cn` 实测 HTTP 200 可达、页面含检索接口）作为文号复查的定向来源，不再依赖通用搜索引擎。

`verify:websearch` 52 → 61 项：RSS 全部无关 / 只剩入口页 / 空结果三种情况都不采用、留下可用结果才采用；跳转包装还原成真实地址且还原后能判定为权威域名，非包装地址、缺 `u` 参数、`u` 参数解不出地址三种情况原样返回。`verify:refcheck` 339 → 347 项：三机关与四部委联合发文连着取、前导副词不进前缀、普通词组不当作机关往左延伸、顿号分隔归一成空格、非公告类文号不延伸、光杆公告号用主题词兜底、自带机关代号的文号仍用上下文关键词。

## 升级后的官方证据逐页核对：9 个原文页全部核实，并更正上一轮一处误判

上一轮开通「商业站点证据升级为政策法规库官方原文」的通道后，13 条候选里 11 条升级成功（文号证据 official 10 → 21、professional 13 → 2），但当时只在数据库层面核对过 grade 与 URL，没有打开页面确认内容。本轮补做。

库里 18 条 `evidence_grade=official` 且地址指向 `fgk.chinatax.gov.cn` 的文号证据，去重后是 9 个原文页。逐页抓取：9 个全部 HTTP 200，正文都出现了对应文号。再用「文号紧邻页面自身的『阅读量』字段」判断本页是否就是该文件，7 页直接成立；剩下 2 页被判为「仅提及」，打开看是判定方法的误判——两页标题区分别是「财政部 国家税务总局 科技部关于完善研究开发费用税前加计扣除政策的通知 财税〔2015〕119号 （ ） 阅读量：」与「财政部 税务总局 科技部关于加大支持科技创新税前扣除力度的公告 财政部 税务总局 科技部公告2022年第28号 （ ） 阅读量：」，文号与阅读量之间夹了一对空括号，把紧邻判定打断了。9 页因此全部确认为该文号自身的原文页，升级通道写入的证据是真的。

顺带更正上一轮的一处误判：当时查不到 2022年第28号，记成「库内只有后续替代文件」。实际《财政部 税务总局 科技部关于加大支持科技创新税前扣除力度的公告》（2022年第28号）就在库里，地址 `zcfgk/c102416/c5202002/content.html`。查不到的原因是检索接口的全文排序没把它排上来，不是库内没有——同一接口查「财税〔2015〕119号」时 `total=1` 且 `govDoc.docNum` 精确等于该字号，说明财税文件栏目同样在索引内、发文字号字段也有值。

由此得到一条待办与一处措辞更正：`searchPolicyLibrary` 只用「完整发文字号」一种查询形式，命中与否取决于接口的全文排序，宜再补几种写法（如去空格的紧凑字号、字号加标题关键词）作为候选；未命中时 `attempts` 的说明已从「该文件可能已被后续公告替代，或库内未收录」改为「检索接口未返回该字号，库内可能确有此文」，不把接口排序问题说成事实不存在。

另需注意：检索接口对部分查询响应很慢（实测单次 `searchUseTime` 达 7.2 秒，本轮一次四写法探测直接超时），补查询形式时要控制候选条数与单次超时，否则批量复查会被拖长。

## 补上第二条政策法规库检索路径：「标题关键词 + 制定年份」

上一轮留的待办（补几种查询写法）已实测收敛，但结论与设想相反：**换写法没用，换过滤参数才有用。**

对《财政部 税务总局 科技部公告2022年第28号》（已知在库 `zcfgk/c102416/c5202002`）逐一实测五种写法：完整字号 `total=14` 不含它、全紧凑字号 `total=2333`、字号加关键词 `total=19`、末机关加字号 `total=281`、纯标题 `total=25`——五种都没捞到。去空格的紧凑写法反而把结果从 14 条稀释到 2333 条，方向是错的，这条待办里想当然的那一半可以直接划掉。

真正的钥匙是官方检索页 `zcfgk/xhtml/js/getSearch.js` 自己会发的 `xxgkFormulatedYear`（制定年份）：关键词「加大支持科技创新税前扣除力度」+ 制定年份 2022，接口精确返回 1 条，正是该原文页；去掉年份则返回 26 条、照样不含它。对照组《国家税务总局公告2017年第40号》加年份后仍是 1 条精确命中，说明这个过滤参数不会误伤本来就能查到的文件。8 字的短关键词同样返回 1 条，对关键词长度不敏感。

于是 `searchPolicyLibrary` 增加可选的 `formulatedYear`，`runRefChecks` 在完整字号未命中且接口没报错时，再用「上下文关键词 + 字号里的年份」查一次；判定口径不变，仍要求发文字号归一化后全等，关键词再噪也认不错文件。顺带排除了两个想当然的做法：`column` 参数不能当栏目过滤使（官方 JS 只用它切「政策解读」，传「财税文件」直接返回 0 条）；`pageSize` 被接口忽略，分页只有 `pageNum` 有效。

上一轮担心的「响应慢、候选条数要控制」也一并回答了：这条路径最多多发一个请求，且仅在第一次空手而归时才发，接口报错不重试（同一故障换写法也是错）。实测一次 6 条目标的批量复查 12 秒内跑完。

实网证据已固化进 `verify:refcheck` 的联网段（默认门禁不联网，设 `TAXAI_VERIFY_LIVE=1` 才跑）：完整字号 `total=14 命中=false`；关键词+制定年份 `total=1 命中=true`。离线 483 项 / 0 失败，`qa:all` 全绿。真实数据里《财政部 税务总局 国家发展改革委 工业和信息化部公告2023年第44号》正是靠这条新路径拿到原文页 `zcfgk/c102416/c5213565`，记录 note 写明「按「标题关键词 + 制定年份」精确命中」。

## 升级候选的判据从「官方站点」改成「原文页」

同一轮还修掉一个会让记录永久卡死的判据。`upgradeRefTargets` 原来用 `grade !== "official"` 挑候选，但主站解读频道页（`www.chinatax.gov.cn/chinatax/…`）与原文页同域名、按分级同样是 official，于是「证据是解读页」的记录永远进不了候选——`2017年第40号` 的任务级证据就一直卡在这里，重跑多少次都不会被修正。改成 `!isLibraryDocUrl(evidence.url)` 后，真实数据里的升级候选从 0 条变成 3 条；跑一次批量复查（4 个任务 / 6 条目标 / 4 条命中），3 条全部换成 `zcfgk` 下的原文页，已核实官方原文索引 9 → 10 条，`2017年第40号` 另外两个任务随即走复用路径拿到同一份原文。

放宽判据不会拿已核实的好证据冒险：`verifiedOfficialDocs` 只收 `zcfgk` 原文页，`runRefChecks` 命中复用索引就直接返回、根本不发请求；反向替换仍被 `saveRefCheck` 的不降级护栏挡着（新增用例按证据力从低到高依次落库，倒过来写会被护栏挡住、测不到东西）。

仍未解决的两处，原因都不在这两个判据里：`2019年第41号` 与 `2022年第28号` 各有一条 `candidate` 记录指向国家统计局页面（`stats.gov.cn` 同样是 `.gov.cn`，分级为 official 但与涉税主题无关）——它们是 candidate 不是 matched，不会被当成证据；另有一处 `2019年第41号` 因结论上下文里没有发文机关，`policyDocNumQuery` 返回空串而整条政策法规库路径被跳过，这是「机关不明就不猜」的既定口径，复用索引也要求带机关的完整字号才命中。

## 机关不明的光杆文号：改用平台已核实的唯一同字号原文认定

上一节末尾记的两处「仍未解决」已经解决。办法不是放宽「机关不明就不猜」，而是分清两件事：猜一个机关去构造检索词是猜，读平台自己已经核实过的事实不是猜。

真实数据先摆清楚：任务 `aabd138a` 的结论里「2019年第41号」「2022年第28号」各只出现一次，全篇没有带机关的写法，所以 `policyDocNumQuery` 返回空串、整条政策法规库路径被跳过，通用检索给它们捞回的是国家统计局页面（`stats.gov.cn/sj/ndsj/2019/indexch.htm`、`stats.gov.cn/sj/zxfb/…`），而同域名一律分级 official，摆在界面上比没有证据更容易误导。但同一平台的另外三个任务里，这两个字号都写过完整写法，并按发文字号精确命中过政策法规库原文页。

于是新增纯离线的 `uniqueVerifiedDocNum(bare, verifiedKeys)`：在已核实原文索引里找以该光杆文号结尾的完整字号，**唯一**才返回，多于一条即跨机关有歧义、照旧退回通用检索。比对前去掉空白，因为库里同时存在「〔2006〕187 号」与「〔2006〕187号」两种写法。命中时 `verdict=matched`、`query` 记认定出的完整字号、`note` 与 `attempts` 都写明「结论未写发文机关」与来源任务，且不发任何网络请求。

跑一次批量复查（1 个任务 / 2 条目标 / 2 条命中）后的实测：全平台未 matched 的文号记录 2 → 0 条，证据指向 `stats.gov.cn` 的记录 2 → 0 条，26 条文号证据全部 official。两份作品说明随之重生成，官方原文 13 → 16、待复查文号 3 → 0、有证据缺口的任务 5 → 4。离线 500 项 / 0 失败，`qa:all` 全绿。

踩坑记一条：`runRefChecks` 第 5 个参数不传就读真实库，三节老用例正是这样写的，新路径一读真库就把它们的光杆文号解析成 matched，未命中 / 覆盖 / 保留规则全测不到。已在 `offlineLib` 旁声明共享的 `noVerified` 空索引并显式传入——凡是想测通用检索这条路的用例都必须隔离索引。

上一节提到的 `stats.gov.cn` 分级问题只解决了文号类：`gradeCitation` 仍把任何 `.gov.cn` 判为 official，引用类复查若捞到与涉税主题无关的其他部委页面，同样会顶着 official 展示。这是下一轮的口子。

## 作品说明里最后一处写死的实测数字

`materials-lib.ts` 开头就写明「数字必须生成时取数」，`evidenceSnapshotText()` 也是这么做的，但紧邻的一行仍把一次历史点按冻在散文里：「实测一次点按覆盖 4 个任务 12 处文号：找到公开出处 9 处、候选待确认 1 处、未检索到 2 处，平台口径随即从『待复查 18 · 已复查到出处 3 · 缺口任务 10』变为『待复查 12 · 已复查到出处 9 · 缺口任务 9』」。8 个数字全是历史值，而平台口径随后一路变到待复查 0、复查取得 16，同一份文档的上一行还承诺「看板与交付材料不会对不上」。

改成两处动态取数：`docRefSnapshotText()` 与 `evidenceSnapshotText()` 同源于 `computePlatformStats`，`batchBudgetText()` 直接读服务端的 `BATCH_REF_BUDGET` / `BATCH_REF_MAX`，常量一改文档跟着改。现在文档里是「按预算切分（默认 12 处、硬上限 30 处）」与「文号 50 处（有出处 50，其中复查取得 16 · 待复查 0 · 复查判定 matched 26）」。

不再讲那次点按的故事：批量复查的事件按任务分散写入、没有批次号，要重建「一次点按」只能靠时间窗去猜，猜出来的仍是不可靠的历史值。改为说明每个任务各写一条事件、时间线上可逐条回看。

门禁加在 `verify:stats`：两份作品说明必须逐字含实时算出的两串口径，写死数字或数据变了没重生成都过不去。做了负向自检——把快照串尾部临时加四个字，`verify:stats` 立刻 2 项失败、退出码 1，确认这道门禁不是空转。平台统计 45 项 / 0 失败，`qa:all` 全绿。

生成器里剩下的数字都是规格常量而不是实测值（8 秒超时、引用上限 24 条、模板标签不超过 8 字、趋势快照最多 60 天），这类本来就该写死；更彻底的做法是逐个改成引用真常量，但那不会与实时数据冲突，本轮只动了确实会自相矛盾的那一处。

## 比对准确率拆成一致率与覆盖率

看板上「记录级比对准确率 累计 33.33%」是个会说谎的数。把 5 次记录级比对的构成摊开：累计 21 项 = 一致 7 + 填错 2 + 仅人工底稿有 12 + 仅自动底稿有 0。其中两次的 `accuracyPercent` 分别是 0% 与 25%，而 `mismatched` 都是 0——48 项与 12 项全是「人工底稿有、自动底稿没有」的范围差异。`accuracyPercent = matched / compared`，而 `compared` 同时含「填错」与「只有一侧有」两类完全不同的问题，一个数把它们混在一起，看板上根本分不清是填列逻辑错了还是两份底稿口径范围不同。

新增 `compareRates(matched, mismatched, onlyA)`：**一致率** = 一致 /（一致 + 填错），回答「填得对不对」；**覆盖率** = 一致 /（一致 + 仅人工底稿有），回答「填得全不全」。分母为 0 时返回 `null`，不拿 100 充数。工作表级与总表级都带这两个字段，工具文字摘要改成先给构成再给三个比率。平台统计的累计口径同步给出构成与两个比率，比率一律按原始计数现算而不是读记录里的字段——拆分上线前的旧记录没有这两个字段，与「过滤规则上线前的历史记录按现行规则回算」同一口径。

顺手修掉一个会让文档与看板对不上的旧缺陷：`statsFor` 取「最近一次比对」用的是遍历顺序而不是调用时间，实测取到 09-28 的旧比对（2 项 / 一致 1）而不是 09-29 的最新一次（3 项 / 一致 2）。这正是作品说明里反复承诺「看板与交付材料不会对不上」的地方自己出了岔子。

实测后的说法变成：土增智填「总准确率 25%」旁边写明「一致率 100%（一致 4 / 填错 0）、覆盖率 25%（人工底稿有的 16 项里自动填到 4 项）」——填进去的一个都没错，只是范围没铺满，这两件事的处置方式完全不同。

前端只动了不影响布局的部分：KPI 卡的 `desc` 是原生 `title` 提示，写清构成与两个比率；`unit` 从「累计 X%」换成「累计一致率 X%」并保持原长度量级，因为这张卡在 `xl:grid-cols-6` 的窄格里，写长会折行挤动整排；MD 快照与 CSV 导出各补 5 行。`CompareView` 本来就并列显示「一致 / 差异 / 仅A / 仅B」，未动。

验证：`verify:compare` 增加 4 组比率断言（含 `4/0/12` 与 `0/0/48` 两种实测形状、以及全零时两个比率都必须是 null），`verify:stats` 从数据库独立重算构成与两个比率并逐项比对，53 项 / 0 失败，`qa:all` 全绿。

顺带记一条本轮查清但不是缺陷的事：23 条弱证据引用全部是百科词条（11）或门户首页（16），引用类复查 21 条里 4 条 matched、17 条 candidate，candidate 的理由都是「与原引用没有共同的涉税领域词」。这不是判据太严——`gradeRefCheck` 的注释写明第二道主题关正是为了挡住「土地（汉语词语）_百度百科 → 土地管理法实施条例」这类替换，且结论里取不到领域词时按「宁可漏判降为 candidate」处理。这批引用的正确处置是从结论里删掉或换成真正的政策依据，不是让机器再猜一次。

## 弱证据引用的处置建议其实已经有了，缺的是 README 里的如实交代

上一节把「23 条弱证据引用机器解决不了、界面只提供找替代来源」列成待办，本轮查证后发现前半句对、后半句不对。`delivery-check.ts` 里已经有两句针对性的处置建议：跑题的那批写「这类词条找不到同主题的官方原文，建议直接从结论中删掉，而不是花时间找替代来源」，检索过但没找到官方原文的那批写「请在结论中说明依据来源或改用政策快照」。所以缺的不是处置入口，是把这些数字与处置建议在参赛作品里如实交代出来——已补进 README 的「已知不足」一节。

两处数字更正，都以看板口径为准：

- 弱证据引用是 **23 条**（百科词条 9 + 门户首页 14），不是上一节写的 27 条（百科 11 + 门户 16）。差在没有结论的失败任务 `060b4eea`：`computePlatformStats` 有 `hasConclusion` 闸门，无结论的任务不计入引用，而它那 4 条弱证据全部来自工具留存。自己数交付文档要用的数字时必须先对上这道闸门，否则 README 就成了「看板与交付材料对不上」的反例。
- 交付自检的跑题提醒点名 **3 条**（「国家（政治地理学名词）_百度百科」「国家数据」「12366_百度百科」），其余 20 条走的是上面第二句通用建议。点名少不是判据漏了，是它刻意保守：误判会劝人删掉正当引用，所以要求「标题去虚词后与正文没有任何共同实词」两道限制同时成立。

另外更正 README 开发状态表里三行事实错误：「合同发票账簿解析与底稿填列 正在开发（Phase 3）」「研发资料解析与政策检索 待开发（Phase 4）」「真实案例测试与录屏 待开发（Phase 5-6）」。这三行与同一个表上面九行自相矛盾（解析、保留式填列、底稿比对、政策快照、联网检索都已写「已完成」），也与库里实际状态不符：`land-vat` 6 个任务、`rd-audit` 18 个任务、合计 24 个任务覆盖 20 个案例编号，两轮证据包（`data/evidence-2026-09-28`、`data/evidence-2026-09-29`）与两份测试报告都在。录屏一行改为「分镜表已完成、实拍待进行」，不替用户声称已录。

## 「服务重启打断」与「执行真的失败」不再共用一个说法

库里 3 个失败任务的错误串全是「服务重启导致执行中断」——开发期 `tsx watch` 热重载打断了执行，续跑就行，结论并没有错。但 `server.ts` 把它们与 `agent-runner` 的真失败一并落成 `failed`，于是同一个状态承担两种事实：界面上四处标签统一写「已中断」（把真失败说轻了），交付自检写「任务执行失败，结论不可用」（把重启中断说重了）。两种说法各自都只对一半，而排查时照着「执行失败」去查提示词与工具，方向就错了。

判据收成一处纯函数 `apps/web/src/task-status.ts`：`INTERRUPTED_ON_RESTART` 常量由 `server.ts` 与前端共用，改文案两边同步，不会出现服务端换了措辞、前端就认不出来。列表接口不带 `error` 全文，因此由服务端判好再给一个 `interrupted` 布尔，前端不必猜错误串。

界面按宽度分两种说法：任务页徽章夹在一排操作按钮之间，文案加长会挤动整行，所以徽章只放短标签（「失败」/「已中断」），完整说法与错误串进 `title`；复制文本与核对表没有宽度约束，用完整说法「已中断（服务重启）」/「执行失败」。看板状态分布从 4 行拆成 5 行，各自带 `title` 说明。交付自检的阻断项分成「被服务重启打断，续跑即可」与「执行失败，结论不可用」；没给错误串时按执行失败处理——宁可说得重，也不能把真失败说成续跑就行。

实测口径：失败态 3 个 = 服务重启中断 3 个 + 执行报错 0 个。`verify:dcheck` 新增 14 项，含与库里真实数据的交叉核对（列表接口的中断标记数必须等于按错误串直接 SQL 数出来的条数），124 项 / 0 失败，`qa:all` 全绿。

三个环境事实记下来免得下次误判：本机 API 与前端进程跨日会退出，需要重新拉起，`Start-Process` 要用 `pnpm.cmd`，`.ps1` 垫片起不来；前端端口是 `apps/web/.env` 里钉死的 `WEB_PORT=5174`（5173 被本机另一个项目占用），不是 Vite 漂移，别去改它，我一度连着重启两次想把它挪回 5173，是在跟用户自己的本地配置对着干；门禁输出里不要写英文 `failed`，`FAIL` 的检索默认不区分大小写，会被自己误命中。

## 更正上一节：candidate 的理由写错了，17 条里有 4 条恰恰相反

上一节说「candidate 的理由都是与原引用没有共同的涉税领域词」，这个描述本身是准确的（note 确实都这么写），但把它当成事实就错了——`gradeRefCheck` 有两道主题关，note 却不论哪道关拦下都写第一道关的措辞。逐条重算后：21 条引用类记录里 17 条 candidate，其中 **4 条的替代来源与原引用确实共用了涉税领域词「土地」**，真正拦下它们的是第二道关，即与这份结论的主题词（「合同 发票」）不相干。人工复核照着错的说明去补，只会往错的方向找。

新增 `topicGapReason`，把两道关各自的结果如实说出来，并区分两种「第二道关没过」：`与结论主题词「H」不相干` 是判定，`结论里取不到涉税领域词` 是无从判定——后者不是「判为不相干」，处置方式不同。上一节记的「不是判据太严」这个结论仍然成立，只是理由文案要按实际拦下的那一关来写。

连接词踩了两次坑，都是真实数据暴露的，记下来免得再犯：先是内层固定写「但」，overlap 为空时出来「但没有共同的涉税领域词，但与结论主题词相符」，连用两个「但」读起来像自我反驳；改成按两段肯定/否定配对之后，又发现外层模板还硬加了一个「但」，与内层的「虽」撞成「但虽与原引用…」。最终把句首连接词整体收进函数：第一道关过了用「虽…但…」，两段都否定用「但…且…」，只有第二段肯定时句首不加连接词，调用方不再补「但」。教训是这类拼接文案不能只靠单元用例，得拿库里的真实条目过一遍。

重跑引用类批量复查（2 个任务 / 12 条目标）后，库里 21 条记录：第二道关拦下 4 条、无共同领域词 11 条、病句 0 条。样例：「检索到官方站点页面，虽与原引用「土地（自然经济综合体）_百度百科」有共同涉税领域词「土地」，但与结论主题词「合同 发票」不相干，看不出谈的是这份结论的事，需人工确认后再替换」。`verify:refcheck` 509 项 / 0 失败（新增断言覆盖四种组合与三种句首连接词），`qa:all` 全绿。

## 写回流程实测翻车一次，翻出两个真问题

`writeback:evidence` 列出 9 个任务、23 条文号出处 + 2 条官方替代待补进结论。挑最小的一个（`c2dda328`，1 条素材、428 字指令）试跑，结果不是「补上出处」而是「换掉结论」：第 1 轮 1895 字、开头是「一、测算结论（工具执行结果）」、含 5 处政策文号；第 2 轮变成 3881 字、开头是「一、本轮处理范围与前置说明（请先阅读）」、只剩 2 处文号。平台合计同步掉：文号有出处 50 → 47、金额溯源项 537 → 515。脚本自己的警告响了（「写回后证据反而变少……别直接把这一轮当成果」），但数据已经落库。

**问题一：修订指令只说「改哪部分」，没说「交回什么形式」。** 原指令三条约束（只改依据与引用、不要动金额与结论意见、不要重跑业务工具）全都对，但模型交回的文本会整体成为新的结论正文，于是它交了一份改动报告，交付材料就此变成一份日志。`buildRevisionInstruction` 补上输出形式约束，并把这次实测当反例写进指令本身。

**问题二：写回脚本给不出「哪个任务改坏的」，也没有回滚出口。** 平台合计只能说明总体变少。现在逐任务对照写回前后的台账行，文号或金额溯源变少就当场告警并打出回滚命令；另加 `--restore <id前缀>`。

回滚的第一版只改了 `tasks.result`，被 `verify:revimpact` 当场抓出来——系统有一条不变量：事件流重组的最后一轮结论必须等于 `tasks.result`（状态以真实事件为准）。改成把回滚如实记成一轮：`run_started` 写明是人工回滚、`agent_text_delta` 与 `agent_text` 带恢复的正文、`run_completed` 收尾，形状与正常一轮一致，时间线与运行次数才都对得上。这是本轮最值钱的一条经验：门禁拦下的是我自己刚写错的实现，不是假警报。

数据已还原：`c2dda328` 结论回到第 1 轮 1895 字，被换下的第 2 轮 3881 字仍留在事件流里。平台口径回到文号 50/50 有出处、金额待确认 17/537；引用 94 → 95、官方 47 → 48 是那一轮核验时抓取的官方原文页留在工具记录里，属如实增加，不算污染。`verify:refcheck` 512 项 / `verify:revimpact` 145 项 / 0 失败，`qa:all` 全绿。

顺带查清一件事：生成器里写死的那些规格常量今天全部与代码一致（链接核验 8 秒超时 = `AbortSignal.timeout(8000)`、引用合并上限 24 = `MERGED_CITATION_LIMIT`、趋势快照 60 天 = `keepDays`、上传白名单 14 类、自定义模板标签 8 字 / 内容 6 字 / 每作品 8 条 = `LABEL_MAX` / `TEXT_MIN` / `MAX_CUSTOM_TEMPLATES`）。所以那只是防未来漂移，不是活缺陷，优先级低于本轮这两处。

**写回的正确用法**（下一个会话照这个来，别再整批跑）：先 `--print` 人工核对指令，再 `--task <前缀> --run` 一个一个跑，跑完看那一条的「修订影响」与逐任务告警；一旦文号或金额溯源变少就 `--restore <前缀>`。目前 9 个任务里 7 个的素材全是已 matched 的官方原文、不含待人工判断项，适合先跑；`eb75f4fb`（待人工标注 5）与 `4bb22d34`（待人工标注 8）含需要人判断的项，建议留在最后。

## 写回翻车的根因不在指令，在续跑拿不到上一轮正文

上一节把问题归到「指令没说交回什么形式」，只说对了一半。加了输出形式约束后重跑同一个任务，模型这次把话讲明白了，第 4 轮开头第一句是：「我没法按要求交回『完整结论正文』，原因必须先讲清楚：**上一轮的结论正文、表格、金额、mermaid 图与工具返回记录都不在当前会话上下文里**，本任务目录也无法通过我的读取工具访问（`file://` 被拒，仅支持 http/https）」。

查会话目录印证了：`data/sessions/c2dda328-…/` 下只有修订这一轮的 jsonl，原始那轮没留存，`SessionManager.continueRecent` 找不到历史就开了新会话。所以「交回完整结论」这个要求在当时的前提下不可能满足——它手里根本没有那份结论。指令约束方向是对的，缺的是前提。

修法：`agent-runner.ts` 的续跑提示词一律把 `task.result` 原文嵌进去，不依赖会话恢复；没有上一轮正文时如实写「本任务此前没有结论正文（上一轮未产出或被中断），请按上面的要求直接产出完整结论」，不假装有的可改。

同一个任务重跑验证：用时 296 秒，文号 5/5 有出处（翻车那次是 3/3）、引用 3 → 8 条全官方、金额溯源 537 → 541（翻车那次是 -22）、修订影响由「有增有减」变成「证据质量改善」，逐任务告警未触发。新结论 6844 字，开头仍是「一、测算结论（工具执行结果）」，原有三章全保留，只在「二、政策依据」下新增（一）各依据文件的原文页出处与检索时间、（二）联网引用清单、（三）政策依据核验记录与资料缺失说明。

随后按上一节的用法把 6 个不含待人工判断项的任务逐个跑完（用时 90 至 334 秒），修订影响全部「证据质量改善」，无一次告警。平台口径：引用 95 → 122、官方 48 → 76、弱证据 23 条不变、金额溯源 537 → 543。剩 `eb75f4fb`（待人工标注 5）与 `4bb22d34`（待人工标注 8）未跑。

## 逐任务告警漏掉的一类：新增无出处文号

写回后文号从 50/50 变成 50/57、待复查 0 → 7。模型补出处时把来源文件自己提到的其他文件也写进了结论，文号总数不降反升，而上一轮加的告警只查「变少」，于是一次都没响。已补判据：按无出处文号数的前后差告警，并说明这类不是改坏而是新欠账，跑一次文号批量复查即可，不必回滚。

跑了文号批量复查（2 个任务 / 7 条 / matched 1），剩 6 处补不上：`2018年第31号`、`〔2008〕116号`、`2018年第23号`、`2020年第24号`、`2021年第34号`、`2025年第1号`。它们不是幻觉——`2021年第34号`《国家税务总局关于企业所得税年度汇算清缴有关事项的公告》、`2020年第24号`《国家税务总局关于修订企业所得税年度纳税申报表的公告》都是真文件，只是被写成了不带机关的光杆形式；不在已核实索引里，「唯一同字号复用」够不着，`policyDocNumQuery` 又因缺机关返回空串、整条政策法规库路径被跳过，只能退回通用检索，捞回来的是生态环境部与国家统计局的页面（`.gov.cn` 一律分级 official），判为 candidate 交人工确认。

## 一个试过但不能用的做法：光杆文号靠年份过滤加后缀唯一去定位

想法是把「唯一性」判据从本地索引扩到政策法规库本身：用制定年份过滤，再要求返回结果里结构化发文字号以该光杆文号结尾的完整字号唯一。实测 6 处里 2 处能定位（`2020年第24号`、`2021年第34号`），但**这个判据不成立**：这两次的 `total` 分别是 110 与 129，接口每页只回 10 条，「前 10 条里后缀唯一」推不出「全库唯一」——别的机关同样有「2020年第24号」，它只是没排在前十。照着它认定就等于猜机关，正是本项目从 `matchPolicyDocNum` 到 `reusableDocNum` 一路明令禁止的事。分页也救不了：`pageSize` 被接口忽略，只有 `pageNum` 有效，`total=165` 要翻 17 页，而翻不完就仍然只是「部分结果里唯一」。

要救这 6 处，唯一站得住的路子是加上下文佐证：要求候选原文页的标题与结论里该文号所在那段话有共同涉税领域词（`domainOverlap` / `onTaskTopic` 已有），再叠加年份与光杆文号两个条件。本轮没做，因为它需要新的实网样本验证误判率，而收益只是 6 处欠账——这 6 处目前是**可见的**欠账，看板、台账与交付自检都一直挂着，没有被藏起来。

## 更正上一节的归因：6 处里有 4 处，机关明明就写在结论里

上一节把 6 处补不上出处的文号归因为「不在已核实索引里、机关不明」，还断言唯一站得住的路子是加上下文佐证。把结论原文逐条调出来看，发现只有 2 处成立，另外 4 处是提取环节把机关丢了：

| 文号 | 结论原文 | 丢在哪 |
| --- | --- | --- |
| `2018年第23号` | 「用加计扣除按国家税务总局公告2018年第23号执行」 | `refPrefix` 把紧邻文号的整段中文当成机关 |
| `2018年第31号` | 「款表述经国家税务总局公告2018年第31号修改」 | 同上 |
| `〔2008〕116号` | 「同时废止国税发〔2008〕116号」 | `trimEdgeWords` 剥得掉「同时」剥不掉「废止」 |
| `2020年第24号` | 首次「先后被 2020年第24号、2021年第34号 部分废止」，第二次「申报说明先后被国家税务总局公告2020年第24号」 | `extractDocRefs` 按核心去重只留首次上下文 |

三处修法：

1. `refPrefix` 截机关。先试「机关结尾字 + 文种词」的正则，被贪婪匹配坑了——「扣除按国家税务总局公告」整体也满足「若干字 + 局 + 公告」，截出来还是带着结论自己的话。改成按已知机关词表取最长后缀匹配（`KNOWN_AGENCIES` 按长度倒序，先剥掉文种词再找机关）。词表是有限的领域知识，宁可列出来，也比一条看着通用、其实贪婪的正则可靠。
2. `LEAD_WORDS` 补上「废止 / 修订 / 修改 / 作废」。`plausibleAgency` 本来就会拒掉「废止国税发」，但 `refPrefix` 不走这道检查，于是照样拼出一个不可能全等的检索词。
3. `extractDocRefs` 记录每一处出现的上下文（`contexts`，最多 8 处），去重键仍是 `core`，落库主键与既有记录不受影响；`refCheckTargets` 用 `bestRefContext` 挑一个能构造出可信机关的，挑不到就沿用首次，由「机关不明就不猜」那道口径兜住。

顺带给 `policyDocNumQuery` 补上 `plausibleAgency` 这道闸：「研发费用加计扣除财税」这种把关键词与机关黏在一起的串不再拿去检索。`plausibleAgency` 的注释里早就点了这个例子，只是当时只有 `reusableDocNum` 在用它。

实测：批量复查 5 条命中 3 条，未 matched 的文号 6 → 2；平台文号有出处 51 → 55/57、待复查 6 → 2、复查到出处 26 → 31、缺口任务 6 → 5。`verify:refcheck` 531 项 / `verify:policytrace` 65 项 / 0 失败，`qa:all` 全绿。

剩下 2 处（`2021年第34号`、`2025年第1号`）全篇确实没有机关，只出现在「先后被 2020年第24号、2021年第34号、2025年第1号公告部分废止」这个清单里，通用检索给它们捞回的还是国家统计局页面。上一节关于「不能靠部分结果唯一性认定机关」的结论仍然成立，所以如实留作可见欠账；但上一节说「唯一站得住的路子是加上下文佐证」是错的——真正该先做的是把提取环节修对，那 4 处根本不需要任何推断。

一条方法论教训：上一轮把「补不上」归因到数据（不在索引里、机关不明），没有去看结论原文。把原文调出来只花了一条命令，归因立刻从「需要设计一套新的推断机制」变成「提取环节有 bug」。**先读原始文本，再设计机制。**

## 9 个可写回任务全部跑完，顺带查出修订影响按截断窗口算的假警报

含待人工标注项的最后两个任务也跑完了：`eb75f4fb`（用时 123 秒，引用 24 条、官方 11、修订影响改善）与 `4bb22d34`（用时 266 秒，引用 24 条、官方 6）。后者一开始被判「证据质量退步」，逐条比对前后两轮才查出是度量缺陷，不是修订真的改坏了。

`evidenceSnapshot` 用 `extractTextCitations` 的默认上限（`CITATION_LIMIT = 20`）取数，而该任务结论正文里的地址从 22 条增到 26 条，前 20 条窗口整体挪动，官方原文被算成 11 → 10。全量其实是 official 11 → 13、weak 9 → 11：本轮真加了 2 条官方原文，同时多 2 条弱证据（标注「仅作背景参考」时把原地址一并列了出来）。截断是界面需要，度量不该跟着截断——`search-evidence.ts` 增加 `UNCAPPED` 常量并写明理由，`evidenceSnapshot` 改用它，`EvidenceSnapshot.citations` 的注释同步改成「不截断：这是度量口径，不是界面清单」。

改完 `4bb22d34` 由「证据质量退步」变成「有增有减」（官方 +2、弱 +2，与事实一致），全平台退步 0 个、改善 8 个。`verify:revimpact` 新增 5 项断言：构造正好卡在上限 20 条的上一轮，再补 2 条官方原文，断言全量 22 条 / 官方 13 / 弱 9 / 判定为改善。177 项 / 0 失败，`qa:all` 全绿。平台口径：文号 55/57 有出处、待复查 2、引用 129（官方 80 · 弱 23）、缺口任务 5 个。

两处如实记下：

- `eb75f4fb` 触发了逐任务告警「金额溯源 -1 项」，但修订影响判为改善，且修订模式在机制上已摘掉会重写产物与比对记录的工具，因此保留不回滚。告警是提示去看，不是一律回滚。
- 台账与看板上的引用数仍按 `MERGED_CITATION_LIMIT = 24` 截断，所以对超过 24 条引用的任务，看板「引用数」与真实地址数不一致（`4bb22d34` 结论正文里实际 26 条、台账显示 24 条）。这一处**没有**跟着改成全量：界面胶囊列的就是那 24 条，看板与界面必须对得上，这是本项目反复强调的口径一致。代价是这类任务的弱证据条数会被低估，要彻底解决得让界面写明「共 N 条，已列前 24 条」，是下一轮的活。

## 度量按全量、显示才截断：上一节那处取舍已撤销

上一节把 `evidenceSnapshot` 改成不截断，只堵了一个口子。同一条链上还有三处按界面清单上限算度量：结果页的分级汇总（`ResultView` 自己 `summarizeGrades(citations)`）、平台统计与台账、弱证据待办清单。上限（`MERGED_CITATION_LIMIT = 24`、`CITATION_LIMIT = 20`）本来是胶囊列表的显示需要，度量跟着截断就会少算，而且结论越长少算越多。

改成两份清单分工：`allCitations` 不截断，供分级汇总、交付自检、整页 MD、manifest、链接核验、BibTeX 与引用清单导出、页签角标、平台统计与台账使用；`citations` 仍是前 24 条，只用于渲染胶囊。界面在分级那一行写明「共 N 条，下方列出前 24 条」，不让人以为清单就是全部。`pendingCitationTargets` 也改成全量取——排在上限之外的弱证据此前永远进不了待办清单，看板上的缺口数因此比实际少。

实测口径变化：引用 129 → 140 条、官方来源 80 → 89 条、弱证据 23 条不变（弱证据本来就没被截断掉）；来源拆分由「工具留存 54 + 结论正文 40」变成「68 + 72」。也就是说此前有 11 条引用、9 条官方来源一直被上限挡在统计之外，而作品说明里写的正是这些数字。

上一节记的那处取舍到此撤销：真正的矛盾不在「截断还是不截断」，而在**同一个数被同时当成显示清单和度量**。分开之后两边各取所需——界面写明总条数、度量按全量，看板与交付材料反而更对得上了。当初把它记成「不能改」，是因为把「界面与看板要一致」错听成了「界面与看板要用同一个截断」。

门禁如实拦了一次：改完 `verify:stats` 报两份作品说明与实时口径不符（正是前面加的同源门禁），重生成后 `qa:all` 全绿。`verify:ledger` 70 项 / `verify:stats` 53 项 / 0 失败。

## 第一次真跑链接核验，牵出引用提取把中文尾巴当成地址的一部分

`link_checks` 表此前是**空的**——24 个任务、上百条引用，一次都没核验过，而作品说明里写着「引用可核验」。把全部任务的引用走真实接口核了一遍，146 条里 23 条 dead，其中多条正是政策法规库原文页，也就是平台当作「已核实官方证据」存着的那些地址。用浏览器 UA 直接请求其中四条，全部 200：链接是活的，坏在提取环节。

落库的状态码把真相摆了出来，失败的地址长这样：`…c5193854/content.html／2026-09-2`、`…c5201978/content.html（检索时间`、`…c5213565/content.html（**检索时间`。裸地址正则 `/https?:\/\/[^\s)\]>"'|，。；、]+/g` 只在空白、半角括号与几个中文句读处停，全角括号（U+FF08）、全角斜杠（U+FF0F）和后面的中文都不在停止集里，于是整段被当成地址。后果有三层：核验必然 404；同一个原文页被重复计成两条引用；路径不以 `/content.html` 结尾，于是 `isPolicySourcePage` 认不出它是政策法规库原文页，分级只能落到泛泛的「政府站点具体文件页」。

修法：加 `URL_TERMINATOR`（全角与中文标点 U+3000–U+303F、全角形式 U+FF00–U+FFEF、弯引号、破折号、省略号），遇到即截断。**不按「非 ASCII」一刀切**——路径里带未转义中文的地址真实存在，既有用例 `https://a.cn/p/研发费用指引.html` 就是，切掉会把好地址截坏；汉字不是终止符，只有标点才是。清理逻辑抽成 `cleanBareUrl` 供提取与验证脚本共用：验证脚本此前自己抄了一套正则，口径一改两边立刻对不上，当场报了 20 项「结论正文的 URL 未进入引用清单」——同一件事写两遍，迟早漂，这次就是现场。工具留存那条路（`urlsOfCall`）也带上同一份清理，实测它同样收进了 `…guoshuifa200991.pdf（检索时间` 这种假地址。

口径变化：引用 140 → **125** 条、官方来源 89 → **77** 条（去掉的都是重复计数的假地址），弱证据 23 条不变。清掉库里 17 行含全角标点的假地址后重跑核验：131 条链接，可访问 101、反爬拒绝 20、无法核验 6、**真失效 4**——`www.chinatax.gov.cn/chinatax/n810356/n3010387/c5185946`（解读页，出现在两个任务）、`fgk.chinatax.gov.cn/zcfgk/c100012/c5197939`、`guangdong.chinatax.gov.cn` 2010 年一篇。这 4 条才是交付前真该替换的，此前它们被 19 条假地址埋在下面。

顺带修的三处，都是这一轮撞出来的：

1. `link_checks` 只 upsert 不删行，结论改过之后旧地址的记录还挂在库里，而 `linkSummary` 是按库里全部行汇总的，于是早已不在清单里的地址会被算成「失效」，交付自检跟着报假警。改成只汇总当前引用清单内的地址。
2. `linkVerdict` 的拒绝码集合太窄：412 被判成「链接失效」。可本项目发的是不带任何 `If-*` 前置条件头的普通 GET，服务端却回 412，实测是省级税务机关站点的 WAF 在挡自动访问（`xinjiang` / `etax.xinjiang` / `beijing` / `liaoning` 四个 `chinatax.gov.cn` 子站全是这个码）。按既定口径反爬不计入交付风险，判成失效就会在交付自检里变成假阻断，逼人去替换一条其实有效的官方链接。412 归入 blocked，521 一类非标 5xx 仍归 unreachable，各加一条断言。
3. 引用清单改成全量后条数可能超过接口单次 30 条上限（实测 `4bb22d34` 有 34 条），服务端 `slice(0, 30)` 会静默截断，少核的那几条在界面上永远显示未核验，而清单标题写着总条数。上限抽成前后端共用的 `LINK_CHECK_BATCH`，前端按它分块顺序跑；接口返回的是该任务全部已核验记录，取最后一批即为全量。

`verify:searchev` 283 项 / `verify:links` 29 项 / 0 失败，`qa:all` 全绿。

一条方法论：这一整串问题是从「表是空的」开始的。一个从未在真实数据上跑过的功能，它的口径正确性其实没有被验证过——**先把没跑过的路径跑一遍，比继续打磨已经跑通的路径更容易挖出真缺陷**。

## 失效链接有了修复通道，随即撞出「作废交代写在地址后面」的漏判

上一节查出的 4 条真失效链接，此前只能被发现、不能被修复：交付自检会提醒「失效链接交付前请替换」，但没有任何一条路径把它送进修订指令，唯一出路是人工去改结论正文。现在 `deadLinkTargets`（`apps/web/src/ref-check.ts`）把判为 dead 的地址送进 `buildRevisionInstruction` 新增的【替换失效链接】段，写回脚本（`apps/api/scripts/writeback-evidence.ts`）与结果页「生成修订指令」按钮共用同一条路径，素材计数也把失效链接单列一项。两道过滤缺一不可：只取判为 dead 的（反爬 401/403/405/412/429 与网络不可达都不算失效，按既定口径写进指令会逼人替换一条其实有效的官方链接）；只取仍在**结论正文**引用清单里的地址（`link_checks` 按 `(task_id, url)` upsert 从不删行，回滚过的轮次会留下残留，实测就有一行来自被回滚那一轮的工具留存，结论里早已没有它，列进指令模型无从下手）。

三个任务续跑之后逐条回读，失效地址确实撤下了、换成了实际调取全文核对过的活页，并留了作废交代。但 `4bb22d34` 上同一条 `c5185946` 仍挂在引用表里（第 19 行），于是修订指令又把它列了出来，模型白跑一轮 300 秒。把正文调出来看，两处交代的形式不一样：

- 前置：`> **失效地址说明：** 原引用《研发费用税前加计扣除政策即问即答》 https://…c5185946/content.html 经服务端 GET 核验返回 4xx，不再作为依据引用`；
- 后置：替换映射表的一行 `| 19 | …即问即答_国家税务总局 https://…c5185946/content.html（**服务端 GET 返回 4xx，地址已失效**） | 《…即问即答_政策解读_中国政府网》 | https://www.gov.cn/zhengce/2023-04/02/content_5749772.htm | 2026-09-29 |`。

`isRetiredMention` 只往前看 40 字，后置那种整条漏判——已经换好的地址又被当成当前引用，失效链接修一次报一次，正是这个函数本来要打破的循环，只是标记长在了另一侧。

修法是把判定改成双向，但**两个方向的词表必须分开**：「已替换为」「不再引用」「不再作为」写在替代地址**前面**时收进来会误杀刚换上的有效地址（前置词表第一版正是这么错的，测试当场抓出来），写在旧地址**后面**时它恰恰是在交代旧地址的下场，必须收。往后看的范围还要收得住：遇下一个地址、遇换行、或超出 40 字即止，否则会把下一行、下一段的说明算到这一条头上。裸「失效」二字不进词表，实测正文里有「同栏目其他页面存在同类失效风险」这种泛泛说法，收了会误伤。调用点同步把地址长度传进去（提取处与验证脚本各一处，两边同源）。

口径变化：引用 139 → **137** 条、官方来源 91 → **89** 条（去掉的正是那两条已作废地址），弱证据 22 条。`deadLinkTargets` 从 1 条回到 **0**，交付自检不再报这条假警。4 条 dead 行的现状：3 条仍出现在结论里、但都只在作废交代中出现，1 条（`c2dda328` 的 `c5197939`）已完全不在结论中。顺带跑了一轮文号批量复查（`tasks=2 ran=4 matched=1`）补新增的光杆文号，当前平台口径：文号 **57/60** 有出处、待复查 3、引用 137（官方 89 · 弱 22）、缺口任务 5。`verify:searchev` 305 项 / `verify:refcheck` 544 项 / 0 失败。

一条方法论：**「指令已发出」和「正文已改对」之间还有一段距离，续跑之后必须回读验证**。这一轮的修订影响判定是「证据质量改善」，统计也确实在变好，那条该撤的地址却还原样躺在引用表里；只看跑完没跑完、只看影响标签，会把它当成已修复。

## 交代过的项还在被反复催办：弱证据的欠账要按「待处置」算

接着处置剩下的 22 条弱证据引用。先跑批量找官方原文（`kinds:["citation"]`、预算 30）：13 次复查、**0 条 matched**、11 条 candidate、2 条 empty。逐条看清单才明白为什么一条也替换不成——它们大多是「土地（汉语词语）_百度百科」「国家（政治地理学名词）_百度百科」「国家政务服务平台」「国家数据」这类泛词条与门户首页，本来就没有「同主题的官方原文」可换；候选页也只是话题相近（知乎话题页、高校图书馆镜像入口、地方局栏目页），判不成 matched 是对的。

再看这些地址在结论里的处境，发现了真问题：`4bb22d34` 的结论里已经有一节「五、未取得公开原文的项目」，用表格逐条写明地址与「**未取得公开原文，仅作背景参考，不作为政策依据**」——正是修订指令要求模型写的那句。也就是说这 8 条**早就交代过了**，可是：

- 写回脚本的注释明写着这类素材「没有地址可比，仍会列出，由人工决定」，于是每轮续跑都把同样 8 条重新交代一遍。实测今天那一轮 300 秒里，模型把同一节表格原样重写了一遍，而真正该做的替换失效地址反而漏了；
- 批量复查的候选清单也照旧收它们，13 次联网检索里多数花在了已经交代过的项上；
- 看板与台账把它们算成欠账：缺口任务 5 个、弱证据 22 条，其中一大半其实已经处置完毕。

修法是把「已交代」做成一份共享判据，而不是各处自己数一遍。`isDisclaimedInConclusion`（`apps/web/src/ref-check.ts`）认两种形态：交代用语与地址**同一行**（表格行），或地址位于**已声明的章节**之内（标题含「未取得公开原文／仅作背景参考」，管到下一个标题为止）。窗口只到行首行尾，不跨行——跨行会把下一行的交代算到上一行头上，密集表格里错得很快。在此之上：

1. `pendingRevisionItems` 把 candidate／empty 且已交代的素材挡在修订指令外（写回脚本与结果页按钮共用）；
2. `pendingCitationTargets`（服务端）与 `weakTargets`（结果页）都不再把已交代的弱证据送进联网复查——这类词条永远判不出 matched，检索一次纯属浪费预算；
3. 台账 `rowGap` 的欠账改成「待处置弱证据 + 待复查文号」，新增「已声明背景参考」一列；缺口清单的入选条件同步改成「还有待处置的项」，`weakCitations` 仍报总数、另带 `weakDisclaimed`，总数不被藏起来；
4. 交付自检的提醒按待处置条数给（`weakOpen`），已交代的部分单独给一条正向说明；证据核对表的「尚有 N 条待处置」与待办分组同口径，整页 MD 与看板文案都写明「其中 N 条已在结论中声明为背景参考」。

实测口径变化：弱证据仍是 22 条（一条没藏），其中 **13 条已在结论中声明为背景参考**，待处置 **9 条**；缺口任务 5 → **4**（`eb75f4fb` 的 5 条弱证据全部已声明，整个任务退出缺口清单）；`4bb22d34` 的写回素材从「8 条 · 待人工标注 8」降到「2 条 · 待人工标注 1」；再点一次批量复查是 `tasks=0 ran=0`——没有待办就不花预算。证据核对表走查 24 个任务、13 条已声明，`verify:sheet` 283 项 / `verify:ledger`、`verify:refcheck`、`verify:dcheck`、`verify:stats` 全 0 失败。

一条方法论：**「提醒」类功能必须自带「已处置」判据，否则它会把自己催办的事情变成永久待办**。这一处与上一节的失效链接假警报是同一个病：判定只看素材本身（地址、标题、分级），不回读结论里已经写下的处置结果，于是每跑一轮就多催一次。凡是「按清单催人办事」的地方，都得先问一句：这件事办完之后，清单会不会自己少一条？

## 留痕不是欠账：只在检索留存里的弱证据不该催人替换

上一节把「已声明为背景参考」的 13 条分出去之后，还剩 9 条待处置弱证据。逐条查它们在哪儿，发现其中 **6 条的地址从未出现在结论正文里**，只存在于工具留存的检索结果中（`7459b28a` 的「研发_百度百科」「研发投入（用于研究与试验发展的资金投入）_百度百科」，`4bb22d34` 的新疆电子税务局两条、12366「网上办税」与「12366_百度百科」）。真正被结论当依据引用的只有 3 条。

引用清单是「工具留存 + 结论正文」两份合并的，这是刻意口径，不该改：检索看到过什么也是留痕，证据力分级要覆盖全部，交付包里也确有这些调用记录。但**欠账不是留痕**。一条从没被写进结论的百科词条，既不是这份交付材料的依据，也没法在结论里给它补一句「仅作背景参考」——把它列进待办、列进修订指令、拿联网预算去给它找替代来源，催的是一件无处可做的事。这与既有判例同源：没有结论的任务不计证据欠账（失败任务 `060b4eea` 带着 5 条引用、4 条弱证据进台账那一次）。

修法沿用上一节的形状，一份实现接进五处消费点：新增 `uncitedWeakUrls`（弱证据里未被结论引用的地址）与 `settledWeakUrls`（= 已声明 ∪ 未进结论），修订指令、服务端复查候选清单、结果页检索清单与待办、台账欠账与缺口清单、交付自检与核对表文案全部改按「待处置」说话。两处实现细节是实测逼出来的：

1. 判「进没进结论」用 `extractTextCitations` 的结果集，不用 `includes` 直接搜原文。提取走过同一份清理与截断规则（全角标点、markdown 链接、裸地址都一致），也天然排除「原引用 X 已失效」这类作废交代——只被作废交代提到的地址同样不算在用，否则会跟上一节那个修复互相打架。
2. `uncited` 计数要扣掉与 `disclaimed` 重叠的部分（按**标题**认出的交代，地址可能并不在正文里），三个数才刚好加回弱证据总数。不扣就会破坏「总数 = 已声明 + 未进结论 + 待处置」这条不变量，门禁里两个断言会当场对不上。

`pendingRevisionItems` 也接了同一道过滤：引用类素材先看 `subjectUrl` 在不在结论的引用集里，不在就不列进【标注未取得原文】——正文里没有它，模型收到指令也只能凭空写一句与结论无关的交代。

实测口径：弱证据仍 **22** 条（一条没藏）= 已声明 13 + 未进结论 6 + 待处置 **3**；缺口任务 4 → **3**（`7459b28a` 的 2 条弱证据都只在检索留存里，整个任务退出缺口清单）；证据核对表走查里「仍有交付前待办」的任务 4 → 3；台账新增「未进结论正文」一列，欠账 = 待处置弱证据 + 待复查文号。剩下 3 条待处置分别是 `4bb22d34` 的「研发_百度百科」「研发 - MBA智库百科」与 `17a56468` 的政策法规库**栏目页**（不是具体文件页，判弱是对的，该换成对应文件页）。`verify:refcheck` 571 项 / `verify:dcheck` 131 项 / `verify:sheet` 283 项 / `verify:ledger` 85 项 / `verify:stats` 全 0 失败。

一条方法论：**看到一个「待办」数字，先问它在催人做什么；如果那件事根本无处可做，它就不该进这个数字**。留痕口径要全（检索看到过什么都记下来），欠账口径要窄（只算交付材料真需要处置的），两者共用一份引用清单但各算各的数——把它们混成一个数，就会一边虚报欠账、一边把真该改的 3 条埋在 22 条里面。

## 看板说有缺口、按钮点了没反应：四处「发现通道」与「修复通道」不同源

接着处置最后 3 条待处置弱证据，一路撞出四个同一形状的缺陷——都是某个口径在一处更新了、另一处没跟上。

**一、服务端候选清单与缺口统计不同源。** 点「批量找替代来源」对 `17a56468` 返回 `ran=0`，可看板上它明明挂着 1 条缺口。查下来：`pendingCitationTargets` 只从**工具留存**取引用，而缺口统计与结果页用的是「工具留存 + 结论正文」的合并清单。那条引用是政策法规库**首页** `https://fgk.chinatax.gov.cn/`，模型在修订时直接写进了正文，工具留存里没有它——于是它有缺口、没通道。函数头上的注释还写着「与结果页同一口径」。改成同一份合并清单，顺带去掉「没有工具调用就不进清单」那道早退（合并之后结论引用可以独立成立）。

**二、配额在过滤之前切。** `citationTargets` 先切前 10 条、再由调用方过滤已处置项。`4bb22d34` 有 14 条弱证据、其中 12 条已处置，切片时前 10 条正好全被已处置项占满，真正该办的两条百科词条永远进不了清单，批量入口对它同样 `ran=0`。把 `exclude` 作为参数传进去、切片**之前**剔除，配额才花在待办上。

**三、查不到出处的素材被一律要求「标注为背景参考」。** 这与交付自检对同一批引用的建议正好相反（自检说的是「这类词条找不到同主题的官方原文，建议直接从结论中删掉，而不是花时间找替代来源」）。更糟的是模型照指令写下的那句声明会把词条**合法化**：它从此算「已声明的背景参考」，不再被催办，一条本该删掉的泛词条就这么永久留在交付材料里。改成按分级理由分派三段——【删掉泛词条引用】（百科词条、问答社区）／【改引具体文件页】（门户首页、栏目页、检索结果页）／【标注未取得原文】（其余，主要是文号），与自检同源；`revisionCounts` 相应给出 `drop／narrow／mark` 三个分项，写回脚本与界面提示都按分项报数。

**四、「已写回」判据太松。** 脚本原先只认「替代地址是否出现在正文里」。实测 `4bb22d34` 那两条百科词条复查判定是 `matched`、官方原文也确实进了结论，但**原百科链接原样留着**——替换只做了一半，弱证据一条没少，而脚本因为「已写回」从此不再提这两条。判据挪进共享的 `pendingRevisionItems`：替代地址进了正文、且原地址已从结论引用清单里消失，才算写回；只在正文里加了新地址、旧的还在，就继续列进指令（走【替换弱证据引用】那一段）。

**措辞也得跟着硬起来。** 判据修好后重跑，模型仍然只补不删——同一批词条连续三轮如此。原话是「请在结论正文与联网引用清单中替换」，改成「请把原来那条引用**整条删掉**（正文与联网引用清单里都不留），改用下面的官方原文……不要新旧两条并列保留：并列等于交付材料里仍挂着一条证据力弱的引用，平台会继续把它算作待处置欠账，下一轮修订指令还会再列一次」。这一轮模型照做了：回读正文，`研发_百度百科` 的地址出现 **0** 次、MBA智库 **0** 次，剩下的 2 处 `baike.baidu` 提及都在「未取得公开原文的项目」声明表里（属已声明，不是活引用）。

实测共跑了两轮写回、7 个任务次（`eb75f4fb` 130 秒、`aabd138a` 312 与 316 秒、`ff4c9a3c` 113 秒、`17a56468` 180 秒、`4bb22d34` 182 与 246 秒），修订影响全部「证据质量改善」，无回滚。平台口径：引用 137 → **152** 条、官方来源 89 → **105** 条、弱证据 22 → **21** 条（已声明 13 · 未进结论 8 · **待处置 0**）、文号有出处 57/60 → **60/68**、缺口任务 3 → **1**（只剩 `aabd138a` 的 8 处待复查文号）。每轮写回都会新增几处无出处文号（模型引用了来源文件里提到的其他文件），跑一次「批量复查文号」即可补齐，属既定处置、不算退步——本轮两次批量复查共 `ran=12 matched=4`。

一条方法论：**凡是一个数字同时驱动「显示」和「行动」，两处就必须共用同一份实现**。这一节四个缺陷全是同一个形状：看板说有缺口、按钮点了没反应；或者指令催的事与自检建议的事相反。这个仓库里已经是第四次踩到它（前面三次：清理逻辑两份、度量按截断窗口算、验证脚本自己抄正则）。

写回把结论改长之后，门禁自己报了一次假警，顺带修掉：`verify:searchev` 的真实任务走查用**带上限**的引用清单（单来源 20、合并 24，那是界面胶囊的显示需要）去断言「结论正文里每条 URL 都进了清单」，守卫写的是「合并总数没触顶就全查」。`aabd138a` 写回后结论里的 URL 超过 20 条，`textCites` 被截断、合并总数却仍未触顶，守卫放行，于是排在截断线之外的两条地址被报成「提取漏项」。完整性断言改用全量清单（`UNCAPPED`），守卫一并去掉，走查报数也换成全量口径——「度量按全量、显示才截断」这条既有口径，在验证脚本里同样适用。检查项从 346 涨到 437（守卫拿掉后断言真的跑起来了），0 失败。

## 文号这条线收口，顺带修掉「越听话分数越难看」的修订影响判定

`aabd138a` 剩 8 处待复查文号。批量复查 `ran=8 matched=7 empty=1`，写回（443 秒）后该任务文号 22/28 有出处、平台 67/73、待复查 6。再跑一轮复查：`ran=6 matched=0`（5 处未检索到、1 处候选）——剩下的确实查不到公开原文，多为来源文件自己引用的其他文件，于是走设计好的第三条路：让写回把它们在结论里标注为「未取得公开原文，仅作背景参考，不作为政策依据」。第三轮写回（444 秒）后该任务文号 25/28、平台 **70/73**、待复查 3，写回清单已经空了（`没有可写回的复查结果`：能补出处的都补了，查不到的都标注了）。

但第三轮的修订影响判成了**「证据质量有增有减，请核对本次修订」**。回读正文：新增的 2 条弱证据（`baike.taxrefund.com.cn` 两页）已经被模型当场写进「未取得公开原文」表里标注为背景参考，全平台待处置弱证据仍是 **0**。也就是说，这一轮做的恰恰是修订指令要求的事，却被判成质量有增有减、要求人工核对。

根因与今天前面几处同源：`evidenceSnapshot`／`evidenceDelta` 比的是弱证据**原始条数**，没扣已声明的。修法：快照加 `weakDisclaimed`（用同一份 `disclaimedWeakUrls` 按该段正文算），差值加 `weakOpen`（待处置变化），`improved`／`regressed` 改按 `weakOpen` 判；`deltaDetail` 拆出独立一段「其中已声明为背景参考 a → b、待处置 ±n」，原有的「弱证据引用 X → Y（±n）」文案原样保留（交付 MD、界面提示与既有断言都在用它）。退步的情形并没有被放过：新增弱证据**没有**声明时 `weakOpen` 上升，照旧判退步——两个方向各加断言。实测 `aabd138a` 的修订影响从「有增有减」翻回「证据质量改善」，`verify:revimpact` 184 项 0 失败。

平台口径（本日累计）：引用 152 → **169** 条、官方来源 105 → **113** 条、弱证据 **23** 条（已声明 15 · 未进结论 8 · **待处置 0**）、文号有出处 60/68 → **70/73**（其中 29 处靠联网复查取得）、待复查 **3**（均已在结论中标注未取得公开原文）、缺口任务 **1**。

顺手清了作品说明里的写死数字：引用清单上限改取 `CITATION_LIMIT`／`MERGED_CITATION_LIMIT`，批量预算改取 `batchBudgetText()`，并删掉两处早已过期的实测绝对数（「真实任务引用从 29 条升到 40 条」「结论正文 50 条、工具留存 40 条、合并去重后 72 条」）。同一份文档里一边承诺「看板与交付材料不会对不上」，一边写着对不上的数字，它自己就成了反例——这正是 `materials-lib.ts` 当初把数字改成生成时取数的理由，散文里残留的绝对值是同一笔欠账。

一条方法论：**判断「这轮修订有没有把证据改好」，必须用与欠账口径同一个「待处置」数**。否则模型越听话——如实标注查不到原文的项目——原始弱证据条数越涨，评分越难看，最后逼人回滚一次正确的修订。今天这是同一形状的第五处（清理逻辑两份、度量按截断窗口算、验证脚本抄正则、发现通道与修复通道不同源、修订影响按原始条数算）。

## 文号侧同一条原则：已标注「未取得公开原文」的不算欠账，缺口清单归零

上一节收口之后只剩 1 个缺口任务：`aabd138a` 的 3 处待复查文号。回读正文，这 3 处已经逐条标注了「未取得公开原文，仅作背景参考，不作为政策依据」——查不到公开原文时这就是设计好的收口。可 `docRefPending` 不认标注，于是缺口清单永远挂着它，交付自检也一直提醒「3 处政策文号未找到公开出处，需人工确认依据后再交付」，把这个任务钉死在「谨慎交付」。

修法与弱证据侧完全同构，而且**共用同一个判据函数**（`isDisclaimedInConclusion`），只是包了一层 `labeledDocRefTexts`。贯通的地方：`stats` 出 `docRefLabeled`（平台汇总与缺口构成各一份）；台账新增「已标注未取得原文」一列，欠账改成「待处置弱证据 + (待复查 − 已标注)」；交付自检按类别拆开算（`untraced`／`unverifiable` 各自只报还没标注的），标注过的单独给一条正向说明，全部标注完的任务不再被降级；核对表的溯源说明与「尚有 N 处没有出处」都按待处置数说话；结果页文号徽章的琥珀色改看待处置数、待办清单不再列已标注项；看板文案、缺口胶囊、两个批量按钮、台账汇总行一律按待处置数报，同时把「已标注 M 处」写出来。

实测：`docRefLabeled = 3`、待处置文号 **0**、**缺口任务 0**（今天从 5 一路降到 0）；核对表走查 24 个任务「**0** 个仍有交付前待办」。缺口归零不是把数字做小：弱证据 23 条一条没藏，只是分成「已声明 15 · 未进结论 8 · 待处置 0」，文号 73 处分成「有出处 70 · 仍无出处 3（全部已标注）」，每一项都能翻到结论正文里指给人看。

顺带修掉同一形状的三处，全是这次跑门禁时当场撞出来的：

1. 核对表走查的引用清单用**带上限**的提取（单来源 20、合并 24），排在第 25 条之后的引用根本不进走查，弱证据与「已声明／未进结论」的计数比看板少 3 条——与前面 `verify:searchev` 那次是同一个坑（度量按截断窗口算）。改全量后计数与平台一致。
2. 走查的汇总行把「没有结论的失败任务」也算进了「未进结论正文」（12 对平台的 8）。平台口径早就定过：没有结论就没有可交付物，不计证据欠账。走查跟着对齐，两处数字才对得上，否则每次比对都要重新解释一遍差在哪。
3. 走查里那条「复查后仍无出处 N 处，不能多于待办清单条数」的断言也得按待处置数比：全部标注完之后待办是 0 项、`pending` 仍是 3 处，按老断言就报「3 处多于 0 项」的假警。门禁自己先踩了一次这个坑，正好说明改口径时**验证脚本里的不变量要跟着一起改**，不然它守的是旧口径。

`verify:ledger` 93 项 / `verify:sheet` 286 项 / `verify:dcheck` 135 项 / `verify:refcheck` 600 项 / `verify:stats` 全 0 失败。

一条方法论：同一条原则（**交代过就不算欠账**）在引用侧与文号侧各落一次，两处必须共用判据函数——词表或窗口哪天要改，只改一处就等于两处都改；各写一份，就会像今天这样一处修好、另一处继续报假警。

## 比对准确率 33.33% 是怎么来的：把「填了多少」记成了「漏了多少」

看板与测试报告的头条数字是「记录级比对累计准确率 **33.33%**（一致 7 / 比对 21）」。拆开看构成：21 项里有 16 项来自 `ff4c9a3c` 的一次比对，而那次的入参是 `a = 已填列-土增清算底稿-合成模板.xlsx`（产物）、`b = 土增清算底稿-合成模板.xlsx`（上传的**原始空白模板**）——拿填列结果和它自己的模板比。逐格模式的明细把话说明白了：B 侧 A4:D6 全为空，A 侧那 12 个格子正是 `fill_land_vat_workpaper` 写进去的 HT-001/002/003 三行合同。

也就是说，这 12 处「仅 A 侧有」不是覆盖缺口，而是**填列成果**。它把累计覆盖率从 100% 拉到 36.84%、把总准确率拉到 33.33%——指标方向整个反了：填得越多，分越低。

分类不能靠 `kind` 猜：`aabd138a` 的三次比对同样是「artifact vs upload」，但 b 侧是「人工参考底稿-样例.xlsx」，那是真正的同行评审，必须留在一致率与覆盖率里。判据改用**产物溯源**：某个填列/生成类调用的 `outputName` 等于本次比对的 a 侧文件名、且它的 `fileName` 等于 b 侧文件名，才算「与自己的模板核对」。

顺带查出同一份口径在仓库里写了**四遍**：平台统计、作品说明生成器、测试报告生成器，以及平台统计门禁里那段 SQL 独立回算。历史上已经因此出现过「报告 60% 对看板 33.33%」的分歧（是报告脚本自己的 WARN 抓到的）。这次抽成 `apps/api/src/services/compare-stats.ts` 一份实现（`summarizeTaskCompares` 每任务取最近一次同行评审、模板核对逐次累加；`aggregatePeerCompares` 跨任务合计并按原始计数现算比率；`buildDerivedFrom`／`isTemplateCompare` 负责分类），三处消费者全部改用。门禁那份**保留独立回算**——它的价值就在于不复用平台的聚合逻辑，只共用分类规则，这样平台侧一旦漂了它还能抓到。

新口径下的数字：与人工参考底稿的同行评审 4 次、比对 5 项、一致 3、差异 2 → **一致率 60%**（填得对不对）、**覆盖率 100%**（人工底稿有的项，自动填到了多少）；与原始模板核对 1 次 → 填列新增 **12** 处、与模板既有内容冲突 **0** 处，正好证明「保留式填列」只往空格子里写值、没改坏模板原有内容与公式。测试报告不再拿「总准确率」当头条，改成两个拆分比率加一行模板核对；作品说明与 PPT 大纲同步改写；看板卡片说明、MD 导出与 TSV 导出都补上模板核对的三项。

门禁补了合成用例，覆盖这次改动最容易错的几处：模板核对不混进同行评审、同行评审只取每任务最近一次但**次数照实计**、address（逐格）模式不进记录级口径（量纲不同）、b 侧是别的上传件时仍算同行评审、合计比率按原始计数现算而不读记录里存的百分比。`verify:stats` 检查项 56 → **73**、0 失败。

改完第一遍跑报告，它仍打 `33.33%（一致 7/比对 21）`，而平台已是 60%——报告脚本自己那条「两处口径不一致」的 WARN 抓到的。原因是我把**只有比对调用**的那份列表传给了共享函数，而分类要靠填列/生成类调用的入参建产物溯源表；表是空的，模板核对就被当成同行评审。改成把该任务的全部调用传进去（函数内部自己挑比对）。这条 WARN 是早先为了抓「报告与看板给出两个累计准确率」而加的，这次立刻又立了一功：**跨处口径的一致性，得有一条会自动叫的断言盯着，靠人眼比对早晚漏**。

剩下的 2 项差异不是统计问题，但**也不是「待人工核查的真差异」**——下一节查到它是预埋的演示差异，这句话当时写错了，已更正。

一条方法论：**看到一个百分比，先问它的分母里装了什么**。这里的分母混进了「与空白模板比」的那一类，于是指标与它想度量的事情反向。另外，分类判据要用系统里已经存在的事实（产物溯源来自调用入参），不要靠文件名前缀或 `kind` 去猜——这次两种情况都是「artifact vs upload」，猜必错。

## 那 2 项差异查到底：是预埋的演示差异，而作品说明没这么说

三处 mismatch 其实是同一处（`aabd138a` 两次 + `d1e10759` 一次；平台按每任务最近一次计入，所以报 2 项），内容都是「直接投入/金额（元）」自动 **420000** 对人工 **425000**。溯源两个数的出处：425000 只出现在 `packages/document-tools/scripts/make-compare-sample.ts`（比对样例生成器）里，而 `make-sample.ts` 与 `agents/rd-audit/agent.config.ts` 的案例指令都是 420000。结论是**系统底稿取数正确**，人工参考底稿那一侧是故意写成不同的数——预埋差异的目的正是验证比对抓得出差异来。上一节把它写成「真问题」是错的。

真正的问题在文档：作品说明的差异明细附录只写了一句「差异项一律列为待核查事项，系统不按人工底稿自动改正」，读者（评委）看到「系统底稿 420000 / 人工底稿 425000」只会理解成系统填错了数。附录改成三段：先写**参照物文件名**，再给一致率与覆盖率两个拆分比率（不再拿「总准确率 66.67%」当头条），然后按参照物是不是演示样例分别说明——是样例就写明「这处差异由样例生成器预埋，系统一侧取自任务指令里的辅助账归集数，不是取数错误；接入真实案例后差异项即为需人工核查的口径差异」，不是样例才写「列为待核查」。判定用 `DEMO_REFERENCE_SAMPLE` 常量比对文件名，不靠人肉在散文里写死。

顺带修了 `latestCompareFor` 的两处：① 它原先只取时间上最后一条比对、发现不是记录级就直接返回 null——实测土增智填最后一次是逐格（address）比对，附录于是整段消失，而它明明有可用的记录级结果；改成按时间倒序扫描，跳过非记录级的那几条。② 它不区分「与自己的原始模板核对」，而那一类根本不是与人工底稿比对；改成沿用与平台统计同源的分类判据（产物溯源），跳过模板核对。

一条方法论：**「待人工核查」不能当成分析的终点**。上一节我把这处差异归到「需要人工核查的口径差异」就收手了，听起来稳妥，其实只是把没查完的事情换了个说法；再往下走两步（两个数各自从哪来）就能确定它是预埋的演示差异，而文档正因为没查这一步，把一次成功的差异检出写成了疑似取数错误。

## 金额待确认 17 处逐条读完：没有一处是模型编的数

把 17 处待确认金额的上下文全打出来看，分成三类，修法完全不同——笼统当成「需要人工核对」就会一直挂着。

**一、根本不是金额。** `4bb22d34` 结论里「PDF 共 37 页、28,263 字符，已解析」的 `28,263` 被当成一笔金额：它带千分位、位数也够长，「既无单位也无千分位、位数又短才跳过」那道守卫拦不住，而拒绝后缀表里没有「字」。补进 `字 页 行 列 张 笔` 六个后缀——金额后面不会跟这些量词，不会误杀真金额（`420,000 元` 一类照旧计入，各有断言）。

**二、出处在字符串里，溯源只收 JSON 数值。** `cc644639`「OCR 扫描件解析验证」4 处金额**全部**待确认，而 `parse_uploaded_files` 的结果里明明写着「人员人工 860000 元」——它在 `textPreview` 这个字符串字段里，`collectToolCents` 只在整个字符串恰好是一个数字时才收。修法：给 `collectToolCents` 加 `scanText` 选项、`traceAmounts` 加第四参 `textResults`，并用 `TEXT_AMOUNT_TOOLS` 白名单限定**只扫客户资料的解析结果**。联网类工具坚决不收：网页正文里满是别人页面上的数字，一律收进来等于结论里写任何金额都能找到「出处」，这道核对就形同虚设。五处调用点（平台统计、结果页、核对表走查、交付包走查、金额溯源门禁）一并接上，避免又一处口径分叉。

**三、工具没给出这个数，模型只能自己算。** `aabd138a` 的 4 处全是「差额 5,000.00 元」（比对工具给了 420000 与 425000，没给差额）；`ff4c9a3c` 的 4 处全是合计行（关联工具给了每份合同的金额与差异，没给总计）；`17a56468` 的 3 处是两个口径的合计与差额。平台本来就要求「不得新增未经工具计算或联网核验的金额」，可工具没算，模型自己减、自己加，减出来的数在工具结果里当然找不到出处——**这不是模型不守规矩，是工具少给了一层数**。

对第三类的修法是让工具把该给的数给出来：`compare_workpapers` 的每条 mismatch 增加 `deltaYuan`（b − a，两侧都是数值时才给）；`match_contract_invoice` 的 summary 增加 `totalContractAmountYuan / totalInvoiceYuan / totalDifferenceYuan`——这个工具的原则本来就写着「金额汇总由程序完成」，只差总计这一层。验证：比对侧 `verify:compare` 增加 `delta=5000.00` 断言并纳入通过条件；关联工具直接调用一次，合计三项如期输出（22,300,000.00 / 20,100,000.00 / 2,200,000.00）。

口径变化（存量数据）：金额 542 → **540**（去掉 2 处篇幅计数误判）、可溯源 525 → **528**、待确认 17 → **12**、比例 **97.8%**；`cc644639` 从 4/4 全待确认变成 0/4。`verify:amounts` 65 项 0 失败。

两处如实记下没做到的：① 剩下的 12 处要等任务**重跑**才会消失——新字段只出现在新产生的工具结果里，存量记录不回填。这是设计取舍：不改历史记录，也不为了让数字好看去放宽溯源判据。② `17a56468` 的 3 处是「两个口径各跑一次测算再相减」，跨调用的算术没法由单个工具给出；`09046f0a` 的 1 处是假设性分配（「若归 HT-003：仍留 1,800,000.00 元差异」）。这两类留在待人工确认是对的。

另记一笔缺口：`agents/land-vat` 只有 typecheck、没有 verify 脚本，所以 `match_contract_invoice` 的新字段这次是靠一次性直接调用验证的，**没有进门禁**——下次改这个工具不会有断言拦着。

一条方法论：**「待人工确认」这类清单要逐条读上下文，而不是盯着总数**。17 处里没有任何一处是「模型凭空编了个数」：一类是提取误判、一类是溯源看不见字符串里的数、一类是工具少给了一层数。三类的原因和修法都不一样，只看「17/542 待确认，比例 96.9%」这一个数，既不知道该怎么修，也容易误以为模型在乱写金额。

## 给土增智填补上门禁，并用一次真实案例跑验证工具改动

`agents/land-vat` 此前只有 typecheck：上一轮给 `match_contract_invoice` 加总计字段时，只能靠一次性直接调用确认，下次谁改坏了也没有断言会叫。补 `apps/api/scripts/verify-lv-tools.ts` 并接进 `qa:all`（`verify:lvtools`，排在 `verify:docsrc` 之后）。脚本放在 api 侧而不是 agent 包里，是因为该包的 `exports` 只暴露 `agent.config.ts`，子路径导入会被 Node 拒掉，脚本走相对路径导入工具即可，也省掉给该包新增 tsx 依赖与改锁文件。

27 项断言覆盖：逐份合同的金额、发票张数、税额合计、差异与三种状态（`consistent`／`difference_pending`／`no_invoice`）；编号归一化关联（`" ht-001 "` 与 `HT-001` 视为同一编号）；未匹配发票的两类原因分别说明；疑似重复发票号；三个总计字段，外加两条恒等式——「差异总计 = 合同总计 − 发票总计」与「总计 = 逐份之和」；发票账面关联（一票多笔合并、号码缺失时按金额唯一性给候选并标待人工确认）；金额一致性检查（差异 = 实际 − 应有、容差内判一致）。

**门禁有没有牙，用改错一行来验**：把 `totalContractAmountYuan` 的求和范围临时改成只取第一份合同，4 项断言立刻报错（合同金额总计、两条恒等式、正文合计行）；还原后 27 项 0 失败。27 项里 26 项第一次就通过，唯一失败的是我对 `normalizeCode` 的预期写错了——它会去掉分隔符（`HT-001` → `HT001`），而这正是让「HT-001」与「ht 001」能关联的原因；断言按实际行为改正并写明用意。

工具改动的实效用一次真实案例跑验证：`pnpm case:run case-lv-template`（新任务 `a351303e`，约 6 分半，`pass=true`，工具链 `parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → render_matching_diagram → generate_workpaper`）。落库的 `match_contract_invoice` 结果里确实带着 `totalContractAmountYuan 22300000.00 / totalInvoiceYuan 20200000.00 / totalDifferenceYuan 2100000.00`——正是 `ff4c9a3c` 结论里引用过、此前溯源不到的那三个数；新任务 **24 处金额全部可溯源**（待确认 0）。平台金额总数 542 → 564、待确认仍是 12（都在存量任务里）、比例 96.9% → **97.9%**。

这也印证了上一轮的判断：新字段只对重跑后的结果生效。存量那 12 处要等对应任务重跑才会消失——`ff4c9a3c` 的 4 处合计行现在有出处可引，`aabd138a` 的 4 处差额同理（比对工具已给 `deltaYuan`），剩下的 4 处是跨两次测算相减与假设性分配，本就该留在待人工确认。

一条方法论：给没有测试的模块补断言时，**先故意改错一行看它叫不叫**。一个 27 项全绿的脚本，如果压根没覆盖到那个字段，绿灯是没有信息量的。

## 让工具改动落到存量任务上：重跑取新结果、回滚留旧结论

上一轮的工具改动（比对差额 `deltaYuan`、关联工具的三项总计）只对**新产生**的工具结果生效，存量那 12 处待确认金额不会自己消失。要清掉它们，得让那两个任务重新调一次工具。

直接完整重跑（`POST /api/tasks/:id/run`）的代价当场就看到了：`aabd138a` 重跑后结论从 34,076 字缩到 **6,855** 字，前几轮写回补进去的官方引用、联网引用清单与「未取得公开原文」声明全没了，修订影响判「证据质量退步，请核对本次修订」。金额确实全可溯源了（0/38），但那是拿交付材料的内容换来的——不能这么算账。

两步走才对：**重跑取新工具结果，再回滚结论**。工具结果按调用落库、不随结论回滚消失，而金额溯源看的是该任务的全部工具结果，所以回滚之后旧结论里引用的差额与合计照样能在新结果里找到出处。

- `aabd138a`：重跑 360 秒（45 次调用，落库结果含 `deltaYuan`）→ `writeback:evidence --restore aabd138a` 回滚到第 8 轮（34,076 字）。金额待确认 4/50 → **0/50**，引用 41 条（官方 30）、文号 25/28 原样保留，修订影响回到「证据质量改善」。
- `ff4c9a3c`：重跑 200 秒（34 次调用，落库结果含三项总计）→ 回滚到第 5 轮（8,769 字）。金额待确认 4/35 → **0/35**，引用 9 条（官方 6 · 弱 0）不变，修订影响「证据质量持平」。

平台口径：金额 564 处、待确认 12 → **4**（比例 97.9% → **99.3%**）；弱证据 23（已声明 15 · 未进结论 8 · 待处置 0）、缺口任务 **0**、文号 70/73（待复查 3、全部已标注）——回滚没有把前几天收口的成果退回去。被换下的两轮短结论仍留在事件流里，回滚本身也记为一轮，状态保持 `waiting_review`：重跑与回滚都留痕，不是悄悄改回去。

剩下的 4 处是**该留着**的：`17a56468` 的 3 处是「两个口径各跑一次测算再相减」的跨调用算术（前五类合计第二口径 2,040,000、限额第二口径 226,666.66、两口径差额 454,444.45），单个工具给不出这个数；`09046f0a` 的 1 处是假设性分配（「若归 HT-003：仍留 1,800,000.00 元差异」）。这两类正是「不得新增未经工具计算或联网核验的金额」要拦的东西，标成待人工确认说明这道核对在正常工作，不是欠账。

> **后一节推翻了这条判断**：「单个工具给不出这个数」不是「该留着」的理由，而是工具的能力欠账。本节前面（「金额待确认 17 处逐条读完」）自己已经写过同一句话——「这不是模型不守规矩，是工具少给了一层数」，比对差额 `deltaYuan` 与关联工具的三项总计就是这么补的。这 4 处是同源的第三、第四处，见「那 4 处『该留着』的金额待确认」。

一条方法论：**重跑会同时换掉工具结果与结论两样东西，先想清楚只要哪一样**。这次只要工具结果，那就重跑完立刻回滚结论；顺手也把「结论回滚不影响工具留痕」这条既有设计验证了一遍——它本来是给写回改坏时兜底的，这里成了正经用途。

## 待复核 135 条里，只有 58 条真的需要人看

看板挂着「待复核问题合计 133 项」（实时算出来是 135）。逐条看构成，三类都不该在清单里：

1. **没有结论的任务**：`26f91720`「底稿比对准确率闭环」status=failed、结论为空，却单独贡献 **43** 条待复核问题——占了全平台三分之一。这与证据欠账那条既定口径是同一件事：没有结论就没有可交付物，那次运行留下的差异与缺失项是残渣，不是欠账。
2. **与自己的原始模板比对**：`ff4c9a3c` 那次比对的 12 处「仅系统底稿」+ 相邻几处，共 **15** 条，全是填列进去的值。上一节已经把这类比对从覆盖率里分出去了，但问题清单这条路径没跟着改——同一个判据（产物溯源）在两个消费点各改一次，漏了一个。
3. **被后续运行取代的旧比对**：`aabd138a` 09-29 05:57 那次有 48 处「仅系统底稿」、6 处「仅人工底稿」，06:36 重跑后只剩 1 处差异。旧的那些留在清单里，等于让人复核一个已经不存在的状态。「仅系统底稿 41 条 / 仅人工底稿 8 条」这两个类型改完之后**整类归零**，就是这么来的。

修法落在 `extractIssues`：结论为空直接返回空清单（读库而不走 task-store——task-store 反过来依赖本模块的 `pendingReviewCount`，互相 import 会成环）；比对类问题只取**最近一次非模板比对**那一条调用的 diffs（分类沿用 `compare-stats.ts` 的产物溯源判据，与看板、报告同一份实现）。

实测：问题合计 139 → **62**、待复核 135 → **58**；类型构成从「资料缺失 41 / 仅系统底稿 41 / 账账差异 18 / 底稿差异 18 / 金额差异 12 / 仅人工底稿 8 / 未匹配发票 1」变成「资料缺失 32 / 账账差异 17 / 金额差异 10 / **底稿差异 2** / 未匹配发票 1」——剩下的底稿差异就是那 2 条真差异（`直接投入/金额` 自动 420000 对人工 425000，已查明是样例预埋）。`verify:review` 增加两条真实数据断言盯着这两道过滤（没有结论的任务不列问题、比对类问题只来自最近一次与人工底稿的比对），检查项通过、待复核合计 58。作品说明里「问题清单由工具结果实时提取」那句也补上了过滤口径与实测收敛数字。

顺带修掉上一轮留下的一处欠账：`verify-lv-tools.ts` 有 4 个类型错误（工具的 `execute` 由 SDK 定义、除 id 与入参外还有若干上下文参数，我按两参签名写了），而 `qa:all` 不做 typecheck，所以昨晚那次「全绿」没拦住它。改成按宽松签名包装一次再调。**门禁不含 typecheck，就意味着类型错误可以带着「全绿」进主干**——已把 `pnpm typecheck:all`（= `pnpm -r typecheck`，8 个包）接在 `qa:all` 最前面，先过类型再跑验证，不靠记性。

一条方法论：**「实时提取」不等于「当前有效」**。清单类功能只要是从历史累积数据里捞的，就得回答一句「哪些记录代表当前状态」；不回答，清单就只增不减，最后没人再看它——135 条待复核和 0 条待复核一样 useless，因为都无法据此行动。

## 58 条待复核去重后是 42 类：同一件事别让人点六遍

把剩下的 58 条按「类型 + 描述原文」聚合：去重后 **42** 类，其中 **7** 类跨任务重复——「留存备查资料『研发人员名单』尚未取得」在 **6** 个任务里各出现一次，「直接投入费用 辅助账 420000 对财务明细账 880000，差异 -460000」在 4 个任务里各出现一次，「合同 HT-003 幕墙 差异 2000000」3 次。这些是同一套案例数据在多次回归运行里的必然结果，判断其实是同一个，可复核页是任务级的，只能一个任务点一遍「全部确认」。

补的是跨任务视角，三层：

1. **共享纯函数** `apps/web/src/review-queue.ts`：`groupPendingIssues` 按「类型 + 描述」分组，组内按任务标题排序、组间按出现次数倒序（排序必须确定，否则同一批数据每次行序不同，批量处置就没法核对），`groupSummary` 给出「条数 / 组数 / 重复组数 / 重复涉及条数」。
2. **平台统计出 `reviewGroups`**：与 `reviewPendingIssues` 同源（都来自 `pendingReviewIssues`），看板和验证脚本读同一份，不再各算一遍。
3. **跨任务批量处置** `POST /api/tasks/reviews-batch`：入参是 `{items:[{taskId,issueId}], decision, comment}`。服务端**按任务重新计算当前待复核清单**、不信任前端传来的 issueId——已复核过的、或因口径变化已不在清单里的逐条跳过并在 `skipped` 里写明原因；每个任务各写一条复核记录与状态事件；待复核清零且处于 `waiting_review` 的任务，按单条复核同一条规则流转为 `completed`。这与既有的 `reopen-review-batch`（批量转为待复核）正好是一对反向操作，也沿用同一句原则：待办清单由服务端重算。

看板上新增一块「全平台待复核问题」：标题行给出「58 项 · 去重后 42 类，其中 7 类在多个任务里重复出现（涉及 30 项）」，每类一行——类型徽章、描述、涉及任务数、可点的任务胶囊（跳去该任务复核页逐项看），右侧「全部确认／全部驳回」两步确认，共用一个复核意见输入框。默认只列前 8 类，其余可展开；任务内的逐项确认与「全部确认／全部驳回」原样保留，跨任务合并只是把同一个判断从点六遍变成点一遍。

联调按「不改数据」的方式验：拿一个不存在的 issueId 与一个不存在的任务号打过去，返回 `total=0`、`skipped=2` 且原因分别是「已复核过，或该问题已不在当前清单里」「任务不存在」；`decision` 非法时返回 400。`verify:review` 增加 9 项断言：分组后条数等于待复核合计、每组内类型与描述一致、组间按出现次数倒序、同一任务的同一条问题不重复计入，以及纯函数的合并/排序/汇总与空清单兜底。

一条方法论：**清单去重不是把数字做小，是把判断合并**。58 这个数字没变，变的是人要做几次判断——42 类里有 7 类是同一个判断在 6 个任务里重复。批量处置的风险在于「一键把一批问题判掉」，所以两道保险缺一不可：两步确认，以及服务端按任务重算清单、逐条跳过并说明原因（前端传来的 id 一律不信）。

## 那 4 处「该留着」的金额待确认：不是留着，是工具少给了一层数

上一节把剩下 4 处判成「该留着」，理由是「单个工具给不出这个数」。这条理由站不住：本文件「金额待确认 17 处逐条读完」一节自己写过同一句话——**这不是模型不守规矩，是工具少给了一层数**——比对工具的差额 `deltaYuan`、关联工具的三项总计，都是照这个判断补上去的。这 4 处是同源的第三、第四处。

逐条读到底（直接查库，把每一处的上下文与工具调用摊开）：

- `17a56468` 三处。该任务共 3 次 `calculate_rd_adjustment` 调用，**三次的入参全是辅助账同一口径**（前五类合计都是 1,580,000）。结论里那张两口径对照表的第二列——前五类合计 2,040,000.00、其他相关费用限额 226,666.66——是模型按 `前五类 × 10% ÷ 90%` 自己算的；两口径差额 454,444.45 是 `2,210,000.00 − 1,755,555.55` 手减。工具从头到尾没被要求算第二个口径。
- `09046f0a` 一处。该任务只有 1 次 `match_contract_invoice` 调用，1,800,000.00 = `2,000,000 − 200,000`，即「若 FP-005 归 HT-003 还剩多少差异」的手减。工具没给假设演算的入口。

**补的是工具能力，不是放宽判据。** 两处各自加一个可选参数：

1. `calculate_rd_adjustment` 加 `label` 与 `alternative{label, expenses}`：一次调用给出两个口径的完整测算与逐项差额（`COMPARISON_ROWS` 七行：前五类合计、其他相关费用实际发生、限额、可加计的其他相关费用、超限部分、可加计扣除基数、加计扣除额）。测算主体抽成 `computeRdScenarioCents` / `rdScenarioDetails` 两个函数，**顶层字段与对照表的主口径列同源同值**，不会出现「一处一个数」。正文直接给一张可整段照抄的对照表，模型不必自己拼两列。
2. `match_contract_invoice` 加 `allocationScenarios[{invoiceNo, contractNo, note}]`：按假设重算目标合同的发票合计、残余差异与全项目差异合计，并判 `cleared / difference_pending / over_invoiced`；发票号或合同号不存在时明确报错，不静默算数。关键是**只输出演算结果，不改动 `matched` 与 `unmatchedInvoices`**——「不得自行归属」是执业规则，不能因为多了一个参数就被绕过去，FP-005 仍留在未匹配清单与待人工确认里。

`verify:rdtools`（新增，此前智研税审只有 `verify:agents` 检查工具名与重名，金额规则本身没有断言）45 项，`verify:lvtools` 扩到 45 项。两个脚本都有一组同源断言：**把工具正文直接喂给 `traceAmounts`，要求零未溯源**——模型照抄正文写结论时，每个金额都必须在工具自己的结果里找得到出处。这条断言当场暴露了溯源侧的一个盲区。

### 顺带挖出金额提取的一个盲区：冒号后的金额根本没进核对

`TOKEN_BEFORE = /[A-Za-z0-9/.\-_#:=?&%]/` 含 `:`，而 `AMOUNT_RE` 带前导 `\s*`。于是「其他相关费用限额: 175555.55 元」的匹配**从冒号后的那个空格起算**，`text[m.index - 1]` 正好是 `:`，整条金额被当成 URL 或编号的一部分跳过。工具正文与结论大量是「某某: 数字 元」的写法，等于给手算数字留了「写成 冒号+空格 就查不到」的口子。

判据改成看紧挨**记号起点**的字符，记号起点取 `full.search(/\S/)`（第一个非空白字符）：冒号后有空格，说明这个数字不是长记号的一部分；而 `tid=27828`、`/c100012/`、`09:17` 里数字紧挨 `=` `c` `:`，照旧跳过。

第一版写成 `full.search(/\d/)`（紧挨数字），当场被 `verify:amounts` 6 项断言拦下：负号在 `TOKEN_BEFORE` 里，`-460,000.00 元` 会因为紧邻**自己的负号**被误杀，`17a56468` 的提取数从 56 处掉到 49 处。改成「第一个非空白字符」后，负号与货币符号都算记号的一部分。

平台口径：金额 564 → **588** 处（多出 24 处此前被冒号吃掉的金额进入核对），可溯源 584，**待确认仍是同样那 4 处**，比例 99.3%。收紧判据没有制造新欠账——多看见的 24 处全部有出处。`verify:amount-trace.ts` 补 6 项断言（冒号+空格后的金额计入、千分位计入、负数保留符号、负号不被自己误杀、时间与查询串里紧挨冒号/等号的数字仍不计入）。

### 落到存量任务：这次用续跑，而且不需要回滚结论

新字段只对新产生的工具结果生效，所以两个任务各续跑一轮。与上一节 `aabd138a` / `ff4c9a3c` 的完整重跑不同，这次走 `POST /api/tasks/:id/resume`（带会话历史），指令里明确「结论其余部分（政策依据引用与检索时间、资料缺失清单、待核查事项）保持原样不要重写」，只替换两口径对照表 / 归属假设那一段，并要求数字直接取自本次工具结果、严禁自行相减。

结果：金额待确认 4 → **0**，金额总数 588 → **612**（新增 24 处全部可溯源）；文号 70/73、待复查 3、引用 169（官方 113 · 弱 23）、欠账任务 0，与续跑前**逐项一致**。**这次没有回滚结论**——上一节回滚是因为完整重跑把结论从 34,076 字写到 6,855 字、拿交付内容换了数字；这次证据没退步，就没有要回滚的东西。同一条原则的两种结局：数字变好不能拿内容换，内容没换才可以直接收。

### 续跑又暴露第三道过滤的缺口：旧一轮的问题清单没被取代

`09046f0a` 续跑后待复核反而多了一条。查下来是新旧两轮并存：旧一轮「HT-001 云璟花园一期**建安工程**合同 / 关联 **1** 张发票 / 差异 100,000」，新一轮「HT-001 云璟花园一期**总承包**合同 / 关联 **2** 张发票 / 差异 100,000」。同一件事两条，去重键（`source + issueType + description`）拦不住——描述里带了合同名与发票张数。

根因是「被后续运行取代」这道过滤此前**只对 `compare_workpapers` 生效**（`latestCompareId`）。但同一条理由对一批工具都成立：凡是返回**完整 `issues` 清单**的工具（归集核查、合同发票关联、发票账面关联、金额一致性），每次调用都是对同一套输入的全量重算，重跑一遍，早先那次描述的状态就不存在了。

推广方式：按工具名动态分组，只取同名工具最近一次成功调用的 `issues`。**不写死工具清单**——判定条件是「这次调用的结果里有 `issues` 数组」，新增同类工具自动适用，不会像硬编码清单那样等着被人漏改。代价写明在注释里：同一任务对两个不同主体各跑一次同类工具时只留最后一次，这与底稿比对既有的取舍一致（平台是一件业务一个任务）。待复核 59 → **57**（续跑新增 1 条、清掉 2 条旧快照）。`verify:review` 加两项断言：全量重算型工具的问题只来自同名工具最近一次调用；且确实检查到了这类问题（否则前一条是空跑）。

### 跨任务批量处置真正用掉：57 → 37

上一节建好的 `POST /api/tasks/reviews-batch` 此前只做过「不改数据」的联调，这次真用：**6 类 20 项**一次处置完，待复核 57 → **37**、分组 42 → **36**、已完成 8 → **12**，20 项**零跳过**——服务端按任务重算出来的清单与前端传来的 issueId 完全对得上，那句「不信任前端传清单」的原则在这轮真实数据上验过了。

处置范围是挑过的，不是全清：

- **判掉的 6 类**（`decision=confirm`，「确认列入底稿」无争议）：资料缺失 5 项（缺失清单本身就是交付项，不是底稿缺陷）、账账差异 10 项、合同发票金额差异 5 项。后两类的差异都取自工具结果、属待核查事项、已列入底稿「异常事项」表，结论里也写明了可能原因与「取得资料前不认定申报错误」。
- **留着不批量处置的 1 类**：「底稿差异 直接投入/金额（元）：系统=420000，人工=425000」2 项。那是自动底稿与人工参考底稿的**实质分歧**，要先判断采信哪一侧，一键判掉正是这个功能最该防的用法。

每类各发一次请求、各写一条针对性的复核意见（写明取数工具、核对依据与不认定错误的口径），各任务分别落复核记录与状态事件。要撤回走既有的 `reopen-review-batch`，同样按类批量。

两条方法论：

1. **「工具给不出这个数」是待办，不是结论。** 判「该留着」之前要分清两种情况：判据正确、数字确实无出处，那是核对在正常工作；判据正确、但工具本该给出这个数却没给，那是能力欠账——补工具，不是放行数字，也不是写一条核对备注把它盖掉。
2. **批量处置的边界是「判断是不是同一个」。** 同一个判断在 5 个任务里重复，合并成一次；不同判断（采信哪一侧底稿）哪怕只有 2 条，也不合并。功能能一次判掉 20 项，不等于这 20 项都该一次判掉。

## 看板上的「失败 37」是假的：把「没有结果」当成了「结果是错误」

看板一直挂着「工具调用 270 次 · 成功率 86.3% · 成功 233 · 失败 37」。查这 37 次失败时，`WHERE ok = 0` **一条都没有**——库里 `ok` 只有两种取值：`1` 共 233 条，`NULL` 共 37 条。那 37 条的 `result` 与 `ended_at` 全是空，也就是调用行在工具发起时落了库、工具却从未返回：进程在工具跑完之前就没了。按工具分布是 `get_search_content` 15 · `fetch_public_document` 9 · `search_public_cases` 6 · 其余 7，集中在联网类慢工具上——慢调用最容易被重启撞个正着。

这 37 条散在 10 个任务里，而这些任务的状态是 `waiting_review` 7 个、`failed` 2 个、`completed` 1 个：**它们大多在后续某一轮跑完了**，任务状态上根本看不出曾经中断过。孤儿调用行是早先那一轮留下的，只有平台指标还带着它们——也正因如此，「失败 37」这个错标一直没人发现：任务页看不出问题，看板又把它归到一个看起来合理的比率里。

失败数是用 `toolCalls - toolOk` 算出来的，于是「没有结果」被记成了「结果是错误」。两处同时错：**成功率被低估**（86.3% 对 100%），以及看板上那句「失败 37」会让人去查一个根本不存在的工具报错。

更值得注意的是，这个判据任务页早就做对了：`TaskWorkbench.tsx` 的 `callStats` 里 `toolFailed` 取 `ok === false`、`toolRunning` 取 `ok === null`，三态分得清清楚楚；只有平台看板没接上。又是「同一判据多个消费点逐个接上」那条老教训。

修法是把口径收成一份共用纯函数 `apps/web/src/tool-outcome.ts`，五类消费点全部接过去：

- **三态计数**：`calls / ok / failed / unfinished`，并要求 `calls === ok + failed + unfinished`（`countsAreConsistent`）。不相等说明库里出现了第四种 `ok` 取值，此时比率不可信，要报错而不是照算。
- **成功率的分母换成有返回结果的调用**（`resolvedCalls = ok + failed`）。没有结果的调用既不进分子也不进分母；一次有结果的调用都没有时返回 `null`，由既有的 `percentOf` / `percentFrom` 显示「—」——「成功率 0%」和「没有调用」是两件事，这条本来就是 `format.ts` 写下的原则，复用而不是另写一套四舍五入。
- **看板环图从两段改三段**：成功（jade）→ 失败（rose）→ 未返回（琥珀 `#fbbf24`）。未返回不用失败的玫红，它不是错误，颜色不该替它认错。中心数字改为按有结果的调用取整。
- **图例与说明**：`成功 233 · 失败 0 · 未返回 37`，下面一行写明「成功率分母为有返回结果的 233 次；37 次发起后未返回（服务重启打断），不计入」；指标卡的 `desc` 同步改写，鼠标停上去能读到完整口径。
- **导出与文档同源**：整页 MD、TSV、快照文字改用 `outcomeLine()` 一句话口径；`gen-materials.ts` 与 `gen-ppt-outline.ts` 里各自那份 `okRate = toolOk / toolCalls` 一并换掉；`materials-lib.ts` 自己那套 DB 聚合也补上两个新字段（它不走 `stats.ts`，是第三个消费点，最容易漏）。

不回填、不改写历史行：`ok IS NULL` 保持原样，三态在读取时判定。把 37 条改成某个「已中断」状态值看起来更整齐，但那是改写运行记录；读取侧判据已经足够，而且与任务页既有做法一致。

门禁两处：新增 `verify:toutcome`（30 项）覆盖纯函数与平台真实数据，其中一条专门断言「成功率与旧口径不同」——如果哪天有人把分母改回调用总数，这条会红；`verify:stats` 里把 SQL 聚合扩成三态并断言互斥穷尽、各作品之和等于平台值，另加一条「计入未返回的调用确实既无结果也无结束时间」，防止第四种状态被错分进这一类。

平台口径变化：工具成功率 86.3% → **100%**（分母 233 次有结果的调用），失败 **0**，未返回 **37** 单列。数字变好看了，但变好的原因是原来那个数算错了，不是把判据放宽——三态全部如实摆在看板上，37 这个数一个都没藏。

一条方法论：**比率的分子分母各自代表什么，要能一句话说清；说不清就是口径错了。**「成功率」的分母本该是「有结果的调用」，写成「所有调用」的那一刻，这个比率就不再是成功率，而是「成功且没被打断」的比率——名字没跟着改，读的人自然读错。
