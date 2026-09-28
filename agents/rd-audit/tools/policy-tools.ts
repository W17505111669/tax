import fs from "node:fs";
import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";

export interface PolicyEntry {
  id: string;
  docNo: string;
  title: string;
  issuer: string;
  year: number;
  appliesFrom: number;
  appliesTo: number | null;
  tags: string[];
  keyPoints: string[];
}

interface PolicyFile {
  snapshotNote: string;
  sourceHome: string;
  entries: PolicyEntry[];
}

const policyFile = JSON.parse(
  fs.readFileSync(new URL("../knowledge/rd-policies.json", import.meta.url), "utf8"),
) as PolicyFile;

export type EnterpriseType = "general" | "manufacturing" | "tech_sme" | "ic_imt";

export const ENTERPRISE_TYPE_LABELS: Record<EnterpriseType, string> = {
  general: "一般企业",
  manufacturing: "制造业企业",
  tech_sme: "科技型中小企业",
  ic_imt: "集成电路/工业母机企业",
};

export interface RateInfo {
  ratePercent: number;
  basisDocNo: string;
  note: string;
}

/** 确定性比例规则表：按费用年度与企业类型返回加计扣除比例及政策依据文号。 */
export function rateFor(year: number, type: EnterpriseType): RateInfo | null {
  if (year <= 2015) return null;
  if (type === "ic_imt" && year >= 2023 && year <= 2027) {
    return {
      ratePercent: 120,
      basisDocNo: "财政部 税务总局 国家发展改革委 工业和信息化部公告2023年第44号",
      note: "集成电路和工业母机企业 2023—2027 年度按 120% 加计扣除",
    };
  }
  if (year >= 2023) {
    return {
      ratePercent: 100,
      basisDocNo: "财政部 税务总局公告2023年第7号",
      note: "符合条件企业自 2023-01-01 起统一按 100% 加计扣除",
    };
  }
  if (year === 2022) {
    if (type === "manufacturing") {
      return { ratePercent: 100, basisDocNo: "财政部 税务总局公告2021年第13号", note: "制造业企业自 2021 年起 100%" };
    }
    if (type === "tech_sme") {
      return { ratePercent: 100, basisDocNo: "财政部 税务总局 科技部公告2022年第16号", note: "科技型中小企业自 2022 年起 100%" };
    }
    return { ratePercent: 75, basisDocNo: "财政部 税务总局公告2021年第6号", note: "75% 比例延期至 2023-12-31" };
  }
  if (year === 2021) {
    if (type === "manufacturing") {
      return { ratePercent: 100, basisDocNo: "财政部 税务总局公告2021年第13号", note: "制造业企业自 2021 年起 100%" };
    }
    return { ratePercent: 75, basisDocNo: "财政部 税务总局公告2021年第6号", note: "75% 比例延期至 2023-12-31" };
  }
  if (year >= 2018) {
    return { ratePercent: 75, basisDocNo: "财税〔2018〕99号", note: "2018—2020 年度比例提高至 75%" };
  }
  return { ratePercent: 50, basisDocNo: "财税〔2015〕119号", note: "2016—2017 年度按 50% 加计扣除" };
}

export function searchPolicies(opts: { year?: number; keyword?: string }): PolicyEntry[] {
  const kw = opts.keyword?.trim().toLowerCase();
  return policyFile.entries.filter((e) => {
    if (opts.year !== undefined) {
      if (opts.year < e.appliesFrom) return false;
      if (e.appliesTo !== null && opts.year > e.appliesTo) return false;
    }
    if (kw) {
      const hay = `${e.title} ${e.docNo} ${e.tags.join(" ")} ${e.keyPoints.join(" ")}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

/** 研发费用政策适用检索：本地版本化快照 + 确定性比例规则。 */
export const searchRdPolicyTool: ToolDefinition = {
  name: "search_rd_policy",
  label: "研发费用政策适用检索",
  description:
    "检索研发费用加计扣除政策快照：按费用年度筛选适用政策、按关键词检索条文要点，并按年度与企业类型返回确定性加计扣除比例及政策依据文号。测算加计扣除额之前必须先调用本工具确认比例与依据。",
  promptSnippet: "search_rd_policy: 按年度/企业类型检索适用政策与加计比例依据",
  parameters: Type.Object({
    year: Type.Optional(Type.Integer({ description: "研发费用所属年度，如 2025" })),
    enterpriseType: Type.Optional(
      Type.String({ description: "general|manufacturing|tech_sme|ic_imt，默认 general" }),
    ),
    keyword: Type.Optional(Type.String({ description: "关键词，如 辅助账、其他相关费用、委托研发" })),
  }),
  async execute(_id, params: { year?: number; enterpriseType?: string; keyword?: string }) {
    const type = (params.enterpriseType ?? "general") as EnterpriseType;
    const entries = searchPolicies({ year: params.year, keyword: params.keyword });
    const rate = params.year !== undefined ? rateFor(params.year, type) : null;

    const lines = [
      `政策快照检索结果（${entries.length} 条适用政策）：`,
      ...entries.map(
        (e) =>
          `- ${e.docNo}《${e.title}》（${e.issuer}，${e.year}；适用 ${e.appliesFrom}—${e.appliesTo ?? "现行"}）\n  要点：${e.keyPoints.join("；")}`,
      ),
    ];
    if (rate) {
      lines.push(
        "",
        `加计扣除比例（${params.year} 年度 · ${ENTERPRISE_TYPE_LABELS[type] ?? type}）：${rate.ratePercent}%`,
        `政策依据：${rate.basisDocNo}（${rate.note}）`,
      );
    }
    lines.push("", `提示：${policyFile.snapshotNote} 法规库入口：${policyFile.sourceHome}`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { year: params.year ?? null, enterpriseType: type, rate, entries, snapshotNote: policyFile.snapshotNote },
    };
  },
};
