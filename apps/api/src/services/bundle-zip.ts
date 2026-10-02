/**
 * 交付包打包：客户端生成的整页交付 MD + 本任务全部产物文件 → 一个 zip。
 * 用 exceljs 已经带进项目的 jszip，不新增第三方依赖；条目名安全化是纯函数，可被 verify:bundle 校验。
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { dirs } from "../config.ts";
import { listFiles } from "./task-store.ts";

export type BundleEntry = { name: string; data: string | Uint8Array };

/** zip 条目名安全化：反斜杠转正斜杠、去掉盘符与绝对路径、禁止 .. 上跳 */
export function sanitizeEntryName(name: string): string {
  const trimmed = name.trim().replace(/\\/g, "/");
  const noDrive = trimmed.replace(/^[A-Za-z]:\//, "");
  const parts = noDrive.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  return parts.join("/") || "未命名";
}

export async function createBundleZip(entries: BundleEntry[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const e of entries) zip.file(sanitizeEntryName(e.name), e.data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/**
 * 组装交付包条目：MD 在最前，产物统一放在「产物/」下（按文件名排序），上传资料放在「资料/」下
 * （按上传顺序）。
 */
export async function collectBundleEntries(
  taskId: string,
  markdown: string,
  mdName = "整页交付.md",
): Promise<BundleEntry[]> {
  const entries: BundleEntry[] = [{ name: mdName, data: markdown }];
  const dir = path.join(dirs.outputs, taskId);
  if (fs.existsSync(dir)) {
    const names = fs
      .readdirSync(dir)
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .sort();
    for (const n of names) {
      entries.push({ name: `产物/${n}`, data: new Uint8Array(await fs.promises.readFile(path.join(dir, n))) });
    }
  }
  // 资料此前压根没被打进包里，而 manifest 一样申报它们（交付 MD 里也有「业务资料清单」表）：
  // 实测 rd-audit 的回归案例申报了「辅助账.xlsx」、包里没有，交付清单在说谎。这个缺陷在
  // scan:deliverables 只测一个任务时藏了很久——它挑中的恰好是 land-vat 那个任务，而那份资料
  // 与包里的一个产物同名，被「按后缀匹配」蒙对了。
  // 磁盘上真缺的那份不塞空文件充数：宁可少一个条目，让门禁与核对表如实报出来。
  for (const f of listFiles(taskId)) {
    if (!fs.existsSync(f.storagePath)) continue;
    entries.push({ name: `资料/${f.fileName}`, data: new Uint8Array(await fs.promises.readFile(f.storagePath)) });
  }
  return entries;
}
