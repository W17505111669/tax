import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { dirs } from "../config.ts";
import { parseExcelFile } from "@tax/document-tools";
import { getTask, listFiles } from "../services/task-store.ts";
import { assertSafeUrl } from "../services/link-checks.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const TEXTUAL = new Set(["txt", "md", "csv", "json", "xml"]);

interface ReaderResult {
  url: string;
  title: string;
  excerpt: string;
  markdown: string;
  retrievedAt: string;
  contentType: string;
}

const readerCache = new Map<string, { at: number; data: ReaderResult }>();

/** 阅读模式解析：linkedom + Mozilla Readability + Turndown，全部为成熟开源库。 */
async function readUrl(raw: string): Promise<ReaderResult> {
  const target = assertSafeUrl(raw);
  const key = target.toString();
  const hit = readerCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;

  const res = await fetch(key, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`读取网页失败 HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf")) {
    const data: ReaderResult = {
      url: key,
      title: decodeURIComponent(path.basename(target.pathname)),
      excerpt: "",
      markdown: "",
      retrievedAt: new Date().toISOString(),
      contentType,
    };
    readerCache.set(key, { at: Date.now(), data });
    return data;
  }
  const html = await res.text();
  const { document } = parseHTML(html);
  type ReadabilityDoc = ConstructorParameters<typeof Readability>[0];
  const article = new Readability(document as unknown as ReadabilityDoc, { charThreshold: 0 }).parse();
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const data: ReaderResult = {
    url: key,
    title: article?.title ?? document.title ?? "",
    excerpt: article?.excerpt ?? "",
    markdown: article?.content ? turndown.turndown(article.content) : "",
    retrievedAt: new Date().toISOString(),
    contentType,
  };
  readerCache.set(key, { at: Date.now(), data });
  return data;
}

function artifactsDir(taskId: string): string {
  return path.join(dirs.outputs, taskId);
}

export async function readerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reader", async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: "缺少 url 参数" });
    try {
      return await readUrl(url);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "读取失败" });
    }
  });

  app.get("/api/tasks/:id/files/:fileId/content", async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    const file = listFiles(id).find((f) => f.id === fileId);
    if (!file) return reply.code(404).send({ error: "文件不存在" });
    if (file.byteSize > 20 * 1024 * 1024) return reply.code(413).send({ error: "文件过大，请下载后查看" });
    const ext = path.extname(file.fileName).replace(".", "").toLowerCase();
    reply.header("Content-Type", MIME[ext] ?? "application/octet-stream");
    reply.header("X-Preview-Kind", TEXTUAL.has(ext) ? "text" : ext === "pdf" ? "pdf" : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "image" : "binary");
    return reply.send(fs.createReadStream(file.storagePath));
  });

  app.get("/api/tasks/:id/artifacts", async (req) => {
    const { id } = req.params as { id: string };
    const dir = artifactsDir(id);
    if (!fs.existsSync(dir)) return { artifacts: [] };
    const artifacts = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const stat = fs.statSync(path.join(dir, e.name));
        return { name: e.name, byteSize: stat.size, updatedAt: stat.mtime.toISOString() };
      });
    return { artifacts };
  });

  app.get("/api/tasks/:id/artifacts/:name/content", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const safe = path.basename(name);
    const file = path.join(artifactsDir(id), safe);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "产物不存在" });
    const ext = path.extname(safe).replace(".", "").toLowerCase();
    reply.header("Content-Type", MIME[ext] ?? "application/octet-stream");
    reply.header("X-Preview-Kind", TEXTUAL.has(ext) ? "text" : ext === "pdf" ? "pdf" : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "image" : "binary");
    return reply.send(fs.createReadStream(file));
  });

  /** Excel 资料/产物的工作表结构化预览，供侧边阅读器渲染表格。 */
  app.get("/api/tasks/:id/artifacts/:name/sheets", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const safe = path.basename(name);
    const file = path.join(artifactsDir(id), safe);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "产物不存在" });
    if (!/\.(xlsx|xls)$/i.test(safe)) return reply.code(400).send({ error: "仅支持 Excel 文件" });
    try {
      return { sheets: await parseExcelFile(file, 200) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "解析失败" });
    }
  });

  app.get("/api/tasks/:id/files/:fileId/sheets", async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    const file = listFiles(id).find((f) => f.id === fileId);
    if (!file) return reply.code(404).send({ error: "文件不存在" });
    if (!/\.(xlsx|xls)$/i.test(file.fileName)) return reply.code(400).send({ error: "仅支持 Excel 文件" });
    try {
      return { sheets: await parseExcelFile(file.storagePath, 200) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "解析失败" });
    }
  });

  app.get("/api/tasks/:id/reader-meta", async (req) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    return { task: task ?? null, files: listFiles(id) };
  });
}
