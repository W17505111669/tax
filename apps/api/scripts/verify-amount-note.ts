/**
 * 验证脚本：金额核对备注的快捷模板（模板自身可用性 / 追加与去重 / 撤销 / 留痕有效性判断）。
 * 运行：pnpm verify:amtnote
 */
import {
  AMOUNT_NOTE_TEMPLATES,
  composeNote,
  dropLastNoteSegment,
  NOTE_SEP,
  noteIsMeaningful,
} from "../../web/src/amount-note.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

const T1 = AMOUNT_NOTE_TEMPLATES[0]!.text;
const T2 = AMOUNT_NOTE_TEMPLATES[1]!.text;

// 1) 模板自身：点了就能当核对依据用
ok("模板至少 5 条", AMOUNT_NOTE_TEMPLATES.length >= 5, `实际 ${AMOUNT_NOTE_TEMPLATES.length}`);
expect(
  "模板标签唯一",
  new Set(AMOUNT_NOTE_TEMPLATES.map((t) => t.label)).size,
  AMOUNT_NOTE_TEMPLATES.length,
);
expect(
  "模板文案唯一",
  new Set(AMOUNT_NOTE_TEMPLATES.map((t) => t.text)).size,
  AMOUNT_NOTE_TEMPLATES.length,
);
expect("每条模板都能算作有效核对依据", AMOUNT_NOTE_TEMPLATES.every((t) => noteIsMeaningful(t.text)), true);
expect("模板文案不含分段符", AMOUNT_NOTE_TEMPLATES.every((t) => !t.text.includes(NOTE_SEP)), true);
expect("模板标签比文案短（芯片放得下）", AMOUNT_NOTE_TEMPLATES.every((t) => t.label.length < t.text.length), true);

// 2) 填入与追加
expect("空备注直接填入", composeNote("", T1), T1);
expect("已有内容按分号追加", composeNote("手工写的一句核对说明", T1), `手工写的一句核对说明${NOTE_SEP}${T1}`);
expect("重复点同一条不重复追加", composeNote(T1, T1), T1);
expect("已有其他段时重复点也不追加", composeNote(`手工写的一句核对说明${NOTE_SEP}${T1}`, T1), `手工写的一句核对说明${NOTE_SEP}${T1}`);
expect("兼容英文分号分段并统一为中文分号", composeNote("A段说明;B段说明", T1), `A段说明${NOTE_SEP}B段说明${NOTE_SEP}${T1}`);
expect("去掉首尾空白", composeNote("  A段说明  ", "  B段说明  "), `A段说明${NOTE_SEP}B段说明`);
expect("空模板不改动备注", composeNote("A段说明", "   "), "A段说明");
expect("连续点两条按顺序追加", composeNote(composeNote("", T1), T2), `${T1}${NOTE_SEP}${T2}`);
expect("追加后仍是有效依据", noteIsMeaningful(composeNote("", T1)), true);

// 3) 撤销最近一段
expect("删掉最后一段", dropLastNoteSegment(`A段说明${NOTE_SEP}B段说明`), "A段说明");
expect("只有一段时删成空", dropLastNoteSegment("A段说明"), "");
expect("空备注删不动", dropLastNoteSegment(""), "");
expect(
  "删掉误点的模板后可换一条",
  composeNote(dropLastNoteSegment(`A段说明${NOTE_SEP}${T1}`), T2),
  `A段说明${NOTE_SEP}${T2}`,
);
expect("删完全部段落后备注为空", dropLastNoteSegment(dropLastNoteSegment(`A段说明${NOTE_SEP}B段说明`)), "");

// 4) 留痕有效性判断
expect("空备注不算有依据", noteIsMeaningful(""), false);
expect("只有空白不算有依据", noteIsMeaningful("    "), false);
expect("过短不算有依据", noteIsMeaningful("已核对"), false);
expect("多段里有一段够长就算有依据", noteIsMeaningful(`短${NOTE_SEP}${T1}`), true);
expect("全部过短不算有依据", noteIsMeaningful(`短${NOTE_SEP}也短`), false);
expect("英文分号分段也能判断", noteIsMeaningful(`短;${T1}`), true);

console.log(`[verify] 金额核对备注模板检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 金额核对备注模板规则不符");
  process.exit(1);
}
console.log("[PASS] 金额核对备注模板正确（模板可用性 / 追加分段与去重 / 撤销 / 留痕有效性）");
