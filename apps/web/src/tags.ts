/** 任务自定义标签：localStorage 持久化，工作台编辑、侧栏过滤。 */
export function loadTags(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem("taxai-tags") ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function saveTags(map: Record<string, string[]>): void {
  localStorage.setItem("taxai-tags", JSON.stringify(map));
}
