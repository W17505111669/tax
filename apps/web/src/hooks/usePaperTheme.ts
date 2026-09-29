import { useSyncExternalStore } from "react";
import { KEYS, readEnum, writeRaw } from "../local-store.ts";

export type PaperTheme = "classic" | "minimal" | "mono" | "modern";

export const PAPER_THEMES: Array<{ id: PaperTheme; label: string }> = [
  { id: "classic", label: "经典固实" },
  { id: "minimal", label: "极简商务" },
  { id: "mono", label: "黑白打印" },
  { id: "modern", label: "现代蓝紫" },
];

const THEME_IDS = PAPER_THEMES.map((t) => t.id);

// 旧版本或脏值不在白名单里时回落经典固实，不把非法值塞进 body[data-paper-theme]
let current: PaperTheme = readEnum(KEYS.paperTheme, THEME_IDS, "classic");

const listeners = new Set<() => void>();

function apply(): void {
  document.body.dataset.paperTheme = current;
}
apply();

export function getPaperTheme(): PaperTheme {
  return current;
}

export function setPaperTheme(theme: PaperTheme): void {
  current = theme;
  writeRaw(KEYS.paperTheme, theme);
  apply();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 报告版式主题（影响阅读器白纸预览与打印导出），localStorage 持久化。 */
export function usePaperTheme(): { theme: PaperTheme; setTheme: (t: PaperTheme) => void } {
  const theme = useSyncExternalStore(subscribe, getPaperTheme);
  return { theme, setTheme: setPaperTheme };
}
