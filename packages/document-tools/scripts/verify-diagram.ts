/**
 * 关联关系图确定性生成验证。
 * 运行：pnpm verify:diagram
 */
import { buildMatchingDiagram } from "../src/index.ts";

const match = {
  matched: [
    { contractNo: "HT-001", invoiceNos: ["FP-001", "FP-002"], status: "difference_pending", differenceYuan: "100000.00" },
    { contractNo: "HT-002", invoiceNos: ["FP-003"], status: "consistent" },
  ],
  unmatchedInvoices: [{ invoiceNo: "FP-005", reason: "发票未注明合同编号" }],
};
const ledger = {
  exact: [{ invoiceNo: "FP-001", voucherNos: ["PZ-01", "PZ-02"] }],
  candidates: [{ invoiceNo: "FP-003", voucherNos: ["PZ-03"] }],
};

const m = buildMatchingDiagram(match, ledger);
console.log(m);

const checks: Array<[string, boolean]> = [
  ["flowchart", m.includes("flowchart LR")],
  ["contractNode", m.includes("HT-001 合同")],
  ["invoiceEdge", m.includes("-->") && m.includes("FP-002")],
  ["diffLabel", m.includes("|差异 100000.00|")],
  ["unmatchedNode", m.includes("FP-005 未匹配")],
  ["ledgerEdge", m.includes("-.->") && m.includes("PZ-01")],
  ["pendingClass", m.includes("classDef pending")],
];
let pass = true;
for (const [name, ok] of checks) {
  if (!ok) pass = false;
  console.log(`[verify] ${name}=${ok}`);
}
console.log(pass ? "\n[PASS] 关联关系图生成正确。" : "\n[FAIL] 关系图验证未通过。");
process.exitCode = pass ? 0 : 1;
