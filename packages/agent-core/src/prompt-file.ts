import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 惰性读取系统提示词文件，按「mtime + 大小」缓存。
 *
 * 为什么不能在模块顶层 `readFileSync` 一次了事：那样提示词只在进程启动时读一遍，改完 `.md`
 * 不重启就不生效，而且**没有任何提示**。实测过一次：API 进程 23:07:31 启动，两份 system-prompt.md
 * 23:28 才改，跑了 21 分钟的旧提示词——调提示词的人只会得出「写了没用」的错误结论。`tsx watch`
 * 也救不了，它盯的是 import 图，`readFileSync` 读的 .md 不在里面。
 *
 * 做成 getter 之后，`agent-factory` 里 `systemPromptOverride: () => agent.systemPrompt` 每次建会话
 * 都会重新取值，改完提示词下一个任务就生效，不必重启服务。缓存让重复访问不产生额外 I/O。
 */
const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

export function readPromptFile(url: URL | string): string {
  const file = typeof url === "string" ? url : fileURLToPath(url);
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  // mtime 与大小都比：同一毫秒内改回同样长度的内容时 mtime 可能不够分辨
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  const text = fs.readFileSync(file, "utf8");
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/** 测试与诊断用：清掉缓存，强制下一次访问重新读盘 */
export function clearPromptCache(): void {
  cache.clear();
}
