/**
 * 验证脚本：金额核对备注的快捷模板（模板自身可用性 / 追加与去重 / 撤销 / 留痕有效性判断）。
 * 运行：pnpm verify:amtnote
 */
import {
  amountNoteTemplates,
  composeNote,
  dropLastNoteSegment,
  NOTE_SEP,
  noteIsMeaningful,
  builtinAgentTemplates,
  CUSTOM_NOTE_STORE_KEY,
  LABEL_MAX,
  loadCustomTemplates,
  MAX_CUSTOM_TEMPLATES,
  mergeTemplates,
  parseCustomStore,
  removeCustomTemplate,
  saveCustomTemplates,
  validateCustomTemplate,
  type AmountNoteTemplate,
  type TemplateStorage,
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

const RD = amountNoteTemplates("rd-audit");
const LV = amountNoteTemplates("land-vat");
const T1 = RD[0]!.text;
const T2 = RD[1]!.text;

// 1) 模板自身：点了就能当核对依据用，且按作品给不同的第一条
ok("每个作品至少 5 条模板", RD.length >= 5 && LV.length >= 5, `研发 ${RD.length} / 土增 ${LV.length}`);
expect("标签唯一（研发）", new Set(RD.map((t) => t.label)).size, RD.length);
expect("文案唯一（研发）", new Set(RD.map((t) => t.text)).size, RD.length);
expect("标签唯一（土增）", new Set(LV.map((t) => t.label)).size, LV.length);
expect("文案唯一（土增）", new Set(LV.map((t) => t.text)).size, LV.length);
expect("每条模板都能算作有效核对依据", [...RD, ...LV].every((t) => noteIsMeaningful(t.text)), true);
expect("模板文案不含分段符", [...RD, ...LV].every((t) => !t.text.includes(NOTE_SEP)), true);
expect("模板标签比文案短（芯片放得下）", [...RD, ...LV].every((t) => t.label.length < t.text.length), true);
expect("作品专属模板排在最前", [RD[0]!.label, LV[0]!.label], ["与辅助账一致", "与清算底稿一致"]);
expect("两个作品的专属模板不同", RD[0]!.text !== LV[0]!.text, true);
expect("专属模板贴合各自作品口径", RD[0]!.text.includes("研发支出辅助账") && LV[0]!.text.includes("土地增值税清算底稿"), true);
expect(
  "通用模板两个作品一致",
  RD.slice(1).map((t) => t.label),
  LV.slice(1).map((t) => t.label),
);
expect("未知作品只给通用模板", amountNoteTemplates("别的作品").length, RD.length - 1);
expect("未知作品不含专属模板", amountNoteTemplates("别的作品").some((t) => t.label === "与辅助账一致"), false);
expect("空 agentId 安全返回通用模板", amountNoteTemplates("").length, RD.length - 1);

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

// 5) 自定义模板：本地存储解析、按作品读写、新增校验、合并顺序与去重
class FakeStorage implements TemplateStorage {
  private map = new Map<string, string>();
  removed = 0;
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
    this.removed += 1;
  }
  seed(k: string, v: string): void {
    this.map.set(k, v);
  }
}
const tpl = (label: string, text: string): AmountNoteTemplate => ({ label, text });
const GOOD = tpl("与台账一致", "与客户合同发票台账逐笔核对一致");

// 5.1 解析：脏数据只丢那一条，不整体失效
expect("空值解析为空对象", parseCustomStore(null), {});
expect("空串解析为空对象", parseCustomStore(""), {});
expect("坏 JSON 不抛异常", parseCustomStore("{不是 json"), {});
expect("顶层数组不接受", parseCustomStore(`[{"label":"a","text":"足够长的内容"}]`), {});
expect("顶层字符串不接受", parseCustomStore(`"rd-audit"`), {});
expect(
  "正常结构原样读出",
  parseCustomStore(JSON.stringify({ "rd-audit": [GOOD] })),
  { "rd-audit": [GOOD] },
);
expect(
  "非数组的作品键被跳过",
  parseCustomStore(JSON.stringify({ "rd-audit": "x", "land-vat": [GOOD] })),
  { "land-vat": [GOOD] },
);
expect(
  "不合规条目被丢掉、合规的留下",
  parseCustomStore(
    JSON.stringify({
      "rd-audit": [
        GOOD,
        { label: "", text: "标签为空要丢掉" },
        { label: "标签实在太长了超过八个字", text: "标签过长要丢掉" },
        { label: "太短", text: "短" },
        { label: "带分号", text: `一句话${NOTE_SEP}被拆成两段` },
        { label: "缺字段" },
        { label: 1, text: 2 },
        null,
      ],
    }),
  ),
  { "rd-audit": [GOOD] },
);
expect(
  "标签与内容两侧空格被 trim",
  parseCustomStore(JSON.stringify({ "rd-audit": [{ label: "  与台账一致 ", text: "  与客户合同发票台账逐笔核对一致 " }] })),
  { "rd-audit": [GOOD] },
);
expect(
  "超过上限只保留前 N 条",
  parseCustomStore(
    JSON.stringify({
      "rd-audit": Array.from({ length: MAX_CUSTOM_TEMPLATES + 3 }, (_, i) =>
        tpl(`标签${i}`, `第 ${i} 条足够长的核对依据`),
      ),
    }),
  )["rd-audit"]!.length,
  MAX_CUSTOM_TEMPLATES,
);

// 5.2 读写：按作品隔离，往返一致
const st = new FakeStorage();
expect("没有存储内容时为空清单", loadCustomTemplates(st, "rd-audit"), []);
saveCustomTemplates(st, "rd-audit", [GOOD]);
expect("写入后读回一致", loadCustomTemplates(st, "rd-audit"), [GOOD]);
expect("换了作品读不到别人的模板", loadCustomTemplates(st, "land-vat"), []);
expect("未知作品为空清单", loadCustomTemplates(st, "no-such-agent"), []);
expect("没有 storage 时降级为空清单", loadCustomTemplates(undefined, "rd-audit"), []);
expect("没有 agentId 时降级为空清单", loadCustomTemplates(st, ""), []);
saveCustomTemplates(st, "land-vat", [tpl("与申报表一致2", "与土地增值税申报表相应栏次核对一致")]);
expect("两个作品各存各的", loadCustomTemplates(st, "rd-audit"), [GOOD]);
expect("互不覆盖", loadCustomTemplates(st, "land-vat").length, 1);
saveCustomTemplates(st, "rd-audit", [GOOD, tpl("与底稿一致2", "与本项目工作底稿合计数逐笔核对一致")]);
expect("同作品再存是覆盖不是追加", loadCustomTemplates(st, "rd-audit").length, 2);
saveCustomTemplates(st, "rd-audit", []);
expect("清空后该作品读不到模板", loadCustomTemplates(st, "rd-audit"), []);
expect("清空后另一个作品还在", loadCustomTemplates(st, "land-vat").length, 1);
saveCustomTemplates(st, "land-vat", []);
expect("全部清空后整份存储被删掉", st.removed, 1);
expect("删掉后确实没有残留", st.getItem(CUSTOM_NOTE_STORE_KEY), null);
st.seed(CUSTOM_NOTE_STORE_KEY, "{坏数据");
saveCustomTemplates(st, "rd-audit", [GOOD]);
expect("存储里是坏数据时也能重新写入", loadCustomTemplates(st, "rd-audit"), [GOOD]);
saveCustomTemplates(st, "rd-audit", [GOOD, tpl("短", "短")]);
expect("保存时会过滤掉不合规条目", loadCustomTemplates(st, "rd-audit"), [GOOD]);
saveCustomTemplates(undefined, "rd-audit", [GOOD]);
ok("storage 为 undefined 时保存不抛异常", true);

// 5.3 新增校验：每条错误都要能直接给用户看
const builtins = mergeTemplates("rd-audit", []);
expect("合规模板通过校验", validateCustomTemplate(GOOD, builtins, 0), null);
expect("前后有空格也算合规", validateCustomTemplate({ label: "  与台账一致  ", text: `  ${GOOD.text}  ` }, builtins, 0), null);
expect(
  "达到上限先拦下",
  validateCustomTemplate(GOOD, builtins, MAX_CUSTOM_TEMPLATES),
  `自定义模板最多 ${MAX_CUSTOM_TEMPLATES} 条，先删掉不用的再加`,
);
expect("空标签被拦下", validateCustomTemplate(tpl("   ", GOOD.text), builtins, 0), "给模板起个短标签，方便在胶囊按钮上认出来");
expect(
  "标签过长被拦下",
  validateCustomTemplate(tpl("一二三四五六七八九", GOOD.text), builtins, 0),
  `标签最多 ${LABEL_MAX} 个字，太长会把同一行的其他模板挤下去`,
);
expect("空内容被拦下", validateCustomTemplate(tpl("新模板", "  "), builtins, 0), "模板内容不能为空：空模板点进去等于没有留痕");
expect(
  "内容过短被拦下",
  validateCustomTemplate(tpl("新模板", "已核对"), builtins, 0),
  `模板内容至少 6 个字，否则不足以作为核对依据`,
);
expect(
  "内容带分号被拦下",
  validateCustomTemplate(tpl("新模板", `与辅助账核对一致${NOTE_SEP}无差异`), builtins, 0),
  "模板内容不要带分号：分号是备注的分段符，会把一句话拆成两段",
);
expect(
  "与内置标签重名被拦下",
  validateCustomTemplate(tpl(builtins[0]!.label, "与本项目专项台账逐笔核对一致"), builtins, 0),
  `已有同名标签「${builtins[0]!.label}」，换一个`,
);
expect(
  "与内置内容重复被拦下",
  validateCustomTemplate(tpl("换个标签", builtins[1]!.text), builtins, 0),
  `已有内容相同的模板「${builtins[1]!.label}」，不必重复添加`,
);
expect("过短内容本身不足以留痕", noteIsMeaningful("已核对"), false);

// 5.4 合并与删除：顺序稳定、同名只出现一次
expect("合并顺序为专属内置 → 自定义 → 通用", mergeTemplates("rd-audit", [GOOD]).slice(0, 2).map((t) => t.label), [
  builtinAgentTemplates("rd-audit")[0]!.label,
  GOOD.label,
]);
expect("自定义排在通用之前", mergeTemplates("rd-audit", [GOOD]).findIndex((t) => t.label === GOOD.label) < mergeTemplates("rd-audit", [GOOD]).findIndex((t) => t.label === "与底稿合计一致"), true);
expect("未知作品只有自定义与通用", mergeTemplates("no-such-agent", [GOOD])[0]!.label, GOOD.label);
expect("没有自定义时与内置清单一致", mergeTemplates("land-vat"), amountNoteTemplates("land-vat"));
expect("空自定义数组与不传等价", mergeTemplates("rd-audit", []), mergeTemplates("rd-audit"));
expect(
  "标签重名只保留先出现的（内置优先）",
  mergeTemplates("rd-audit", [tpl(builtins[0]!.label, "与本项目专项台账逐笔核对一致")]).filter(
    (t) => t.label === builtins[0]!.label,
  ).length,
  1,
);
expect(
  "重名时保留的是内置那条文案",
  mergeTemplates("rd-audit", [tpl(builtins[0]!.label, "与本项目专项台账逐笔核对一致")]).find(
    (t) => t.label === builtins[0]!.label,
  )!.text,
  builtins[0]!.text,
);
expect(
  "不合规的自定义条目不进合并结果",
  mergeTemplates("rd-audit", [GOOD, tpl("太短", "短")]).filter((t) => t.label === "太短").length,
  0,
);
expect("合并后标签仍唯一", new Set(mergeTemplates("rd-audit", [GOOD, tpl("另一条", "与另一份专项台账核对一致")]).map((t) => t.label)).size, mergeTemplates("rd-audit", [GOOD, tpl("另一条", "与另一份专项台账核对一致")]).length);
expect("合并后每条都算有效核对依据", mergeTemplates("land-vat", [GOOD]).every((t) => noteIsMeaningful(t.text)), true);
expect("删除指定标签", removeCustomTemplate([GOOD, tpl("另一条", "与另一份专项台账核对一致")], "另一条"), [GOOD]);
expect("删除不存在的标签不影响清单", removeCustomTemplate([GOOD], "没有这条"), [GOOD]);
expect("删到最后是空清单", removeCustomTemplate([GOOD], GOOD.label), []);

console.log(`[verify] 金额核对备注模板检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 金额核对备注模板规则不符");
  process.exit(1);
}
console.log("[PASS] 金额核对备注模板正确（模板可用性 / 追加分段与去重 / 撤销 / 留痕有效性 / 自定义模板存取与校验）");
