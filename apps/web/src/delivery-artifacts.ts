/**
 * 交付 MD 的「生成产物与溯源」节。
 *
 * 为什么抽出来：这一节此前写在 TaskWorkbench 的 `bundleLines()` 里，那是个组件内闭包，任何单测
 * 都碰不到它。底层取数是有门禁的（`verify:artsrc` 核 `artifactSources` 的来源判定、
 * `verify:runart` 核运行时间窗与产物归属），但把它们拼成对外表格的那一段没有：列数、列顺序、
 * 三态文案（生成 / 引用 / 未识别）、空态那句「（本次任务无生成产物）」、「第 N 次」的写法，
 * 全靠下载下来肉眼扫。而这一节正是交付包里「产物从哪来」的对外声称——列错位、或把「未识别」
 * 写成「生成」，材料就在撒谎，且没有任何门禁会红。与 delivery-docref / delivery-amount /
 * delivery-cite 三节同一条路子。
 *
 * 顺手修掉一个静默退化：`role` 的取值名单在 `artifact-sources.ts` 里（`"producer" | "ref"`），
 * 而按 role 分文案的地方此前写了三遍，全是三元兜底——交付 MD 的「关系」列、界面产物区块那句
 * 「由 X 生成于 T / 被 X 引用（T），非该调用生成」、以及「定位」按钮的 tooltip。名单在别处、
 * 文案靠三元，将来加第三种 role 时三处都会把它静默归成「引用」，而 MD 与界面谁也不会红。
 * 这里改成两个 `Record<SourceCall["role"], …>`（一个给词、一个给整句）：漏一个取值直接编译不过。
 * 所以本模块不只服务交付 MD，也是界面上产物溯源文案的唯一来源。
 */
import { fmtBytes } from "./run-artifacts.ts";
import type { SourceCall } from "./artifact-sources.ts";

export type DeliveryArtifactRow = {
  name: string;
  byteSize: number;
  /** 来源那次工具调用；null = 没识别出来源（此时关系列写「未识别」，不猜） */
  source: SourceCall | null;
  /** 属于第几次运行；null = 归不到任何一次运行 */
  run: number | null;
};

/** 列名即列数：表头、分隔行与「每行几列」的断言都从这里取，不各写一个 6 */
export const ARTIFACT_COLUMNS = ["文件", "大小", "来源工具", "关系", "时间", "所属运行"] as const;

export const ARTIFACT_ROLE_TEXT: Record<SourceCall["role"], string> = { producer: "生成", ref: "引用" };

/**
 * 界面产物区块那句完整说明。与 ARTIFACT_ROLE_TEXT 同一个名单，所以两处不可能对 role 各说一套。
 * 「非该调用生成」这半句是刻意保留的：ref 只说明产物出现在那次调用的结果里（例如作为比对输入），
 * 不说清楚就会被读成「这次调用产出了它」。
 */
export const ARTIFACT_ROLE_NOTE: Record<SourceCall["role"], (toolName: string, at: string) => string> = {
  producer: (toolName, at) => ` · 由 ${toolName} 生成于 ${at}`,
  ref: (toolName, at) => ` · 被 ${toolName} 引用（${at}），非该调用生成`,
};
export const ARTIFACT_UNKNOWN_SOURCE = "未识别";
export const ARTIFACT_EMPTY_NOTE = "（本次任务无生成产物）";
export const ARTIFACT_DASH = "—";

/** 时间列与交付 MD 其余各节同一个格式（zh-CN、24 小时制） */
const stamp = (iso: string): string => new Date(iso).toLocaleString("zh-CN", { hour12: false });

export function artifactsSection(rows: DeliveryArtifactRow[]): string[] {
  if (rows.length === 0) return [ARTIFACT_EMPTY_NOTE];
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  return [
    line([...ARTIFACT_COLUMNS]),
    line(ARTIFACT_COLUMNS.map(() => "---")),
    ...rows.map((r) =>
      line([
        r.name,
        fmtBytes(r.byteSize),
        r.source?.toolName ?? ARTIFACT_DASH,
        r.source ? ARTIFACT_ROLE_TEXT[r.source.role] : ARTIFACT_UNKNOWN_SOURCE,
        r.source ? stamp(r.source.at) : ARTIFACT_DASH,
        r.run !== null ? `第 ${r.run} 次` : ARTIFACT_DASH,
      ]),
    ),
  ];
}
