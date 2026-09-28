/**
 * 政策快照与比例规则确定性验证。
 * 运行：pnpm verify:policy
 */
import { rateFor, searchPolicies } from "../tools/policy-tools.ts";

const cases: Array<{ year: number; type: Parameters<typeof rateFor>[1]; rate: number; basis: string }> = [
  { year: 2016, type: "general", rate: 50, basis: "财税〔2015〕119号" },
  { year: 2019, type: "general", rate: 75, basis: "财税〔2018〕99号" },
  { year: 2021, type: "manufacturing", rate: 100, basis: "财政部 税务总局公告2021年第13号" },
  { year: 2022, type: "tech_sme", rate: 100, basis: "财政部 税务总局 科技部公告2022年第16号" },
  { year: 2025, type: "general", rate: 100, basis: "财政部 税务总局公告2023年第7号" },
  { year: 2025, type: "ic_imt", rate: 120, basis: "财政部 税务总局 国家发展改革委 工业和信息化部公告2023年第44号" },
];

let pass = true;
for (const c of cases) {
  const got = rateFor(c.year, c.type);
  const ok = got?.ratePercent === c.rate && got.basisDocNo === c.basis;
  if (!ok) pass = false;
  console.log(`[verify] rate(${c.year},${c.type}) = ${got?.ratePercent}% ${got?.basisDocNo} | expect ${c.rate}% ${c.basis} | ${ok ? "ok" : "MISMATCH"}`);
}

const aux = searchPolicies({ keyword: "辅助账" }).map((e) => e.id);
const okAux = aux.includes("sta2015-97") && aux.includes("sta2021-28");
const y2025 = searchPolicies({ year: 2025 }).map((e) => e.id);
const ok2025 = y2025.includes("cs2015-119") && y2025.includes("mof2023-7") && !y2025.includes("cs2018-99");
console.log(`[verify] keyword(辅助账)=${aux.join(",")} ok=${okAux} | year2025=${y2025.length}条 ok=${ok2025}`);
pass = pass && okAux && ok2025;

console.log(pass ? "\n[PASS] 政策快照与比例规则验证通过。" : "\n[FAIL] 政策工具验证未通过。");
process.exitCode = pass ? 0 : 1;
