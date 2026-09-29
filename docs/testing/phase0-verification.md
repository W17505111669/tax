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

证据口径此前只落在单个任务的结果页与交付材料里，平台层面看不出欠账。现在 `computePlatformStats` 增加 `evidence` 一节，直接复用前端那套纯函数（`extractCitations` / `summarizeGrades` / `searchEvidence` / `searchFiltering` / `traceDocRefs` / `summarizeRefChecks` / `pendingAfterRecheck`），保证看板、结果页、整页 MD 与 manifest 出自同一份实现，不会出现两处数字对不上。

口径包括：检索调用数与其中「留下来源 / 只留查询元数据」两类、检索留下并可引用的来源数、被过滤掉的无关结果与门户首页数、引用总数与官方原文 / 证据力弱条数、政策文号总数与「工具可溯源 / 复查后仍无出处 / 已复查到公开出处」，以及仍有缺口的任务清单（弱引用或待复查文号大于 0，按缺口大小倒序）。

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

实现分三层，避免口径各写一份：`apps/web/src/evidence-ledger.ts` 是纯函数层，定义 `LedgerRow`、15 列表头 `LEDGER_COLUMNS` 与取值 `ledgerCells`（表头与取值分开定义但成对使用，MD 与 CSV 共用同一份列序，杜绝两份表对不上）；`rowGap = 弱证据引用 + 复查后仍无出处的文号`，`ledgerSort` 按欠账倒序、再按作品与标题，保证同一批数据每次导出行序一致；`ledgerCsv` 带 UTF-8 BOM 且逐格走 `csvField` 转义，Excel 直接打开不乱码、含逗号与引号的标题不串列。数据层在 `apps/api/src/services/stats.ts`：沿用已有的逐任务循环顺手累积 `evidence.ledger`（累加器写成 `Omit<EvidenceStats, "ledger">`，让类型检查盯着新增字段不漏初始化），返回前统一 `ledgerSort`，实测 24 个任务 59ms，不额外查库。

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
