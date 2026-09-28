/**
 * 验证脚本：交付包新鲜度判定（上次打包之后是否又有变更）。
 * 运行：pnpm verify:fresh
 */
import { bundleButtonLabel, bundleButtonTitle, bundleFreshness, freshnessText } from "../../web/src/bundle-freshness.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const PACKED = "2026-09-28T10:00:00.000Z";
const BEFORE = "2026-09-28T09:00:00.000Z";
const AFTER = "2026-09-28T11:00:00.000Z";
const LATER = "2026-09-28T12:30:00.000Z";

expect("从未打包时不算过期", bundleFreshness(null, [{ at: AFTER, label: "新事件" }]).stale, false);
expect("从未打包时记录为空", bundleFreshness(null, []).lastPackedAt, null);
expect("从未打包也能给出最新变更", bundleFreshness(null, [{ at: AFTER, label: "新事件" }]).latest?.label, "新事件");
expect("打包后无变更 → 不过期", bundleFreshness(PACKED, [{ at: BEFORE, label: "旧事件" }]).stale, false);
expect("打包后有变更 → 过期", bundleFreshness(PACKED, [{ at: AFTER, label: "产物更新" }]).stale, true);
expect("过期清单只含打包后的变更", bundleFreshness(PACKED, [
  { at: BEFORE, label: "旧事件" },
  { at: AFTER, label: "产物更新" },
]).newer.map((c) => c.label), ["产物更新"]);
expect("同一时刻不算变更", bundleFreshness(PACKED, [{ at: PACKED, label: "同时发生" }]).stale, false);
expect(
  "多处变更按时间倒序",
  bundleFreshness(PACKED, [
    { at: AFTER, label: "复核提交" },
    { at: LATER, label: "产物更新" },
  ]).newer.map((c) => c.label),
  ["产物更新", "复核提交"],
);
expect("时间不可解析的变更被忽略", bundleFreshness(PACKED, [{ at: "不是时间", label: "坏数据" }]).newer, []);
expect("空变更列表", bundleFreshness(PACKED, []).newer, []);

expect("文案-未打包", freshnessText(bundleFreshness(null, [])), "尚未打包");
expect("文案-最新", freshnessText(bundleFreshness(PACKED, [{ at: BEFORE, label: "旧事件" }])), "交付包仍是最新");
expect(
  "文案-过期含最近变更",
  freshnessText(bundleFreshness(PACKED, [{ at: AFTER, label: "产物更新" }, { at: LATER, label: "复核提交" }])),
  "打包后又有 2 处变更（最近：复核提交），建议重新打包",
);

// 打包按钮：过期时要改口「重新打包」，并把打包后的变更列进提示
expect("按钮文案-未打包", bundleButtonLabel(bundleFreshness(null, [])), "打包下载");
expect("按钮文案-仍是最新", bundleButtonLabel(bundleFreshness(PACKED, [{ at: BEFORE, label: "旧事件" }])), "打包下载");
expect("按钮文案-已过期", bundleButtonLabel(bundleFreshness(PACKED, [{ at: AFTER, label: "产物更新" }])), "重新打包");
expect(
  "按钮文案-打包中优先于过期",
  bundleButtonLabel(bundleFreshness(PACKED, [{ at: AFTER, label: "产物更新" }]), true),
  "打包中…",
);
expect("按钮提示-未过期沿用原文", bundleButtonTitle(bundleFreshness(PACKED, []), "BASE"), "BASE");
expect("按钮提示-未打包沿用原文", bundleButtonTitle(bundleFreshness(null, [{ at: AFTER, label: "新事件" }]), "BASE"), "BASE");
expect(
  "按钮提示-过期列出变更",
  bundleButtonTitle(bundleFreshness(PACKED, [{ at: AFTER, label: "产物更新" }, { at: LATER, label: "复核提交" }]), "BASE"),
  "BASE\n上次打包后又有 2 处变更（复核提交、产物更新），交付包已过期，请重新打包",
);
expect(
  "按钮提示-同类变更合并计数",
  bundleButtonTitle(
    bundleFreshness(PACKED, [
      { at: AFTER, label: "新事件" },
      { at: LATER, label: "新事件" },
    ]),
    "BASE",
  ).includes("新事件 ×2"),
  true,
);

console.log(`[verify] 交付包新鲜度检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付包新鲜度规则不符");
  process.exit(1);
}
console.log("[PASS] 交付包新鲜度规则正确（未打包 / 最新 / 过期与倒序清单 / 坏数据忽略）");
