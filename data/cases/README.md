# 案例回归目录约定

每个案例一个目录：`data/cases/<caseId>/`

```text
case.json            案例定义（见下）
inputs/              上传给 Agent 的业务资料（合成或脱敏真实件）
expected/            人工参考底稿等比对基准（不上传给 Agent）
report-<date>.md     case:run 生成的回归报告
```

`case.json` 字段：

| 字段 | 说明 |
| --- | --- |
| agentId | `rd-audit` 或 `land-vat` |
| title | 任务标题 |
| instruction | 任务指令（应明确工具与输出格式，保证可比对） |
| inputs | 相对案例目录的上传文件路径列表 |
| expectedFile | 可选，人工参考底稿路径；存在时自动与系统产物做记录级比对 |
| minAccuracy | 可选，比对准确率下限（百分数），低于则案例判 FAIL |

运行：`pnpm case:run <caseId>`（需 API 已启动）。

真实案例接入流程：客户授权脱敏资料放入 `inputs/`，税务师人工完成底稿放入 `expected/`，编写 instruction 后即可回归；合成案例仅用于开发验证，不得描述为客户业务成果。
