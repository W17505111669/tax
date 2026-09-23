import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);

/**
 * 解析社区 Pi 扩展入口。优先使用 pi-web-access（MIT，npm 现成包），
 * 解析失败时返回空数组，业务仍可退回自建检索工具。
 */
export function resolveCommunityExtensions(): string[] {
  const candidates = ["pi-web-access/dist/index.js"];
  const resolved: string[] = [];
  for (const spec of candidates) {
    try {
      const file = require.resolve(spec);
      if (fs.existsSync(file)) resolved.push(file);
    } catch {
      // 未安装则跳过
    }
  }
  return resolved;
}
