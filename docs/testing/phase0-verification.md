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
