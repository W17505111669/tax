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
pnpm verify:agents   # Phase 1：两个 Agent 的系统提示词与工具集相互独立
pnpm -r typecheck    # 全仓类型检查
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
| PDF 文本提取（无文本层提示 OCR） | 已完成 |
| OCR 扫描件识别 | 待开发 |
| 合同发票账簿解析与底稿填列 | 正在开发（Phase 3） |
| 研发资料解析与政策检索 | 待开发（Phase 4） |
| 真实案例测试与录屏 | 待开发（Phase 5-6） |
