# 税务智能审查平台（双智能体参赛作品）

全国税务师行业 AI 赋能涉税专业服务技能竞赛参赛作品。一个共享技术底座承载两个独立业务智能体：

- **智研税审**——研发费用加计扣除专项审查
- **土增智填**——合同发票账簿智能核验填表

技术路线：Pi Agent SDK（`@earendil-works/pi-coding-agent@0.87.1`，已锁定）+ TypeScript + React + Vite + Tailwind + Fastify + SQLite（`node:sqlite`）。

## 快速开始

```bash
pnpm install
cp .env.example .env        # 按需修改模型端点
pnpm dev                    # 同时启动 API(8787) 与前端(5173)
```

打开 `http://127.0.0.1:5173/`，选择智能体，输入任务或使用示例任务，点击「创建并执行」，即可在工作台实时查看 Agent 执行过程。

## 验证命令

```bash
pnpm verify:pi       # P0-4：Pi SDK 安装、模型连接、自定义工具调用、事件回传
pnpm verify:docs     # Phase 2：Excel/CSV 解析与 Excel 底稿生成确定性验证
pnpm verify:template # Phase 3：模板检查与保留式填列确定性验证
pnpm verify:policy   # Phase 4：政策快照与加计比例规则确定性验证
pnpm verify:compare  # 底稿比对：记录级/地址级逐格差异与准确率
pnpm verify:ocr      # OCR 适配器：中文+数字识别验证
pnpm verify:extract  # 合同/发票字段确定性抽取验证
pnpm verify:websearch # 联网检索可信度：相关度门槛 / 入口页过滤 / 验证页识别 / 历史数据回放
pnpm verify:citegrade # 联网引用证据力分级：官方原文 / 专业来源 / 首页百科检索页
pnpm verify:searchev # 联网检索留痕：区分「留下来源」与「只留查询元数据」，引用提取口径统一
pnpm report:test     # 生成测试报告（实时跑验证矩阵 + 汇总真实任务台账与准确率）
pnpm gen:materials   # 生成两个作品的比赛说明文档（docs/competition/，含真实运行统计）
pnpm gen:ppt         # 生成答辩 PPT 大纲（每作品 10 页，含讲稿要点与画面元素）
pnpm demo:script     # 生成录屏分镜表（docs/competition/录屏分镜表.md，含每幕深链与建议时长）
pnpm case:run <id>   # 案例回归：上传→执行→与人工参考底稿比对→案例报告（data/cases/）
pnpm verify:agents   # Phase 1：两个 Agent 的系统提示词与工具集相互独立
pnpm -r typecheck    # 全仓类型检查
pnpm qa:all          # 全量质量门：30 项 verify + 测试报告 + 比赛材料 + 证据包
```

验证记录见 [docs/testing/phase0-verification.md](docs/testing/phase0-verification.md)。

## 目录结构

```text
apps/api          Fastify 服务：任务、文件、SSE 事件、Agent 运行调度
apps/web          React 工作台：智能体首页、新建任务、执行时间线、工具调用、执行结论
packages/agent-core      Agent Factory、Pi Runtime、ToolRegistry、事件总线
packages/shared-schemas  统一业务类型、Zod Schema、整数分金额工具
agents/rd-audit          智研税审：系统提示词、业务工具、示例任务
agents/land-vat          土增智填：系统提示词、业务工具、示例任务
data/                    上传文件、生成成果、SQLite 数据库、Pi 隔离配置
docs/                    架构、竞赛材料、测试记录
```

## 关键设计

- **双 Agent 真正独立**：各自独立的系统提示词、工具集与会话；Pi 内置 `read/bash/edit/write` 一律禁用（`noTools: "builtin"`），业务 Agent 不具备任何系统操作能力。
- **金额不由大模型计算**：限额、汇总、差异全部由 TypeScript 工具以整数分确定性计算，模型只负责解释与组织结果。
- **状态以真实事件为准**：任务状态由持久化事件与执行结果决定，不依据模型文字判断；SSE 事件先落库再推送，前端可回放。
- **模型端点可替换**：`.env` 中配置 `TAXAI_BASE_URL / TAXAI_API / TAXAI_MODEL`，默认指向本机 OpenAI 兼容网关，可切换为任意兼容服务。
- **配置隔离**：Pi 的 `agentDir` 指向项目内 `data/agent-home`，不读取也不污染用户全局 `~/.pi`。
- **对话式工作台**：前端对齐法律/财税 AI 产品视觉语言——窄图标栏 + 可折叠会话侧栏、居中对话列、可折叠工具调用步骤（入参/返回）、引用来源胶囊与复制/重新生成操作行、底部发光输入框、大数字首页与任务状态条形图、底部品牌栏；侧边阅读器按「引用文件 / 文件生成」分组页签管理网页、任务资料与产物预览，加载时为点阵动画。

## 前端交互速览

| 入口 | 行为 |
| --- | --- |
| Ctrl+K | 聚焦侧栏任务搜索 |
| Ctrl/Cmd+Enter | composer 提交新任务 |
| Esc | 依次收起续跑面板 / 侧边阅读器（焦点归还触发元素） |
| Alt+1~4 | 切换工作台页签（执行过程 / 审查结论 / 底稿比对 / 人工复核） |
| ↑/↓ 与 Enter | 比对视图选择差异行并在阅读器打开双底稿定位 |
| Home / End | 比对差异行跳首/末 |
| Ctrl+Tab（Shift 反向） | 阅读器标签循环切换 |
| Ctrl+Shift+1~9 | 阅读器直跳第 N 个标签 |
| Enter / Shift+Enter（阅读器搜索框） | 下一处 / 上一处命中 |
| ←/→ | 概览页切换作品 |
| 阅读器标签双击 | 本地重命名（localStorage 别名） |
| 阅读器标签中键 / 拖拽 | 关闭标签 / 排序 |
| 阅读器表头点击 | sheets 预览列排序（数值感知、再点反向） |
| 阅读器标签 ⚑ / 中键 / 拖拽 | 固定（关闭全部时保留）/ 关闭 / 排序 |
| 时间线「时间戳」芯片 | 显示 #事件序号 + 时间戳调试视角 |
| 步骤条点击 | 跳转到对应步骤首事件 |
| 工作台头部 ☆ | 收藏任务（侧栏 ★ 标识并组内置顶） |
| 侧栏运行中任务 | 0-5 步进度条（后端事件推导，verify:progress 断言） |
| 侧栏任务行拖拽 | 手动排序/置顶（localStorage 持久化，「复位排序」恢复） |
| 工作台头部标签输入 | 回车添加自定义标签，侧栏 #tag 芯片过滤与管理面板重命名/删除 |
| Ctrl+Shift+1~9 | 阅读器直跳第 N 个标签 |
| Ctrl+/ 或 ? | 开关快捷键帮助浮层 |
| 阅读器「复制短链」 | 视图状态 Base64 短码附 URL（?vs=），打开自动应用 |
| 时间线图例/步骤条点击 | 图例隔离单类事件；步骤条跳转对应首事件 |

## 开发状态

| 模块 | 状态 |
| --- | --- |
| Monorepo / 前端 / 后端 / SSE | 已完成 |
| Pi SDK 接入与自定义工具 | 已完成 |
| 双 Agent 独立配置 | 已完成 |
| 文件上传与归档 | 已完成 |
| 联网检索公开案例 / 公开文件 | 已完成 |
| 社区网搜扩展 pi-web-access 接入 | 已完成 |
| 侧边阅读器（网页/文件/产物预览） | 已完成 |
| Markdown + mermaid 输出渲染 | 已完成 |
| Excel/CSV 解析与 Excel 底稿导出 | 已完成 |
| 土增原始模板保留式填列（地址/映射双模式） | 已完成 |
| 底稿比对与准确率统计 | 已完成 |
| 人工复核闭环（waiting_review 状态机） | 已完成 |
| 续跑接口（会话历史恢复） | 已完成 |
| 研发政策快照库与比例规则 | 已完成 |
| PDF 文本提取（无文本层提示 OCR） | 已完成 |
| OCR 扫描件识别（tesseract.js 本地引擎） | 已完成 |
| 合同/发票票面字段抽取（parse_contract/parse_invoice） | 已完成 |
| 合同发票账簿解析与底稿填列 | 正在开发（Phase 3） |
| 研发资料解析与政策检索 | 待开发（Phase 4） |
| 真实案例测试与录屏 | 待开发（Phase 5-6） |
