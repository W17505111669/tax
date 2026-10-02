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

> **本节对成因与结论的判断被下一节推翻**：这 37 行不是「进程在工具返回前就没了」，而是运行器按工具名配对开始与结束事件时把 callId 弄丢了；「成功率 100%」也只是把这批行排除在分母外的结果，真实的失败数是 7、成功率 97.41%。三态口径本身（分母只取有结果的调用）仍然成立。见下一节「37 行孤儿调用行的真因」。

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

## 37 行孤儿调用行的真因：按工具名配对，以及 isError 读错了位置

上一节把这 37 行归因于「服务重启打断」。这个判断是错的，而且错得有意思——它是只看 `tool_calls` 一张表时最合理的解释。多看一张表就推翻了：`events` 里 `tool_start` 270 条、`tool_end` **也是 270 条**，一一成对。每次调用都收到了结束事件，结果却没写回行里。那不是进程死了，是**配对丢了**。

`agent-runner.ts` 用 `pendingToolCalls` 这张 Map 配对，键是**工具名**：`tool_start` 时 `set(event.toolName, callId)`，`tool_end` 时 `get(event.toolName)`。同名工具在上一次还没结束就再次开始时，`set` 会把前一次的行 id 覆盖掉。于是 start1、start2、end1、end2 这一串下来：end1 取到的是 **id2**，结果写进了第二次调用的行；end2 取不到任何 id，什么也不写。净效果是**一行永远停在 ok IS NULL，另一行拿着别人的结果**。

数据完全对得上：「同名工具未结束就再次开始」的次数正好是 **37**，与孤儿行数一模一样；`calculate_rd_adjustment` 有一行读不出 `details.firstFiveTotalYuan`，那就是拿到了别人结果的行。而工具本来就可以并发执行（SDK 的 `ToolDefinition.executionMode` 支持 `"parallel"`），按工具名配对从一开始就站不住。

改为按 SDK 的 `toolCallId` 配对——`ToolExecutionStartEvent` 与 `ToolExecutionEndEvent` 都带这个字段，在归一化事件里透传出来；SDK 万一没给 id 时才退回按名配对兜底。

### 顺带发现的第二处：平台从来没有能力记录一次工具失败

`ok` 的判据是 `e.result?.isError !== true`，而 SDK 的 `ToolExecutionEndEvent` 把 `isError` 放在**事件顶层**（`{ type, toolCallId, toolName, result, isError }`），不在 `result` 里。这个表达式于是恒为 true——事件表里 270 条 `tool_end` 的 `ok` **全是 true**。看板上那个「失败 0」不是没有失败，是根本没有能力记录失败。

失败还有第二种写法：社区联网类工具把错误放在 `details.error` 里、并不置 `isError`。233 条有结果的行里 7 条带非空 `error` 字符串——HTTP 404、HTTP 412（提示 firecrawlBaseUrl 未配置）、`No query specified`、`No URL specified`、`Only HTTP and HTTPS URLs can be fetched remotely`——全部记成 `ok=1`。取不到内容就是没成功；把抓不到页面算成正常，成功率就是虚的。判据改为三处都认：事件顶层 `isError`、`result.isError`、`details.error` 为非空字符串。

### 存量数据：恢复被错配的结果，不是回填编造的数值

37 行的结果并没有真的丢——`tool_end` 事件的 payload 里带着完整 `result`，所以这是数据恢复。`pnpm repair:toolcalls` 默认只试算、`--apply` 才写库、幂等，遇到无法解释的配对直接拒绝写库；写库前用 `VACUUM INTO` 做了一致性快照（库是 WAL 模式，直接拷文件会漏掉 WAL 内容），并打开快照核对行数与孤儿行数。

配对规则不能想当然。**「按开始顺序结束」这条直觉在试算时当场被推翻**：14 条结果回显的入参与所在行的 args 对不上，而且都是成对互换（`fetch_public_document` 第 1 次拿到第 2 次的 url，反之亦然）——同名工具的结束顺序与开始顺序并不一致。改成两级配对：

1. **硬证据优先**：结果里原样回显了入参的工具，按该字段精确命中唯一一行。实测可用的回显字段是 `calculate_rd_adjustment` / `check_rd_expenses` 的 `projectName`、`search_public_cases` 的 `query`、`fetch_public_document` 的 `url`。
2. **顺序兜底**：其余按顺序配（结果不回显入参，或同组内取值相同无法区分）。

回显字段不能按字段名猜：`get_search_content` 的入参是 `{responseId, urlIndex}`，结果里的 `url` 是由这两个参数推出来的、不是入参回显；`fetch_content` 的结果给的是 `urls` 数组而不是 `url`。把这两个也当证据，试算立刻冒出 34 条「结果回显的 url 没有任何一行 args 与之相符」的假冲突；改成按工具白名单后归零。

结果：**67 行归位**——37 行补回从未落库的结果、7 行 `ok` 由 1 改 0、23 行的结果挪回正确的行；重跑试算 0 改动，确认幂等。

平台口径：成功 263 · 失败 **7** · 无结果 **0**，成功率 **97.41%**（此前显示 86.3%，中间一度显示 100%）。恢复的 37 条结果让引用 169 → **170** 条、官方原文 113 → **114**；金额 612 处待确认 0、文号 70/73、待复查 3、弱证据 23、检索 140、欠账任务 0、待复核 37 逐项未变——**没有新增欠账**。

一个连带后果值得记下：上一轮那 4 处「模型手算」的金额里，`17a56468` 的 3 处根源其实是这个配对 bug——孤儿行里就有 `calculate_rd_adjustment` 对「财务明细账口径」那次调用的结果，工具**算过**，只是结果没落到行上，溯源自然找不到出处。给工具补 `alternative` 参数仍然是对的（一次调用给出两口径与逐项差额，比调两次再让模型相减更稳），但它治的是「工具少给一层数」，配对 bug 治的是「工具给了、平台弄丢了」。两个问题叠在一起，只看其中一个就会误判成因。

门禁：`verify:toutcome` 扩到 40 项，加了配对不变量（`tool_start` 与 `tool_end` 事件数相等、结束事件数等于调用行数、结束事件齐全时不该有无结果的行、有结果的行必须写了 `ok` 与 `ended_at`、失败行必须带可读的错误结果）与两处修复的静态走查（运行器按 `toolCallId` 配对且不再按工具名；归一化事件读顶层 `isError`、认 `details.error`）。配对或判据一旦回退，这些断言会红。

两条方法论：

1. **只查一张表得出的「合理解释」是假设，不是结论。**「进程被打断」在只看 `tool_calls` 时完全说得通，加上 `events` 表里 270:270 的成对计数就立刻垮了。归因之前先问一句：还有哪张表能证伪它？
2. **恒真的判据比缺失的判据更危险。** `e.result?.isError !== true` 语法正确、类型过得去、跑起来不报错，270 次全部走「成功」分支——它不是没生效，是永远只在一个方向上生效。指标显示 0 失败时，第一反应应该是「我们有没有能力记录失败」，而不是「质量真好」。

## 界面上那些「一句话展示位」在漏 Markdown 原文

结论正文由 `MarkdownView`（marked + DOMPurify + mermaid）渲染成 HTML，这条路是对的。但界面上还有一批小位置是把结论**原文当字符串直接塞进 JSX** 的，它们没有任何处理。

查法不是靠眼睛扫页面，而是遍历 DOM 的文本节点、排除 `pre / code / textarea / input` 之后匹配 Markdown 记号（井号标题、反引号、`**`、表格分隔行、链接语法）。在 `17a56468` 的结果页一次扫出 7 处：

- **目录条目**：`1.2 加计扣除测算（\`calculate_rd_adjustment\`，单次调用 \`alternative\` 两口径对照…）`。`toc` 只做了 `.replace(/^#{2,3} /, "")`，井号去了，行内记号全留着。
- **上次运行结论预览**：整段 `## 一、事实（工具返回） ### 1.1 六大类归集账账比对（\`check_rd_expenses\`） | 费用类别 | 辅助账金额（元） | …` 原文，连表格竖线一起显示。
- **结论差异行**：按 `[\n。；;]` 切句后，`### 1.2 …` 这样的标题行带着井号进了「新增/删除」清单。
- 右下角浮动的目录、关键词命中段落、摘要首段是同一类问题。

修法是把「Markdown 片段 → 可读纯文本」收成一份共用纯函数 `apps/web/src/md-text.ts`（`stripInlineMarkdown` / `plainLine` / `markdownToPlainText` / `plainSnippet` / `tocEntries` / `countTables`），再把 5 个展示位逐个接过去。这些位置要的是一行能扫读的文字，不是富文本，所以只去记号、不做渲染。两个细节：

- **单个下划线不能动**：`check_rd_expenses`、`calculate_rd_adjustment` 里的下划线是工具名的一部分，只处理成对的 `**` `__` `*` `~~`，否则工具名会被啃掉。
- **目录 key 要带下标**：原来 `<li key={h}>` 用的是标题原文，剥掉记号后两个不同层级的同名小节会变成同一个字符串、当场撞 key（React 报 unique key 警告）。改成 `key={\`${i}-${h}\`}`。

`tocEntries` 第一版把正则拼成 `#{[23]}`（一个 `#` 后跟 2 或 3），永远匹配不到 `## `，目录恒为空——是新加的断言「确实提取到了目录条目」把它拦下来的。这也说明走查断言不能只断「没有残留」，还得断「确实检查到了东西」，否则空跑一样是绿的。

顺带查出一处口径错误：摘要里的「表格 N」用 `/^\| ?---/` 数分隔行，遇到带对齐冒号的 `|:---|---:|` 一张也数不到——实测某个土增任务页面上渲染出 5 张表，摘要里写「表格 0」。改成逐格检查（整行只由竖线、冒号、短横、空白组成，去掉首尾竖线后每格形如 `:?-+:?`），短横个数不写死为 3，`|:--:|` 这种居中写法同样算。全库真实结论的表格数 **73 → 94**，此前漏数 21 张。

验证：新建 4 个测试任务（单口径测算 / 双口径对照 / 纯 mermaid 关系图 / 归属假设演算），连同既有任务共扫 8 个「任务 × 页签」组合（result / review / timeline / compare），Markdown 记号残留 **0 处**，表格与 mermaid SVG 正常渲染。`verify:mdtext` 46 项进门禁，含 26 个真实结论、217 条目录条目的走查。

**任务指令面板保持原文显示**，这是有意的：那是用户提交的输入逐字回显，与对话流里的用户气泡同一口径。测试指令里写了 `**一次**`，面板就显示 `**一次**`——如实回显输入，不等于渲染遗漏；把它也转成富文本反而会篡改「你当时提交的是什么」。

## 「失败 7」要能点开：失败清单、归因分类与提示词约束

上一节把失败数从 0 修成 7 之后，看板上那个数字仍然只能干看着——不知道是哪 7 次、错在哪、该谁处理。补两样东西。

**逐条清单**：`stats.ts` 输出 `toolFailures`（任务、作品、工具名、错误正文、入参摘要、时间，按时间倒序，上限 50 条，总数仍看 `toolFailed`）。入参摘要一定要给：失败排查第一眼要看的就是「模型到底传了什么」。

**归因分类**：`apps/web/src/tool-failures.ts` 按错误正文把失败分成四类，因为处置方式完全不同——

| 类别 | 实测条数 | 处置 |
|---|---|---|
| 模型传错参数 | 3 | 把合法参数组合写进系统提示词 |
| 用法不支持 | 1 | 本地资料走 `parse_uploaded_files`，远程抓取只收 http/https |
| 外部服务拒绝或未配置 | 1 | 换 `fetch_public_document` 自有通道，或按提示补抓取服务配置 |
| 外部资源不存在 | 2 | 用检索找现行版本或换官方具体文件页，如实标注链接失效 |

判不出来的老实归入 `unknown`，不硬塞。分类只看错误正文、不猜工具内部实现。面板按类分组，每类给一句处置建议，每条可点任务胶囊跳回原始上下文。

**提示词约束**：3 条 `get_search_content` 失败全是同一个原因——模型给了 `findText` + `responseId` 却没给 `urlIndex`，工具回「No URL specified」；另有一次不带 `responseId` 只给 `findText`，回「No query specified」。这是在猜参数组合。两个作品的系统提示词各补四条：`get_search_content` 必须带 `responseId` 并二选一给 `urlIndex` 或 `findText`；`fetch_content` / `fetch_public_document` 只接受 http/https，上传资料一律走 `parse_uploaded_files`（实测有 1 次拿 `file:///C:/…` 去远程抓取）；404 改用检索找现行版本并标注原链接失效；412 换自有通道重试一次，仍失败就写「正文未能核验」，不得凭摘要或记忆补写原文。

**顺带修掉一处非法 HTML**：侧栏状态分组把「按工具数排序」按钮嵌在「折叠」按钮里面（`button` 套 `button`），React 报 hydration 警告、内层点击还可能冒泡触发折叠。改成 flex 行 + 两个并列 button，视觉不变，DOM 里嵌套 button 归零。

**4 个测试任务的实测结果**（同时验证上一轮的工具改动在真实运行里被模型正确用上）：

| 任务 | 工具调用 | 结论要素 | 关键验证 |
|---|---|---|---|
| A 加计扣除测算 | 3 次（含 `calculate_rd_adjustment` 1 次） | 表格 1 · mermaid 1 · 标题 8 | 单口径基线正常 |
| B 双口径对照 | 2 次 | 表格 3 · mermaid 1 · 标题 6 | **单次调用即带 `alternative`，结果含 `comparison`** |
| C 关系图 | 0 次 | mermaid 2 · 标题 3 | 纯出图，不硬凑工具调用 |
| D 归属假设演算 | 2 次 | mermaid 1 · 标题 9 | **带 `allocationScenarios`，结果含演算** |

4 个任务合计 7 次工具调用，**零失败**；平台口径变为调用 277 · 成功 270 · 失败 7 · 无结果 0，成功率 97.47%。

一条方法论：**修好一个指标只是让它变真，还得让它变得可用。**「失败 0」是假的，「失败 7」是真的但没法处置；只有能点开、能归因、每条带着入参与错误正文，这个数字才开始产生动作。

## 自由文本当 key 的隐患，以及一条没能定位到的告警

剥掉 Markdown 记号带来一个副作用：目录 `<li key={h}>` 用的是标题原文，两个不同层级的同名小节剥离后变成同一个字符串，当场撞 key。同类隐患一并收了——标签 `key={t}`、步骤 `key={step.label}`、证据核对表行 `key={r.item}`、交付前待办分组 `key={g.label}`，这五处的 key 全部来自**自由文本**（用户起的标签名、文案里的核对项名），本身就允许重复，统一改成「下标 + 文本」。下标前缀对这些静态展示列表没有副作用：它们不会重排、不会增删，用下标不会破坏 React 的复用。

`verify:mdtext` 补 9 项静态走查进门禁（55 项）：结果页必须引入 md-text、目录走 `tocEntries` 而不是自己 match 井号、预览与摘要走 `plainSnippet`、关键词段落先转纯文本再匹配、表格计数走 `countTables`（旧正则 `/^\| ?---/gm` 一旦出现就说明回退了）、五处 key 都带下标。

其中一条断言是**反向**的：任务指令面板必须保持 `{task.instruction}` 原文回显。这是有意的设计——那是用户提交的输入逐字回显，与对话流里的用户气泡同一口径；把它也转成富文本反而篡改了「当时提交的是什么」。写断言是为了防止后人看见面板里有 `**一次**` 就顺手「修」掉。实测中那处正是全站唯一剩下的 Markdown 记号命中点，来源是测试指令自己写了 `**一次**`。

回归验证：4 个页面（含 result 与 review 两种页签）全部正常挂载、无 ErrorBoundary 兜底，目录条目 8 / 6 / 9 条、表格 3 / 3 / 5 张、mermaid SVG 正常出图，Markdown 记号残留 **0 处**（任务指令面板那一处按设计保留）。

> **下一节把这条告警定位并修掉了**：根因是关键词云的 `<button>` 完全没写 key，不是 key 重复。上面五处加下标是有价值的加固，但都不是根因；「逐个排除候选」这条路走错了方向——该扫的是「缺 key」，不是「重复 key」。

**一条没能定位到的告警，如实记在这里。** 控制台仍有一条 React「Each child in a list should have a unique "key" prop. Check the render method of `TaskWorkbench`」。上面五处改完它并没有消失，说明根因另有其处。已逐个排除的候选：目录、标签、步骤、核对表行、待办分组（均已加下标）；引用列表 `key={c.url}`（`mergeCitations` 按 URL 去重，结构上不可能重复）；时间线 `key={${seq}-${kind}}` 与工具调用 `key={callId ?? toolName#seq}`（都唯一）；工具统计 `key={s.name}`、可用工具 `key={t.name}`、页签 `key={key}` / `key={id}`、事件图例 `key={k.id}`、字号 `key={k}`（都是固定集合）。也检查过 `.map()` 里返回裸 Fragment 缺 key 这一经典情形，命中的两处 Fragment 都是条件子节点、不在 map 内。

没能继续下去的原因是手段用尽：React 只把告警归属到最近的组件名（`TaskWorkbench`），不给具体列表；页面对象被冻结（`object is not extensible`），无法注入 `console.error` 钩子去抓完整的 owner stack；`dev.logs` 的计数也不可靠——React 对同一条告警会去重，导航之间缓冲不随之重置，实测「4 次加载 → 4 条」与「再 4 次加载 → 累计 5 条」自相矛盾。下一步要用 React DevTools 的 owner stack，或在开发构建里临时给 `console.error` 打补丁后从头加载页面。

影响面判断：这是开发模式下的控制台告警，React 会退化为按下标复用，目前没有观察到由此引起的渲染错误（上述 4 个页面的表格、图、目录与跳转都正常）。不把它当成已完成，也不为了消掉告警而继续盲改 key——没有证据的散弹式修改比留着一条已知告警更糟。

## 换一条路：静态扫描把那条 key 告警定位到了

上一节的结论是「手段用尽」。其实还有一条路没走：**告警的两种成因里，只有一种需要运行时信息**。「key 重复」要靠数据才知道，但「`.map()` 返回的 JSX 压根没写 key」是纯静态的，扫一遍源码就能找出来——而且扫完就能当永久门禁，因为这类问题在开发模式下只是一条控制台告警、页面上看不出任何异常，靠人眼永远发现不了。

`verify:jsxkeys` 扫全部 13 个 `.tsx`：找出每个 `.map(` / `.flatMap(`，用括号配对精确取出这一次调用的完整范围，若范围内出现 JSX 开标签却没有 `key=`，判为缺 key。三处工程细节都是被误报逼出来的：

1. **范围必须靠括号配对，不能用固定字符窗口。** 第一版取「到下一个 `.map(` 之前、上限 1200 字」，结果把 map **之后**的 JSX 也吞了进来——`.map((t) => t.createdAt).sort().pop()` 这种返回字符串的调用被判成「返回 JSX 却没有 key」，13 个组件里误报 **41 处**，真问题被埋在噪声里。
2. **要把字符串与模板字面量的内容抹掉再判 JSX。** 配对版仍误报 2 处，其中一处是 `.map((c, i) => \`| ${i + 1} |<br>${x} |\`)`——它在拼 Markdown 表格文本，字符串里的 `<br>` 被当成了 JSX 开标签。抹掉字面量内容（保留 `${}` 里的代码）后消掉。
3. **`<` 前一个字符不能是标识符字符或点号，否则 TypeScript 泛型会被当成 JSX。** 另一处误报来自 `const a = c.args as Record<string, unknown> | null;`，`<s` 命中了 `/<[A-Za-z]/`。加这条约束后消掉。

三轮收敛：误报 41 → 3 → 2 → **0**，扫描器最终报「204 处 map 调用 · 其中返回 JSX 91 处 · 缺 key 0 处 · 括号配对失败 0 处」。配对失败数单独断言为 0，是因为它一旦非零就说明扫描器遇到了没处理的语法，此时的「0 处缺 key」不可信。

**根因**：`TaskWorkbench.tsx` 关键词云的 `topWords.map((x, i) => <button …>)` 完全没写 key。它在每个有结论的任务页都渲染，正好对上「每次挂载触发一次告警」。补 `key={\`${i}-${x.w}\`}`。

回头看，上一节那条路走错了方向：一直在排查「哪个 key 重复了」，而真正的问题是「哪个列表没有 key」。排除法把结构性不可能的候选逐个划掉，代价高且永远划不完；换成静态扫描是一次性的，而且顺手变成了门禁。

验证方式也换对了：`dev.logs` 的计数不可靠（React 对同一条告警去重、导航之间缓冲不重置），改成**开一个全新标签页**——日志缓冲是干净的，加载 1 个任务结果页后 error/warn 总数 **0**，再连续加载 5 个页面（含 result / review / timeline 三种页签与两个作品的总览）仍是 **0**。上一节那条告警与侧栏嵌套 button 的告警都确认消失。

一条方法论：**运行时看不见的东西，先问它是不是静态可判的。** 缺 key、缺 `alt`、写了 `any`、忘了 `await`——这类问题的共同点是「页面上完全正常」，靠点点点永远不会发现，但源码里一目了然。与其在浏览器里想办法抓栈，不如把判据写成扫描器，顺便永久守住。

## 提示词改了不生效，而我上一轮把工具契约写错了

要验证上一轮补进系统提示词的联网工具约束是否生效，先撞上一个更基础的问题：**改了根本没生效**。API 进程 23:07:31 启动，两份 `system-prompt.md` 23:28:53 / 23:29:07 才改——`tsx watch` 盯的是 import 图，`fs.readFileSync` 读的 `.md` 不在里面，所以进程没重启，之后 21 分钟跑的都是旧提示词。提示词是在模块顶层一次性读进 `const` 的，改文件对已启动的进程完全没有影响，而且没有任何提示。

这比「没改」更危险：没改你知道没改，改了不生效你会以为「提示词这条路走不通」，从而得出错误结论。

修法是根治而不是每次手动重启：`agent-factory` 里本来就是 `systemPromptOverride: () => agent.systemPrompt`，**每次建会话都重新取值**，所以把 `systemPrompt` 从「顶层常量」改成「getter」即可，消费方零改动。新增 `packages/agent-core/src/prompt-file.ts` 的 `readPromptFile`，按「mtime + 大小」缓存——只比 mtime 时，同一毫秒内改写成同样长度会分辨不出。两个 `agent.config.ts` 各改成：

```ts
const systemPromptFile = new URL("./system-prompt.md", import.meta.url);
export const rdAuditAgent: TaxAgentConfig = {
  get systemPrompt() { return readPromptFile(systemPromptFile); },
};
```

### 上一轮写进提示词的契约本身是错的

三个实测任务（E / F 用旧提示词，G 用改后的）跑出来一个意外结论：**第一次尝试仍然失败**。E 与 F 的首次 `get_search_content` 都是 `findText + responseId`、都报错，之后模型自行补上定位参数重试成功。看成功过的参数组合——`responseId+urlIndex`、`findText+responseId+urlIndex`、`responseId+url`、`findText+queryIndex+responseId`——才发现问题在我写的规则上。

上一轮我照着 7 条失败样本归纳成「二选一给 `urlIndex` 或 `findText`」。**样本推不出契约**：`findText` 根本不是定位参数。去读扩展源码（`pi-web-access/index.ts` 的 `GetSearchContentParams`）拿到权威定义：

```ts
interface GetSearchContentParams {
  responseId: string;              // 必填
  query?: string;  queryIndex?: number;   // 定位参数，四选一
  url?: string;    urlIndex?: number;
  offset?: number; limit?: number;        // 分页
  findText?: string | string[];  findMode?: FindMode;   // 只是已定位内容里的过滤器
}
```

即：`responseId` 之外必须再给一个**定位**参数（四选一），`findText` / `findMode` 只在已定位到的内容里做关键词过滤。我那句「二选一给 urlIndex 或 findText」等于告诉模型「只给 findText 就行」，不但没治住误用，还可能诱导它。两份提示词按真实契约重写，并补一条：`findText` 要传字符串或**真正的数组**，不要 `JSON.stringify` 成字符串——历史失败里模型传的正是 `"[\"质保金\", \"质量保证金\"]"`，那会被当成一整段字面文本去搜，永远匹配不上。

### 复测：G 任务同时验证了两件事

G 任务（`rd-audit`，同样的诱发指令，**API 全程未重启**）：8 次工具调用，`get_search_content` 调用 2 次，**两次首次尝试就带对了定位参数**（`findText+responseId+urlIndex`、`findText+responseId+url`），`findText` 0 次被传成 JSON 字符串，参数误用失败 **0 次**（E/F 是 2 个任务各失败 1 次）。

时序可以钉死惰性加载确实生效：进程 00:13:48 启动（晚于 `agent.config.ts` 00:13:37 与 `prompt-file.ts` 00:12:55，所以跑的是新代码），提示词 00:22:59 修改（**晚于进程启动 9 分钟**），G 任务在此之后创建执行并按新契约调用。

E / F 也留下一个有用的观察：模型在报错后自行改正并重试成功，两个任务都 `completed` 且结论完整（4458 / 4192 字）。提示词里「报错后不要放弃检索，补上定位参数重试」这句起了作用；但让它**第一次就对**的，是把契约写准，而不是靠它自己试错。

### G 还暴露了一类新失败：工具自己炸了

G 的唯一一次失败是 `fetch_content` 抛 `Cannot read properties of null (reading 'tagName')`——社区扩展内部的未捕获异常，既不是入参问题也不是对方资源问题。归因分类补第五类 `tool_bug`，处置建议写明「换同类工具重试（`fetch_content` → `fetch_public_document`），记录扩展版本与触发页面以便向上游反馈，不要反复重试同一个工具」。模型这次已经自己回退到 `fetch_public_document` 并成功取到正文，与提示词里的兜底路径一致。

### 上一轮漏配的门禁

`tool-failures.ts` 是随失败面板一起加的，**当时没有配验证脚本**——分类规则一条断言都没有，改错了不会有人知道。补 `verify:tfails`（41 项）：断言用的错误正文全部取自库里真实出现过的失败，不是编的样例（分类规则本来就是照着这些样本写的，用别的字符串测等于没测）；类别表自洽（每类都有标签与含「处置」动作的建议、标签互不重复）；分组顺序确定、组内按时间倒序、同一批输入两次结果一致；`fixableByUs` 只算改提示词能治的两类，工具内部异常与外部因素不算；最后走查全库失败，断言**没有「未归类」**——出现未归类就说明遇到了没见过的错误模式，该补规则而不是放着。当前 11 条真实失败归类为：模型传错参数 5 · 用法不支持 1 · 工具内部异常 1 · 外部服务拒绝或未配置 1 · 外部资源不存在 3。

`verify:agents` 也补了：两个作品的 `systemPrompt` 必须是 getter、`readPromptFile` 的缓存在文件变动后确实失效、以及照着真实失败写进提示词的 10 条联网约束不能被悄悄删掉（共 27 项）。

### 顺带把上一轮那条 key 告警的判定收口

上一轮用全新标签页测得 0 条告警。这一轮在旧标签页里又看到 1 条，需要判定它是陈旧的还是活跃的。办法是**整页重载前后的计数差**：重载会重置 React 的告警去重状态，但 `dev.logs` 缓冲不随之重置——两次重载（任务结果页 + 作品总览）后计数都停在 1、增量均为 0，说明当前代码不再触发，那 1 条是修复前留下的。

三条方法论：

1. **「改了不生效」比「没改」更危险。** 没改你知道没改；改了不生效你会以为这条路走不通，进而得出错误结论。凡是「配置文件 + 常驻进程」的组合，动手前先确认加载时机；能让它惰性加载就别靠人记得重启。
2. **给别人（包括模型）写约束之前先读契约源码。** 从失败样本归纳规则，样本量不足以推出真实契约——我照 7 条样本写出「二选一」，规则本身是错的，反而可能诱导失败。读 20 行 interface 就能拿到权威答案，比归纳便宜也更准。
3. **静态扫描报 0 不等于运行时干净，运行时看到的也可能是陈旧日志。** 判定「是否仍活跃」要用重载前后的计数差，不能用缓冲区的绝对值。

### 复测留下的证据欠账，以及一个读数陷阱

E / F / G 三个复测任务跑完后，平台口径出现两处新欠账：金额待确认 0 → **23**、欠账任务 0 → **3**。逐项查清后分别处置，没有为了让数字回到 0 而绕过判据。

**11 处文号待复查**走平台自己的批量联网复查（`POST /api/tasks/ref-checks-batch`，`kinds=["docref"]`）：11 处全部跑过，6 处找到公开出处、1 处有候选、4 处未检索到。结果 E 3 → 0、G 2 → 0（全部命中官方原文），F 6 → 5，平台「复查到出处」43 → 49、欠账任务 3 → 1。F 剩下的 5 处（4 未检索到 + 1 候选）要走「生成修订指令 → 续跑」在结论里标注「未取得公开原文，仅作背景参考，不作为政策依据」，那会重写整份结论，留给复核人决定，不在这里替它跑。

**23 处金额待确认不处置，并且这里有个读数陷阱值得写下来**：E 是 12/12、G 是 11/11——**结论里的金额全部无出处**。乍看像溯源坏了，其实是既定口径的必然结果：金额溯源的工具结果池只收客户资料解析结果（`TEXT_AMOUNT_TOOLS` 只有 `parse_uploaded_files`），**联网正文一律不收**，因为网页上满是别人页面里的数字，一律收进来等于结论写任何金额都能找到「出处」，这道核对就形同虚设。所以一个纯联网检索、结论里摘引政策原文数字的任务，金额待确认必然是 100%。

这不是缺陷，是设计选择的可读性代价：**「金额待确认 N」这个数在不同类型的任务上含义不同**——测算类任务上它意味着「模型可能口算了」，检索类任务上它意味着「这些数字抄自网页，需要人核对引用是否准确」。把它们加总成一个平台数字时，后一类会把前一类淹掉。当前 23 处全部来自 E 与 G 两个检索类测试任务，测算类任务仍是 0 处。

处置上明确不做的一件事：**不自己 ack 掉这 23 处**。金额核对备注是留给复核人写「我核对过、依据是什么」的，由造出这批数据的同一方去点确认、把指标抹回 0，正是这个平台一直在防的「为数字好看放宽判据」。留着，并在文档里写清它为什么是这个数。

一条方法论：**指标异动先分类再处置。** 同样是「欠账 +3」，文号那部分有自动化补救入口、跑一遍就清掉大半；金额那部分是口径的必然结果、清掉它反而要破坏判据。分不清这两者，就会要么放着真欠账不管，要么把不该抹的抹平。

## 平台从来没留存过网页正文，所以引文永远无法核对

上一节说「23 处金额待确认是检索类任务的必然结果」，这句话只对了一半。要把待确认再分成「摘引联网原文」与「三处都找不出出处」两类，得先能拿联网正文来比对——查下来发现**平台根本没存过正文**。

`agent-factory` 归一化 `tool_end` 时落库的是 `e.result?.details`，而联网类工具把网页正文放在 `content` 文本块里交给模型、`details` 里只有元数据。全库统计：`get_search_content` 51 条结果里最长字符串字段 **110 字**、`fetch_public_document` 22 条里 **93 字**（就是 URL 本身）、`web_search` 32 条里 **14 字**。模型确实读到了正文、也确实把政策原文摘引进了结论，但平台一个字都没留下。

对一个以「有据可查」为卖点的平台，这是证据链上的洞：结论里那段带引号的政策原文，既证明不了是忠实引用，也证明不了是编造。金额溯源把它们判成「无出处」在数据层面完全正确，但「无出处」和「口算」被混成了一个数。

修法是给联网类工具留存**有上限**的正文（`packages/agent-core/src/agent-factory.ts`）：`TEXT_EVIDENCE_TOOLS` 五个工具的结果里补 `retainedText` / `retainedChars` / `omittedChars`，上限 `MAX_RETAINED_TEXT = 20000` 字，覆盖实测的政策解读页与法规原文页（`charCount` 多在 3,000～8,000）。截断量单独记，不假装存全了——读的人能判断「这条引用有没有可能落在没存下来的那一段里」。非联网工具原样不动，避免无谓膨胀。名单与前端 `search-evidence.ts` 的 `SEARCH_TOOL_NAMES` 必须一致（一边决定存不存、一边决定认不认），agent-core 不能反向依赖 apps，所以各存一份并由 `verify:agents` 断言两者相同。

关键取舍：**留存的正文只用于分类，不进可溯源池。** `classifyUntraced` 单独用 `scanText` 扫联网正文来判断「这个数是不是抄自网页」，而 `traceAmounts` 的池子仍然只收客户资料解析结果（`TEXT_AMOUNT_TOOLS`）。否则任何金额都能声称有出处，这道核对就形同虚设——分类可以宽松，判定必须严格。

### 对照实测：同一份原文，留存前后差别

E / G 两个任务摘引的是同一份《2021年第28号公告》官方解读里 A、B 两项目的举例（90 万 / 12 万 / 100 万 / 8 万 / 10 万 / 11.11 万 / 18 万 / 21.11 万 / 20 万）。新建 H 任务要求原文摘引同一段：

| | 联网工具结果 | 待确认金额 | 引自联网正文 | 三处均无出处 |
|---|---|---|---|---|
| E / G（留存上线前） | 只有元数据 | 12 / 11 | 0 / 0 | 12 / 11 |
| H（留存上线后） | 最长 18,204 字 | 28 | **27** | **1** |

H 那唯一 1 处很说明问题：`| 28号公告（统一计算） | A+B 合计 | 190 万元 |` ——**190 万是模型自己把 A 的 90 万加 B 的 100 万加出来的**，原文里没有这个数。守卫精准地只留下了这一个真正的口算数字，其余 27 处全部对上了留存正文。这正是拆分想要的效果：合并显示时它是「28 处待确认」，拆开后是「27 处引文 + 1 处口算」，该核对的和该拦的一眼分开。

不回填历史：E / G 的正文当时没存，现在也无从补，它们那 23 处仍归在「三处均无出处」。因此第二类列名刻意叫**「三处均无出处」而不是「疑似口算」**——它混着「模型确实口算了」与「运行时还没留存正文、无从核对」两种情况，断言前者是我们不知道的。平台口径：金额待确认 51 处 = 引自联网正文 27 + 三处均无出处 24（E 12 · G 11 · H 1）。

门禁：`verify:agents` 扩到覆盖留存行为（名单一致、只对联网工具生效、原元数据一个不少、超长截断且省略号不计入留存字符数、空正文不凭空造字段），检查项数改由计数器给出而不是手写公式——上一版公式在新断言加进来后仍报旧数字，「检查项=27 失败=0」看着像跑了 27 项、实际更多，计数失真和没断言一样危险。`verify:amounts` 加 `classifyUntraced` 的单元断言（含「联网正文不进可溯源池」这条关键取舍），`verify:ledger` 加两列拆分的列序、单元格位置、合计恒等与真实台账逐行校验。

一条方法论：**「查不到出处」和「没有出处」是两件事，别让指标替你把它们说成同一件。** 前者是平台自己没留证据，后者才是被核对方的问题。分不清就会一边冤枉模型、一边把自己该补的留存当成设计如此。

### 留正文顺带放宽了文号溯源的判据，这件事必须写明并守住

`collectRefStrings` 是**通用字符串遍历**（带 `MAX_STRINGS` 预算，对每个字符串取 `normalizeRef`），所以 `retainedText` 一加进去就自动参与了文号溯源——「文号有出处」的判据从「出现在标题、地址等元数据里」悄悄放宽成「出现在我们真的抓下来的页面正文里」。这是上一轮改留存时**没有察觉、没有记录、也没有上门禁**的语义变更，是本轮量化后才看清的。

量化：H 任务结论里 2 处文号，`2021年第28号` 靠标题就能溯到，`2023年第8号` **只靠留存正文才溯到**（字符串池 43 → 51 条）。

判断是这个方向**对**：那个文号确实出现在我们抓下来的官方页面上，这比联网复查所接受的「检索结果标题或摘要里出现过该文号」更强。此前判它「无出处」是**假阴性**——页面就在手上，却因为只存了元数据而说找不到。

但放宽必须写明并守住，所以 `verify:policytrace` 补 5 项断言（共 87 项）：

- 只有元数据时，仅出现在正文里的文号溯不到（把假阴性复现出来，作为对照基线）；
- 留存正文后同一处文号可溯源，且**文号总数不变**（留存只影响能否溯到，不该凭空多出或少掉文号）；
- **反向保险**：正文里出现的其它地址不得混进引用清单。`extractCitations` 走 `urlsOfCall`，只读 `results[]` / `url` / `urls[]` 三个结构化字段、不对整段 JSON 盲扫——这条断言守住这个前提。否则一页 18,000 字的正文里随便一个链接都会变成一条「结论引用」，引用分级、官方来源计数与弱证据判定会一起被污染。本轮已手工核对过 `urlsOfCall` 无兜底盲扫分支，断言是防止以后有人给它加一个。

还有一处没做、留给下一步：目前无法区分「这个文号是该页的主题」与「只是在抓到的页面里被顺带提到」（例如页面侧栏的相关文件列表）。要区分就得让 `traceDocRefs` 回传溯源依据（元数据 / 正文），台账再分列。当前判断是先接受放宽（它修掉的是假阴性，方向明确），把「依据可见」作为下一步，而不是为了区分而把正文排除在溯源之外——那会把 H 任务那处真实有出处的文号重新判成欠账。

## 界面上最后那批 Markdown 原文：把人工浏览器扫描固化成可复跑的实测

上一轮修的是「一句话展示位」（目录、摘要、差异行、关键词段落），当时靠人工在浏览器里扫了一个结果页。这一轮先补工具：`apps/api/scripts/scan-ui-markdown.ts`（`pnpm scan:uimd`）用 playwright-core 驱动本机 `ms-playwright` 缓存里的 Chromium（**不下载浏览器**，`chrome.dll` 缺失的完整版会被跳过、优先用 headless shell），遍历「任务 × 页签」组合，扫描 DOM 文本节点里的记号残留，跳过 `pre/code/textarea/input/svg` 与标了 `data-keep-raw` 的容器。人工扫一次只能证明那一次，脚本能在新建任务、换页签、改组件之后重扫。

配套新建 5 个测试任务（渲染实测 E~I）覆盖不同输出形态：短结论纯文字问答、三项目多表格 + mermaid、合同发票关联核验、联网检索原文摘引、纯图表流程说明。加上既有任务，全库扫了 **142 个页面 / 99319 个文本节点 / 231 万字**。

首轮扫出 30 处，去掉误报后定位到三类真问题：

1. **引文胶囊的标题与地址带记号**。标题取自 Markdown 链接文字，写成 `` [`28号公告解读`](url) `` 或 `[**官方解读**](url)` 时记号原样进了标题；更严重的是裸地址的字符类没排除反引号，实测把 ``…content.html` `` 收进了引用清单——标题难看是小事，**带着反引号的地址点开必然 404**，链接核验也白跑一次。
2. **复核页「结论金额核对」清单显示原文片段**。上下文是 `text.slice(idx-24, idx+16)` 的直切，实测出现过「…其他相关费用为8万元。** > > **（一）按照97号公告…」。同一段上下文还会被 `buildRefQuery` 拼进联网复查的检索词，记号混进去等于给检索词掺噪声。
3. **正文渲染本身在漏记号**（`.md-body` 内部），两个机制：
   - gfm 自动链接只在 ASCII 空白与 `<` 处收尾，中文和全角标点都不算。原文「（中瑞财税信息网站，http://www.cntax.cn/list_detail/36801.html）摘要称该公告「第一条」因…该信息**来自非官方来源…**。」整段被吃进一个 `<a>`：满屏蓝色链接文字、点进去 404、段内 `**` 不再渲染。
   - `**` 紧贴标点时 CommonMark 判不出强调边界。「**「归集比对」**工作表」的闭合 `**` 前跟 `」`（标点）、后跟 `工`（非标点非空白），不构成 right-flanking，整对 `**` 原样显示。真实结论 35 份里 **34 份**有这种写法。

修法都收在源头，避免多个消费点各修一遍：

- `md-text.ts` 新增 `plainContext`（剥行内记号 → 落单反引号 → 行中引用记号 → 中文标点后的多余空格）。`amount-trace` 与 `policy-trace` 的 context 切片接过去，界面 6 个消费点（清单、tooltip、待核查列表、导出表格）一次全干净。**`raw` 与 `match` 仍是原文**：正文就地标注靠 `match` 精确匹配渲染后的文本，改了标不上。
- `search-evidence.ts` 新增 `plainTitle`（两条提取路径共用），裸地址字符类与 `cleanBareUrl` 尾部剥除都加上反引号与星号。
- 新增 `md-render-fix.ts`，`MarkdownView` 在 `marked.parse` 之前调用 `prepareMarkdown`：`wrapBareUrls` 把裸地址显式包成 `<http://…>`（边界自己定，尾部沿用 `cleanBareUrl` 的口径，同一件事不写两遍），`fixCjkEmphasis` 给成对 `**` 内外插零宽空格。ZWSP 属于 Cf 格式字符，既不是 Unicode 空白也不是标点，于是 `**` 两侧都满足 flanking 条件。

这里翻了两次车，都记下来：

- **第一版把标点搬到 `**` 外侧**（`**（正文）**` → `**（正文**）`），看着等价，实际改小了粗体范围、还让本该配对的 `**` 错位——全库扫描的残留从 11 处**涨到 253 处**。改内容永远比加边界危险，于是钉了一条硬断言：「去掉零宽空格后与原文逐字相同」，对 35 份真实结论逐份校验。
- **第二版只枚举全角标点**，又漏了 `**[账账差异]**「直接投入费用」`——紧贴的是 ASCII 方括号，同样判不出 right-flanking（17 处）。逐类枚举标点永远会漏下一类，最终改成无条件给成对 `**` 插边界符、只跳过 `***粗斜体***`（那种 marked 本来就能渲染，插手会把星号拆散）。
- `wrapBareUrls` 第一版直接返回 `<clean>`，把 `cleanBareUrl` 剥掉的尾巴（全角标点、后面的中文正文与 `**`）一起删了：某任务结论的 `**` 从 116 个变成 113 个。补了「地址包裹不吞正文」的断言（去掉 `<>` 后与原文逐字相同）。

扫描判据本身也修了一处：去掉「有序/无序列表记号」两条。渲染后的表格单元格里出现「1. 人员人工费用」「+ B：」是结论作者写的正常编号文字，首轮 30 处命中里 13 处是这类误报，把真问题淹了。真正的原文泄漏一定伴随更强的记号（`#`、`|`、反引号、`**`、`>`、围栏）。

有意保留原文的两处（对话流用户气泡、右侧任务指令面板）加了 `data-keep-raw="instruction"`，让扫描器认识它、不当成残留——那是用户输入的逐字回显，转成富文本反而篡改了「当时提交的是什么」。侧栏悬停提示改成走 `plainSnippet`：它是「这个任务问了什么」的提示，不是逐字回显，实测提示里出现过「读取正文后**原文摘引**关于…」。

侧边阅读器要点击才会挂载，光扫主区域永远扫不到它，而它恰恰是显示外部网页正文与产物内容的地方。`--reader` 会先点产物（本地文件，快且稳），没有产物再点引用胶囊（要联网抓取）。实测 12 个页面 / 24 万字 / 残留 0。

最终口径：

- 全库 `--all`：142 页 · 99319 文本节点 · 231 万字 · **残留 0 处**（修前 11 处，中途翻车时 253 处）。
- 侧边阅读器 `--reader`：12 页 · 10876 节点 · 24 万字 · **残留 0 处**。
- 真实结论 35 份：裸地址黏中文修了 6 份，`**` 紧贴标点修了 34 份。
- 门禁：新增 `verify:mdrender` 28 项（含两条「不改内容」硬断言与真实结论走查），`verify:mdtext` 64 项、`verify:amounts` 109 项、`verify:policytrace` 108 项、`verify:searchev` 620 项。

`scan:uimd` 刻意**不进 `qa:all`**：它要浏览器与运行中的前端服务，放进强制门禁会让没装 Chromium 的环境整条 QA 挂掉。它的定位是可复跑的实测工具，改动渲染链路后手动跑一次；`verify:mdrender` 才是进门禁的那部分（纯函数，不依赖浏览器）。

上一节留的「`traceDocRefs` 回传溯源依据、台账分列」本轮没动：这轮的要求是界面上不要再出现 Markdown 原文，先把这条收口。那件事仍然欠着。

## 文号的「有出处」分出三档依据，顺带查出台账合计行错位

上一节欠的那件事这轮做了。此前的口径是：文号核心只要出现在**任一**工具结果字符串里就算有出处。而 `collectRefStrings` 是通用字符串遍历，`retainedText`（留存的网页正文）自然也在池子里——于是「标题里写着这个文号」与「抓下来的页面正文里顺带提了一句」被判成同一档，复核人看不出哪几处需要再点开原文确认。

拆法是把一个池拆成两个，**同一套遍历只在「这个字符串是不是 `retainedText`」上分流**：`collectRefStrings(results, kind)`，`kind` 取 `all`（默认，与拆池前完全一致）/ `meta`（跳过留存正文）/ `body`（只收留存正文）。不写两遍遍历，否则深度上限、字符串预算这些细节迟早漂。

两池**各自一份 `MAX_STRINGS` 预算**，这是有意的：共用一份时长正文会把元数据挤出预算，出现「元数据里明明有，却判成只靠正文才溯到」——分档本身造假。断言用「`all` 池条数 == `meta` 池 + `body` 池」与「`meta` 池仍收得到标题里的文号」两条盯着。

优先级定为 **元数据 > 留存正文 > 联网复查**，一条文号只算在它最强的那一档上，三个数相加恒等于 `traced`。`tracedByRecheck` 的口径没有变：原来是「不在合并池里且复查 matched」，现在是「不在元数据池、不在正文池、且复查 matched」，等价。

量化上一轮那次「有意放宽」的实际影响面：真实数据 111 处文号、102 处有出处 = **元数据 65 · 仅留存正文 2 · 复查取得 35**。也就是说，把留存正文纳入溯源池只多认出 2 处，不是决口。上一轮判断「方向对但必须写明并守住」，这轮把守住的代价标出来了。

只给数字还不够——「依据可见」得能看到是哪几处，所以 `RefTraceResult` 同时回传 `bodyTracedRefs: DocRef[]`（带上下文）。消费点逐个接上：`stats.ts`（看板聚合 + 台账行）、`web/types.ts`、`evidence-ledger.ts`（新列「其中仅正文提到」+ 合计 + CSV + MD + 口径说明）、`AgentOverview.tsx`（台账摘要行 + 解释三档的 tooltip）、`TaskWorkbench.tsx`（交付 MD 里单列一张表 + 文号徽章 tooltip）、`materials-lib.ts` 与 `gen-materials.ts`（作品说明的取数口径）。`retainedText` 这个键名 agent-core 落库时写一份、web 侧认键拆池写一份，改一边不会报错、只会静默退化成「全部算元数据」，因此加了静态走查断言盯着两边一致。

**顺带查出一个交付物缺陷**：台账 MD 的合计行只有 19 个值，表头 21 列。上一轮给金额加「其中引自联网正文」「其中三处均无出处」两列时只改了 CSV 合计行，MD 那份漏了，于是「可比 N · 改善 M」被顶到「其中引自联网正文」那一列、最后两列空着。合计行每一格都有值，**错位比缺列更难发现**——肉眼扫过去像是对的，只有按列名对账才看得出串了位。补的断言是「MD 合计行的列数 == 表头列数」加按列名逐列取值对账（复查取得 / 仅正文提到 / 两个金额列 / 修订影响），以后再插列就会当场红。

错位的根因是 CSV 与 MD 的合计行各写了一遍，所以没停在「加断言守住」上：抽出 `ledgerTotalCells(t)` 由两侧共用，MD 只在首列加粗。断言随之升级为「MD 合计行与 CSV 合计行**逐格全等**」加「合计行取值与表头同列数」——只要哪天有人又在某一侧手写一遍就会当场红。按列名逐列对账（复查取得 / 仅正文提到 / 两个金额列 / 修订影响）也保留：它守的是取值本身对不对，不只是列数齐不齐。

### 只给计数还不够：这一档得能点开原文

`bodyTracedRefs` 因此带上 `sourceUrl` / `sourceTitle` / `sourceCount`，交付 MD 的表格里「留存正文出处」是一列可点开的链接。判断「该页主题还是被顺带提到」这件事只能由人点开原文做，所以这一档必须能行动，否则就只是个装饰性数字。

第一版按下标取第一个命中的留存正文，实测**两处全都先撞上 `web_search`**——它只留查询词、结果里没有地址字段，于是 `sourceUrl` 全空，功能等于白做。改成优先挑带地址的那一份，都不带时才留空，并报出命中份数（多份互不相关的来源同时提到，比孤零零一份更站得住）。修完：2 处里 1 处拿到 gov.cn 的原文地址，且它在 4 份留存正文里都出现（`sourceCount=4`）。

剩下那 1 处**确实没有地址可归属**，界面与交付 MD 如实写「命中的留存正文来自只留查询词的检索结果，没有地址可点」。不是没试过硬凑：`web_search` 的留存正文里是有地址的（第一个就是 chinatax.gov.cn），但那是 1.7 万字拼成的一整块，`joinTextContent` 把各文本块用换行接起来时就丢掉了块边界，把某个文号归到其中某个地址属于猜测。宁可少给一个链接，也不给一个可能是错的——那比没有更坏，复核人会照着它去确认一个不相干的页面。

顺带把 `traceDocRefs` 的 `toolNames` 契约写进了注释：它是**一袋名字**（只用来判断「本任务有没有用过只留元数据的检索工具」），与 `results` **不按下标配对**——三个生产调用点传的都是「全部调用的名字」配「只有成功调用的结果」，长度本来就不相等。今天它无害（只走 `.some()`），但谁要是哪天按下标去取就会静默错位，所以取地址这类信息一律直接从 result 对象上按形状取（`urlsOfCall` 的 `toolName` 参数本身就是显式弃用的，函数体里 `void toolName`）。

门禁：`verify:policytrace` 108 → **202 项**（拆池、优先级、明细与计数同源、地址归属挑带地址的那份、命中份数、无地址时不硬凑、真实任务逐份自洽、键名两边一致），`verify:ledger` 103 → **120 项**（新列位置紧跟「其中复查取得」、合计与看板一致、两档弱依据相加不超过有出处、合计行同源与对齐）。`typecheck` 8 包通过，`qa:all` 单趟全绿。浏览器复扫 6 个页面（两个作品总览 + 2 个任务的 result/review）残留 0 处，确认新列与 tooltip 没把界面弄坏；`AgentOverview` 的欠账列高亮按列名取下标（`LEDGER_COLUMNS.indexOf`），插列不会错位。

### 剩下那 1 处地址：真因不是块边界，是正文里的来源行没人解析

上一轮把这处留空，理由写的是「`joinTextContent` 用换行拼接文本块时丢掉了块边界，把某个文号归到其中某个地址属于猜测」。这轮动手改之前先量了一遍真实数据，结论是**诊断错了**：

- 全库 24 次调用带留存正文（`get_search_content` 10 · `fetch_public_document` 5 · `fetch_content` 5 · `web_search` 2 · `search_public_cases` 2）；
- 那处「2023年第8号」命中的 `web_search` 正文长 18204 字、162 段，里面**本来就写着 48 个地址（去重 18 个）**，格式是每条结果末尾独占一行的 `Source: <标题> (<地址>)`；
- 命中位置 15302，往后最近的来源行在 15670：标题「国家税务总局关于进一步落实研发费用加计扣除政策有关问题的公告 - 中瑞财税信息网站」、地址 `http://www.cntax.cn/list_detail/36801.html`。命中上下文是「……公告 - 中瑞财税信息网站 …… 注：根据2023.05.26国家税务总局公告2023年第8号《……目录的公告》，本文第一条失效」。**标题与地址都对得上，归属是确定的，不是猜。**

真因是 `urlsOfCall` 只认三种结构化形状（`results[]` / `url` / `urls[]`），而 `web_search` 的结构化字段只有查询词与 provider；正文里那 48 个地址整条链路一个都没读出来。块边界在这件事上无关：每个文本块内部都是「结果正文 + 来源行」自闭合的，用换行拼接不会把来源行和它所属的结果切开。**`joinTextContent` 因此这轮没动**——存块偏移只对「块本身就是一页、且块内不写来源行」的未来场景有意义，实测这 2 条 `web_search` 正文用来源行就能确定归属，为此改落库格式属于没有收益的改动（还要让新老数据的正文格式不一致）。

判据落在 `search-evidence.ts` 的两个纯函数上（与 `urlsOfCall` 共用 `cleanBareUrl` 和标题去记号，同一件事不写两遍）：

- `retainedSourceLines`：只认整行严格匹配 `Source: <标题> (<http(s) 地址>)`，地址再过一遍 `cleanBareUrl`；认不出一条也不给。
- `retainedSourceAt`：归属方向是**往后**找最近的一条来源行。往前找会归到上一页——那处往前拿到的是广东税务的解读页，与命中上下文写的「中瑞财税信息网站」不是一页，方向反了就是给错链接，比不给更坏。两种情况判为归属不确定、返回 null：命中所在行是小节标题（`## Query: "……"` 是检索词，不属于任何页面），或命中与来源行之间隔了新的小节标题（跨段了，往后那条不是这一段的收尾）。

**取舍：来源行不接进 `urlsOfCall`。** 那条路上有现成断言守着「留存正文里的地址不进引用清单（只认结构化字段）」，理由也成立：18000 字页面正文里随便一个链接都不该变成一条「结论引用」，否则引用分级与官方来源统计全被污染（这一份正文就有 48 个地址）。所以来源行只服务「仅正文提到」这一档的地址归属，不参与引用提取，两条路径各走各的判据。

依据档位单列成 `sourceVia: "structured" | "body-line" | ""`。「点得开」不等于「依据同级」：来源行归属是按命中位置往后找的，比结构化字段弱一档，得说清是哪一种；更要紧的是门禁能断言这条路径**真的被走到了**——否则哪天每处都碰巧有结构化地址，这段代码从未执行也不会被发现，空跑一样是绿的。

翻车一次：样例正文照实测形状写时，我把「检索词行」写成了 `## Query:` 之后的一行普通文本（于是它不再命中标题行规则），又把「往后没有来源行」的偏移取成 `body.length - 1`（那一行本身就是来源行，命中在来源行内归属自己，是正确行为）。两条断言当场红。判据没问题，是我把测试数据写成了别的东西，改样例后过。

量化：全库「仅正文提到」2 处，带可点开地址 **1 → 2**（其中 1 处依据是正文来源行、1 处是结构化字段）；`verify:policytrace` 202 → **228 项**（来源行解析与归属方向、检索词行不归属、跨小节不归属、往后无来源行不归属、相对地址不算、全链路 `sourceVia` 三档、结构化优先于来源行、留空不影响「有出处」判定，外加真实走查里「每一处都能点开」与「至少一处走的是来源行」两条硬断言）。交付 MD 的兜底文案跟着改准：原来写「命中的留存正文来自只留查询词的检索结果，没有地址可点」，而现在没地址的原因可能是正文里认不出来源行、也可能归属不确定，统一写成「这份留存正文里认不出可归属的来源行，宁可不给地址也不猜」。

**这算不算回填历史？** 不算，但界线值得写清：没有重跑任何任务、没有改任何一条落库数据，读的还是当时那份 `retainedText`——地址本来就写在里面，这轮只是把它解析出来。与上一轮「把留存正文纳入文号溯源池」同一性质（读取侧口径修正，历史数据自然受益），不同于「为了让数字好看去重跑任务或改写当时的判定」。此后新任务同样受益：只要联网工具把来源行写进正文，这一档就自动带地址。

### 这一档在界面上终于能点开了：复查面板加一组条目，点击走侧边阅读器

上一轮把地址接进了交付 MD 的表格，界面上却只有一个 tooltip 计数：「文号溯源 102/111」按钮的 `title` 里写着「仅正文提到：2023年第8号」，鼠标移开就没了，复核人在界面上点不开那一页。而这一档恰恰是最需要人点开的——它有出处，但依据只在网页正文里，可能是该页主题，也可能只是侧栏「相关文件」列表里的一行。

改法是在政策文号复查面板里单列一组「仅在留存正文中出现」：每条给文号、依据档位徽章、结论中的上下文，以及一个「原文」按钮走 `openReader({ kind: "url", url })` 进侧边阅读器；没有地址的条目不显示按钮，只留档位徽章说明为什么没有。放在复查面板里而不是结果页别处，是因为它和「待复查」构成一组对照：待复查是**没有**出处、要联网再查一遍的，这一组是**有**出处、但依据弱一档、要人点开确认的。两组并排，复核人才看得出哪些还要查、哪些只要看。

顺带收掉一处重复实现：清单上限此前在界面面板与交付 MD 表格里各写了一遍 `slice(0, 20)`，改一处不改另一处就会出现「面板列 20 条、MD 只列 10 条」的对不上账。抽成 `BODY_REF_LIST_LIMIT` 放在 `policy-trace.ts`（与 `sourceVia` 同源），断言钉住「两处消费点都引用它」且「字面量没有再被写死第二遍」。计数用的是 `split(...).length - 1 === 2`，不是 `includes` 一下就算——少接一处也得当场红，否则空跑一样是绿的。

档位文案 `SOURCE_VIA_TEXT` / `SOURCE_VIA_HINT` 同样放在 `policy-trace.ts` 而不是组件里：界面徽章、交付 MD、门禁三处要说同一件事，各写一遍迟早漂。文案里刻意不用 Markdown 记号（写反引号或方括号就会被 `scan:uimd` 判成「界面出现 Markdown 原文」），并且用一条正则把这件事钉在门禁上：三档 ×（文案 + 说明）×（非空 + 无记号）共 12 项，外加真实数据走查——每一处 `bodyTracedRef` 的档位都必须能取到非空文案，否则界面上就是 `undefined`。

写的时候差点踩一个坑：面板说明第一版写成「这几处 `**有**` 出处」，粗体记号会原样进 JSX 文本节点。这类错误 `typecheck` 看不见，只有真渲染出来扫 DOM 才发现，而复查面板要点击才挂载、`scan:uimd` 现在扫不到它，所以门禁也拦不住——改成不带记号的写法，并把「界面文案不含记号」这条断言落在文案常量上（常量是纯数据，门禁能直接读）。

**已知缺口，下一轮补**：`scan:uimd` 扫的是默认挂载的页签，复查面板要点「文号溯源」按钮才展开，所以这轮新加的一组条目**没有被浏览器实测覆盖**。这轮只跑了复扫，确认没把别处弄坏：34 页 / 19715 文本节点 / 残留 0 处。把「点击才挂载」的状态纳入扫描是待办池里的 P0-4，做完要回头把这一节真正扫一遍。

量化：全库「仅正文提到」2 处，界面上可点开 **0 → 2** 处（依据档位分开标：结构化字段 1 · 正文来源行 1）；清单上限由两处字面量收成一份常量。`verify:policytrace` 228 → **254 项**。`typecheck` 8 包通过，`qa:all` 单趟全绿。

### scan:uimd 现在会点开折叠面板：覆盖面翻 6 倍，顺手把上一轮的缺口验掉了

`scan:uimd` 此前只扫默认挂载的 DOM。而界面上一批文案最密的地方恰恰要点击才挂载：政策文号复查面板（点「文号溯源」按钮）、时间线的「展开全部」、总览的「查看全部」、会话侧栏、侧边阅读器。上一轮刚在复查面板里加了一整组「仅在留存正文中出现」的条目，全是现拼的字符串，而扫描器进不去那个面板——基线 34 页 / 19715 个文本节点里，一个节点都不属于它。新增的界面文案等于完全没有实测覆盖，那句「复扫 0 残留」只能证明没弄坏别处。

修法不是逐个硬编码入口（新增一个折叠区就得回来改脚本，迟早漏），而是在每个页面上按白/黑名单自己找「纯展开类」按钮，逐个点开再扫一遍。白名单只认展开 / 收起 / 折叠 / 更多 / 显示全部 / 查看全部 / 帮助 / 详情；黑名单排除会写库或发请求的动作（复查、复核、下载、删除、清空、生成、上传、运行、重跑、续跑、复制、写入、写回、导出、重新解析、校验、核验、标注、保存、提交、新建、发送、启动、停止、归档、打开、跳转、前往）。**黑名单只按可见文本判，不看 `title`**：说明性 title 里写着「点击展开复查面板」，那是名词短语，不该把入口挡掉——而白名单要靠 title 才认得出这个按钮（它的可见文本是「文号溯源 102/111」）。点到会跳转的按钮时整页交互立刻中止（DOM 已经换了，继续点只会扫到别的页面）并如实计数，实测 0 次。

翻车一次，而且是覆盖面意义上的翻车。第一版一次枚举全部入口、给每个打上 `data-scan-toggle` 标记再逐个点：结果 92 次成功里 **52 次点击失败**——点开一个面板会让 React 重建那一片 DOM，挂在旧节点上的标记跟着没了。失败率 36%，等于三分之一的折叠态压根没扫到，而脚本**还是绿的**（失败只计数、不判失败）。改成每轮重新枚举、按 label 去重（同一入口展开后文本会变，「展开全部」→「折叠全部」，不会被重复点），失败 52 → **0**，点开数 92 → **200**。

「确实检查到了东西」这次当硬判据做：`REQUIRED_TOGGLES` 列出必须点到的入口（现在是「文号溯源」，适用 result / review 页签），一次都没点到就在 `--strict` 下退出码 1。否则哪天按钮改了 title、白名单不再匹配，扫描会安安静静退回「只扫默认挂载」，而输出上仍然是 0 残留。

量化（默认口径：最近 8 个有结论的任务 × 4 页签 + 2 个总览页）：

| | 改前 | 改后 |
| --- | --- | --- |
| 扫描次数 | 34 | **234** |
| 文本节点 | 19715 | **121626** |
| 字数 | 361072 | **2419716** |
| 点开的折叠入口 | 0 | **200**（去重 13 类） |
| 点击失败 | — | **0** |
| 残留 | 0 | **0** |
| 耗时 | 约 1 分钟 | 165 秒 |

残留仍是 0，但这次的 0 是**扫到 6.2 倍内容之后**的 0。上一轮加进复查面板的那组条目（文号、档位徽章、依据说明 tooltip、「原文」按钮）这一轮真正被扫过，没把 Markdown 记号带进界面。顺带被覆盖到的还有：会话侧栏展开态、时间线「展开全部 / 全展」、总览「查看全部 / 展开其余 33 类」、侧边阅读器与其收起态。

取舍：耗时从约 1 分钟涨到 2 分 45 秒，`--all`（142 页）会更久，所以留了 `--nointeract` 与 `--interact-limit=N` 两个退路。它照旧不进 `qa:all`：门禁里塞一个要开浏览器的检查，会让每次提交多等几分钟，而且浏览器实测的失败原因常常与代码无关（端口没起、页面还在加载），放进必过门禁会变成噪声源。

仍没覆盖的：需要**产生新数据**才挂载的状态——上传报告浮层（要真的拖文件进去）、下载确认与产物浮层、修订模式对话框、以及侧边阅读器的「查看原文」模式（要点开阅读器再切模式，`--reader` 只点开阅读器本身）。这几项要么是写操作不宜在实测里触发，要么需要多步交互，留在待办里。

### 交付 MD 的「政策文号溯源」节搬出组件：从肉眼到 182 项断言

整份交付 MD 是 TaskWorkbench 里 `bundleLines()` 拼出来的，那是个组件内闭包（约 300 行），任何单测都碰不到它。上一轮新加的「留存正文出处」表因此一条断言都没有——列数对不对、链接能不能点开、依据档位有没有写、超出上限有没有如实说明，全靠下载下来肉眼扫一遍。

这轮把「政策文号溯源」整节搬进 `apps/web/src/delivery-docref.ts`，导出纯函数 `docRefSection({ refTrace, refSummary, refChecks })`，组件里只剩一行调用。**为什么先搬这一节而不是整份**：它是本轮新增内容所在的节、断言缺口最实在，而且依赖最少（只吃三个已经算好的对象）；其余各节（金额溯源、联网引用、产物、工具调用、核对表）依赖的组件状态多得多，一次搬完会变成大重构，违背「一个提交一个可验证改进」。剩余部分留在待办里。

搬出来立刻查出两个真问题：

1. **口径混淆**：复查表原来用 `Object.values(refChecks)`，把**引用复查**（`kind='citation'`）也列进了「政策文号溯源」节，而同节上面的计数走的是文号复查汇总（`refSummary` 只统计 docref 类）。于是「已复查 N 处」与表里实际行数对不上——交付 MD 是签字归档件，这种对不上就是缺陷。现在节内只列 `kind === 'docref'` 的记录，断言钉住「表行数 == 文号类复查记录数」，真实任务逐个走查。
2. **静默截断**：两张表都是 `slice(0, 20)`，超过 20 条就不声不响少列。界面那一侧上一轮补了「另有 N 处未列出」，交付 MD 这一侧没有。现在两张表都补上，并由断言守住（造 21 条明细，断言表只列 20 行且正文里写明「另有 1 处……未列出」）。

顺带把三处 `slice(0, 20)` 收成一份常量：`BODY_REF_LIST_LIMIT` 改名 `DOC_REF_TABLE_LIMIT`（它管的不只是「仅正文提到」一张表，还有「待人工确认」表与界面那一组），三处消费点都引用它。断言按文件分开数出现次数（模块里 2 次、组件里 1 次），并断「字面量没有再被写死」——只 `includes` 一下是不够的，少接一处也得当场红。

取数也收了一份：`verify:policytrace` 与新脚本会各写一遍 SQL（tool_calls 取成功调用、ref_checks 取 matched 的文号原文），口径改一处忘一处就会出现「两个门禁对同一批任务算出不同的数」。抽 `apps/api/scripts/docref-lib.ts` 的 `loadTaskDocRefs()` 给两边共用；复查记录改走 `listRefChecks` 服务（与界面同一个读取口），不再自己拼 SQL。`verify:policytrace` 切过去之后检查项数与实测数字一字未变（254 项，真实文号 111 / 有出处 102 / 仅留存正文 2 / 复查取得 35），这本身就是重构没改口径的证据。

新门禁 `verify:docrefmd`：**182 项**，分五组——

- 三档依据各造一处：结构化字段给地址、正文来源行给地址、认不出来源行如实留空，逐档断言链接形态与「依据」列文本；
- 复查表只列文号类（造一条 docref + 一条 citation，断言表里只有 1 行、且「已复查 1 处」与行数一致）；
- 超出上限如实说明（两张表各造 21 条）；
- 真实任务走查：全库 35 个有结论的任务逐个生成这一节，断言节标题、末尾空行、表行数 == min(明细数, 上限)、每行 5 个单元格、链接都是 http(s) 且不含空格、复查表行数与文号类记录数一致；
- 同源静态走查：上限常量只有一份、组件里只调用一次、组件里不再自己拼节标题。

真实数据这一趟生出 **2 行出处表 · 2 个可点开链接**，与 `verify:policytrace` 报的「仅正文提到 2 处、2 处带地址」对得上——两个门禁走同一份取数，数字不可能各说一套。

量化：新增 `verify:docrefmd` **182 项**（`qa:all` 从 50 个 verify 变 51 个），`verify:policytrace` 254 项未变；交付 MD 的「政策文号溯源」节从 **0 条断言到 182 条**；查出口径混淆 1 处、静默截断 2 处，`slice(0, 20)` 字面量 3 处收成 1 个常量，取数 SQL 2 份收成 1 份。

### 断言有效性抽检：6 处故意改坏，5 处被拦住，1 处暴露了自证其说的盲点

门禁项数涨到 254 + 182，但「项数多」不等于「拦得住」。这轮挑 6 条关键判据，逐条把实现改坏、跑对应门禁、确认它红、再改回（`git diff` 逐条核对干净）。

| # | 改坏的地方 | 拦住它的断言 | 结果 |
| --- | --- | --- | --- |
| 1 | `retainedSourceAt` 的归属方向从「往后找最近的来源行」改成「往前找」 | 归属方向那组 | **红，7 项失败**（含「往前找会归错页」与真实数据的地址） |
| 2 | `docRefSection` 不再按 `kind === 'docref'` 过滤复查记录 | 复查表行数 == 文号类记录数 | **红，5 项失败**；真实数据里 4 个任务对不上，共多出 **18 行**引用复查混进了文号溯源节 |
| 3 | 交付 MD 的待确认表把 `DOC_REF_TABLE_LIMIT` 换回字面量 `10` | 同源静态走查 | **红，3 项失败** |
| 4 | `SOURCE_VIA_TEXT["body-line"]` 改成空串 | 交付 MD 的「依据」列 | **`verify:policytrace` 红（2 项），`verify:docrefmd` 却 182 项全绿** |
| 5 | `urlsOfCall` 加上「盲扫留存正文里的地址」 | 留存正文里的地址不进引用清单 | **红，5 项失败** |
| 6 | `scan:uimd` 的白名单去掉「展开」一词 | `REQUIRED_TOGGLES` 必需入口 | **退出码 1**：覆盖从 234 次扫描 / 121626 节点 / 200 个入口塌到 58 次 / 26208 节点 / 24 个（去重 13 类 → 4 类），而**残留仍报 0** |

第 2 条顺手给出了上一轮那个口径缺陷的真实规模：不是理论上的可能对不上，而是 4 个任务的交付 MD 里已经混进了 18 行引用复查（eb75f4fb 9 行 vs 4 条、4bb22d34 13 行 vs 3 条、17a56468 6 vs 5、7459b28a 3 vs 1）。第 6 条则是「空跑绿」的教科书样本：少一个白名单词，覆盖面塌掉四分之三，输出上依然是 0 残留、依然好看。

**第 4 条是这轮唯一的真盲点。** `verify:docrefmd` 里「依据列写明档位」那条断言的**期望值取自 `SOURCE_VIA_TEXT` 本身**：常量被清空时期望值跟着变空，断言自证其说——交付 MD 的依据列已经变成空单元格，182 项却全绿。同一类的还有一条脚注断言写成 `l.includes(SOURCE_VIA_TEXT["body-line"])`，而 `includes("")` 恒真。

修法是给自引用的断言配一条**不引用常量**的兜底：按列位置取第 5 列（`viaCell`），断言「依据列没有空值」「三档各占一行」「取值都在档位文案表里」，真实任务走查里逐行加一条「依据列非空」，脚注那条改成「三档文案都非空且都出现在脚注里」。再改坏一次验证：`verify:docrefmd` **187 项里 3 项失败**，其中一项正是真实任务 89498fe0 的依据列为空——兜底断言确实咬住了。

教训记下来：**凡是断言的期望值与被测实现共用同一个常量或同一张表，这条断言就只能验「接线接上了」，验不了「值还在」。** 这类断言必须配一条按位置或按字面量独立取的兜底。抽检这件事查的不是实现、是断言本身，应该定期做。

顺带一个发现：第 5 条变异（引用清单被正文里的地址污染）让 `verify:searchev` 的检查项从 620 涨到 **789 而仍然全绿**。它的断言是自洽型的（计数与明细一致、去重正确），对「清单里多了一批不该有的地址」不敏感；真正拦住污染的是 `verify:policytrace` 那条「留存正文里的地址不进引用清单（只认结构化字段）」。两个门禁的分工由此清楚了一分：`searchev` 管形状自洽，`policytrace` 管来源边界。要不要给 `searchev` 补一条绝对口径的断言，留给下一轮判断——它可能只是分工不同，不是缺陷。

量化：抽检 6 条，5 条被现有断言当场拦住，1 条暴露盲点并加固；`verify:docrefmd` 182 → **187 项**，其余门禁项数未变（`verify:policytrace` 254、`verify:searchev` 620）。

### 脚本头部的运行命令：从「手工查过一次」变成常驻门禁

上一轮手工查出 1 处脚本头部注释里的运行命令写错（把文号溯源那条写成了政策库的另一项检查），改完就完了。问题是这种错**不会报任何错**：照着敲，跑到别的检查上，看到一片绿还以为本脚本过了。手工查过一次不等于以后不会漂——脚本会改名、script 键会重命名、`qa:all` 会增删条目。

新门禁 `verify:runcmd` 从三个方向核对：

1. **正向**：每个脚本头部注释里的那条运行命令，顺着 package.json 的 `pnpm --filter <pkg> <sub>` 链一路解析到最终命令行，命令行里必须出现这个脚本自己的文件名。60 个带运行命令的脚本逐个走一遍。
2. **反向**：`qa:all` 里挂着的 52 个 verify 条目都要能解析到一条真实存在的 `tsx xxx.ts`，不允许门禁清单里挂着一个已经改名或删掉的脚本。
3. **对外文档**：README 与 `docs/competition/*.md` 是交付件，里面写的 38 条 pnpm 命令逐个核对存在性——照着敲报「Command not found」比脚本注释写错更难看。`docs/testing` 不纳入，那是内部记录，本来就会写「此前误写成某某」这类历史叙述。

写这个脚本自己先被自己绊了两跤，都值得记下来：

- 头部注释里为了说明判据，原样写了一句带命令形态的示例文字，结果**这句说明被自己的正则当成了运行命令**，报「这条命令在 package.json 里不存在」。说明性文字里出现命令样例，就得防着被自己的扫描器吃掉——改成不含命令形态的措辞。
- 包扫描只遍历了 `apps/` 与 `packages/`，漏了 `agents/`（智研税审、土增智填两个智能体包），于是 `pnpm --filter @tax/agent-rd-audit verify:policy` 这条链解析不出来，报「qa:all 里的 verify:policy 解析不出来」。这条报错是**假阳性**，但它暴露的口径问题是真的：workspace 的包分布在三个目录下，任何「遍历所有包」的代码都得三个都走。

变异验证：把 `verify-delivery-docref.ts` 头部的命令改成另一个真实存在的检查（`verify:docsrc`）——正是最容易犯、也最难发现的那类错，命令能跑、跑的不是本脚本。门禁当场红，报错直接点出「实际执行的是 `tsx scripts/verify-doc-source.ts`，跑不到本脚本」。

量化：这一轮**没查出既有不符**（60 条脚本命令 + 52 条 qa 条目 + 38 条文档命令，共 150 处一致性全部对得上，说明上一轮那次手工修正之后是干净的）。价值在于把这 150 处从「0 处被自动核对」变成「每次 `qa:all` 都核对一遍」：`verify:runcmd` **269 项**，`qa:all` 从 51 个 verify 变 52 个。

### 五处口径交叉核对：第一趟就查出 13 处不一致，其中 10 处是门禁自己算错了

待办里写的是「同一个数字在看板 / 台账 / 交付 MD / manifest / 作品说明五处必须一致，现在只有台账 vs 看板对过」。先去看那「对过」的一处：`verify:ledger` 比的是台账合计 vs 看板聚合，而**台账行与看板聚合都是 `stats.ts` 同一次遍历里算出来的**（`ledger.push` 与 `evidence.xxx +=` 就挨在一起），等于自己跟自己比。真正独立的两条路径是：

- 服务端聚合：`stats.ts` → 看板、台账、作品说明（`gen-materials` 也从这里取数）；
- 前端交付：web 侧纯函数 + 各自从库取数 → 交付 MD、`manifest.json`。

这两条从来没有逐项对过。交叉核对因此加在 `verify:manifest` 里——它是唯一同时握着两条路径数据的地方（真实走查本来就在服务端脚本里用 web 侧纯函数组装 manifest 输入），不必再抄第三份取数。三层对比：任务级比台账行（13 项指标）、平台级比 `evidence` 聚合（11 项）、交付 MD 比它写在人读那一行里的数字（6 个片段）。

第一趟就红了 13 处，全部集中在「引用」这一族，而**两处真因都不是产品缺陷**：

1. **门禁自己算错了**（10 处）。`verify-manifest` 的 `citationsOf` 注释写着「与前端同一口径」，实现却漏传 `UNCAPPED`：`extractCitations` / `mergeCitations` 的默认上限是给界面胶囊用的 20 / 24 条，于是交付包这一侧被截到 24。报出来的是「aabd138a 台账 41 ≠ 交付包 24」「4bb22d34 台账 44 ≠ 交付包 24」「看板 204 ≠ 交付包累加 174」。而 `stats.ts` 那边早就明确写了「统计按全量算，不套用界面清单上限」，还记着一次教训（真加了 2 条官方原文却被算成 official 11 → 10、判为证据质量退步）。**注释说同源、实现不同源，这类漂移只有交叉核对能抓到**：单边自校验永远是绿的。修完交付包侧是 211 条，与看板 204 条的差额正好等于下面第 2 条。
2. **有意的口径差异**（3 处）。`stats.ts` 对没有结论的任务把引用三项记 0（注释写明理由：无结论任务的引用进不了缺口清单，计进来会让台账欠账与缺口清单互相矛盾），而交付包照实给出检索留存里的引用数。3 个无结论任务共 7 条引用因此不在看板的 204 里。

第 2 条的处理方式值得单说：既不能当成不一致报失败（那是口径差异不是缺陷），也不能一声不响地跳过（跳过就等于这条口径从此没人守，哪天被改回去也没人发现）。所以按 `hasConclusion` 分成两支：有结论的任务逐项相等；无结论的任务断言台账侧**必须是 0**，交付包侧的条数只报不计入平台累加，并单独打一行说明。口径本身因此变成了断言对象。

量化：`verify:manifest` 425 → **1200 项**（任务级 35 个有结论任务 × 13 项 + 3 个无结论任务 × 3 项 + 交付 MD 文号节 38 个 × 6 项 + 平台级 11 项 + 3 条「确实比对到了东西」）。13 处不一致全部消解：10 处是门禁自己漏传 `UNCAPPED`，3 处是有意口径差异、现已写成断言。**文号**（总数 / 有出处 / 仅正文提到 / 复查取得 / 待复查 / matched）、**检索**（调用 / 仅元数据）、**金额**（总数 / 待确认）共 10 项指标两条路径逐项全等，平台级 11 项也全等——说明这几族此前就是对得上的，只是从来没人验过。金额待确认合计 85 / 金额总数 958，与台账、作品说明里的数字一致。

还没接上的一处：交付 MD 只核对了「政策文号溯源」节的 6 个数字，因为只有这一节被抽成了模块（上一轮的成果），其余各节仍在 `bundleLines()` 闭包里取不到。等剩余各节抽完，按节接上即可；作品说明这一处目前是**间接**对上的（它由 `gen-materials` 从 `stats` 取数生成，而 `stats` 已与交付路径逐项对过），直接解析文档文本再比一遍留给下一轮判断值不值得做。

### 交付物真的下载一次：三个「验生成逻辑」的门禁都没产出过一份文件

`verify:csv` 验的是 `csv.ts` 的纯函数（转义 / BOM / CRLF / 往返），`verify:bundle` 验的是打包函数与条目组装，`verify:diaexport` 验的是图类型识别、文件名与导出配置——三个都在验「生成逻辑对不对」，**没有一个真的产出过一份文件**。于是对外声称的三句话此前全靠推断：「CSV 带 BOM，Excel 打开不乱码、含逗号与引号的标题不串列」「PNG 带背景色，Office 与 WPS 直接插得进」「bundle 里文件齐且 manifest 自校验通过」。

新脚本 `scan:deliverables`（`pnpm scan:deliverables`，需要 `pnpm dev` 已起）用真浏览器点真按钮，接住 `download` 事件把字节落到临时目录，再逐项验：台账 CSV、台账 Markdown（作品总览页），单任务核对表 MD、交付包 zip、mermaid 的 PNG 与 SVG（任务结果页）。挑任务不能只挑「结论里有 mermaid」：交付包这一档还要有产物与上传资料，否则 manifest 的申报核对就在空数组上通过了——第一版正是这样，选中一个测试任务，zip 里只有 2 个文件、申报产物 0 份，那条「申报的都在包里」绿得毫无意义。现在优先挑三样都齐的任务，并断言 `declaredTotal > 0`。

**第一趟就查出三个真缺陷，全在 SVG 导出这一条路上**：

1. **两条导出路径不同源。** 「下载 PNG」用 `mm.render(id, withExportInit(code))` 重新渲染，「下载 SVG」却直接 `svg.cloneNode(true)` 抓页面上已经渲染好的 DOM。页面为了好看用 `htmlLabels`（标签是 `foreignObject` 里的 HTML），而 Office 与 WPS 插 SVG 时不渲染 `foreignObject`。实测导出的 SVG 有 53KB、`<path>` 与 `<rect>` 齐全，**12 处文字全在 `foreignObject` 里**，插进 Office 就是一张只有框没有字的图。而按钮的 title 写的是「导出矢量图（放大不糊，需要较新的 Office 或浏览器打开）」——暗示能进 Office。修法不是给 SVG 单独打补丁，而是把两条路收成一份 `exportSvg()`：都重新渲染、都补 `xmlns`、都过 `sanitizeSvgForExport`。
2. **`withExportInit` 遇到作者自带 init 就整条失效。** 原实现是「原文已带 init 指令时原样返回，尊重作者写的配置」。这个取舍在页面上成立，在导出件上不成立：作者写 `%%{init: {"theme":"neutral"}}%%` 只是为了配色，导出必需的 `htmlLabels:false` 就跟着被丢掉了。改成**合并**——作者的其它配置优先，`htmlLabels` 一律关掉；作者的 init 解析不出来时不猜，整条换成导出配置。
3. **mermaid v11 只关 `flowchart.htmlLabels` 不够。** 合并逻辑修好、指令也确实前置了，导出的 SVG 里节点标签仍然落在 `foreignObject` 里。顶层 `htmlLabels` 与 `flowchart.htmlLabels` 两处都写之后才干净（多写一处对不认它的版本无害，少写一处就导出没有文字的图）。这一条是实测逼出来的，不是读文档读出来的。

翻车两次，都在测试数据上：

- 合并用的正则第一版写成非贪婪 `([\s\S]*?)\}%%`。init 的 JSON 自己就以 `}` 结尾，指令收尾是「JSON 的 `}` + 指令的 `}` + `%%`」，非贪婪会在第一个 `}%%` 处截断，把 `{"theme":"neutral"}` 捕成 `{"theme":"neutral"`，`JSON.parse` 失败 → 作者配置被整条丢掉。改贪婪。
- 给合并写的测试数据少写了一层收尾括号（`%%{init: {"flowchart":{...}}%%`，正确是三个 `}`），于是被当成「作者的 init 不是合法 JSON」走了退回分支，断言「留住作者的 curve 配置」当然红。**实现没错，是我构造的输入不合法**——这类失败先看测试数据再看实现。

顺带收了两处重复：`findChromium` 从 `scan-ui-markdown.ts` 抽到新的 `browser-lib.ts`（两个实测脚本共用，本机缓存路径与 headless shell 的坑只写一份），`parseCsv` 从 `verify-csv.ts` 抽到 `csv.ts`（生成与解析本来就该是一对；交付物实测要按 RFC 把真下载到的 CSV 解析回来验列数，抄一遍就是两处口径各改各的）。

还有一个与 P0-4 同源的教训：台账的两个下载按钮在 `<details>` 里、默认折叠，`visible=false`，直接点会一直等到超时，而报错只说「Timeout exceeded」。实测脚本必须先点 `summary` 展开。点击失败现在会把 `visible` / `enabled` 一起打出来，否则下次还是只能看到一句超时。

量化：真下载 **6 份**交付物、**44 项**字节级检查全过——台账 CSV 40 行 × 22 列（BOM、CRLF、每行字段数一致、无公式注入格）、台账 MD 6202 字 / 表格 41 行（竖线数一致、不错位）、核对表 MD 801 字 / 表格 11 行、交付包 zip 4 个文件（含 manifest.json，schema 对得上、`manifestIssues` 自校验为空、申报的 2 份产物与 1 份资料都在包里）、PNG 982×556（魔数、IHDR、IEND 完整）、SVG 不含 `foreignObject` 且有 `width`/`viewBox`。`verify:diaexport` 79 → **85 项**（合并行为 8 条新断言，改写原来那 2 条「原样返回」）。文件落在系统临时目录并打印路径，可以用 Excel 与 Office 人工复核。

它不进 `qa:all`，理由与 `scan:uimd` 相同：要开浏览器、要前端在跑，失败原因常常与代码无关。`--strict` 下有任何一项不符即退出码 1；非 `--strict` 时打 `[WARN]` 而不再打 `[PASS]`——第一版在有 6 项失败的情况下末尾仍然印 `[PASS]`，那种输出比没有输出更坏。

### 待确认金额的两类拆分只接到了台账：复核人在任务页上看到的仍是一整列

追一个对外声称的数字「金额待确认 85 处（61 引自联网正文 / 24 三处均无出处）」，把它在代码里的全部消费点走一遍，发现**分类只存在于服务端**：`classifyUntraced` 的调用方只有 `stats.ts`（喂台账那两列与看板 tooltip）和 `verify-amount-trace.ts`。前端一处都没接——任务页的金额核对清单（`amountReviewItems`）与结论正文的就地标注（`amountAnnotations`）拿到的都是一整列 `untraced`，复核人看不出哪一处是「引自联网正文、只要核对引用抄得准不准」，哪一处是「三处均无出处、这才是要拦的」。

缺口的位置很别扭：**逐条处置恰恰是在任务页做的**。台账告诉你「全平台有 24 处三处均无出处」，可点进去要一条条看的时候，这 24 处又和另外 61 处混在同一列里，还是得靠人把上下文读一遍才能判断属于哪类。

修法是在源头出一份、消费点逐个接上：`amount-trace.ts` 加 `UNTRACED_ORIGIN_TEXT` / `UNTRACED_ORIGIN_HINT`（台账列名、看板 tooltip、复核页徽章、就地标注 label 共用一份，各写一遍迟早漂；文案不能带 Markdown 记号，因为会直接进 JSX 文本与 `title` 属性），`TaskWorkbench` 用与服务端**同一个** `classifyUntraced` 算出 `amountOrigin`（按 `amountKey` 查），就地标注的 label 与复核页每条清单都带上类别徽章（`unexplained` 用玫红，`web` 用中性灰，两类的处置动作本来就不同）。

口径上踩了一个坑：服务端算检索结果池时是 `parsedCalls.filter(SEARCH_TOOL_NAMES)`，**不按 ok 过滤**；我第一版前端写成 `c.ok !== false && SEARCH_TOOLS.has(...)`（跟着同文件里 `traceAmounts` 的写法走的），两边就差了一层过滤。这类差异不报错，只会让任务页的分类与台账两列悄悄对不上。所以交叉核对里也把这两项接了进去（`其中引自联网正文` / `其中三处均无出处`，台账 vs 交付路径逐项比），改完 570 次逐项对比 0 失败，才算证明两边真的是同一口径——**接一个新消费点，就顺手把它纳入交叉核对**，否则「同源」只是注释里的一句话。

兜底方向也有讲究：`amountOrigin.get(key)` 查不到时兜成 `unexplained`（更严的那一类），不是 `web`。兜底要选「宁可多拦一条」，不能选「宁可放过一条」。

量化：`verify:amounts` 109 → **120 项**（两类文案覆盖两档、非空、不含 Markdown 记号，外加「样例里两类都确实出现了」这条防空跑），`verify:manifest` 1200 → **1276 项**（交叉核对新增两项指标，逐项对比 570 次全过）。真实数据：金额待确认 85 处 = 引自联网正文 61 + 三处均无出处 24，与台账两列、作品说明里的数字一致；界面上这 85 处现在每一条都带类别徽章。`scan:uimd --strict` 复扫残留 0。

还没接上的三个消费点：`evidence-sheet.ts`（单任务核对表的金额节）、`delivery-check.ts`（交付自检的提醒）与交付 MD 的金额节仍只报一个合计。前两个要改 `SheetInput` / `CheckInput` 的类型，连带 manifest 的 `amounts` 结构与 `manifestIssues` 的不变量；第三个在 `bundleLines()` 闭包里。留下一轮接，理由与「政策文号溯源」节相同：一次改四个模块的类型会变成一个不可验证的大包。

### 金额两类拆分接到剩下三个消费点：核对表、交付自检、交付包清单

上一轮把「引自联网正文 / 三处均无出处」接到了任务页的就地标注与复核清单，但同一份拆分还有三个消费点没接：单任务核对表（`evidence-sheet.ts`）的金额溯源行、交付自检（`delivery-check.ts`）的提醒、交付包 `manifest.json` 的 `amounts`。三处都只报一个 `pending` 合计。

这三个不是「顺便也改一下」的关系：核对表是**签字归档件**（表末有核对人签字行），交付自检决定「可交付 / 谨慎交付 / 不建议直接交付」，manifest 是交付包的机器可读清单。复核人在核对表上看到「待人工确认 85」却没有那 24 处要逐条看的分类，等于把最关键的处置信息留在了平台界面里、没跟着纸面材料走。

改法仍是源头一份、消费点逐个接：三个模块的输入类型各加两个字段（核对表与 manifest 叫 `pendingWeb` / `pendingUnexplained`，交付自检叫 `amountPendingWeb` / `amountPendingUnexplained`），文案按同一句式报，取数全部来自 `TaskWorkbench` 里那**一个** `amountSplit`，不各自再算一遍。

`manifest.json` 顺带补了一条不变量：`pendingWeb + pendingUnexplained === pending`，由 `manifestIssues` 自校验。交付包里出现「合计 85、分类加起来 61」这种账必须当场报出来，而不是等人对账时才发现。断言用三条钉住：两类之和不符会报、分类计数为负会报、**样例清单本身是平的**——最后这条是防「断言只在坏数据上生效、好数据其实也没配平」。

**用 typecheck 找消费点，不靠记忆**：先把三个模块的类型改严，`pnpm typecheck:all` 直接把 9 个需要补字段的位置全列了出来（`TaskWorkbench` 3 处、`verify-evidence-sheet` 4 处、`verify-manifest` 4 处、`verify-delivery-check` 1 处）。这比 rg 关键字可靠——漏一个消费点 TS 会当场说，而 rg 只能找到你想得到去搜的那些。这也是「同一判据的多个消费点要逐个接上」最省力的执行方式：把判据写进类型，让编译器去数消费点。

翻车一次：新加的断言引用了 `bareRows`，而它定义在插入点之后 60 多行，`const` 的暂时性死区会让脚本直接抛错。断言插在哪要看它引用的数据在哪儿初始化，不能只看语义上属于哪一段。

量化：`verify:sheet` 412 → **415 项**（金额行按两类拆开报、待确认为 0 时不写拆分也不填占位数字），`verify:dcheck` 149 → **152 项**（提醒里两类处数与总数必须并存于同一条），`verify:manifest` 1276 → **1279 项**（两条新不变量 + 一条配平）。交叉核对的 570 次逐项对比仍全过，说明台账、任务页、核对表、交付包四处现在是同一个数。真实数据：金额待确认 85 = 引自联网正文 61 + 三处均无出处 24。`scan:uimd --strict` 复扫残留 0。

还没接的最后一处：交付 MD 的金额节（`## 结论金额溯源`）仍在 `bundleLines()` 闭包里，要接分类就得先把这一节抽成模块，与抽「政策文号溯源」节同一套路。

### 交付 MD 的金额节也搬出组件：待确认金额表现在带类别，处置建议按类别分开写

最后一处没接分类的是交付 MD 的金额节。这轮按抽「政策文号溯源」节的同一套路把它搬进 `apps/web/src/delivery-amount.ts`，导出 `amountSection(input)`，组件里只剩一次调用。

搬出来之后才腾得出手做两件在闭包里做不了的事：

1. **待确认金额表加「类别」列，并把「处理建议」按类别分开写。** 此前那一列对所有 85 处都是同一句「核对来源或在正文中点击标记为已核对」，等于没给建议：引自联网正文的那 61 处要做的是核对引用抄得准不准，三处均无出处的那 24 处要做的是逐条确认是否为推算值。两个动作完全不同，混在一句通用话里，复核人还是得自己判断属于哪类——而那正是分类本来要替他做的事。`ORIGIN_ADVICE` 与 `UNTRACED_ORIGIN_HINT` 分工明确：后者解释依据是什么（进 tooltip，可以长），前者写该做什么（进表格的一列，必须短）。
2. **表后加一行配平说明**：「两类之和 N 处 = 待人工确认 M 处」，并把两类的口径写清。交付 MD 是签字归档件，复核人要能自己在纸上把这笔账对平，而不是相信一个数字。

真实数据走查没有另起一份取数：`verify:manifest` 的循环里已经组装好了 `amounts`、待确认清单与两类拆分，直接在那儿调 `amountSection` 逐项核对（首行 4 个数字、有待确认时的两类拆分 2 个数字、表行数 == min(待确认数, 上限)、每一行都标了类别）。再抄一份 SQL 就是第三处口径，而这正是前两轮反复踩的坑。

量化：`verify:delivamount` 新增 **34 项**（两类各造几处、验类别列与处置建议成对出现；超出上限如实说明还有几处没列；空态不写拆分也不填占位数字；已核对表逐条列出且备注为空时写「（无）」；组件里只调用一次、不再自己拼节标题、上限没在组件里写死），`verify:manifest` 1279 → **1511 项**（38 个任务的交付 MD 金额节逐个走查），`qa:all` 从 52 个 verify 变 53 个。真实数据：金额待确认 85 = 引自联网正文 61 + 三处均无出处 24，交付 MD、核对表、交付自检、manifest、台账五处现在报的是同一组数。

翻车两次都在 `apply_patch` 上：一个 hunk 的上下文里带了 `};` 这样的短行，匹配失败，而报错只说「找不到期望的行」，看不出是哪个 hunk 出的问题。把 hunk 拆小、换成更长且唯一的锚点（整行注释）之后才过。教训是**上下文行要选长的、唯一的**：`}`、`};`、`),` 这类短行在同一个文件里出现几十次，靠它定位等于赌。

### 「未进结论正文的弱证据」此前只有一个计数：8 条到底是哪 8 条，界面上看不到

追 `weakUncited` 这个数字（台账一列、看板 tooltip 一处、交付自检一条说明），发现它在界面上**只有计数、没有明细**：`TaskWorkbench` 里是 `Math.max(0, weakSettledUrls.size - weakDisclaimedUrls.size)`，一个减法算出来的数；`AgentOverview` 把它拼进「其中 N 条未进入结论正文」的文案。复核人看到「8 条」，却没有任何入口知道是哪 8 条，更没法点开原文确认这个判据对不对。

而这一类的判据恰恰最需要人抽查：它说的是「这条引用从没被写进结论正文，所以不是交付依据、也不必催人替换」，靠 `extractTextCitations` 回读结论来判。万一提取规则漏了某种写法（地址被包在行内代码里、写成脚注、或被换行拆开），一条真在用的依据就会被判成「没进结论」，然后从待处置清单里**静默消失**。这种错误不报错，只会让欠账数字变好看——正是「不为数字好看放宽判据」要防的那一类。

修法与「仅正文提到」那一组同一套路：源头出明细、计数由明细派生。`ref-check.ts` 加 `uncitedWeakItems(citations, conclusion)` 返回 `{url, title}[]`（按地址去重、带出标题），`uncitedWeakUrls` 改成由它派生（`new Set(items.map(i => i.url))`），于是集合与明细不可能各说一套。`TaskWorkbench` 的 `weakUncited` 从减法改成 `weakUncitedItems.length`，明细传给结果页；结果页在弱证据面板上方新增一组「未进结论正文的弱证据」，每条给标题与一个「原文」按钮走侧边阅读器，组头一句话说清这一类为什么不必替换、以及点开是为了核对判据。

口径上又踩到同一类坑，值得单独记：服务端 `stats.ts` 算这两项时都在 `hasConclusion` 为假的分支里记 0（注释写明理由——这两类都要**回读结论正文**才判得出来，分级只看地址与标题；没有结论就没有正文可回读）。我第一版直接拿 `uncitedWeakItems(...).length` 与台账比，交叉核对当场报「060b4eea 未进结论正文的弱证据：台账 0 ≠ 交付包 4」。这不是缺陷而是口径差异，处置方式与引用三项一样：按 `hasConclusion` 分支，有结论的逐项相等，无结论的断言台账侧必须是 0，并把报错原因写全。同时把这一支的清单从「引用三项」扩成「引用三项 + 弱证据两类」，变量名也从 `citePairs` 改成 `conclusionPairs`——**名字要跟着判据走**，否则下一个人会以为它只管引用。

还有一处：`weakUncited` 要扣掉「已声明为背景参考」的部分（服务端是 `[...uncitedWeakUrls(...)].filter(u => !disclaimedUrls.has(u))`）。第一版没扣，等于把两类重叠的部分算了两遍。

量化：`verify:refcheck` 680 → **687 项**（明细按地址去重、带出标题、官方来源不进这份明细、集合与明细同源两条、清单上限是正整数），`verify:manifest` 1511 → **1587 项**，交叉核对逐项对比 570 → **646 次**（新增两项指标 × 38 个任务，其中 3 个无结论任务走「必须为 0」那一支）。真实数据：全库「未进结论正文的弱证据」8 条、「已声明背景参考」15 条，现在界面上逐条可点开，且与台账两列逐项相等。`scan:uimd --strict` 复扫残留 0。

### 「已声明为背景参考」那 15 条同样只有计数：判据里最松的一步没人能抽查

上一轮给「未进结论正文的弱证据」补了逐条明细，同一面板里的另一类——「已在结论中声明为背景参考」——还是只有一个数。而这一类的判据比上一轮那类**更松**：`isDisclaimedInConclusion` 先按地址认，地址认不出就退回**按标题认**（工具留存的引用常常只在清单里出现一次，正文里不写地址）。按标题认意味着：结论里任何一行只要出现这个标题、又带着「仅作背景参考」这类字样，这条引用就被判成已声明，从待处置清单里划掉。

误判的方向是**让欠账变少**。所以它比上一轮那类更需要能被逐条抽查，而不是只报一个「15 条」。

修法完全对称：`ref-check.ts` 加 `disclaimedWeakItems` 出明细（按地址去重、带标题），`disclaimedWeakUrls` 改成由它派生；`TaskWorkbench` 的 `weakDisclaimedUrls` 从直接调用改成 `new Set(items.map(i => i.url))`，计数与明细同源；结果页在「未进结论正文」那一组上方再加一组「已声明为背景参考的弱证据」，每条给标题与「原文」按钮，组头写明「点开原文、或在结论里搜这个标题，可核对声明是不是真的写了」——这一类的依据在结论正文里而不在外部页面，所以核对动作是两步。

两组共用一个清单上限常量，并把名字从 `UNCITED_WEAK_LIST_LIMIT` 改成 `WEAK_SETTLED_LIST_LIMIT`：它管的是「两类不必再催办的弱证据」，名字只提其中一类，下一个人加第三类时就不知道该不该复用。

顺带把两类**重叠**的边界钉住了。声明句里只写标题、不写地址时，那条引用同时落进两类（既算已声明、又算未进结论正文），所以「已处置集合」是**并集**而不是相加——这正是服务端算 `weakUncited` 时要先 `filter` 掉 `disclaimed` 的原因（`stats.ts` 的注释写着「uncited 要扣掉与 disclaimed 重叠的部分，三个数才刚好加回弱证据总数」）。三条断言把这个边界固定下来：只写标题的声明算已声明、地址没进正文时它同时算未进结论、重叠时已处置集合只算一条。没有这三条，将来谁把那个 `filter` 去掉，欠账会凭空多出一批，而所有单边门禁都是绿的。

量化：`verify:refcheck` 687 → **697 项**（按地址认、按标题认、没写声明的不进明细、计数与明细同源两条、两类并集等于已处置集合、重叠边界三条）。`verify:manifest` 1587 项与交叉核对 646 次逐项对比**一字未动**——「已声明背景参考的弱证据」上一轮已纳入交叉核对，这一轮把它的取数改成由明细派生之后数字没变，正是「同源改造没改口径」的证据。真实数据：全库弱证据 23 条 = 已声明 15 + 未进结论 8（重叠 0），待处置 0 条，这 23 条现在界面上逐条可点开。`scan:uimd --strict` 复扫残留 0。

### 提示词回归：11 个「渲染实测」任务逐条对约束，顺带撞出一个表格解析的真缺陷

系统提示词里写了一批硬约束（先查政策再测算、加计扣除比例必须取自工具返回值、抓取报 404/412 要如实标注且不得凭检索摘要或记忆补写原文、金额保留两位小数、结论用表格与 mermaid 组织且图后附一句说明、问题清单用有序列表）。「写了」不等于「模型遵守了」，此前只能靠人把结论读一遍：改一次提示词就要重读一次，而读的人未必记得全部约束，漏读一条就是静默退化。

新门禁 `verify:promptreg` 用**命名约定**接管这件事：标题以「渲染实测」开头的任务就是回归任务，脚本对它们逐个走查。新建一个这类任务，门禁自动覆盖，不用回来改脚本——这一趟它直接吃下了库里已有的 11 个任务，不只是这轮新建的 2 个（「渲染实测J 加计扣除测算与图表」验测算与图表约束、「渲染实测K 失效链接处置」验 404 处置与「不得凭记忆补写原文」）。

约束分两组，判据不同。**硬约束**所有回归任务都必须满足：金额两位小数；`search_rd_policy` 必须在 `calculate_rd_adjustment` 之前；比例数字必须出现在政策检索的返回文本里（不认字段名、只认数字，工具入参改了也不会失效）；本任务确实出现过抓取失败时，结论必须如实标注。**呈现要求**只在指令确实要求了的时候验（指令写了「表格」才验表格、写了「mermaid / 流程图」才验图与图后说明、写了「有序列表 / 核查要点」才验列表），避免拿一条没要求画图的指令去判「缺 mermaid」。每组都有触发计数器，末尾断言四组「确实被检查过」，否则库里没有回归任务时这个门禁会永远绿着。

第一趟红了 4 处，全是「mermaid 图后没有紧跟文字说明」，而**4 处都是我的判据错了、不是模型错了**：真实结论里图后写的是 `**图意说明：** …` 与 `**图说（约140字）**：…`，粗体开头。第一版把 `*` 与 `-` 一律当列表记号排除，于是把粗体说明误杀成「没有说明」。改成只把「又一个块的开头」判为无说明（代码围栏、标题、表格、分隔线）。**用真实任务的结论校准判据，比照着提示词字面想象一个正则可靠**——这与「断言的期望值不能与被测实现共用同一个常量」是同一类教训：断言本身也要被真实数据验一遍。

第二趟又撞出一个真缺陷，这次出在别的门禁上：新任务的文号上下文以 `\|` 开头（模型在结论里如实抄了原文的表格片段），`mdCell` 正确地把竖线转义了，而 `verify:docrefmd` 数单元格用的是 `line.split("|")`，把转义竖线也当成了列分隔符，于是报「表行不是 5 个单元格」。交付 MD 本身没坏，是**校验器的表格解析太粗**。修在源头：`md-text.ts` 加 `markdownTableCells(line)`，按 Markdown 规则拆单元格、认 `\|` 为字面竖线，三个消费点共用（交付 MD 文号节的列数断言、交付物实测里台账 MD 的错位检查、本模块单测）——各自 `split` 一遍就是三处口径。这类缺陷此前不可能被发现：库里所有历史任务的上下文都恰好不含竖线，只有新跑一个任务才撞得出来。这正是提示词回归的附带价值，**新数据是门禁的探针**。

量化：新增 `verify:promptreg` **43 项**（11 个回归任务；触发情况：金额 7 · 工具顺序 5 · 比例取自工具 8 · 抓取失败标注 2 · 表格 3 · mermaid 4 · 有序列表 3），`verify:mdtext` 64 → **71 项**（表格拆分 7 条），`verify:docrefmd` 187 → **204 项**（新增 2 个任务的真实走查），`qa:all` 从 53 个 verify 变 54 个。这轮新建 2 个任务后全库统计随之变动（任务 38 → 40、金额待确认 85 → 92、金额总额 958 → 995、交叉核对逐项对比 646 → 680 次），这是预期的：门禁验的是自洽与口径一致，不是某个固定数字。

### 五处口径的最后一处：作品说明里的数字，一半是取数、一半是手写死的

目标状态要求「每一个对外声称的数字都能在看板 / 台账 / 交付 MD / manifest / 作品说明五处对上」。前四处已经由 `verify:manifest` 的交叉核对逐项比过，作品说明这一处此前记的是「间接对上」——理由是它由 `gen-materials` 从 `stats` 取数生成，而 `stats` 已与交付路径逐项对过。这轮去验这个「间接」，发现它只对了一半。

作品说明里的数字有两种来源，混在同一份文档里，读的人分不出来：

- **取数的**：`evidenceSnapshotText()` 生成的那一串（「检索 202 次（留来源 143 / 仅元数据 59）、引用 218 条（官方 159 · 弱 23）、拦下 237 条、文号 121 处（有出处 111…）」），以及第七节「应用效果（真实运行统计）」整段。这些随库更新，与 `stats` 逐项一致。
- **手写死的**：`INNOVATIONS` 文案里的那批。它是导出常量，数字直接写在字符串里，永远不会变。

手写那批里有一句是**实质性错误**：「金额溯源会把工具结果里找不到出处的金额判为待人工确认，**全平台 612 处结论金额零待确认**」。库里现在是 995 处结论金额、92 处待人工确认。也就是说，对外交付件上印着一句与平台数据直接矛盾的绝对声明，而且已经这么印了很久——每次 `qa:all` 都会重新生成这份文档，取数的那半段每次都刷新，于是整份文档看起来「是活的」，恰好掩盖了另一半是死的。这类缺陷靠「文档是不是最新的」永远查不出来。

顺带查出根因的一部分：`evidence` 里有引用、检索、文号三族的平台级聚合，**唯独没有金额**。所以那句「全平台 N 处结论金额」即使想取数也没处可取——台账每行本来就有这四项，平台级只是没人把它们加起来。补上 `amountTotal` / `amountPending` / `amountPendingWeb` / `amountPendingUnexplained` 四个字段，`verify:manifest` 的平台级交叉核对随之从 11 项扩到 15 项（680 次逐项对比全过）。金额不受「有没有结论」影响（与引用、弱证据两类不同），所以累加不放在 `hasConclusion` 分支里，这条也写进了注释。

修法是把「当前状态」与「历史陈述」分开对待，而不是把所有数字都改成取数：

1. `INNOVATIONS` 常量改成 `INNOVATIONS_RAW` 模板 + `innovations()` 函数，凡是描述**当前平台状态**的数字写成 `{占位符}`，生成时取数填入。认不出的占位符**原样留着**而不是替换成空串——留着才能被门禁抓到（`verify:materials` 断言文档里不残留 `{xxx}`），悄悄吞掉等于把写错键名的 bug 藏起来。
2. 描述**某次修复当时效果**的数字保留原值，但必须带时间或限定词。「平台口径变为成功 263 · 失败 7 · 无结果 0，成功率 97.41%，引用 169 → 170」改成「修复当时（2026-09-30）平台口径为……这几个数是那次修复的即时效果，不是当前口径，当前值见第七节」。历史记录不该被取数覆盖（那等于改写历史），但也不能读起来像当前状态。
3. 「零待确认」这类绝对声明单独判：当前待确认 > 0 时文档里出现「零待确认」直接失败。

新门禁 `verify:materials`：**26 项**。当前状态数字按「文档里写了就核对、没写不算失败」的方式匹配（两份作品说明覆盖的范围本来就不同），这轮核对到 12 处；历史数字核对限定词 3 处；外加残留占位符、文档存在与长度、以及三条「确实检查到了东西」。

翻车一次：`INNOVATIONS` 不止 `gen-materials` 在用，`gen-ppt-outline` 也 import 了它。改成函数后 `typecheck` 当场报出来——这又是「把判据写进类型、让编译器数消费点」的收益，靠 rg 关键字很容易只改一处。

量化：`verify:materials` 新增 **26 项**（`qa:all` 从 54 个 verify 变 55 个），`verify:manifest` 1587 → **1670 项**（平台级交叉核对 11 → 15 项）。修掉实质错误声明 1 处（「612 处零待确认」）、误导性陈述 1 处（历史口径写成当前口径），补齐平台级金额聚合字段 4 个。真实数据：全平台金额 995 处 / 待确认 92、引用 218 条、检索 202 次、文号 121 处，这五族在作品说明里现在都是取数。至此五处口径全部有门禁逐项盯着，不再有「间接对上」这一档。

### 门禁的门禁：用空库把走真实数据的 verify 全跑一遍，12 个此前能被空输入骗过

「所有门禁都在验真实数据而不是空跑绿」这句话此前只有 6 处人工抽检的证据（查出 1 处自证其说的盲点）。48 个 verify 脚本里其余的谁也不知道——一个走查型门禁如果断言全是「遍历库里的任务，逐个检查」，那么库空了它就一项都不检查、打印「失败=0」、退出 0，绿得毫无破绽。

新门禁 `verify:gates` 把这件事自动化：给 `config.ts` 的 `dataDir` 加上 `TAXAI_DATA_DIR` 重定向（此前写死在仓库的 `data/`，测试隔离根本没法做），然后建一个空数据目录，把每个「走真实数据」的脚本用空库跑一遍，**必须非 0 退出**。第一趟的结果：

| | 数量 |
| --- | --- |
| verify 脚本总数 | 48 |
| 走真实数据（判据内） | 25 |
| 纯函数单测（判据外，空库本来就该绿） | 23 |
| 空库下断言红 | 13 |
| 空库下崩溃退出 | 0 |
| **空库下仍然绿（能被空输入骗过）** | **12** |

那 12 个是 `verify:amounts`、`verify:artsrc`、`verify:citegrade`、`verify:dcheck`、`verify:ledger`、`verify:fileparse`、`verify:links`、`verify:progress`、`verify:refcheck`、复核导出、`verify:searchev`、`verify:toutcome`。它们的形状都一样：纯函数断言 + 一段真实数据走查，走查那段在空库下一条都不执行，而**没有任何一条断言说「我确实走到了数据」**。于是「失败=0」既可能意味着「全部合格」，也可能意味着「一个都没查」，从输出上分不出来。

修法是逐个补一条防空跑断言，用它自己已有的走查计数（`tasks >= 1`、`ev.ledger.length >= 1`、`listTasks().length >= 1`、`SELECT COUNT(*) FROM tasks`），不引入新的取数、不新增第二份口径。补完 26 个走真实数据的门禁在空库下**全部会红**、0 崩溃、0 被骗过。

判据本身也翻了一次车，翻得很有教育意义：第一版按「源码里出现 `src/db.ts` / `listTasks` / `computePlatformStats` 这些字样」判定谁走真实数据，结果把 **`verify:gates` 自己**也算了进去——它的文档注释里正好写着这几个词。于是它拿空库跑自己，当然是绿的，报出一条谁也修不了的失败。改成只认 import 语句的 `from "..."` 子句、并显式排除自己。**判据要盯着「从哪儿取数」，不是「提到了什么词」**——这与前几轮的教训同源：拿文本特征代替结构特征，迟早被自己的文档绊倒。

顺带把「崩溃退出」与「断言红」分开统计：崩溃也是非 0 退出，但它不代表脚本里有防空跑的判据，只是碰巧退不出 0，属于该补断言的候选而不是可以放心的对象。这轮 0 个崩溃，说明 26 个都是**明确断言**红的，不是靠异常兜的。

`verify:gates` 进了 `qa:all`（第 56 个 verify）。代价是全量门禁从约 2.5 分钟变成约 5 分钟（要起 26 个子进程），换的是「以后每加一个门禁，都会被自动检查它能不能被空输入骗过」。这个交换值得：新增门禁恰恰是最容易漏掉防空跑断言的时候，而漏掉之后没有任何别的手段会发现。

### 链接核验的陈旧行：汇总过滤了，明细与待办没过滤，交付 MD 自己跟自己打架

`link_checks` 按 `(task_id, url)` upsert、**从不删行**。结论续跑或回滚之后，早已不在引用清单里的地址，核验记录仍挂在库里。这件事代码里早就知道——`linkSummary` 那一处写着注释解释为什么要按当前引用清单过滤，否则「全量汇总会把早已不在清单里的地址算成失效，交付自检因此报假警」。

问题是这道判据只接上了一个消费点。同一份 `linkChecks` 还有两个消费点直接吃全量：

| 消费点 | 修复前 | 后果 |
| --- | --- | --- |
| 汇总计数 `linkSummary` | 按引用清单过滤 | 正确 |
| 交付 MD 的核验明细行 | 全量 | 汇总写「非可访问 4 条」，底下列 5 行 |
| 核对表待办「已失效链接」 | 全量 | 催人替换一条交付材料里没有的地址 |

实测（40 个任务，11 个有核验记录、共 131 行，其中 6 行的地址已不在当前引用清单里）：

- **交付 MD 自相矛盾 3 个任务**：eb75f4fb 汇总非可访问 4 / 明细 5 行、7459b28a 5 / 6 行、4bb22d34 13 / 14 行。界面上看不出来——界面是按引用逐条挂核验结果的，陈旧行没有对应的引用胶囊、压根不渲染；只有下载下来的那份 MD 里对不上。
- **核对表待办 4 条里 3 条是幽灵**：全平台「已失效、需替换或补充依据的链接」共 4 条，其中 3 条的地址已不在引用清单里、0 条在结论正文里。复核人被叫去替换的，是这份交付材料里根本不存在的一条链接。

修法是把判据收到一处：`link-check.ts` 新增 `liveLinkChecks(checks, citationUrls)`，三个消费点全部改成吃它的结果（组件里落成一份 `liveChecks`，汇总、MD 明细、核对表待办共用同一个 `useMemo`）。

两处**故意不统一**，写在这里免得下一个人来「合并重复实现」：

- 修订指令那条路更窄一层（只认结论正文里的地址，`deadLinkTargets` 已有的判据）。修订能改的只有结论正文，工具留存是历史调用结果、改不动。两个口径不是同一件事写两遍，是两个不同的问题。
- 交付包新鲜度那处不过滤。它问的是「打包之后有没有新动作」，不是「当前交付材料里有什么」；一次核验即使地址后来掉了，也仍然是打包之后发生过的变更。

修完的数字：核对表失效链接待办 **4 → 1 条**（3 条幽灵消失），交付 MD 的汇总与明细同源、**3 处矛盾归零**。

顺带堵了一个门禁空跑：`verify:sheet` 的真实走查里 `linkCheck` 与 `deadLinks` 此前是**写死的 `null` 与 `[]`**，40 个任务走下来这两处从来没被真实数据碰过，门禁却一直是绿的。接上真实取数之后，「仍有交付前待办」的任务数从 3 变成 4——多出来的正是 c2dda328 那条**真的**失效链接。门禁瞎着的时候，唯一那条真待办也一起被忽略了。

断言分两层。`verify:links` 补 `liveLinkChecks` 的纯函数判据（陈旧行剔除、清单为空则一条不留、重复地址不翻倍、过滤后汇总不再算失效、不过滤确实会多算），外加同源断言：组件里 `liveLinkChecks` 只调用一次、不再有 `Object.values(linkChecks).filter(r => linkVerdict…)` 这种第二份实现。`verify:sheet` 的走查逐条断「待办里的失效链接必须在当前引用清单中」「陈旧行不得漏进待办」，并断「确实遇到了陈旧行」「确实有任务的待办条数因这道过滤而改变」——后两条防的是空差异：真实数据里若一行陈旧行都没有，这道过滤等于没验，绿得毫无意义。

抽检：把 `liveLinkChecks` 改成原样返回（`checks.slice()`），`verify:links` 与 `verify:sheet` **双双变红**，报出「引用清单为空时一条都不留：实际 3，期望 0」「4bb22d34 陈旧失效行漏进了待办」「确实遇到了陈旧行：实际 0 行」。改回后复绿。

门禁项数：`verify:links` 30 → 39、`verify:sheet` 433 → 441。`qa:all` 56 个 verify 全绿；`scan:uimd --strict` 34 页 / 含交互态共扫 235 次 / 130789 个文本节点 / 残留 0 处。

环境插曲，记下来省下一个人的半小时：这轮开工时 C 盘一度 0 字节可用，SQLite 直接报 `disk I/O error`、`apply_patch` 写不进文件。不是代码问题，腾出空间后同一条命令原样通过。遇到 `disk I/O error` 先看盘，别去改判据。

### 交付包清单的门禁从来没读过 link_checks：那一节和每条引用的 verdict 都是写死的空值

上一轮把「只算地址仍在引用清单里的核验行」这道判据收进了 `liveLinkChecks`，顺手去接其余消费点时发现：`verify:manifest` **从头到尾没读过 `link_checks` 表**。它给每个真实任务组装一份 manifest 再跑 `manifestIssues` 自校验，但链接核验那一节写死 `{ summary: null, checkedAt: null }`，每条引用的 `verdict` 写死 `"unchecked"`、`status` 写死 `null`，喂给 `deliveryCheck` 的也是 `linkCheck: null`。

这个门禁是「五处口径交叉核对」的主力，1670 项、走全部 40 个真实任务，看起来最不可能空跑。实测它漏了什么：

| 真实数据 | 门禁看到的 |
| --- | --- |
| 11 个任务共 131 行核验记录 | 0 行 |
| 125 条引用有判定（ok 98 / blocked 20 / unreachable 6 / dead 1） | 225 条全是 `unchecked` |
| `manifestIssues` 两条链接规则 | `summary` 恒为 null，整段跳过 |
| 交付自检 warns/infos | **6 个任务与产品真实产出不一致** |

最后一行是最要紧的：c2dda328 的 warns 实际是 2（那条真失效链接），门禁算出来是 1；另外 5 个任务各少一条「N 条引用拒绝自动访问、M 条无法核验」的说明项。**门禁在验一份产品不会产出的清单**——它自己内部自洽（`manifestIssues` 检查的是 blocks/warns/infos 与 items 明细对不对得上，两边都少所以照样绿），但与用户下载到的 `manifest.json` 不是同一份。

两条链接规则（「四类之和不等于总数」「条数多于引用条数」）此前只在文件顶部那个合成 fixture 上跑过。这类「合成数据验过了、真实数据整段跳过」的形状，比完全没写断言更难发现：脚本输出里检查项数一直在涨，涨的全是别的节。

修法是接上真实取数，判据复用上一轮那一份：`listLinkChecks(t.id)` → `liveLinkChecks(rows, cites.map(c => c.url))` → `summarizeLinkChecks`，`checkedAt` 取全量行的最大值（与服务端 `GET /link-checks` 同口径，不是只取 live 行）；`citationsOf()` 多收一个 `Map<url, LinkCheckLike>`，按 URL 填 `verdict` 与 `status`，查不到就如实写 `unchecked`。

断言分三层：

- **同源但独立组装的两个数字必须对上**：带核验结论的引用条数 == 链接核验汇总总数（实测 125 == 125）。一个是逐条引用填出来的、一个是按核验行汇总出来的，同一份数据两条路径，最容易只改一边。
- **防空跑**：`linkTasks >= 1`、`citesWithVerdict >= 1`。
- **防「读到了却没组装」**：`manifestLinkSummaries >= 1` 且 `== linkTasks`。这条是必要的——只断「读到了核验行」的话，把 manifest 那一节改回 `null` 仍然是绿的，因为 `manifestIssues` 对 null 是整段跳过，不会报错。**「取数接上了」与「取数真的进了被校验的那份产物」是两件事，要各断一次。**

抽检：把 `verdict` 改回写死 `"unchecked"`，12 项失败（11 个任务的条数不符 + 1 条防空跑），改回后复绿。

门禁项数：`verify:manifest` 1670 → 1713。`qa:all` 56 个 verify 全绿。

### 交付 MD 数字最密的那一节，此前一条断言都没有：「联网引用」整节搬出组件

交付 MD 里对外声称数字最密的一节是「联网引用」：证据力分级三类、弱证据两类「不必再催办」的条数、只留查询元数据的检索次数、引用清单逐条、替代来源检索四类、链接核验五类，全在这一节。而它此前写在 `TaskWorkbench` 的 `bundleLines()` 闭包里——`verify:manifest` 的五处交叉核对只覆盖了文号节与金额节，这一节的 MD 文本**一个数字都没对过**。上一轮查到的「汇总写非可访问 4 条、底下列 5 行明细」就发生在这一节里，当时只能靠组件源码断言间接钉住，MD 本身没人验。

整节搬进 `delivery-cite.ts` 的 `citeSection()`，组件只调用一次。关键取舍是**链接核验的汇总行不接受外部传入**：模块拿到的是一份已过滤的核验行，汇总由它就地 `summarizeLinkChecks` 算出，明细行也从它筛。两者由同一个数组推出来，结构上不可能再各说一套——这比「组件里保证传同一个变量」强，因为后者下一次改动就可能又传两个。

断言分两层。新增 `verify:delivcite`（58 项）喂假数据验形状：节标题与首尾空行、分级行三个数字按**位置**从文本里抠出来与传入的 `grades` 比（不引用 `GRADE_TEXT` 常量，常量被清空时才拦得住）、两类弱证据括注的有无与数字、`weakOpen` 决定那句替换提醒的有无、仅元数据检索行与工具名连接符、引用清单条数与每条的三行结构、替代来源表 4 列 / 行数 / 判定文案 / 链接可点开、核验汇总五个数字与「明细行数 == 非可访问条数」、空态兜底与 `emptyNote` 优先。`verify:manifest` 再加一段真实任务走查：40 个任务逐个生成这一节，把上述数字与它自己那份结构化取数逐项对，并带三个防空跑计数（有引用 18 · 带替代来源表 5 · 带链接核验 11）。

这一轮翻车三次，**三次都是断言写错、不是实现错**，记下来因为它们各自代表一类陷阱：

1. 引用清单每条是**一个含换行的数组元素**（`1. 标题\n   地址\n   证据力：…`），不是三个数组元素。第一版按「数组里存在一行等于该地址」断，3 条全红。改成按元素内分行、逐行按位置断。
2. 「只留查询元数据」这件事的交代法按有没有引用分两种措辞：有引用时在分级行下面补一行「另有 N 次…」，一条引用都没有时整节换成 `searchEvidenceNote` 那段说明。第一版只认前一种措辞，实测 26f91720（0 条引用 / 1 次仅元数据检索）被误报成缺陷。**该断的是「这件事必须被交代」这个不变量，不是某一句具体文案**——改成按分支认措辞。
3. 同源断言写 `modSrc.includes("liveLinkChecks")` 期望 false，被模块自己的文档注释命中（注释里写了「必须已按 liveLinkChecks 过滤」）。这与 `verify:gates` 上一轮踩的坑同源：拿文本特征代替结构特征，迟早被自己的注释绊倒。改成按**调用**判 `/liveLinkChecks\s*\(/`。

抽检：把模块里那句 `if (v === "ok") continue;` 删掉（明细行不再按判定过滤，正是上一轮那个真缺陷的形状），`verify:delivcite` 红 3 项、`verify:manifest` 红 11 项并逐个任务报出「核验明细 18 行 ≠ 汇总非可访问 4 条」，改回后复绿。两个门禁从不同数据面拦住了同一处退化。

门禁项数：新增 `verify:delivcite` 58 项（`qa:all` 第 57 个 verify）；`verify:manifest` 1713 → 1960。交付 MD 的三节（文号 / 金额 / 联网引用）现在都有真实任务走查。PPT 大纲里「自动化验证 56 项」由 `gen:ppt` 自动跟到 57 项——这个数字是取数的，不是手写死的，所以不用回来改。

### README 是唯一一份手写、不由生成脚本取数的对外文档：实测 6 处数字已过期

`verify:materials` 此前的判据是对的，覆盖面漏了一处：它只读 `docs/competition/` 下两份**作品说明**，而那两份由 `gen:materials` 生成、数字在生成时取数，本来就不会漂。真正会漂的是 **README**——它是人写的，写死的数字没有任何东西去更新它，而它恰恰是外人最先读到的那一份。

实测过期 6 处：

| README 写的 | 平台当前值 |
| --- | --- |
| `qa:all` 全量质量门 **42** 项 verify | **57** 项 |
| **24** 个任务；证据包**两轮**（09-28、09-29） | **40** 个任务；证据包轮次改成通配写法 `data/evidence-*`，不再写死（理由见下文第二次翻车） |
| rd-audit **18** 个任务 / land-vat **6** 个任务 | **29**（27 个已出结论）/ **11**（10 个已出结论） |
| 弱证据引用 **23 条待人工处置** | 23 条弱证据，按现行判据**待处置 0 条**（15 条已声明背景参考 + 8 条未进结论正文） |
| 底稿比对**覆盖率 36.84%**、累计 21 项 = 一致 7 + 填错 2 + 仅人工底稿有 12 | 累计 **5** 项 = 一致 3 + 填错 2，一致率 **60%** · 覆盖率 **100%** |
| 台账**第 16 列「其中复查取得」**的高亮落点 | 高亮的是**第 7 列「待复查」与第 12 列「证据力弱」**；「其中复查取得」在第 5 列 |

后三处不只是数字旧了，是**把已经修掉的事仍写成欠账**：弱证据那 23 条早已按「已声明背景参考 / 未进结论正文」两类判为不必催办（看板缺口清单是空的），README 还在说「需要人工落实」；覆盖率 36.84% 是「填列产物 vs 它自己的原始模板」被误记成覆盖缺口时的旧值，那个口径错误当轮就修了；台账高亮列在第 16 列更是从来没有过。README 那节的标题写着「数字不好看也如实列出」，结果列的是三个已经不存在的问题——**如实的反面不只是粉饰，也包括把修好的说成没修**。

修法是把 README 接进 `verify:materials`，判据与作品说明同一套，不另立规则：当前状态数字必须与取数一致；历史数字（`36.84%`、`matched 均为 0`）允许保留原值，但附近必须有「此前 / 一度 / 当时」这类限定词。另外加一条**每条正则都必须真的匹配到文本**——否则 README 哪天改写了措辞，正则失配，这一项就静默退化成「没写就不核对」，绿得毫无破绽。这与作品说明那侧「写了就核对、没写不算失败」是有意不同的：作品说明有两份、覆盖范围本来就不一样，README 只有一份、每条都该在。

顺带钉住一处同源：`qa:all` 里调用的 verify 与 `package.json` 里定义的 `verify:*` 必须一一对应。少调一个，就是新门禁没进全量门（单独跑绿、全量门里从来不跑）；多调一个，就是脚本名写错（`qa:all` 当场炸）。上一轮新增 `verify:delivcite` 时这一步是手工接的，接对了，但没有任何东西保证下一次也接对——现在有了。

翻车一处，错的是断言不是文档：「最后一轮证据包日期」的期望值忘了带 `data/` 前缀。`readdirSync` 拿到的是目录名 `evidence-2026-10-01`，README 写的是仓库相对路径 `data/evidence-2026-10-01`，于是门禁报「两者不一致」而其实文档是对的。**取数与文档的路径基准不同**，这类比对必须先把基准对齐，否则第一条断言就会把对的判成错的。

紧接着又翻了一次，这次翻得更有价值：我给「证据包轮次」也加了一条同型断言（README 写「四轮」，磁盘上有几个 `data/evidence-*` 目录就该写几轮）。写完跑 `qa:all` —— **它自己红了**，报「README 写四轮、磁盘实际五轮」。原因是 `qa:all` 末尾的 `pack:evidence` 会按当天日期再留一轮：门禁每跑一次，这个数就变一次。我写了一条**被门禁自己推翻的断言**。

这类数字的正确处置不是「勤更新」，是**根本不要写进手写文档**。改成：README 用通配写法 `data/evidence-*`，断言反过来钉三件事——通配写法必须在、写死轮次判失败、写死具体日期判失败。判据从「值相等」变成「形式合法」，因为这里根本没有一个能长期成立的值。同一节里 `verify:delivcite` 那条「明细行数 == 汇总非可访问条数」之所以能钉值，是因为它比的两边出自同一份数据；而轮次比的是「文档 vs 一个每次运行都会变的目录」，两边不可能长期相等。**能钉值的前提是这个值不该随门禁运行而变。**

顺带说清哪些数字属于哪一类：任务数、案例数、verify 项数、弱证据条数、比对累计——都由人的动作产生（建任务、加门禁、跑比对），写进 README 并钉值是合适的；证据包轮次由 `qa:all` 自己产生，只能钉形式。分清这两类，比多写十条断言有用。

抽检：把 README 的 `57` 改回 `42`、`40` 改回 `24`，门禁报出 2 项失败并给出期望值（「qa:all 的 verify 项数 42 与平台当前值 57 不一致」「案例编号数与任务总数 20/24 与平台当前值 20/40 不一致」），改回后复绿。

门禁项数：`verify:materials` 26 → 112。`qa:all` 57 个 verify 全绿。

### 交付 MD 的「工具调用清单」整节此前零断言，而清单门禁里的平均耗时是写死的 null

这一轮修的是同一件毛病的两个面，根子都在**拼那一节的代码留在 `TaskWorkbench` 的闭包里**。

`run-tools.ts` 的头注释一直写着「供整页交付 MD 的工具调用清单一节使用」，但真正把清单拼成 Markdown 的那 30 行留在组件内。于是 `verify:rtools` 只验得了纯函数（`mdCell` / `summarizeArgs` / `durationMs` / `callsByRun` / `callStats`），而合计行五个数字对不对、分组表头写得对不对、每行是不是 6 列、分组表行数加起来等不等于调用总数，一条断言都没有，只能靠下载下来肉眼扫。搬进模块后汇总行由 `callStats` 就地算、明细行由 `callsByRun` 的分组就地展开，两者不可能各说一套；组件里只剩一次调用，另用源码断言钉住「不再有第二份拼行实现」「表头只有一处定义」。

`verify:manifest` 那侧是同一个毛病的另一面：它自己从库里取 `tool_calls` 组装 manifest，`tools.avgMs` 一直写死 `null`，连 `args` 字段都没读（所以入参摘要那一列门禁从来没看过）。而产品交付的 `manifest.json` 走前端路径、写的是真数字——**门禁验的清单和用户拿到的清单不是同一份**，与上一轮 `linkCheck` 写死 `null`、`verdict` 写死 `"unchecked"` 是同一类缺陷。接上真实取数后实测：40 个任务里 37 个有工具调用、共 363 次、68 个运行分组、分组精确（表行合计 == 调用总数，不丢行不重复计行）、37 个任务全都算得出平均耗时、`ended_at` 缺失 0 条。

变异测试当场暴露一个判据盲区。把合计行的 `st.total` 改成 `st.ok + st.failed`、`fmtDuration(st.avgMs)` 改成 `fmtDuration(null)`：`verify:rtools` 报 2 项失败（fixture 里那条 `ok: null` 的调用让总数对不上），**`verify:manifest` 却全绿**——真实库里没有一条未结束的调用，`running` 恒为 0，`ok + failed` 恰好等于 `total`，四个数字全对得上。也就是说这一节在真实数据上唯一能区分对错的是「平均耗时」那一项，而我恰好没断它。补上 `平均耗时 ${fmtDuration(toolStats.avgMs)}` 后，同一个变异报 37 项失败（每个有调用的任务一条，并打出实际写出的那一行）。

这里有一条值得单记的教训：**fixture 能拦住的错，真实数据不一定拦得住**。合成 fixture 里我特意放了一条未结束的调用，所以「总数漏掉执行中」在它上面是红的；真实库 363 次调用全部已结束，同一处错完全隐形。断言有效性不能只在 fixture 上确认，必须在真实库上再确认一遍——这也是把 `toolAvgNonNull`（算得出平均耗时的任务数）单独计数、并加一条「至少 1 个」防空跑断言的原因：哪天耗时口径断了，这项会立刻红，而不是悄悄变成 37 个 null。

另一处翻车在断言自己身上：按列比文案时取了 `markdownTableCells(row)[2]`，而那个函数**不 trim 单元格**，拿到的是 `" 成功 "`，三条判定断言全红。红得对。但同一循环里那条 `if (cs[0] === "1" && ...)` 的条件断言因为同样的空格问题**一次都没执行过**，绿得毫无破绽——条件断言必须有计数器证明它走到过（现在是 `dashRows >= 1`）。

搬迁前后拼行逻辑逐字相同（只把 `calls` / `windows` 参数化），交付 MD 文本不变，因此不涉及界面、未复扫 `scan:uimd`。

门禁项数：`verify:rtools` 20 → 52，`verify:manifest` 1960 → 2301。`qa:all` 57 个 verify 全绿。

### 扫描器只认得带文字的按钮：图标浮层从来没被扫过，而每页的点击预算被布局开关吃光

`scan:uimd` 的「交互覆盖」靠一份词汇表在页面里认折叠入口：`TOGGLE_OPEN` 命中就点，`TOGGLE_BLOCK` 命中就跳过（那些按钮点下去会写库或落文件）。实测 before：34 页 · 201 次点击 · **14 类入口** · 130789 个文本节点 · 0 残留。数字很好看，但把 14 类入口的名字打出来一看，全是带文字的按钮——侧栏那个只有 `title="键盘快捷键"`、正文全空的图标按钮一次都没被点开过，浮层里那 10 行快捷键说明从来没进过扫描范围。**「0 残留」的说法只在扫到的地方成立**，而覆盖范围本身此前没有任何断言。

改法分三步，都是同一件事的不同面：把 `aria-label` 一起算进匹配字符串、OPEN 词汇表补「快捷键」、返回 `iconOnly` 标记；必需入口优先点（`interactLimit` 是每页预算，DOM 顺序在前的普通入口能把预算吃光，于是「必须点到」这条断言变成自己无法满足的要求）；纯布局开关排掉并把预算从 6 放到 10。

翻车一，浮层扫完没关。帮助浮层是绝对定位的，开着就盖住主内容左侧的入口：**34 次点击被它拦下**（每次白等 2500ms 超时），必需入口「文号溯源」一次都没点到，扫过的文本节点从 130789 掉到 117791、入口类别从 14 掉到 7。为了多扫一个浮层反而少扫了七类面板——这是这一轮最贵的一课：**加覆盖的动作本身会吃掉覆盖**。改成扫完立刻点回去关掉（关回 34 次），失败归零。

顺带撞出一处预算漏洞：label 去重挡不住「收起会话侧栏 / 展开会话侧栏」这一对。同一个按钮，收起后 `title` 变了就被当成两个入口，每页白吃两轮，而收起侧栏只会**藏起**文本、不会长出新文本。加了 `TOGGLE_SKIP` 把纯布局开关排掉。

翻车二更有意思，错的不是扫描器而是我对字段的理解。把 `TOGGLE_BLOCK` 也改成试 `title + aria-label + text`（为了防「更多操作（删除 / 清空）」这种图标按钮被 OPEN 的「更多」放进去）之后，**「文号溯源」这个必需入口反而彻底消失了**。真因：那个按钮的 `title` 是一整段给人看的说明，里面写着「已联网复查 N 处…待人工确认 N 处…仅作背景参考」，一句话命中 BLOCK 的三个词（复查 / 核验 / 标注），于是被判成「会写库的按钮」而永不点击。BLOCK 想判的是**这个按钮点下去会不会改数据**，而 title 描述的是面板内容，不是按钮动作——判据用错了字段。改成：有文字时只试 text，没文字（图标按钮）才退回 title / aria-label。两边的风险都得防，取舍写进代码注释。

after：34 页 · 240 次扫描（原 235）· 点开 206 个入口（原 201）· **去重 22 类（原 14）** · 文本节点 **150757（原 130789，+15.3%）** · 合计 3854766 字 · 残留 0 处 · 点击失败 0。新覆盖到的 8 类入口里包括键盘快捷键、展开全文（5127 字 / 5084 字 / 3411 字）、展开其余 3 类、展开全部、收起阅读器——「展开全文」这一类尤其值得记：那是结论正文被折叠起来的长文，此前一次都没展开扫过。

防空跑补了两层，都进 `--strict`：必需入口（文号溯源 / 键盘快捷键）一个都没点到即失败；图标按钮一个都没点到即失败（说明 title / aria-label 那条匹配路径失效了，浮层会静默退出扫描范围）。抽检：把 OPEN 词汇表里的「快捷键」删掉，窄扫一页立刻报「必需入口一次都没点到：键盘快捷键」并退出码 1，改回后复绿。

仍未覆盖，写清为什么不动：修订模式对话框与下载类浮层都落在 `TOGGLE_BLOCK` 里，它们离「写库 / 落文件」只有一次点击，而扫描器是无人值守反复跑的，不该冒这个险；下载件的字节由 `scan:deliverables` 真点真下载来验。

`scan:uimd` 依旧不进 `qa:all`（要开浏览器、要前端在跑，失败原因常常与代码无关）。`qa:all` 57 个 verify 全绿。

### 截断有两层，平台一层都报不出来，而且两层共用一个字段名、彼此盖掉

起点是想量一个还没量过的东西：留存正文的截断比例。全库实测（363 次工具调用，其中联网类 202 次）——36 条有留存正文；**联网扩展自己截断了 22 次**（details 里自报 `truncated: true`），其中 **20 次连正文都没交给我们**（`content` 里没有文本块，留存函数原样返回，平台手里只有查询元数据），涉及 10 个任务；**平台留存层截断 1 次**（`fetch_content` 撞上 20000 字上限，10173 字没存下）；两层同时发生 1 次。

真因一是**字段名撞了**。联网扩展截断返回内容时用的正是 `omittedChars`（web_search 的 details 里有 `truncated / originalChars / returnedChars / omittedChars`），而 `withRetainedText` 是 `{ ...stored, ...extra }` 直接展开——我们这一层把工具那一层的数字盖掉了。实测 29443fec 那条 `fetch_content`：工具自报 `originalChars` 36918、交给我们 30173 字，中间少的 6745 字被我们的 `omittedChars: 10173` 覆盖，从此无人知晓。修法是撞名时把工具那份原样挪到 `toolOmittedChars`，我们自己的键名不动（历史行照旧可读，不回填、不迁移）。

真因二是**这几个字段在 `apps/web` 里零消费者**。落库了、`verify:agents` 也断言了「如实记录」，但界面上看不出来、交付 MD 里也没写。于是「三处均无出处」「无法核验」这些判定的一个可能成因——引文正好落在被截掉的那一段里——从来没被说出口，读的人只能以为平台核对过全部原文。修法：`search-evidence.ts` 新增 `retentionStats` / `retentionNote`（与「哪些工具算联网证据」共用 `SEARCH_TOOL_NAMES`，不另立一份名单），两个消费点各接一次——结果页新增「留存正文截断」一块、交付 MD 的联网引用节末尾加一行。MD 那一行刻意放在引用清单**之外**：没有引用清单的任务同样可能截断，而那一节恰恰是「无出处」最容易被误读成「平台核对过全文」的地方。

判据取舍一条：**工具层只报条数、不报字数**。各工具自报的字段形状不同（web_search 给 `originalChars / returnedChars`，fetch_content 给 `totalChars / shownBytes`），历史行里那一份又被我们自己盖掉过，凑一个「合计字数」出来只能是猜的——宁可留空。留存层的字数照报，那是我们自己算的、口径唯一。这句话也写进了给复核人看的说明里（「工具层截掉的字数各工具口径不同，只报条数、不推算字数」），不让人以为漏写了。

防空跑：`verify:manifest` 逐任务把两层数字对回 MD 文本（`平台留存时又截断 N 条`、`联网工具自己截断了 N 次`），任一层写漏或写成另一层的数字即红；平台级再加两条「至少 1 个任务被留存层截断」「至少 1 个任务被工具层截断」（实测分别是 1 与 10，都不是空跑）。`verify:agents` 钉住撞名不覆盖：我们的写进 `omittedChars`、工具的留在 `toolOmittedChars`、没撞名时不凭空造字段。

界面实测（playwright 真开页面取 `innerText`）：抽查 3 个有截断的任务，f8fc2a0d 与 29443fec 在 2 秒内显示出说明，文本与交付 MD 同一份；**4bb22d34 等了 181 秒仍然没有**，而且那个页面上所有依赖工具结果的模块（联网引用面板、检索留痕、客户端工具计数）都是空的。为排除取数口径分叉，用 node 按浏览器同一套配对逻辑回放了它的 SSE：13829 条事件、33 条 `tool_end` 全部配对成功、6 条 `truncated: true` 都在，`retentionStats` 算出 `toolTruncatedCalls: 6`——**数据到得了浏览器，是界面回放跑不完**（每条事件都要 `setTimeline(prev => [...prev, item])`，13829 条就是二次方级的数组复制与重渲染；对照任务的事件数是 780 与 944，2 秒内就渲染完了）。

这条本轮没处置，如实记成下一轮的第一条线索：超大任务上，界面在几分钟内呈现的是「没有工具结果」的状态，而这正是交付 MD（在浏览器里由同一份 `toolCalls` 生成）与门禁取数（直接读库）口径分叉的一个来源——门禁绿不代表用户当下下载到的那份 MD 也完整。

**（下一轮更正：这个归因是错的。**「界面回放跑不完」被页内实测证伪，真因是 `ResultView` 一见到 `error` 就整块不渲染，见下一节。二次方的聚合确实存在、也确实修了，但它不是这个现象的原因。）

门禁项数：`verify:agents` 35 → 39、`verify:searchev` 640 → 656、`verify:delivcite` 58 → 72、`verify:manifest` 2301 → 2343。`qa:all` 57 个 verify 全绿；`scan:uimd --strict` 在两个受影响任务的结果页与复核页复扫，0 残留。

### 上一轮那条线索被证伪：不是事件回放跑不完，是 ResultView 一见到 error 就整块不渲染

上一轮把「4bb22d34 界面上看不到留存截断说明」归因成「13829 条事件回放跑不完」。这一轮先证伪自己的归因——用 playwright 在**同一个页面里**做了三项实测：

1. 另开一条 `EventSource` 收同一个任务的事件流：13829 条**全部收到**（`task_created` 1 · `run_started` 7 · `agent_status` 44 · `agent_text_delta` 13684 · `agent_text` 20 · `tool_start` 33 · `tool_end` 33 · `run_completed` 7），33 条 `tool_start` 的 payload 里 `toolName / args / callId` 齐全，33 条 `tool_end` 都带 `result`。数据到得了浏览器。
2. 同一时间段 `requestAnimationFrame` 计到 1169 帧 ≈ 58 fps。主线程没被堵住。
3. 页面头部那句「工具调用 33 次」渲染的是客户端 `toolCalls.length`。聚合确实完成了。

三条加起来，「回放跑不完」不成立。真因在渲染分支：`ResultView` 开头是 `if (error) return <执行失败块>`。这个任务的 `tasks.error` 是「服务重启导致执行中断」，于是整块证据区——联网引用、检索留痕、留存截断说明、文号 / 金额溯源、交付自检、下载报告、字号与打印工具条——一个都不渲染，页面上只剩那一行错误。实测全库 4 个任务带 `error`，其中 **1 个已经有 16365 字结论正文与 33 次工具调用**，就是它：复核人在结果页看不到任何证据，得绕到复核页或时间线去。这条不在本轮改（改的是「失败任务该展示什么」的取舍，值得单独一轮），记成下一轮第一条。

二次方的聚合是真存在的，这一轮顺手修在源头：把聚合口径从 hook 的 SSE 回调搬进 `apps/web/src/task-events.ts`（`createEventsAcc` / `applyEvent`，纯数据、可单测），hook 只负责订阅与**批量刷新**——事件先并进累加器，每 `FLUSH_MS = 80` 毫秒把累加器快照进 state 一次。此前每条事件都要 `setTimeline((prev) => [...prev, item])` 复制整个数组并触发一次重渲染，流式 delta 那条还要再 `prev.map(...)` 复制一次。

量化：1.4 万条事件在聚合层耗时 **74 ms**（`verify:tlcalls` 里的真实计时，只打印不判定，阈值松到 5 秒避免抖动误报）；重渲染次数从「每条事件一次」降到「每 80 毫秒最多一次」。判据没有放宽：批量刷新只改渲染频率、不改聚合口径，配对规则（`callId` 精确 + 同名未结束兜底）逐条照搬，并补了回归断言——同名工具并发时按 `callId` 各归各的（这正是后端「按工具名配对」那个老 bug 的前端版）、无 `callId` 退回同名未结束的那条、配不上的 `tool_end` 不凭空造调用记录但仍进时间线（事件本身是真的）、上万条 delta 合并成一条时间线行、`agent_text` 之后再来 delta 另起一条、三种运行状态推进。

一处必须跟着搬的断言：`verify:jsxkeys` 原本去读 `hooks/useTaskEvents.ts` 的源码来断言「时间线条目 id 由 seq 与 kind 组成」，口径搬走后那条断言会指向一个不再包含它的文件——已改成读 `task-events.ts`。**搬代码时要把读它源码的断言一起搬**，否则断言不会报错，只会静默失效（文件读得到，只是内容永远匹配不上或永远匹配得上）。

门禁项数：`verify:tlcalls` 8 → 36（新增事件聚合与批处理两组断言）。`qa:all` 57 个 verify 全绿。

### 失败任务的结果页只剩一行错误：16365 字结论、33 次工具调用、6 次工具层截断，全部看不见

真因就是上一轮末尾指到的那个渲染分支：`ResultView` 开头是 `if (error) return <执行失败块>`。库里 4 个任务带 `error`（都是「服务重启导致执行中断」），其中 4bb22d34 已经有 **16365 字结论正文与 33 次工具调用**（含 6 次工具层截断、1 次留存层截断 10173 字）。它的结果页此前只渲染那一行错误：联网引用、检索留痕、留存截断说明、文号 / 金额溯源、交付自检、下载报告、字号与打印工具条，一个都不挂载。复核人在最需要看证据的时候，什么都看不到。

这一轮最值得记的不是修法，是**上一轮那些源码断言全是绿的**：`verify:policytrace` 里「复查面板确实渲染了这一组条目」「每条都接了侧边阅读器（点击能打开原文）」都成立——它们查的是「源码里写了没有」，不是「运行时渲染了没有」。整块被 early return 跳过时，源码级断言一条都不会红。这是它的固有盲区，只能靠真开页面补：本轮的 before / after 全部由 playwright 量出来，并且把「渲染条件本身」也写进了断言（`if (error && !result) return errorBanner;` 必须在、`if (error) { return` 这种写法必须不在）。

修法：错误只作横幅。只有「既失败又没有任何结论正文」时才整块替换成错误块；否则横幅挂在正常内容之上，并写清「本次运行中断前已产出 N 字结论正文，下面的证据与原文入口照常可用；结论可能不完整，请核对后决定是否续跑」。取舍是不隐藏失败（横幅一直在最上面、打印也带着），同时不因为失败就把已经产出的证据一并藏掉。

实测 before / after（playwright 真开结果页，取 `innerText` 与 `.kicker` 列表）：

| 任务 | before | after |
| --- | --- | --- |
| 4bb22d34（waiting_review，结论 16365 字） | kicker 10 个，证据类 0；下载报告 / 字号 / 打印工具条都没有；只剩一行「执行失败 服务重启导致执行中断」 | kicker **17** 个，新出现「联网引用」「留存正文截断」；下载报告恢复；留存截断说明第一次在这个任务上显示出来（工具层 6 次 + 留存层 1 条 10173 字） |
| 92e1005b / 060b4eea / 26f91720（failed，`tasks.result` 为空但事件流里有过程正文） | 同样只有一行错误 | 横幅 + 完整证据区（kicker 13 / 15 / 13） |

4 个页面复扫 `scan:uimd --strict`：18496 个文本节点、0 残留；全库默认扫描 34 页 / 240 次交互 / 22 类入口 / 150785 节点 / 0 残留，与上一轮持平（本轮改的是渲染条件，不是文案）。

顺带修掉扫描器一处误红：`REQUIRED_TOGGLES` 的判据从「任何时候都必须点到」改成「**本次范围内出现过**就必须点到」。窄范围跑（`--tasks` 指定那 4 个失败任务、`--no-overview`）时，这些页面上压根没有「文号溯源」入口，老判据会红，而红的原因与覆盖率无关。现在没出现的必需入口如实报一行「本次范围内没出现的必需入口：文号溯源（不计为失败，换 `--all` 复扫才会覆盖到）」，出现过却没点到仍然算失败。这不是放宽判据：放宽的是「不存在的东西必须被点到」这条根本不成立的要求，真正要防的「入口在、却没点到」一条没少。

门禁项数：`verify:policytrace` 274 → 280（5 条渲染条件与横幅文案 + 2 条真实数据防空跑：库里有带 error 的任务 4 个、其中已有结论正文 1 个）。`qa:all` 57 个 verify 全绿。

### 交付物实测只测一个任务，于是「manifest 申报的资料不在包里」藏了很久

`scan:deliverables` 一直是「挑一个最齐的任务，真下载 6 份交付物，逐字节验」。库里 40 个任务、两个智能体，它只测 1 个——实测挑中的是 land-vat 的回归案例，**rd-audit 的交付物一次都没被下载过**。这一轮改成按维度挑一组：每个智能体各一个「资料 + 产物 + 图」都齐的、一个「有结论但没产物」的空态、一个带 `error` 的失败态（上一轮才让失败任务的结果页渲染出下载按钮，这一档从来没被实测过）。

覆盖面一铺开，第一条就撞出真缺陷：`交付包zip·齐全·rd-audit：manifest 申报的资料文件都在包里: 实际 ["辅助账.xlsx"]，期望 []`。真因在打包源头——`collectBundleEntries` 只打「整页交付 MD + `data/outputs/<taskId>/` 下的产物」，**上传资料（`data/uploads/<taskId>/`）从来没进过包**，而 manifest 的 `files` 一样申报它们、交付 MD 里也有一张「业务资料清单」表。换句话说：凡是有上传资料的任务，它的交付包都在说谎——申报了、包里没有。

为什么藏了这么久：land-vat 那个任务也申报了 1 份资料，但那份资料与包里的一个产物**同名**，而核对用的是「按后缀匹配」（`names.some((p) => p.endsWith(n))`），于是蒙对了。**单任务覆盖 + 宽松匹配**，两处各差一点，叠在一起缺陷就隐形了。

修法：源头补上资料（`资料/<原文件名>`）；磁盘上真缺的那份不塞空文件充数——宁可少一个条目，让门禁与核对表如实报出来。消费点逐个接上：`verify:bundle` 那条「除 MD 外都在产物目录下」改成「产物/ 或 资料/」，并新增逐任务核对（打进包里的资料份数 == 磁盘上实有的份数、逐份文件名对得上）；下载按钮的 `title` 与作品说明里那句「与全部产物合成一个 zip」也一起改成含资料（作品说明由 `gen:materials` 生成，改的是生成脚本里的那一句，不是改产物）。

实测 before / after：

| | before | after |
| --- | --- | --- |
| `scan:deliverables --strict` | 1 个任务 · 6 份交付物 · 44 项 | **4 个任务 · 18 份交付物 · 128 项**，失败 0 |
| `verify:bundle` | 52 项 | **173 项**（带产物任务 16 · 带资料任务 12 · 打进包里的资料 13 份） |

四个维度分别是：rd-audit 齐全（资料 1 · 产物 1 · 申报 2）、land-vat 齐全（资料 1 · 产物 2 · 申报 3）、空态无产物（申报 0）、失败态带 error（申报 0；它的 mermaid PNG 2104×336 / SVG 21992 字都能正常下载——这正是上一轮那个渲染修复带来的新覆盖）。

变异测试：把资料打包那两行删掉，`verify:bundle` 立刻报 **25 项失败**，12 个任务逐个点名缺哪份资料（「申报的资料没打进包里：合同-样例.txt、发票-样例.txt」），改回后复绿。

空态这一档必须说清：它的 manifest 申报为 0，「申报的都在包里」这条核对是在空数组上通过的，等于没验。所以专门加了一条断言把这个事实钉住（`空态任务的 manifest 申报确实是 0`），同时保留原有的「至少有一个任务申报数 > 0」，免得覆盖率数字里混进空跑的那一档。

一处环境坑，记下来免得下一个人再踩：改**服务端** `.ts` 之后必须重启 API 进程才生效。上一会话是手动 `tsx src/server.ts` 起的（不带 watch），我改完 `bundle-zip.ts` 复跑实测，缺陷「修不好」——因为跑的还是旧代码；换成 `pnpm --filter @tax/api dev`（`tsx watch`）后立刻通过。前端走 vite HMR 不受影响，所以这个坑只在改服务端时出现。

门禁项数：`verify:bundle` 52 → 173。`scan:deliverables --strict` 44 → 128 项（与 `scan:uimd` 同理不进 `qa:all`）。`qa:all` 57 个 verify 全绿。

### 修订指令按钮：数字口径与渲染条件不同源，而扫描器此前根本不认得这个入口

P0 第 4 项剩最后一档「修订模式对话框」。查下来是两件事，一起修。

**一、扫描器不认得这个入口。**`TOGGLE_OPEN` 的词汇表里没有它，而它的可见文字「生成修订指令」正好撞上 `TOGGLE_BLOCK` 的「生成」——两头都进不去。加词汇表之外，还要一个**逐个点名、只按可见文字精确放行**的例外（`TOGGLE_ALLOW = /^生成修订指令/`）：这个按钮点下去只调 `fillRevisionInstruction`，把指令填进「续跑任务」输入框并展开面板，既不写库也不发请求；面板里真正会提交的按钮（提交 / 续跑 / 运行）一个都不放。放行只看文字、不看 `title`——它的 title 里写着「需人工核对后提交」，拿 title 判就又会被 BLOCK 吃掉，与上一轮「文号溯源」那个坑同源。扫完按 `Esc` 收起面板（快捷键表里就写着「Esc 收起续跑面板 / 阅读器」），别让它挡住后面的入口；并把它加进 `REQUIRED_TOGGLES`，按上一轮改过的判据「本次范围内出现过就必须点到」。

**二、真实数据里这一档跑不出来。**全库复扫 150 页 / 1037 次交互 / 850888 个文本节点 / **0 残留**，「生成修订指令」一次都没出现（扫描器如实报「本次范围内没出现的必需入口」）。量了原因：40 个任务里做过链接核验的 11 个，**失效链接修订素材 0 条**；复查素材（与当前结论对得上、且还没写回过的复查记录）同样 0 条。所以按钮在任何页面都不渲染，不是扫描器漏点。这一档如实记为「现有数据上无法覆盖」：入口已经接好，等有任务带复查记录或失效链接时它会被自动点到，并纳入必需入口断言。另外即使点开，面板正文是 `<textarea>`（扫描口径刻意跳过输入框，代码块与输入框里出现记号是应该的），能扫到的只有静态标签与那句提示。

**三、顺着这个按钮量出一处潜伏的口径分叉。**按钮上的数字是「复查素材 + 失效链接」（`revisionTotal`），而它的渲染条件此前只看 `revisionItems.length > 0`。也就是「只有失效链接、没有复查素材」的任务，数字算得出来、按钮却渲染不出来——链接腐烂的唯一修复通道等于没有，而组件里那句注释正好写着「链接腐烂此前只能被交付自检发现，没有修复通道」。通道加了，入口条件漏了它。改成 `revisionTotal > 0`，同时把 title 里漏掉的「失效链接」补上（此前 title 只说文号、弱证据与未取得原文三类，与按钮上的数字也对不上）。

判据取舍：这一档在真实数据上跑不出来，所以只能钉源码——渲染条件与数字同源、旧写法不许回来、只有失效链接时 `buildRevisionInstruction` 必须非空（否则按钮点下去什么也填不出来）。这不理想，但比留着一条「只有失效链接时才暴露、而那时没人能点到」的死路强；等真实数据出现这一档，`REQUIRED_TOGGLES` 会自动接管，源码断言就退居二线。

实测：全库 `--all --reader --strict` 150 页 / 1037 次交互 / 75 类入口 / **850888** 个文本节点 / 23608656 字 / 0 残留（上一轮全库基线 844502 节点，多出来的正是失败任务结果页恢复渲染后的内容）；默认 34 页扫描与 2 个任务的窄扫（result + review 两个页签、6 页 41 次交互）同样 0 残留。`verify:refcheck` 708 → 712。`qa:all` 57 个 verify 全绿。

### 量了四件还没量过的事：库体积、事件构成、回放耗时、图表产出率

这一轮先不修缺陷，把四个从来没量过的数量出来。三个数字好看，第四个此前只是「靠运气一致」。

**库与事件构成。**`data/database` 目录 45.4 MB：`tax-agent.sqlite` 22.8 MB、WAL 3.9 MB，另有 09-30 那次工具调用配对修复留下的 18.6 MB 一次性备份（两份都在 `.gitignore` 的 `data/database/*` 里，没有进仓库）。`events` 表 88131 行，其中 `agent_text_delta` **86655 条 = 98.3%**；其余是 tool_start 363 / tool_end 363 / agent_status 363 / agent_text 190 / run_started 80 / run_completed 77 / task_created 40。事件最多的任务 aabd138a 有 24717 条（45 次工具调用），其次 4bb22d34 的 13833 条。

**回放耗时。**playwright 实测，量到「头部工具调用计数与库里 `tool_calls` 行数对齐」为止——不是量到第一次出现非零，那样第一条 `tool_start` 就会命中，量不到完整回放（第一版探针就是这么错的，报出 0.7 s 的假好消息）：24717 条 → **1.1 s**、13833 条 → **1.3 s**、944 条 → 0.5 s。这把上一轮那个猜测彻底钉死：**界面回放不是瓶颈**，4bb22d34 看不到证据区的唯一原因就是 `ResultView` 一见 error 就整块 return。也顺带否掉了「服务端把历史 delta 折叠成一段再发」这个改动——98.3% 的事件是流式分片，看着吓人，但客户端聚合层 1.4 万条只要 66 ms、端到端 1.1 s，折叠省不下用户能感知的时间。**量出来好看的时候，如实写「不必改」也是结论**，否则下一个人还会被那个 98.3% 再吓一次。

**图表产出率。**37 个有结论的任务里：含 Markdown 表格 35 个（95%）、含 mermaid 图 30 个（81%）。逐个查了例外，不把一个比率当结论：没图的 7 个里 4 个创建于 2026-09-23（图表要求写进系统提示词之前，不回填历史）、2 个是 09-28 的验证类任务、1 个是 09-30 的「渲染实测E 政策问答短结论」（533 字，任务性质就是短问答）；**9/29 之后创建且有结论的任务里没图的只有这 1 个**。没表格的 2 个分别是 292 字的「续跑会话历史验证」与 2043 字的「渲染实测C 关系图」。处置：不重跑（重跑会毁掉「留存上线前后」的对照证据），把这组数字记在这里当观测基线；提示词到底有没有被遵守，按待办池第 9 项用**新建的渲染实测任务**去验，而不是拿历史任务当证据。

**顺手查了一处「同一件事存两份」。**结论正文既存 `tasks.result`，又能从 `events` 的 delta 分片按 `listConclusions` 重组出来。界面上结果页正文走前者、「上次运行结论 / 结论较上次运行变化」走后者——两边不一致就是同一份材料各说一套，而且不会有任何门禁报警。实测 37 个有结论的任务**全部逐字一致、0 个不一致**，另外 3 个没有结论的任务如实计数、不参与比对。数字好看，但此前一条断言都没有：一致靠的是运气，不是被钉住的口径。已把它钉进 `verify:tlcalls`——逐任务比对最后一段重组结论与 `tasks.result`，加「确实对到了有结论的真实任务」防空跑，再加「不参与比对的无结论任务数必须与库里一致」（否则「跳过」会变成静默放行）。

门禁项数：`verify:tlcalls` 36 → 75（37 个有结论任务逐个一项 + 2 条防空跑）。`qa:all` 57 个 verify 全绿。

### 「三处均无出处」24 处里 23 处其实无从核对；而看板那段说明是共享文案的手写副本，已经漂了

欠账逐条处置从金额这一档开始，第一步是把 92 处待确认量到「每一处属于哪一类、为什么」。实测：**92 = 引自联网正文 68 + 三处均无出处 24**，分布在 5 个任务，而这 5 个任务都是「全部金额都待确认」（7/7、34/34、28/28、11/11、12/12）——它们都是检索类任务，结论里的数字全来自网页正文，而溯源池按既定口径不收联网正文（否则任何金额都能声称有出处）。

24 处「三处均无出处」里，**23 处所在任务一条留存正文都没有**：f39c3efa 11 处、ac585ad7 12 处，都是 09-30 跑的「提示词实测 G / E」，联网类调用 6 / 9 次而留存正文 0 条——正是留存功能上线前的那两个任务。这一档的共享说明自己就写着「混了两种情况：模型确实口算了，以及该任务运行时还没留存网页正文因而无从核对」；这两种情况现在**能靠数据分开**，不需要猜：留存条数为 0 就是结构性无从核对（联网正文那一路压根是空的）。剩下 1 处在 89498fe0（留存正文 8 条），就是作品说明里记的那处「模型把 A 项目 90 万与 B 项目 100 万自己加成 190 万」。

也就是说，这一档真正需要人逐条看的是 **1 处，不是 24 处**。把这个数固化进门禁：`verify:amounts` 现在逐任务算两类构成并打印，另加两条断言——两类相加必须等于待确认总数（防止哪天分类漏了一档而总数照样对得上），以及「三处均无出处里确实有属于无从核对的」（防空跑，实测 23）。

顺带查出一处重复实现：看板 `AgentOverview` 那段长 tooltip 把两类金额的说明**手写了一遍**，而 `UNTRACED_ORIGIN_HINT` 才是唯一来源（任务页就地标注、复核页徽章 title 都引它）。两份已经漂了：共享表的连接词是「客户指令**与**联网正文」并以「但这正是需要人逐条看的那一类」收尾，手写副本改了连接词、删了后半句；web 那一类也少了「不是模型有没有口算」。改成引用共享表，并断言三个消费点都引用它、且不再出现手写副本的措辞。

翻车一次，翻在自己手上：新断言第一次跑就红，报「看板里仍有手写副本的措辞」——命中的是我自己刚写的那段解释性注释（注释里逐字引用了漂移后的原句）。这与 `verify:delivcite` 里记过的那个坑同源：**拿文本特征代替结构特征，迟早被自己的注释绊倒**。处置是把注释改写成不含那句原文的描述，而不是放宽断言——放宽就等于把这条判据废掉。

处置结论（欠账池第 8 项·金额与工具失败两档）：

- **23 处无从核对：不动。**只能靠重跑清掉，而重跑会毁掉「留存上线前后」的对照证据，与不回填历史冲突（禁区里写着的那一条）。
- **1 处真无出处：不动。**它是有价值的正面证据（平台拦下了一次模型口算），已写进作品说明。
- **68 处引自联网正文：不需要处置。**要核对的是「引用抄得准不准」而不是「有没有口算」，界面上已按类别分开、逐条可点开原文。
- **工具失败现状是 14 条**（不是待办池里写的 12 条）：模型传错参数 5 · 用法不支持 1 · 工具内部异常 2 · 外部服务拒绝或未配置 2 · 外部资源不存在 4，5 类归因全部有分类、无未归类项。

门禁项数：`verify:amounts` 123 → 137。看板 tooltip 改的是 `title` 属性文本，窄扫（2 个总览页 + 1 个任务页，3 页 23 次交互 / 31047 节点）0 残留；`qa:all` 57 个 verify 全绿。
