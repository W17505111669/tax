/**
 * 验证脚本：已核实官方原文索引（原文页地址门槛 / 标题区判据 / 索引结构 / 逐页实网核对）。
 *
 * 这套索引会被跨任务复用成「该文号的官方原文」，一旦收进错页面，错误会扩散到所有引用同一
 * 字号的任务，因此判据本身要有测试，索引内容也要能逐页复核。
 *
 * 默认离线：只跑纯函数与索引结构校验。设 TAXAI_VERIFY_LIVE=1 才逐页抓取核对——
 * 与 verify:websearch 同一约定，默认门禁不联网，免得时长与结果随网络环境波动。
 * 运行：pnpm verify:docsrc
 */
import {
  isLibraryDocUrl,
  isLibraryPageForDoc,
  libraryPageHeader,
  libraryDocTitle,
  normalizeDocNum,
} from "@tax/business-tools";
import { verifiedOfficialDocs } from "../src/services/ref-checks.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
  if (!cond) failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
}

// 1) 原文页地址门槛：只有政策法规库文档树算原文，主站解读频道页会出现字号但不是原文
expect(
  "政策法规库文档树算原文页",
  isLibraryDocUrl("http://fgk.chinatax.gov.cn/zcfgk/c100012/c5194895/content.html"),
  true,
);
expect(
  "https 写法同样算",
  isLibraryDocUrl("https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202002/content.html"),
  true,
);
expect(
  "主站解读频道页不算原文页",
  isLibraryDocUrl("https://www.chinatax.gov.cn/chinatax/n810341/n810760/c2922282/content.html"),
  false,
);
expect("栏目列表页不算", isLibraryDocUrl("http://fgk.chinatax.gov.cn/zcfgk/c100012/listflfg.html"), false);
expect("库首页不算", isLibraryDocUrl("https://fgk.chinatax.gov.cn/zcfgk/"), false);
expect("第三方站点不算", isLibraryDocUrl("https://www.shui5.cn/article/cc/83114.html"), false);
expect("非法地址不算", isLibraryDocUrl("不是地址"), false);

// 2) 标题区判据。夹具按实测页面结构写：SPA 的 <title> 是站点名、文号与阅读量之间夹着一对空括号、
//    正文里还会出现别的文件的字号——三点都是真实踩过的坑。
const page = (docNum: string, title: string): string =>
  `<html><head><title>国家税务总局政策法规库</title><style>.a{color:red}</style></head><body>` +
  `<script>var ignored = 1;</script><div>当前位置： 首页 &gt; 政策法规 &gt; 财税文件</div>` +
  `<h1>${title}</h1><span>${docNum}</span><span>（ ）</span><div>阅读量：165377次</div>` +
  `<p>正文里还会提到 国家税务总局公告2099年第1号 这份别的文件</p></body></html>`;

expect(
  "标题区截到阅读量之前并去掉空括号",
  libraryPageHeader(page("财税〔2015〕119号", "关于完善研究开发费用税前加计扣除政策的通知")).endsWith(
    "财税[2015]119号",
  ),
  true,
);
expect(
  "不用 title 判断（SPA 的 title 是站点名）",
  libraryPageHeader(page("财税〔2015〕119号", "…")).includes("政策法规库"),
  false,
);
expect("本页即该文件", isLibraryPageForDoc(page("财税〔2015〕119号", "…通知"), "财税〔2015〕119号"), true);
expect(
  "联合发文归一化后判定成立",
  isLibraryPageForDoc(
    page("财政部 税务总局 科技部公告2022年第28号", "…公告"),
    "财政部 税务总局 科技部公告2022年第28号",
  ),
  true,
);
expect(
  "正文里提到别的文件不算命中",
  isLibraryPageForDoc(page("财税〔2015〕119号", "…通知"), "国家税务总局公告2099年第1号"),
  false,
);
expect("字号不同不算", isLibraryPageForDoc(page("国税发〔2006〕187号", "…通知"), "国税发〔2006〕188号"), false);
expect("空字号不算", isLibraryPageForDoc(page("财税〔2015〕119号", "…"), ""), false);
expect(
  "缺阅读量标记时不把正文中间的字号当成标题区",
  isLibraryPageForDoc("<html><body>正文里 财税〔2015〕119号 出现在中间</body></html>", "财税〔2015〕119号"),
  false,
);

// 2b) 原文页标题：SPA 的 <title> 是站点名，阅读器标签要靠正文标题区才能区分是哪一份文件。
//     面包屑切掉后栏目名会留在开头（「财税文件」），它本身是标题区的一部分，无害且有助于判断文件类别。
expect(
  "标题取到栏目、文件名与发文字号",
  libraryDocTitle(
    page("财税〔2015〕119号", "财政部 国家税务总局 科技部关于完善研究开发费用税前加计扣除政策的通知"),
  ),
  "财税文件 财政部 国家税务总局 科技部关于完善研究开发费用税前加计扣除政策的通知 财税〔2015〕119号",
);
expect(
  "标题里不含站点名（SPA 的 title 必须被 head 剔除）",
  libraryDocTitle(page("国税发〔2006〕187号", "关于土地增值税清算有关问题的通知")).includes("政策法规库"),
  false,
);
expect(
  "缺阅读量标记时返回空串，不猜",
  libraryDocTitle("<html><body>只有正文 财税〔2015〕119号</body></html>"),
  "",
);

// 3) 真实索引的结构校验（离线）
const idx = verifiedOfficialDocs();
expect(
  "索引键都是归一化后的完整发文字号",
  [...idx.keys()].every((k) => k === normalizeDocNum(k) && k.length > 4),
  true,
);
ok(
  "索引里的地址全部是政策法规库原文页",
  [...idx.values()].every((v) => isLibraryDocUrl(v.evidence.url)),
  JSON.stringify([...idx.values()].map((v) => v.evidence.url).filter((u) => !isLibraryDocUrl(u))),
);
expect(
  "索引里的证据分级都是官方原文",
  [...idx.values()].every((v) => v.evidence.grade === "official"),
  true,
);
console.log(`[verify] 已核实官方原文索引 ${idx.size} 条（全部为政策法规库文档树原文页）`);

// 4) 逐页实网核对：确认「本页即该文件」，而不只是「页面里出现过这个字号」
if (process.env.TAXAI_VERIFY_LIVE === "1") {
  let passed = 0;
  let skipped = 0;
  for (const [docNum, v] of idx) {
    try {
      const res = await fetch(v.evidence.url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
      });
      checks += 1;
      if (!res.ok) {
        failures.push(`实网核对 ${docNum}：HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      if (isLibraryPageForDoc(html, docNum)) passed += 1;
      else failures.push(`实网核对 ${docNum}：页面标题区不以该字号结尾，本页不是该文件（${v.evidence.url}）`);
      // 标题也要能用：侧边阅读器的标签靠它区分是哪一份文件，取不到或取到站点名都等于没有标题。
      // 不同栏目（税收规范性文件 / 财税文件 / 部门规章）的标题区格式若有差异，这里会先暴露出来。
      const title = libraryDocTitle(html);
      checks += 1;
      if (title === "") failures.push(`实网核对 ${docNum}：取不到原文页标题（${v.evidence.url}）`);
      else if (title.includes("政策法规库")) {
        failures.push(`实网核对 ${docNum}：标题仍是站点名而非文件名「${title.slice(0, 40)}」`);
      } else if (!normalizeDocNum(title).endsWith(docNum)) {
        failures.push(`实网核对 ${docNum}：标题里没有该发文字号「${title.slice(0, 40)}」`);
      }
    } catch (err) {
      // 网络不可用不算失败：如实跳过，不把环境问题记成证据问题
      skipped += 1;
      console.log(`[verify] 实网核对跳过 ${docNum}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  console.log(`[verify] 实网逐页核对：确认 ${passed} 页 · 跳过 ${skipped} 页 · 共 ${idx.size} 条`);
} else {
  console.log("[verify] 实网逐页核对跳过（默认门禁不联网；设 TAXAI_VERIFY_LIVE=1 可跑）");
}

console.log(`[verify] 官方原文索引检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 已核实官方原文索引规则不符");
  process.exit(1);
}
console.log("[PASS] 已核实官方原文索引正确（原文页门槛 / 标题区判据 / 索引结构 / 逐页核对）");
