# 测试报告（2026-09-28）

生成方式：`pnpm report:test` 实时执行验证脚本并汇总数据库真实任务记录，非人工填写。

## 一、运行环境

- Node v25.9.0 / Windows
- Pi Agent SDK 0.87.1
- 模型端点：http://127.0.0.1:15721/v1（OpenAI Responses 兼容网关）
- 社区扩展：pi-web-access（联网检索/正文提取）

## 二、自动化验证矩阵

| 验证脚本 | 覆盖范围 | 结果 |
| --- | --- | --- |
| `pnpm verify:pi` | Pi SDK 安装、模型连接、自定义工具调用、事件回传 | PASS |
| `pnpm verify:docs` | Excel/CSV 解析与 Excel 底稿生成 | PASS |
| `pnpm verify:template` | 模板检查与保留式填列（地址/映射双模式） | PASS |
| `pnpm verify:policy` | 政策快照与加计扣除比例规则 | PASS |
| `pnpm verify:compare` | 底稿逐格/记录级比对统计口径 | PASS |
| `pnpm verify:ocr` | OCR 适配器中文+数字识别 | PASS |
| `pnpm verify:extract` | 合同/发票票面字段确定性抽取 | PASS |
| `pnpm verify:diagram` | 关联关系图 mermaid 确定性生成 | PASS |
| `pnpm verify:agents` | 双 Agent 独立性与内置工具禁用 | PASS |
| `pnpm verify:progress` | 列表执行进度 0-5 步推导规则 | PASS |

## 三、真实任务台账

| 任务 | 智能体 | 案例 | 状态 | 工具调用链 | 比对准确率 | 产物 |
| --- | --- | --- | --- | --- | --- | --- |
| 研发费用加计扣除测算验证 | rd-audit | RD-2025-001 | completed | calculate_rd_adjustment | — | — |
| 合同发票关联核验验证 | land-vat | LV-2025-001 | completed | match_contract_invoice | — | — |
| 智研税审任务 2026/9/23 15:22:53 | rd-audit | DEMO-001 | completed | check_rd_expenses | — | — |
| 智研税审任务 2026/9/23 15:59:04 | rd-audit | DEMO-001 | completed | — | — | — |
| 缺失资料联网检索与图表输出验证 | rd-audit | RD-2025-002 | completed | check_rd_expenses → search_public_cases(…) → search_public_cases → calculate_rd_adjustment(…) → calculate_rd_adjustment → fetch_public_document → search_public_cases → search_public_cases(…) → search_public_cases | — | — |
| 社区扩展 web_search 实测 | rd-audit | RD-2025-003 | failed（服务重启导致执行中断） | web_search → check_rd_expenses → web_search → fetch_content(…) → fetch_content | — | — |
| 智研税审任务 2026/9/28 09:35:25 | rd-audit | DEMO-001 | completed | calculate_rd_adjustment → web_search → get_search_content → fetch_content → fetch_content | — | — |
| 上传资料解析与底稿生成闭环 | rd-audit | RD-2026-001 | completed | parse_uploaded_files → check_rd_expenses → calculate_rd_adjustment → web_search → generate_workpaper | — | 1 个（上传 1） |
| 模板保留式填列闭环 | land-vat | LV-2026-001 | completed | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → web_search → check_amount_consistency → generate_workpaper | — | 2 个（上传 1） |
| 政策依据检索与测算闭环 | rd-audit | RD-2026-002 | completed | parse_uploaded_files → search_rd_policy → calculate_rd_adjustment → search_rd_policy → web_search → web_search → search_public_cases → check_rd_expenses → generate_workpaper | — | 1 个 |
| 映射模式填列验证 | land-vat | LV-2026-002 | failed（服务重启导致执行中断） | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → web_search → search_public_cases(…) → search_public_cases → check_amount_consistency → generate_workpaper | — | 2 个（上传 1） |
| 底稿比对准确率闭环 | rd-audit | RD-2026-003 | failed（服务重启导致执行中断） | parse_uploaded_files → generate_workpaper → compare_workpapers → generate_workpaper → compare_workpapers → generate_workpaper → compare_workpapers → check_rd_expenses → generate_workpaper → compare_workpapers → web_search | 0%（地址模式） | 4 个（上传 1） |
| 记录级底稿比对闭环 | rd-audit | RD-2026-004 | completed | parse_uploaded_files → generate_workpaper → compare_workpapers → web_search | 66.67% | 1 个（上传 1） |
| 人工复核流程验证 | rd-audit | RD-2026-005 | completed | parse_uploaded_files → check_rd_expenses → web_search → fetch_content → search_rd_policy → fetch_content → web_search | — | — |
| 人工复核状态机验证 | rd-audit | RD-2026-006 | completed | parse_uploaded_files → check_rd_expenses | — | — |
| 续跑会话历史验证 | rd-audit | RD-2026-007 | waiting_review | check_rd_expenses | — | — |
| OCR 扫描件解析验证 | rd-audit | RD-2026-008 | completed | parse_uploaded_files | — | —（上传 1） |
| 比对联动验证 | rd-audit | RD-2026-009 | waiting_review | parse_uploaded_files → generate_workpaper(…) → generate_workpaper → compare_workpapers | 50% | 2 个 |
| 回归案例：研发费用归集核查与底稿 | rd-audit | case-rd-basic | waiting_review | parse_uploaded_files → check_rd_expenses → generate_workpaper | — | 1 个（上传 1） |
| 回归案例：研发费用归集核查与底稿 | rd-audit | case-rd-basic | waiting_review | parse_uploaded_files → check_rd_expenses → generate_workpaper | — | 1 个（上传 1） |
| 回归案例：研发费用归集核查与底稿 | rd-audit | case-rd-basic | waiting_review | parse_uploaded_files → check_rd_expenses → generate_workpaper | — | 1 个（上传 1） |
| 回归案例：土增模板映射填列 | land-vat | case-lv-template | waiting_review | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → check_amount_consistency → generate_workpaper | — | 2 个（上传 1） |
| 票面字段抽取闭环 | land-vat | LV-2026-003 | waiting_review | parse_uploaded_files → parse_contract → parse_invoice → match_contract_invoice → web_search → check_amount_consistency → generate_workpaper | — | 1 个（上传 2） |
| 关系图工具嵌入验证 | land-vat | LV-2026-004 | waiting_review | parse_uploaded_files → match_contract_invoice → match_contract_invoice → render_matching_diagram → web_search → search_public_cases → check_amount_consistency → generate_workpaper | — | 1 个 |

## 四、准确率统计（记录级比对口径）

- 比对项合计 5：一致 3、差异 2、仅系统 0、仅人工 0
- 记录级比对总准确率：**60%**
- 口径说明：一致=正确识别；差异=错误识别；仅人工=未识别；仅系统=系统多出项（需人工复核）。差异项一律列为待核查事项，不计入正确。

## 五、案例回归（case:run）

| 案例 | 状态 | 比对准确率 | 结论 | 工具链 |
| --- | --- | --- | --- | --- |
| case-lv-template（2026-09-28） | waiting_review | 未比对 | PASS | parse_uploaded_files:ok → inspect_workpaper_template:ok → match_contract_invoice:ok → fill_land_vat_workpaper:ok → check_amount_consistency:ok → generate_workpaper:ok |
| case-rd-basic（2026-09-28） | waiting_review | 66.67% | PASS | parse_uploaded_files:ok → check_rd_expenses:ok → generate_workpaper:ok |

## 六、已知限制

- OCR 扫描件识别未接入：PDF 无文本层时工具明确提示需 OCR，不虚构内容。
- 政策快照为开发参考版本，正式引用前 Agent 会联网核验并记录核验时间。
- 任务会话为内存态，服务重启后运行中任务标记为已中断，历史事件与产物保留。
- 电子税务局申报、ERP/银行接口不在本期范围。

**总体结论：全部自动化验证通过；真实任务台账与准确率统计均来自数据库记录。**