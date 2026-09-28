/**
 * 证据包装配器：把提交所需的文档证据复制到 data/evidence-<date>/ 并生成清单。
 * 运行：pnpm pack:evidence
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.join(root, "data", `evidence-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

function copyLatest(srcDir: string, pattern: RegExp, destName: string): string | null {
  if (!fs.existsSync(srcDir)) return null;
  const hits = fs.readdirSync(srcDir).filter((f) => pattern.test(f)).sort();
  const latest = hits[hits.length - 1];
  if (!latest) return null;
  fs.copyFileSync(path.join(srcDir, latest), path.join(outDir, destName));
  return latest;
}

const manifest: string[] = ["# 证据包清单", "", `- 生成时间：${new Date().toISOString()}`, ""];
let packed = 0;

const testing = path.join(root, "docs", "testing");
const competition = path.join(root, "docs", "competition");

const report = copyLatest(testing, /^test-report-.*\.md$/, "测试报告.md");
  if (report) {
    manifest.push(`- 测试报告.md（源：docs/testing/${report}）`);
    packed += 1;
  }

for (const f of ["智研税审-作品说明.md", "土增智填-作品说明.md", "智研税审-PPT大纲.md", "土增智填-PPT大纲.md", "录屏分镜表.md"]) {
  const src = path.join(competition, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outDir, f));
    manifest.push(`- ${f}（源：docs/competition/${f}）`);
    packed += 1;
  }
}

const casesDir = path.join(root, "data", "cases");
if (fs.existsSync(casesDir)) {
  for (const caseName of fs.readdirSync(casesDir).sort()) {
    const dir = path.join(casesDir, caseName);
    if (!fs.statSync(dir).isDirectory()) continue;
    const rep = copyLatest(dir, /^report-.*\.md$/, `案例回归-${caseName}.md`);
    if (rep) {
      manifest.push(`- 案例回归-${caseName}.md（源：data/cases/${caseName}/${rep}）`);
      packed += 1;
    }
  }
}

const readme = path.join(root, "README.md");
if (fs.existsSync(readme)) {
  fs.copyFileSync(readme, path.join(outDir, "README.md"));
  manifest.push("- README.md（源：仓库根）");
  packed += 1;
}

manifest.push("");
manifest.push("## UI 交互要点");
manifest.push("");
manifest.push("- 对话式工作台：图标栏 + 可折叠侧栏、居中对话列、分段页签、引用胶囊与操作行、发光输入框（Ctrl+Enter 提交）。");
manifest.push("- 键盘：Ctrl+K 聚焦任务搜索；Esc 收起续跑面板/阅读器（焦点归还）；比对视图 ↑/↓ 选差异行、Enter 阅读器双底稿定位。");
manifest.push("- 阅读器：引用文件/文件生成分组页签（分组记忆）、点阵加载动画、高亮行自动滚至视口中央。");
manifest.push("");
manifest.push("## 提交提醒");
manifest.push("");
manifest.push("- 运行录屏 MP4（≤500MB、≤8 分钟）需人工录制后放入本目录；");
manifest.push("- 真实脱敏案例回归：替换 data/cases/<id>/inputs 与 expected 后重跑 pnpm case:run；");
manifest.push("- 本包内所有数字均可由 pnpm report:test / pnpm case:run 复算。");

manifest.push("", `- 合计文件：${packed} 份（不含本清单）`);
fs.writeFileSync(path.join(outDir, "MANIFEST.md"), manifest.join("\n"), "utf8");
console.log(`[evidence] packed ${packed} files -> ${outDir}`);
