# 测试报告（2026-10-01）

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
| `pnpm verify:locate` | 阅读器表格定位命中规则（记录地址 / A1 / 文本 / 差异值校验） | PASS |
| `pnpm verify:review` | 人工复核状态一致性（完成态遗留待复核问题的补救判定） | PASS |
| `pnpm verify:tlcalls` | 时间线工具调用配对（callId 精确匹配 + 同名序号兜底） | PASS |
| `pnpm verify:runart` | 运行时间窗推导与产物归属（导出「本次运行产物清单」的依据） | PASS |
| `pnpm verify:artsrc` | 产物溯源（生成产物与工具调用的确定性对应） | PASS |
| `pnpm verify:rtools` | 工具调用清单（按运行分组 / 入参摘要 / 耗时 / 汇总） | PASS |
| `pnpm verify:revexp` | 人工复核记录导出（计数与后端同口径 / 转义 / 状态提示） | PASS |
| `pnpm verify:dcheck` | 交付自检分级规则（阻断 / 提醒 / 可交付）与真实任务走查 | PASS |
| `pnpm verify:amounts` | 结论金额溯源（提取规则 / 双量纲收集 / 工具-指令-待确认三级口径） | PASS |
| `pnpm verify:links` | 引用链接核验分级（可访问 / 反爬拒绝 / 失效 / 无法核验） | PASS |
| `pnpm verify:fileparse` | 上传资料解析摘要（状态中文化 / 表格与 OCR 摘要 / 按文件名汇总） | PASS |
| `pnpm verify:bundle` | 交付包打包（条目名安全化 / zip 往返 / 真实任务条目组装） | PASS |
| `pnpm verify:manifest` | 交付清单 manifest.json（结构 / 内部一致性自校验 / 真实任务走查） | PASS |
| `pnpm verify:fresh` | 交付包新鲜度（上次打包后的变更识别与提示文案） | PASS |
| `pnpm verify:stats` | 平台统计口径（比对准确率双口径 / 工具 / 任务 / 产物计数） | PASS |
| `pnpm verify:policytrace` | 政策文号溯源（提取 / 归一化 / 有出处-无法核验-待确认三级口径） | PASS |
| `pnpm verify:websearch` | 联网检索可信度（词元切分 / 相关度门槛 / 入口页过滤 / 验证页识别 / 历史数据回放） | PASS |
| `pnpm verify:citegrade` | 联网引用证据力分级（官方来源 / 专业来源 / 首页百科检索页 + 两套实现口径交叉核对） | PASS |
| `pnpm verify:searchev` | 联网检索留痕与引用提取（各工具结果形状 / 去重上限 / 只留元数据时如实说明 / 真实任务走查） | PASS |
| `pnpm verify:refcheck` | 政策文号联网复查（发文机关前缀与检索词构造 / 四级判定 / 落库往返与覆盖 / 真实任务走查） | PASS |
| `pnpm verify:revimpact` | 修订前后证据对比（快照口径 / 差值与总体判断 / 按事件流重组结论的真实续跑走查） | PASS |
| `pnpm verify:trend` | 指标趋势（每日快照记录与裁剪 / 基线日选择 / 环比差值 / 越高越好与越低越好的方向判断） | PASS |
| `pnpm verify:sheet` | 证据核对表（九项核对结论 / 空输入如实兜底 / 待办分组 / MD 片段 / 真实任务走查） | PASS |
| `pnpm verify:amtnote` | 金额核对备注模板（模板可用性 / 追加分段与去重 / 撤销最近一段 / 留痕有效性判断 / 自定义模板按作品存取、脏数据丢弃、新增校验与合并去重） | PASS |
| `pnpm verify:ledger` | 全平台证据核对台账（缺口判断 / 排序与合计 / 22 列单元格 / CSV 与 Markdown 导出 / 与平台统计口径交叉核对） | PASS |
| `pnpm verify:csv` | CSV 与文件下载统一口径（转义 / 公式注入防护 / CRLF 与 BOM / RFC 往返解析 / 组件里不再手写 createObjectURL） | PASS |
| `pnpm verify:diaexport` | mermaid 图导出（图类型识别 / 文件名不互相覆盖 / 导出配置指令 / SVG 尺寸解析 / 交付件脱敏 / 真实比赛材料走查） | PASS |
| `pnpm verify:localstore` | 本地存储统一入口（读写与内存降级 / 形状校验 / 脏数据回落不抛错 / 收藏与排序等跨组件共享键 / 键登记 / 前端不再绕过入口的静态走查） | PASS |
| `pnpm verify:format` | 数字与单位排版口径（小数去零 / 百分比取值与「—」兜底不写成「—%」/ 中文单位留空格而 % 紧贴 / 字节数 / 组件不再各自 round 的静态走查） | PASS |
| `pnpm verify:reltime` | 时间显示口径（相对时间分档 / 坏数据兜底不猜「刚刚」/ 与旧实现逐值一致 / link-check 空串语义 / 文件名时间戳 / 不许再出现第二份实现） | PASS |
| `pnpm verify:textfind` | 阅读器查找口径（命中区间 / 计数与旧口径逐例一致 / 高亮分段拼接保真 / 环形序号与旋转角 / 计数文案 / markdown 以 DOM mark 数为准 / 无第二份实现） | PASS |
| `pnpm verify:upload` | 上传预检规则（扩展名 / 大小 / 空文件 / 批量分组 / 提示文案） | PASS |

## 三、真实任务台账

| 任务 | 智能体 | 案例 | 状态 | 工具调用链 | 比对准确率 | 产物 |
| --- | --- | --- | --- | --- | --- | --- |
| 研发费用加计扣除测算验证 | rd-audit | RD-2025-001 | completed | calculate_rd_adjustment | — | — |
| 合同发票关联核验验证 | land-vat | LV-2025-001 | waiting_review | match_contract_invoice → parse_uploaded_files → match_contract_invoice | — | — |
| 智研税审任务 2026/9/23 15:22:53 | rd-audit | DEMO-001 | completed | check_rd_expenses | — | — |
| 智研税审任务 2026/9/23 15:59:04 | rd-audit | DEMO-001 | completed | — | — | — |
| 缺失资料联网检索与图表输出验证 | rd-audit | RD-2025-002 | waiting_review（服务重启导致执行中断） | check_rd_expenses → search_public_cases → search_public_cases → calculate_rd_adjustment → calculate_rd_adjustment → fetch_public_document → search_public_cases → search_public_cases → search_public_cases → parse_uploaded_files → search_rd_policy → compare_workpapers → fetch_content → compare_workpapers → get_search_content → fetch_public_document → fetch_public_document → fetch_public_document → web_search → fetch_content → fetch_content → fetch_content → web_search → fetch_content → fetch_content → get_search_content → fetch_public_document → fetch_content → get_search_content → get_search_content → get_search_content → get_search_content → fetch_content | — | — |
| 社区扩展 web_search 实测 | rd-audit | RD-2025-003 | failed（服务重启导致执行中断） | web_search → check_rd_expenses → web_search → fetch_content → fetch_content | — | — |
| 智研税审任务 2026/9/28 09:35:25 | rd-audit | DEMO-001 | completed | calculate_rd_adjustment → web_search → get_search_content(!) → fetch_content(!) → fetch_content → search_rd_policy → fetch_content → fetch_content(!) → search_rd_policy → search_rd_policy → web_search → fetch_content → search_public_cases → web_search → search_public_cases → search_public_cases → fetch_content → fetch_content | — | — |
| 上传资料解析与底稿生成闭环 | rd-audit | RD-2026-001 | waiting_review | parse_uploaded_files → check_rd_expenses → calculate_rd_adjustment → web_search → generate_workpaper → parse_uploaded_files → search_rd_policy → fetch_content → get_search_content → fetch_public_document → fetch_public_document → search_rd_policy → search_rd_policy → web_search → check_rd_expenses → calculate_rd_adjustment → calculate_rd_adjustment → web_search → generate_workpaper → web_search → fetch_content → search_rd_policy → calculate_rd_adjustment | — | 2 个（上传 1） |
| 模板保留式填列闭环 | land-vat | LV-2026-001 | waiting_review | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → web_search → check_amount_consistency → generate_workpaper → parse_uploaded_files → render_matching_diagram → fetch_public_document → fetch_public_document → fetch_public_document → fetch_content → web_search → compare_workpapers → inspect_workpaper_template → compare_workpapers → search_public_cases → search_public_cases → search_public_cases → check_amount_consistency → search_public_cases → search_public_cases → fetch_public_document → fetch_public_document → fetch_public_document → fetch_content(!) → fetch_public_document → fetch_public_document → parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → render_matching_diagram | 模板核对 1 次 | 2 个（上传 1） |
| 政策依据检索与测算闭环 | rd-audit | RD-2026-002 | waiting_review | parse_uploaded_files → search_rd_policy → calculate_rd_adjustment → search_rd_policy → web_search → web_search → search_public_cases → check_rd_expenses → generate_workpaper → fetch_content → web_search → search_public_cases → fetch_content → get_search_content → get_search_content | — | 1 个 |
| 映射模式填列验证 | land-vat | LV-2026-002 | failed（服务重启导致执行中断） | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → web_search → search_public_cases → search_public_cases → check_amount_consistency → generate_workpaper | — | 2 个（上传 1） |
| 底稿比对准确率闭环 | rd-audit | RD-2026-003 | failed（服务重启导致执行中断） | parse_uploaded_files → generate_workpaper → compare_workpapers → generate_workpaper → compare_workpapers → generate_workpaper → compare_workpapers → check_rd_expenses → generate_workpaper → compare_workpapers → web_search | — | 4 个（上传 1） |
| 记录级底稿比对闭环 | rd-audit | RD-2026-004 | waiting_review | parse_uploaded_files → generate_workpaper → compare_workpapers → web_search → parse_uploaded_files → search_rd_policy → search_rd_policy → fetch_content → fetch_public_document → fetch_public_document → get_search_content → get_search_content → fetch_content → web_search → calculate_rd_adjustment → search_rd_policy → generate_workpaper → compare_workpapers → parse_uploaded_files → generate_workpaper → compare_workpapers → fetch_content → get_search_content → get_search_content → fetch_content → get_search_content → get_search_content → get_search_content → get_search_content → fetch_content → get_search_content → get_search_content → fetch_content → fetch_content → get_search_content → get_search_content → get_search_content → get_search_content → get_search_content → get_search_content → get_search_content → web_search → parse_uploaded_files → generate_workpaper → compare_workpapers | 66.67% | 4 个（上传 1） |
| 人工复核流程验证 | rd-audit | RD-2026-005 | completed | parse_uploaded_files → check_rd_expenses → web_search → fetch_content → search_rd_policy → fetch_content → web_search → fetch_content → get_search_content(!) → get_search_content → fetch_content → get_search_content → get_search_content → get_search_content → get_search_content → get_search_content | — | — |
| 人工复核状态机验证 | rd-audit | RD-2026-006 | completed | parse_uploaded_files → check_rd_expenses | — | — |
| 续跑会话历史验证 | rd-audit | RD-2026-007 | waiting_review | check_rd_expenses | — | — |
| OCR 扫描件解析验证 | rd-audit | RD-2026-008 | completed | parse_uploaded_files | — | —（上传 1） |
| 比对联动验证 | rd-audit | RD-2026-009 | waiting_review | parse_uploaded_files → generate_workpaper → generate_workpaper → compare_workpapers | 50% | 2 个 |
| 回归案例：研发费用归集核查与底稿 | rd-audit | case-rd-basic | completed | parse_uploaded_files → check_rd_expenses → generate_workpaper | — | 1 个（上传 1） |
| 回归案例：研发费用归集核查与底稿 | rd-audit | case-rd-basic | completed | parse_uploaded_files → check_rd_expenses → generate_workpaper | — | 1 个（上传 1） |
| 回归案例：研发费用归集核查与底稿 | rd-audit | case-rd-basic | completed | parse_uploaded_files → check_rd_expenses → generate_workpaper | — | 1 个（上传 1） |
| 回归案例：土增模板映射填列 | land-vat | case-lv-template | completed | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → check_amount_consistency → generate_workpaper | — | 2 个（上传 1） |
| 票面字段抽取闭环 | land-vat | LV-2026-003 | waiting_review | parse_uploaded_files → parse_contract → parse_invoice → match_contract_invoice → web_search → check_amount_consistency → generate_workpaper | — | 1 个（上传 2） |
| 关系图工具嵌入验证 | land-vat | LV-2026-004 | waiting_review | parse_uploaded_files → match_contract_invoice → match_contract_invoice → render_matching_diagram → web_search → search_public_cases → check_amount_consistency → generate_workpaper → fetch_content → fetch_public_document → fetch_public_document → web_search → search_public_cases → fetch_content → get_search_content(!) → get_search_content → get_search_content → fetch_content → fetch_content(!) → fetch_content | — | 1 个 |
| 回归案例：土增模板映射填列 | land-vat | case-lv-template | completed | parse_uploaded_files → inspect_workpaper_template → match_contract_invoice → fill_land_vat_workpaper → render_matching_diagram → generate_workpaper | — | 2 个（上传 1） |
| 渲染实测A 加计扣除测算 | rd-audit | DEMO-001 | completed | search_rd_policy → search_rd_policy → calculate_rd_adjustment | — | — |
| 渲染实测B 双口径对照 | rd-audit | DEMO-001 | completed | search_rd_policy → calculate_rd_adjustment | — | — |
| 渲染实测C 关系图 | rd-audit | DEMO-001 | completed | — | — | — |
| 渲染实测D 归属假设演算 | land-vat | DEMO-001 | waiting_review | match_contract_invoice → render_matching_diagram | — | — |
| 提示词实测E 检索结果内定位正文 | rd-audit | DEMO-001 | completed | search_rd_policy → web_search → parse_uploaded_files → get_search_content(!) → fetch_content → get_search_content → get_search_content → get_search_content → fetch_public_document → fetch_public_document → fetch_content(!) | — | — |
| 提示词实测F 检索结果内定位正文 | land-vat | DEMO-001 | completed | web_search → get_search_content(!) → get_search_content → get_search_content → get_search_content → get_search_content → get_search_content → web_search → get_search_content → web_search → get_search_content | — | — |
| 提示词实测G 修正契约后复测 | rd-audit | DEMO-001 | completed | parse_uploaded_files → web_search → search_rd_policy → get_search_content → get_search_content → web_search → fetch_content(!) → fetch_public_document | — | — |
| 正文留存实测H 引文可核对 | rd-audit | DEMO-001 | completed | web_search → search_public_cases → fetch_content → get_search_content → get_search_content → get_search_content → get_search_content → get_search_content | — | — |
| 渲染实测E 政策问答短结论 | rd-audit | DEMO-001 | completed | search_rd_policy → calculate_rd_adjustment | — | — |
| 渲染实测F 多表格长文 | rd-audit | DEMO-001 | completed | search_rd_policy → calculate_rd_adjustment → calculate_rd_adjustment → calculate_rd_adjustment → calculate_rd_adjustment → parse_uploaded_files | — | — |
| 渲染实测G 合同发票核验 | land-vat | DEMO-001 | waiting_review | parse_uploaded_files → match_contract_invoice → render_matching_diagram | — | — |
| 渲染实测H 联网政策检索摘引 | rd-audit | DEMO-001 | completed | web_search → search_public_cases → fetch_content → get_search_content → get_search_content → get_search_content → get_search_content → fetch_content → fetch_public_document → get_search_content → fetch_content(!) → fetch_public_document → fetch_public_document → fetch_public_document → fetch_public_document → fetch_content → fetch_content | — | — |
| 渲染实测I 清算流程图解 | land-vat | DEMO-001 | completed | — | — | — |

## 四、准确率统计（记录级比对口径）

- 与人工参考底稿的同行评审（每任务取最近一次）：比对项合计 5，一致 3、差异 2、仅自动底稿有 0、仅人工底稿有 0
- 一致率 **60%**（= 一致 /（一致 + 差异），只看两边都有的项，回答「填得对不对」）· 覆盖率 **100%**（= 一致 /（一致 + 仅人工底稿有），回答「人工底稿有的项自动填到了多少」）
- 口径说明：一致=正确识别；差异=错误识别；仅人工=未识别；仅自动底稿有=系统多出项（需人工复核）。差异项一律列为待核查事项，不计入正确。不再报「总准确率」——它把「填错」与「范围没对上」混成一个数，两类问题会互相掩盖。
- 另有「已填列底稿 vs 它自己的原始模板」核对 1 次：填列新增 12 处、与模板既有内容冲突 0 处。**不计入上面两个比率**——模板本来是空的，只有一侧有的格子正是填进去的值，算成覆盖缺口等于把「填了多少」记成「漏了多少」。

## 五、案例回归（case:run）

| 案例 | 状态 | 比对准确率 | 结论 | 工具链 |
| --- | --- | --- | --- | --- |
| case-lv-template（2026-09-30） | waiting_review | 未比对 | PASS | parse_uploaded_files:ok → inspect_workpaper_template:ok → match_contract_invoice:ok → fill_land_vat_workpaper:ok → render_matching_diagram:ok → generate_workpaper:ok |
| case-rd-basic（2026-09-28） | waiting_review | 66.67% | PASS | parse_uploaded_files:ok → check_rd_expenses:ok → generate_workpaper:ok |

## 六、已知限制

- OCR 扫描件识别未接入：PDF 无文本层时工具明确提示需 OCR，不虚构内容。
- 政策快照为开发参考版本，正式引用前 Agent 会联网核验并记录核验时间。
- 任务会话为内存态，服务重启后运行中任务标记为已中断，历史事件与产物保留。
- 电子税务局申报、ERP/银行接口不在本期范围。

**总体结论：全部自动化验证通过；真实任务台账与准确率统计均来自数据库记录。**