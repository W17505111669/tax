/**
 * 验证脚本：阅读器表格定位命中规则（比对页点击差异行 → 阅读器表格高亮）。
 * 数据形态取自真实比对结果：工作表「归集比对」，差异地址「直接投入/金额（元）」。
 * 运行：pnpm verify:locate
 */
import {
  colLettersToIndex,
  currentHitRow,
  locateSheet,
  sameValue,
  sheetLocate,
  visibleRows,
  type LocateRow,
} from "../../web/src/sheet-locate.ts";

const headers = ["费用类别", "金额（元）"];
const rows: [LocateRow, LocateRow] = [
  { 费用类别: "人员人工", "金额（元）": 860000 },
  { 费用类别: "直接投入", "金额（元）": 420000 },
];
const sheet = "归集比对";
const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 记录地址「记录名/列名」：命中记录所在行，并加深对应列
expect("记录地址-命中行", sheetLocate(rows[1], headers, 1, "直接投入/金额（元）", sheet, false), {
  hit: true,
  cols: ["金额（元）"],
});
expect("记录地址-非目标行", sheetLocate(rows[0], headers, 0, "直接投入/金额（元）", sheet, false), {
  hit: false,
  cols: [],
});
expect("记录地址-首行记录", sheetLocate(rows[0], headers, 0, "人员人工/金额（元）", sheet, false), {
  hit: true,
  cols: ["金额（元）"],
});
expect("记录地址-记录不存在", sheetLocate(rows[0], headers, 0, "折旧摊销/金额（元）", sheet, false), {
  hit: false,
  cols: [],
});

// 2) A1 地址：表头算第 1 行，数据行从第 2 行起
expect("A1-带表名前缀命中", sheetLocate(rows[1], headers, 1, "归集比对!B3", sheet, false), {
  hit: true,
  cols: ["金额（元）"],
});
expect("A1-行号不符", sheetLocate(rows[0], headers, 0, "B3", sheet, false), { hit: false, cols: [] });
expect("A1-表名前缀不符", sheetLocate(rows[1], headers, 1, "其他表!B3", sheet, false), { hit: false, cols: [] });
expect("A1-排序状态下不生效", sheetLocate(rows[1], headers, 1, "B3", sheet, true), { hit: false, cols: [] });
expect("A1-列标转列序", [colLettersToIndex("A"), colLettersToIndex("B"), colLettersToIndex("AA")], [0, 1, 26]);

// 3) 普通文本：全等优先，其次包含；数值列按字符串比较
expect("文本-全等命中", sheetLocate(rows[1], headers, 1, "直接投入", sheet, false), {
  hit: true,
  cols: ["费用类别"],
});
expect("文本-数值命中", sheetLocate(rows[0], headers, 0, "860000", sheet, false), {
  hit: true,
  cols: ["金额（元）"],
});
expect("文本-包含命中", sheetLocate(rows[0], headers, 0, "人员", sheet, false).hit, true);
expect("文本-未命中", sheetLocate(rows[0], headers, 0, "不存在的关键词", sheet, false), { hit: false, cols: [] });
expect("文本-空关键字", sheetLocate(rows[0], headers, 0, "   ", sheet, false), { hit: false, cols: [] });

// 4) 期望值校验（比对侧 A/B 值）：值不符就不高亮，避免定位落到错误行
expect("值校验-记录地址+值命中", sheetLocate(rows[1], headers, 1, "直接投入/金额（元）", sheet, false, 420000), {
  hit: true,
  cols: ["金额（元）"],
});
expect("值校验-记录对但值不符", sheetLocate(rows[1], headers, 1, "直接投入/金额（元）", sheet, false, 410000), {
  hit: false,
  cols: [],
});
expect("值校验-错行不命中", sheetLocate(rows[0], headers, 0, "直接投入/金额（元）", sheet, false, 420000), {
  hit: false,
  cols: [],
});
expect("值校验-千分位与小数等价", [sameValue("420,000.00", "420000"), sameValue("420000", "410000")], [
  true,
  false,
]);
expect("值校验-A1 几何+值通过", sheetLocate(rows[1], headers, 1, "B3", sheet, false, "420000"), {
  hit: true,
  cols: ["金额（元）"],
});
expect("值校验-A1 几何+值不符", sheetLocate(rows[1], headers, 1, "归集比对!B3", sheet, false, 1), {
  hit: false,
  cols: [],
});
expect("值校验-仅给期望值（纯值定位）", sheetLocate(rows[0], headers, 0, "", sheet, false, 860000), {
  hit: true,
  cols: ["金额（元）"],
});
expect(
  "值校验-期望值为 null（仅系统/仅人工）",
  sheetLocate(rows[1], headers, 1, "直接投入/金额（元）", sheet, false, null),
  { hit: true, cols: ["金额（元）"] },
);

// 5) 同一行多列同值时，按地址里的列名收窄加深范围
const headers2 = ["项目", "系统", "人工"];
const row2: LocateRow = { 项目: "直接投入", 系统: 420000, 人工: 420000 };
expect("值校验-同值多列按列名收窄", sheetLocate(row2, headers2, 0, "直接投入/人工", "S", false, 420000), {
  hit: true,
  cols: ["人工"],
});

// 6) 真实比对数据（联动验证任务）：同一记录 A=420000 / B=425000，
//    双栏对照时副栏必须用本侧期望值，否则会把命中判成未命中
const rowA: LocateRow = { 费用类别: "直接投入", "金额（元）": 420000 };
const rowB: LocateRow = { 费用类别: "直接投入", "金额（元）": 425000 };
expect("双栏-A 侧用本侧值命中", sheetLocate(rowA, headers, 0, "直接投入/金额（元）", sheet, false, 420000), {
  hit: true,
  cols: ["金额（元）"],
});
expect("双栏-B 侧用本侧值命中", sheetLocate(rowB, headers, 0, "直接投入/金额（元）", sheet, false, 425000), {
  hit: true,
  cols: ["金额（元）"],
});
expect("双栏-B 侧误用 A 值则不命中", sheetLocate(rowB, headers, 0, "直接投入/金额（元）", sheet, false, 420000), {
  hit: false,
  cols: [],
});

// 7) 取行与排序口径：主栏渲染、副栏渲染与命中计数三处共用同一实现
const many: LocateRow[] = Array.from({ length: 120 }, (_, i) => ({ 费用类别: `项${i}`, "金额（元）": i }));
expect("取行上限 100", visibleRows(many, null).length, 100);
expect("无排序保持原序", visibleRows(many, null)[0]?.["费用类别"], "项0");
expect(
  "数值列升序",
  visibleRows(rows, { col: "金额（元）", dir: 1 }).map((r) => r["金额（元）"]),
  [420000, 860000],
);
expect(
  "文本列降序按 zh-CN",
  visibleRows(rows, { col: "费用类别", dir: -1 }).map((r) => r["费用类别"]),
  ["直接投入", "人员人工"],
);
expect(
  "排序不改动入参数组",
  rows.map((r) => r["费用类别"]),
  ["人员人工", "直接投入"],
);

const sheetObj = { name: sheet, headers, rows };
expect("locateSheet 命中数", locateSheet(sheetObj, null, "直接投入/金额（元）", 420000).count, 1);
expect("locateSheet 无关键字时不计算命中", locateSheet(sheetObj, null, "", null).count, 0);
expect("locateSheet 行序与命中一一对应", locateSheet(sheetObj, null, "直接投入", null).hits.map((h) => h.hit), [
  false,
  true,
]);
expect(
  "locateSheet 排序状态下 A1 定位不生效",
  locateSheet(sheetObj, { col: "金额（元）", dir: 1 }, "B3", null).count,
  0,
);
expect(
  "locateSheet 文本关键字可多命中",
  locateSheet(
    { name: "s", headers: ["名称"], rows: [{ 名称: "发票A" }, { 名称: "发票B" }, { 名称: "合同" }] },
    null,
    "发票",
    null,
  ).count,
  2,
);
expect(
  "locateSheet 取行上限一致",
  locateSheet({ name: "多行", headers: ["费用类别", "金额（元）"], rows: many }, null, "", null).rows.length,
  100,
);

// 8) 双栏「当前处」：主栏序号映射到副栏自己的命中序列，越界夹边，无命中返回 -1
const H = (hit: boolean) => ({ hit, cols: [] as string[] });
expect("无命中返回 -1", currentHitRow([H(false), H(false)], 0), -1);
expect("单命中取该行", currentHitRow([H(false), H(true), H(false)], 0), 1);
expect("主栏序号越界时夹到最后一处", currentHitRow([H(true), H(false), H(false)], 5), 0);
expect("多命中按序号取第 2 处", currentHitRow([H(true), H(false), H(true), H(true)], 1), 2);
expect("负序号夹到第一处", currentHitRow([H(false), H(true), H(true)], -3), 1);
expect("非整数序号向下取整", currentHitRow([H(true), H(true), H(true)], 1.7), 1);

console.log(`[verify] 表格定位检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 表格定位规则不符");
  process.exit(1);
}
console.log("[PASS] 表格定位规则正确（记录地址 / A1 地址 / 普通文本 / 期望值校验）");
