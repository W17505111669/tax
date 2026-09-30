/**
 * 失败工具调用的归因分类：把看板上的「失败 N」拆成几类**处置方式完全不同**的问题。
 *
 * 只有一个数字时，「失败 7」既可能是模型把参数传错（该改提示词），也可能是链接真的死了
 * （该换出处），还可能是本机抓取服务没配（该配环境）——三件事的负责人和动作都不一样，
 * 混在一个数里等于谁也不去处理。实测那 7 条正好落满四类：3 条模型猜错 get_search_content
 * 的参数组合、1 条拿 file:// 本地路径去调远程抓取、2 条 HTTP 404 死链、1 条 HTTP 412
 * （提示 firecrawlBaseUrl / crawl4aiBaseUrl 未配置）。
 *
 * 分类只看错误正文，不猜工具内部实现；判不出来的老实归入 unknown，不硬塞进某一类。
 */

export type FailureCause = "bad_args" | "unsupported" | "not_found" | "upstream" | "unknown";

export interface FailureItem {
  taskId: string;
  taskTitle: string;
  agentId: string;
  toolName: string;
  error: string;
  args: string;
  startedAt: string;
}

export interface FailureGroup {
  cause: FailureCause;
  /** 类别名，直接显示 */
  label: string;
  /** 这一类该怎么办，一句话；写不出具体动作的类别不编 */
  hint: string;
  items: FailureItem[];
}

export const CAUSE_LABELS: Record<FailureCause, string> = {
  bad_args: "模型传错参数",
  unsupported: "用法不支持",
  not_found: "外部资源不存在",
  upstream: "外部服务拒绝或未配置",
  unknown: "未归类",
};

export const CAUSE_HINTS: Record<FailureCause, string> = {
  bad_args: "工具本身能跑，是入参组合不合法。处置：把该工具的合法参数组合写进系统提示词，别让模型继续猜",
  unsupported:
    "调用方式与工具能力不匹配（如拿本地文件路径去调远程抓取）。处置：本地上传资料走 parse_uploaded_files，远程抓取只接受 http/https",
  not_found: "对方页面已不存在。处置：用检索找现行版本，或改引其他可核验出处，并在结论中如实标注链接失效",
  upstream:
    "对方拒绝请求，或本机抓取服务未配置。处置：换 fetch_public_document 等自有通道重试，或按错误提示补齐抓取服务配置",
  unknown: "错误正文没有匹配到已知模式。处置：逐条读错误正文后判断，必要时补一条分类规则",
};

/** 分类顺序即优先级：一条错误只归一类，先命中的算数 */
const RULES: Array<{ cause: FailureCause; test: (error: string) => boolean }> = [
  // 「No query specified」「No URL specified」这类是工具在说「你没给我必需的入参」
  { cause: "bad_args", test: (e) => /^no (query|url|input|prompt|parameter)\b/i.test(e) || /missing required/i.test(e) },
  { cause: "unsupported", test: (e) => /only http and https/i.test(e) || /unsupported (protocol|scheme|url)/i.test(e) },
  { cause: "not_found", test: (e) => /\b(HTTP\s*)?404\b/.test(e) || /not found/i.test(e) },
  {
    cause: "upstream",
    test: (e) =>
      /\b(HTTP\s*)?(40[13]|412|429|5\d\d)\b/.test(e) ||
      /firecrawlBaseUrl|crawl4aiBaseUrl/i.test(e) ||
      /(timeout|timed out|ECONNREFUSED|ENOTFOUND|rate limit)/i.test(e),
  },
];

export function classifyFailure(error: string): FailureCause {
  const text = String(error ?? "").trim();
  for (const rule of RULES) if (rule.test(text)) return rule.cause;
  return "unknown";
}

/** 类别展示顺序：先摆能改代码/提示词治好的，再摆外部因素，未归类垫底 */
const CAUSE_ORDER: FailureCause[] = ["bad_args", "unsupported", "upstream", "not_found", "unknown"];

/**
 * 按归因分组。组间按 CAUSE_ORDER，组内按时间倒序（最近的先看到）。
 * 排序必须确定：同一批数据每次行序一致，导出与截图才对得上。
 */
export function groupFailures(items: FailureItem[]): FailureGroup[] {
  const by = new Map<FailureCause, FailureItem[]>();
  for (const it of items) {
    const cause = classifyFailure(it.error);
    by.set(cause, [...(by.get(cause) ?? []), it]);
  }
  return CAUSE_ORDER.filter((c) => (by.get(c) ?? []).length > 0).map((cause) => ({
    cause,
    label: CAUSE_LABELS[cause],
    hint: CAUSE_HINTS[cause],
    items: [...(by.get(cause) ?? [])].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
    ),
  }));
}

/** 汇总一行：总条数、类别数、其中可以靠改提示词或配置治好的条数 */
export function failureSummary(items: FailureItem[]): {
  total: number;
  causes: number;
  fixableByUs: number;
} {
  const groups = groupFailures(items);
  return {
    total: items.length,
    causes: groups.length,
    // 模型传错参数与用法不支持这两类，改提示词就能减少；其余取决于外部资源与本机配置
    fixableByUs: groups
      .filter((g) => g.cause === "bad_args" || g.cause === "unsupported")
      .reduce((n, g) => n + g.items.length, 0),
  };
}
