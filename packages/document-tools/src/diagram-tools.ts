import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";
import type { TaskDocumentContext } from "./task-tools.ts";

interface MatchedContract {
  contractNo: string;
  contractName?: string;
  invoiceNos?: string[];
  differenceYuan?: string;
  status?: string;
}
interface MatchResultLike {
  matched?: MatchedContract[];
  unmatchedInvoices?: Array<{ invoiceNo: string; reason?: string }>;
}
interface LedgerResultLike {
  exact?: Array<{ invoiceNo: string; voucherNos?: string[] }>;
  candidates?: Array<{ invoiceNo: string; voucherNos?: string[] }>;
  unmatched?: Array<{ invoiceNo: string }>;
}

function nodeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "");
}

/** 由关联工具结果确定性生成 mermaid 关系图源码（合同→发票→账面记录）。 */
export function buildMatchingDiagram(match: MatchResultLike | null, ledger: LedgerResultLike | null): string {
  const lines: string[] = ["flowchart LR"];
  const nodeLabels = new Map<string, string>();
  const edges: string[] = [];
  const pendingNodes = new Set<string>();

  const declare = (id: string, label: string, kind: "contract" | "invoice" | "voucher" | "missing") => {
    if (!nodeLabels.has(id)) {
      nodeLabels.set(id, label);
      const shape =
        kind === "contract"
          ? `${id}["${label}"]`
          : kind === "voucher"
            ? `${id}[("${label}")]`
            : `${id}("${label}")`;
      lines.push(`  ${shape}`);
    }
    if (kind === "missing") pendingNodes.add(id);
  };

  for (const m of match?.matched ?? []) {
    const cid = nodeId(`C${m.contractNo}`);
    declare(cid, `${m.contractNo} 合同`, "contract");
    for (const inv of m.invoiceNos ?? []) {
      const iid = nodeId(`I${inv}`);
      declare(iid, inv, "invoice");
      const diffLabel = m.status === "difference_pending" && m.differenceYuan ? `|差异 ${m.differenceYuan}|` : "";
      edges.push(`  ${cid} -->${diffLabel} ${iid}`);
      if (m.status === "difference_pending") pendingNodes.add(iid);
    }
    if ((m.invoiceNos ?? []).length === 0) pendingNodes.add(cid);
  }
  for (const u of match?.unmatchedInvoices ?? []) {
    const iid = nodeId(`I${u.invoiceNo}`);
    declare(iid, `${u.invoiceNo} 未匹配`, "missing");
  }
  const ledgerLinks = [...(ledger?.exact ?? []), ...(ledger?.candidates ?? [])];
  for (const l of ledgerLinks) {
    const iid = nodeId(`I${l.invoiceNo}`);
    if (!nodeLabels.has(iid)) declare(iid, l.invoiceNo, "invoice");
    for (const v of l.voucherNos ?? []) {
      const vid = nodeId(`V${v}`);
      declare(vid, v, "voucher");
      edges.push(`  ${iid} -.-> ${vid}`);
    }
  }
  lines.push(...edges);
  if (pendingNodes.size > 0) {
    lines.push(`  classDef pending stroke:#f59e0b,stroke-dasharray: 5 4;`);
    lines.push(`  class ${[...pendingNodes].join(",")} pending;`);
  }
  return lines.join("\n");
}

/** 土增智填专属：由本任务最近一次关联结果生成 mermaid 关系图，保证图与数据同源。 */
export function createDiagramTools(ctx: TaskDocumentContext): ToolDefinition[] {
  const tool: ToolDefinition = {
    name: "render_matching_diagram",
    label: "生成关联关系图",
    description:
      "读取本任务最近一次 match_contract_invoice / match_invoice_ledger 的结果，确定性生成 mermaid 关系图源码（合同→发票→账面记录，差异边带金额标签，未匹配节点琥珀虚线）。结论中的关系图必须原样嵌入本工具返回的源码，不得手工重画。",
    promptSnippet: "render_matching_diagram: 由关联结果生成 mermaid 关系图源码",
    parameters: Type.Object({}),
    async execute() {
      const match = (ctx.latestToolResult?.("match_contract_invoice") ?? null) as MatchResultLike | null;
      const ledger = (ctx.latestToolResult?.("match_invoice_ledger") ?? null) as LedgerResultLike | null;
      if (!match) {
        return {
          content: [{ type: "text", text: "本任务尚无 match_contract_invoice 的成功结果，请先完成合同发票关联再生成关系图。" }],
          details: { mermaid: null },
        };
      }
      const mermaid = buildMatchingDiagram(match, ledger);
      const nodeCount = (mermaid.match(/^\s{2}[A-Za-z0-9]+[\[(]/gm) ?? []).length;
      const edgeCount = (mermaid.match(/-->/g) ?? []).length;
      return {
        content: [
          {
            type: "text",
            text: `关系图 mermaid 源码（${nodeCount} 节点、${edgeCount} 条边），请在结论中原样嵌入：\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
          },
        ],
        details: { mermaid, nodeCount, edgeCount },
      };
    },
  };
  return [tool];
}
