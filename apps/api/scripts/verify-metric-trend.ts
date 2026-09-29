/**
 * 验证脚本：指标趋势（每日快照 / 基线选择 / 环比差值 / 方向判断与文案）。
 * 运行：pnpm verify:trend
 */
import {
  baselineKey,
  deltas,
  recordSnapshot,
  shiftDay,
  trend,
  trendText,
  trendTitle,
  type DailySnapshot,
} from "../../web/src/metric-trend.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 日期回退（跨月与非法输入）
expect("回退 7 天", shiftDay("2026-09-29", 7), "2026-09-22");
expect("跨月回退", shiftDay("2026-03-01", 7), "2026-02-22");
expect("跨年回退", shiftDay("2026-01-01", 7), "2025-12-25");
expect("回退 0 天是当天", shiftDay("2026-09-29", 0), "2026-09-29");
expect("非法日期返回 null", shiftDay("不是日期", 7), null);

// 2) 快照记录与裁剪
const empty: DailySnapshot = {};
const s1 = recordSnapshot(empty, "2026-09-22", { tasks: 20, weakCitations: 30 });
expect("新增当天快照", s1["2026-09-22"], { tasks: 20, weakCitations: 30 });
const s2 = recordSnapshot(s1, "2026-09-22", { tasks: 22 });
expect("同一天重复记录取最新值", s2["2026-09-22"]?.tasks, 22);
expect("同一天重复记录保留其他指标", s2["2026-09-22"]?.weakCitations, 30);
expect("不改动传入对象", s1["2026-09-22"]?.tasks, 20);
let many: DailySnapshot = {};
for (let i = 0; i < 70; i += 1) {
  const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  many = recordSnapshot(many, day, { tasks: i });
}
expect("按 keepDays 裁剪", Object.keys(many).length, 60);
expect(
  "裁剪保留最近的日子",
  Object.keys(many).sort()[Object.keys(many).length - 1],
  new Date(Date.UTC(2026, 0, 1) + 69 * 86_400_000).toISOString().slice(0, 10),
);
expect("裁剪掉最早的日子", many["2026-01-01"], undefined);

// 3) 基线选择
const snap: DailySnapshot = {
  "2026-09-10": { tasks: 10 },
  "2026-09-22": { tasks: 20 },
  "2026-09-29": { tasks: 24 },
};
expect("正好 7 天前有快照时取该天", baselineKey(snap, "2026-09-29", 7), "2026-09-22");
expect("没有正好 7 天时取之前最近的一次", baselineKey({ "2026-09-10": { tasks: 10 } }, "2026-09-29", 7), "2026-09-10");
expect("基线日之后的快照不算基线", baselineKey({ "2026-09-28": { tasks: 1 } }, "2026-09-20", 7), null);
expect("没有历史快照返回 null", baselineKey({ "2026-09-29": { tasks: 24 } }, "2026-09-29", 7), null);
expect("空快照返回 null", baselineKey({}, "2026-09-29", 7), null);
expect("可指定回退天数", baselineKey(snap, "2026-09-29", 19), "2026-09-10");

// 4) 差值：只算基线里也有的指标
expect(
  "差值按当前减基线",
  deltas({ tasks: 24, weakCitations: 25 }, { tasks: 20, weakCitations: 30 }, ["tasks", "weakCitations"]),
  { tasks: 4, weakCitations: -5 },
);
expect(
  "基线缺该指标时不算差值",
  deltas({ tasks: 24, weakCitations: 25 }, { tasks: 20 }, ["tasks", "weakCitations"]),
  { tasks: 4 },
);
expect("没有基线时返回空对象", deltas({ tasks: 24 }, undefined, ["tasks"]), {});
expect("只算指定的指标", deltas({ tasks: 24, artifacts: 9 }, { tasks: 20, artifacts: 3 }, ["tasks"]), { tasks: 4 });
expect("持平时差值为 0", deltas({ tasks: 20 }, { tasks: 20 }, ["tasks"]), { tasks: 0 });

// 5) 方向判断：越低越好的指标与越高越好的指标颜色相反
expect("弱证据下降算改善", trend(-3, true), "better");
expect("弱证据上升算退步", trend(3, true), "worse");
expect("官方原文上升算改善", trend(3, false), "better");
expect("官方原文下降算退步", trend(-3, false), "worse");
expect("持平", trend(0, true), "flat");
expect("持平（越高越好）", trend(0, false), "flat");
expect("无基线时未知", trend(undefined, true), "unknown");
expect("非有限值时未知", trend(Number.NaN, true), "unknown");

// 6) 文案
expect("上升文案", trendText(3), "▲3");
expect("下降文案", trendText(-5), "▼5");
expect("持平不显示", trendText(0), "");
expect("无基线不显示", trendText(undefined), "");
expect("提示含基线日与方向口径", trendTitle("2026-09-22", true), "较 2026-09-22 快照（越低越好）");
expect("无基线时的提示", trendTitle(null, false), "暂无历史快照（越高越好）");

console.log(`[verify] 指标趋势检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 指标趋势规则不符");
  process.exit(1);
}
console.log("[PASS] 指标趋势正确（快照记录与裁剪 / 基线选择 / 差值 / 方向判断与文案）");
