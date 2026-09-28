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
