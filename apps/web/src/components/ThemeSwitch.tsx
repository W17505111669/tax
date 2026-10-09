import { PAPER_THEMES, usePaperTheme } from "../hooks/usePaperTheme.ts";

/** 报告版式切换器：经典固实 / 极简商务 / 黑白打印 / 现代蓝紫。 */
export function ThemeSwitch() {
  const { theme, setTheme } = usePaperTheme();
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-line bg-night-850 p-0.5">
      {PAPER_THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          title={`版式：${t.label}`}
          onClick={() => setTheme(t.id)}
          className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
            theme === t.id ? "glow-ring bg-night-700 text-glow-300" : "text-mist-600 hover:text-mist-100"
          }`}
>
          {t.label}
        </button>
      ))}
    </div>
  );
}
