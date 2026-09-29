/**
 * 验证脚本：CSV 导出统一口径（转义 / 公式注入防护 / CRLF 与 BOM / 往返解析 / 调用方不再各写一份）。
 * 运行：pnpm verify:csv
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSV_BOM, CSV_EOL, csvBody, csvField, csvRow } from "../../web/src/csv.ts";

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

// 1) 基础转义
expect("普通字段不加引号", csvField("示例任务"), "示例任务");
expect("含逗号加引号", csvField("a,b"), '"a,b"');
expect("含双引号翻倍并加引号", csvField('a"b'), '"a""b"');
expect("含 LF 加引号", csvField("a\nb"), '"a\nb"');
expect("含 CR 加引号", csvField("a\rb"), '"a\rb"');
expect("空串原样", csvField(""), "");
expect("null 变空串", csvField(null), "");
expect("undefined 变空串", csvField(undefined), "");
expect("数字原样", csvField(12), "12");
expect("数字 0 不能被当成空", csvField(0), "0");
expect("小数原样", csvField(1.5), "1.5");

// 2) 公式注入防护：交付件里不能留能在 Excel 里执行的格子
expect("等号起头前置单引号", csvField("=1+1"), "'=1+1");
expect("DDE 载荷被拦下", csvField("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
expect("加号起头前置单引号", csvField("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
expect("减号起头非数值前置单引号", csvField("-cmd|' /C calc'!A0"), "'-cmd|' /C calc'!A0");
expect("at 起头前置单引号", csvField("@SUM(A1:A9)"), "'@SUM(A1:A9)");
expect("制表符起头前置单引号", csvField("\t=x"), "'\t=x");
expect("CR 起头前置单引号并加引号", csvField("\r=x"), '"\'\r=x"');
expect("两个减号起头也要拦", csvField("--合计"), "'--合计");
expect("纯负数不加前缀", csvField(-5), "-5");
expect("负小数字符串不加前缀", csvField("-1.25"), "-1.25");
expect("正号纯数字不加前缀", csvField("+3"), "+3");
expect("前置引号与逗号转义同时生效", csvField("=1,2"), '"\'=1,2"');
expect("前置引号与引号翻倍同时生效", csvField('=a"b'), '"\'=a""b"');
expect("正文中间有等号不算公式", csvField("差异=金额不一致"), "差异=金额不一致");
expect("中文全角等号不受影响", csvField("＝１＋１"), "＝１＋１");

// 3) 行与整篇
expect("一行逐格转义后逗号连接", csvRow(["a", "b,c", 3, null]), 'a,"b,c",3,');
expect("空行是空串", csvRow([]), "");
expect("整篇用 CRLF 分行", csvBody([["a"], ["b"]]), `a${CSV_EOL}b`);
expect("单行不含分行符", csvBody([["a", "b"]]).includes(CSV_EOL), false);
expect("空数据是空串", csvBody([]), "");
expect("BOM 码位正确", CSV_BOM.charCodeAt(0), 0xfeff);
expect("BOM 只有一个字符", CSV_BOM.length, 1);
expect("EOL 是 CRLF", CSV_EOL, "\r\n");
const mixed = csvBody([
  ["标题", "备注"],
  ["含,逗号", "两\n行"],
  ['含"引号', "=公式"],
]);
expect("字段内的 LF 不会被当成分行", mixed.split(CSV_EOL).length, 3);
expect("每行列数一致（按 RFC 解析）", new Set(parseCsv(mixed).map((r) => r.length)).size, 1);
expect("按 RFC 解析回来的列数是 2", parseCsv(mixed)[1]!.length, 2);

// 4) 往返：按 RFC 4180 解析回来应与原数据一致（公式格多一个前置单引号）
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
const source: string[][] = [
  ["标题", "备注", "金额"],
  ["含,逗号的任务", "两\n行备注", "-1200"],
  ['含"引号"的标题', "=1+1", "0"],
];
const round = parseCsv(csvBody(source));
expect("往返行数一致", round.length, source.length);
expect("往返含逗号与换行的格子还原", round[1]!.slice(0, 2), source[1]!.slice(0, 2));
expect("往返含引号的格子还原", round[2]![0], source[2]![0]);
expect("往返负数不被加前缀", round[1]![2], "-1200");
expect("往返零值保留", round[2]![2], "0");
expect("公式格解析回来只多一个单引号", round[2]![1], "'=1+1");

// 5) 调用方口径：不允许再出现第二份手写转义
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");
const read = (rel: string): string => fs.readFileSync(path.join(webSrc, rel), "utf8");
const compare = read("components/CompareView.tsx");
const sidebar = read("components/Sidebar.tsx");
const ledger = read("evidence-ledger.ts");
const overview = read("components/AgentOverview.tsx");
ok("比对视图不再有本地 csvEsc", !compare.includes("csvEsc"));
ok("会话侧栏不再有本地 esc 转义", !sidebar.includes('const esc = (v: string | number)'));
for (const [name, src] of [
  ["CompareView", compare],
  ["Sidebar", sidebar],
] as const) {
  ok(`${name} 走共享下载助手`, src.includes('from "../download.ts"') && src.includes("downloadCsv"));
  // 只针对 CSV：Markdown 与剪贴板导出仍然自己拼 \n，那是正常口径
  ok(
    `${name} 不再自己拼 CSV（BOM 与 text/csv 都交给 downloadCsv）`,
    !src.includes("text/csv") && !src.includes("\\uFEFF"),
  );
}
ok("csv.ts 保持纯函数不碰 DOM（api 侧可直接引用与验证）", !read("csv.ts").includes("document"));
ok("下载助手单独一个模块", read("download.ts").includes("export function downloadCsv"));
// 组件里不许再手写 createObjectURL：抄一份就可能漏掉 charset、BOM 或 revokeObjectURL
const componentsDir = path.join(webSrc, "components");
const handRolled = fs
  .readdirSync(componentsDir)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .filter((f) => fs.readFileSync(path.join(componentsDir, f), "utf8").includes("createObjectURL"))
  .sort();
expect("组件里不再手写 createObjectURL（统一走 download.ts）", handRolled, []);
const dl = read("download.ts");
expect("下载助手里只有一处 createObjectURL 调用", dl.split("URL.createObjectURL(").length - 1, 1);
expect("每处 createObjectURL 都对应一次回收", dl.split("URL.revokeObjectURL(").length - 1, 1);
ok("台账模块从 csv.ts 取口径", ledger.includes('from "./csv.ts"'));
ok("台账模块仍转出 csvField 与 CSV_BOM", /export \{[^}]*CSV_BOM[^}]*csvField[^}]*\}/s.test(ledger));
ok("台账不再自己 join LF", !ledger.includes('lines.join("\\n")'));
ok(
  "平台总览的下载也走共享助手（不再自己碰 BOM）",
  overview.includes('from "../download.ts"') && !overview.includes("CSV_BOM"),
);

console.log(`[verify] CSV 导出口径检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] CSV 导出口径不符");
  process.exit(1);
}
console.log("[PASS] CSV 导出口径正确（转义 / 公式注入防护 / CRLF 与 BOM / 往返解析 / 调用方统一）");
