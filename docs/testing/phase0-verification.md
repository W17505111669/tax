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

## 报告版式选择器（2026-09-28）

新增四套纸张版式主题（经典固实 / 极简商务 / 黑白打印 / 现代蓝紫），以 CSS 变量驱动，作用于侧边阅读器的白纸预览与打印导出（`body[data-paper-theme]`），选择经 localStorage 持久化；切换器出现在阅读器版式行与审查结论「打印版式」行。浏览器实测切换器渲染与选中态正常，抓取失败（403）时阅读器的「新标签页打开原文」兜底按钮同屏可见。
