/** 任务自定义标签：工作台编辑、侧栏过滤。存储口径统一走 local-store.ts */
import { asStringArrayRecord, KEYS, readJson, writeJson } from "./local-store.ts";

export function loadTags(): Record<string, string[]> {
  return readJson(KEYS.tags, asStringArrayRecord, {});
}

export function saveTags(map: Record<string, string[]>): void {
  writeJson(KEYS.tags, map);
}
