import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateTaskInputSchema } from "@tax/shared-schemas";
import { parseOne } from "@tax/document-tools";
import { allowedExtensions, dirs, maxUploadBytes } from "../config.ts";
import { getAgent } from "../agents.ts";
import { eventBus, isRunning, runTask } from "../services/agent-runner.ts";
import {
  extractIssues,
  listReviews,
  needsReopenReview,
  pendingReviewIssues,
  pendingReviewCount,
  saveReview,
  selectReopenTargets,
} from "../services/issues.ts";
import { listAmountChecks, setAmountCheck } from "../services/amount-checks.ts";
import { collectBundleEntries, createBundleZip } from "../services/bundle-zip.ts";
import { checkLink, listLinkChecks, saveLinkChecks } from "../services/link-checks.ts";
import {
  BATCH_REF_BUDGET,
  listRefChecks,
  pendingCitationTargets,
  pendingRefTargets,
  planBatchRefChecks,
  runRefChecks,
  toTargets,
} from "../services/ref-checks.ts";
import { topicHint } from "../../../web/src/domain-keywords.ts";
import {
  appendEvent,
  createTask,
  getTask,
  insertFile,
  listEvents,
  listFiles,
  listTasks,
  listToolCalls,
  setFileParseStatus,
  setTaskStatus,
} from "../services/task-store.ts";

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks", async (req) => {
    const agentId = (req.query as { agentId?: string }).agentId;
    return { tasks: listTasks(agentId as never) };
  });

  app.post("/api/tasks", async (req, reply) => {
    const parsed = CreateTaskInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "参数错误" });
    const input = parsed.data;
    const agent = getAgent(input.agentId);
    const task = createTask({
      agentId: input.agentId,
      caseId: input.caseId,
      title: input.title?.trim() || `${agent.shortName}任务 ${new Date().toLocaleString("zh-CN")}`,
      instruction: input.instruction,
    });
    fs.mkdirSync(path.join(dirs.uploads, task.id), { recursive: true });
    appendEvent(task.id, "task_created", `任务已创建，智能体：${agent.displayName}`);
    return reply.code(201).send({ task });
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    return { task, files: listFiles(id), toolCalls: listToolCalls(id) };
  });

  app.post("/api/tasks/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { instruction?: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const instruction = body.instruction?.trim() || task.instruction;
    void runTask(id, instruction);
    return reply.code(202).send({ taskId: id, status: "processing" });
  });

  /** 补充资料/补充意见后续跑同一任务（恢复会话历史）。 */
  app.post("/api/tasks/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { instruction?: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (isRunning(id)) return reply.code(409).send({ error: "任务正在执行中" });
    const instruction = body.instruction?.trim();
    if (!instruction) return reply.code(400).send({ error: "续跑需要补充说明 instruction" });
    void runTask(id, instruction, { resume: true });
    return reply.code(202).send({ taskId: id, status: "processing", resume: true });
  });

  /** 下载本任务最新的专业工作底稿（交接文档 6.3 的 export 接口）。 */
  app.get("/api/tasks/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dir = path.join(dirs.outputs, id);
    if (!fs.existsSync(dir)) return reply.code(404).send({ error: "本任务暂无可导出的底稿" });
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => /\.(xlsx|xls)$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    const latest = candidates[0];
    if (!latest) return reply.code(404).send({ error: "本任务暂无 Excel 底稿" });
    const file = path.join(dir, latest.f);
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(latest.f)}"`);
    return reply.send(fs.createReadStream(file));
  });

  app.post("/api/tasks/:id/files", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });

    const parts = req.parts();
    const saved: unknown[] = [];
    for await (const part of parts) {
      if (part.type !== "file") continue;
      const ext = path.extname(part.filename).toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        await part.toBuffer();
        return reply.code(400).send({ error: `不支持的文件类型: ${ext || part.filename}` });
      }
      const buffer = await part.toBuffer();
      if (buffer.byteLength > maxUploadBytes) {
        return reply.code(413).send({ error: `文件超过大小限制 ${Math.round(maxUploadBytes / 1024 / 1024)}MB` });
      }
      const taskDir = path.join(dirs.uploads, id);
      fs.mkdirSync(taskDir, { recursive: true });
      const storagePath = path.join(taskDir, `${randomUUID()}${ext}`);
      fs.writeFileSync(storagePath, buffer);
      const category = (part.fields.businessCategory as { value?: string } | undefined)?.value;
      saved.push(
        insertFile({
          id: randomUUID(),
          taskId: id,
          fileName: part.filename,
          fileType: ext.replace(".", "") || "unknown",
          storagePath,
          byteSize: buffer.byteLength,
          ...(category ? { businessCategory: category } : {}),
        }),
      );
      appendEvent(id, "agent_status", `资料已上传：${part.filename}`);
    }
    return reply.code(201).send({ files: saved });
  });

  app.get("/api/tasks/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    return { files: listFiles(id) };
  });

  app.get("/api/tasks/:id/events", (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });

    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    stream.write(": connected\n\n");

    const send = (data: unknown) => {
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    for (const event of listEvents(id)) send(event);

    const unsubscribe = eventBus.subscribe(id, send);
    const heartbeat = setInterval(() => stream.write(": ping\n\n"), 15000);

    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/tasks/:id/results", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const toolCalls = listToolCalls(id).map((row) => ({
      id: String(row.id),
      toolName: String(row.tool_name),
      args: row.args ? JSON.parse(String(row.args)) : null,
      result: row.result ? JSON.parse(String(row.result)) : null,
      ok: row.ok === 1,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : null,
    }));
    return {
      task,
      toolCalls,
      events: listEvents(id).filter((e) => e.kind !== "agent_text_delta"),
      files: listFiles(id),
    };
  });

  /** 待复核问题清单（从工具结果与比对差异中提取）与人工复核记录。 */
  app.get("/api/tasks/:id/issues", async (req) => {
    const { id } = req.params as { id: string };
    return { issues: extractIssues(id), reviews: listReviews(id), pending: pendingReviewIssues(id).length };
  });

  /** 提交人工复核意见；全部复核完成后任务从 waiting_review 流转为 completed。 */
  app.post("/api/tasks/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { issueId?: string; decision?: string; comment?: string };
    if (!body.issueId || (body.decision !== "confirm" && body.decision !== "dismiss")) {
      return reply.code(400).send({ error: "需要 issueId 与 decision(confirm|dismiss)" });
    }
    const record = saveReview(id, body.issueId, body.decision, body.comment ?? "");
    const task = getTask(id);
    const pending = pendingReviewIssues(id).length;
    if (task && task.status === "waiting_review" && pending === 0) {
      setTaskStatus(id, "completed");
      appendEvent(id, "agent_status", "人工复核完成，任务流转为已完成");
    } else {
      appendEvent(id, "agent_status", `人工复核已提交：${body.decision === "confirm" ? "确认列入底稿" : "判定无需处理"}（剩余待复核 ${pending} 项）`);
    }
    return { review: record, pending };
  });

  /** 已完成但仍挂着待复核问题时，把任务重新流转为 waiting_review（税务师发现遗漏时的补救入口）。 */
  app.post("/api/tasks/:id/reopen-review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(id);
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const pending = pendingReviewIssues(id).length;
    if (!needsReopenReview(task.status, pending)) {
      return reply.code(409).send({
        error: pending === 0 ? "没有待复核问题，无需重新打开复核" : `当前状态（${task.status}）无需重新打开复核`,
      });
    }
    setTaskStatus(id, "waiting_review");
    appendEvent(id, "agent_status", `复核重新打开：${pending} 项问题待税务师复核`);
    return { status: "waiting_review", pending };
  });

  /**
   * 批量重开复核：把「已完成但仍有待复核问题」的任务改回 waiting_review。
   * body.ids 缺省时处理全部符合条件的任务；不符合条件的任务在 skipped 中说明原因。
   */
  app.post("/api/tasks/reopen-review-batch", async (req) => {
    const body = (req.body ?? {}) as { ids?: string[] };
    const wanted = Array.isArray(body.ids) && body.ids.length > 0 ? new Set(body.ids) : null;
    const scoped = listTasks()
      .filter((t) => !wanted || wanted.has(t.id))
      .map((t) => ({ id: t.id, title: t.title, status: t.status as string, pending: pendingReviewCount(t.id) }));
    const targets = new Set(selectReopenTargets(scoped));
    const reopened: Array<{ id: string; title: string; pending: number }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const t of scoped) {
      if (targets.has(t.id)) {
        setTaskStatus(t.id, "waiting_review");
        appendEvent(t.id, "agent_status", `复核重新打开：${t.pending} 项问题待税务师复核（批量处理）`);
        reopened.push({ id: t.id, title: t.title, pending: t.pending });
        continue;
      }
      if (wanted) {
        skipped.push({ id: t.id, reason: t.pending === 0 ? "没有待复核问题" : `当前状态 ${t.status} 无需重开` });
      }
    }
    return { total: reopened.length, reopened, skipped };
  });

  /** 结论金额的人工核对标记清单 */
  app.get("/api/tasks/:id/amount-checks", async (req) => {
    const { id } = req.params as { id: string };
    return { checks: listAmountChecks(id) };
  });

  /** 上传策略：前端预检与服务端校验共用同一份配置，避免两处规则漂移 */
  app.get("/api/upload-policy", async () => ({ allowedExtensions, maxUploadBytes }));

  /**
   * 打包交付：客户端生成的整页交付 MD + 本任务全部产物 → zip。
   * MD 由前端组装（口径与「导出整页」完全一致），服务端只负责合包与产物读取。
   */
  app.post("/api/tasks/:id/bundle", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { markdown?: string; fileName?: string; manifest?: unknown };
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    if (markdown.trim() === "") return reply.code(400).send({ error: "需要 markdown 内容" });
    const entries = await collectBundleEntries(id, markdown);
    // 机器可读清单紧跟在 MD 之后，便于归档系统直接读取
    if (body.manifest && typeof body.manifest === "object") {
      entries.splice(1, 0, { name: "manifest.json", data: JSON.stringify(body.manifest, null, 2) });
    }
    const zip = await createBundleZip(entries);
    const base = (body.fileName ?? "交付包").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 80);
    appendEvent(id, "agent_status", `交付包已打包：${entries.length} 个文件（含整页交付 MD）`, {
      bundlePacked: { files: entries.length, mdChars: markdown.length, hasManifest: Boolean(body.manifest) },
    });
    return reply
      .type("application/zip")
      .header("Content-Disposition", `attachment; filename="bundle.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`)
      .send(Buffer.from(zip));
  });

  /** 标记 / 撤销某处「待人工确认」金额；写入事件留痕，键为「值（分）|原文片段」 */
  app.post("/api/tasks/:id/amount-checks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { key?: string; checked?: boolean; note?: string };
    if (!body.key) return reply.code(400).send({ error: "需要 key（值|原文片段）" });
    const checked = body.checked !== false;
    const check = setAmountCheck(id, body.key, checked, body.note ?? "");
    const label = body.key.split("|")[1] ?? body.key;
    appendEvent(id, "agent_status", checked ? `金额已人工核对：${label}` : `撤销金额核对：${label}`);
    return { check, checks: listAmountChecks(id) };
  });

  /** 已持久化的引用链接核验结果（刷新页面不丢） */
  app.get("/api/tasks/:id/link-checks", async (req) => {
    const { id } = req.params as { id: string };
    const results = listLinkChecks(id);
    const checkedAt = results.reduce((m, r) => (r.checkedAt && r.checkedAt > m ? r.checkedAt : m), "");
    return { results, checkedAt: checkedAt || null };
  });

  /** 触发引用链接核验并落库（最多 30 条；服务端 GET、8 秒超时、不下载正文、拦截内网地址） */
  app.post("/api/tasks/:id/check-links", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { urls?: string[] };
    const urls = Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === "string").slice(0, 30) : [];
    if (urls.length === 0) return reply.code(400).send({ error: "需要 urls（1-30 条）" });
    const results = await Promise.all(urls.map((u) => checkLink(u)));
    const checkedAt = saveLinkChecks(id, results);
    appendEvent(
      id,
      "agent_status",
      `引用链接核验：${results.filter((r) => r.ok).length}/${results.length} 条返回 2xx/3xx`,
    );
    return { checkedAt, total: results.length, ok: results.filter((r) => r.ok).length, results: listLinkChecks(id) };
  });

  /** 已持久化的政策文号复查结果（刷新页面不丢） */
  app.get("/api/tasks/:id/ref-checks", async (req) => {
    const { id } = req.params as { id: string };
    const checks = listRefChecks(id);
    const checkedAt = checks.reduce((m, c) => (c.checkedAt > m ? c.checkedAt : m), "");
    return { checks, checkedAt: checkedAt || null };
  });

  /**
   * 触发政策文号联网复查：用自建检索通道（Bing RSS 优先 + 相关度过滤）复查结论里没有出处的文号，
   * 判定结果与证据链接按条落库，并写入事件留痕（同时让交付包变为待重新打包）。
   */
  app.post("/api/tasks/:id/ref-checks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targets?: unknown };
    // 检索补充词从本任务结论里取领域词：弱证据引用的标题常常只有一两个字，单独检索命不中
    const targets = toTargets(body.targets, topicHint(getTask(id)?.result ?? ""));
    if (targets.length === 0) return reply.code(400).send({ error: "需要 targets（1-10 条，每条含 text）" });
    const fresh = await runRefChecks(id, targets);
    const count = (v: string) => fresh.filter((c) => c.verdict === v).length;
    const allCitations = targets.every((t) => t.kind === "citation");
    const label = allCitations ? "弱证据引用找官方原文" : targets.some((t) => t.kind === "citation") ? "证据复查" : "政策文号复查";
    appendEvent(
      id,
      "agent_status",
      `${label}：${fresh.length} 处 · 找到公开出处 ${count("matched")} · 候选待确认 ${count(
        "candidate",
      )} · 未检索到 ${count("empty")} · 检索失败 ${count("error")}`,
      {
        refChecks: {
          total: fresh.length,
          matched: count("matched"),
          candidate: count("candidate"),
          empty: count("empty"),
          error: count("error"),
          results: fresh.map((c) => ({ key: c.key, text: c.text, verdict: c.verdict, url: c.evidence?.url ?? null })),
        },
      },
    );
    return {
      checks: listRefChecks(id),
      checkedAt: fresh[0]?.checkedAt ?? null,
      ran: fresh.length,
      matched: count("matched"),
    };
  });

  /**
   * 跨任务批量复查：平台看板的证据缺口条一键处理。
   * 待复查清单由服务端按任务重新计算（不信任客户端），总条数受预算限制，逐个任务写入事件留痕。
   */
  app.post("/api/tasks/ref-checks-batch", async (req) => {
    const body = (req.body ?? {}) as { ids?: string[]; budget?: number; kinds?: string[] };
    const wanted = Array.isArray(body.ids) && body.ids.length > 0 ? new Set(body.ids) : null;
    const candidates = listTasks()
      .filter((t) => !wanted || wanted.has(t.id))
      .map((t) => ({ id: t.id, title: t.title }));
    const budget = typeof body.budget === "number" && body.budget > 0 ? body.budget : BATCH_REF_BUDGET;
    const kinds = new Set(
      (Array.isArray(body.kinds) ? body.kinds : ["docref"]).filter(
        (k): k is "docref" | "citation" => k === "docref" || k === "citation",
      ),
    );
    if (kinds.size === 0) kinds.add("docref");
    // 同一预算下文号优先：政策依据比引用替换更影响结论成立与否
    const pendingOf = (id: string) => [
      ...(kinds.has("docref") ? pendingRefTargets(id) : []),
      ...(kinds.has("citation") ? pendingCitationTargets(id) : []),
    ];
    const plan = planBatchRefChecks(candidates, pendingOf, budget);
    const label =
      kinds.has("citation") && kinds.has("docref")
        ? "证据批量复查"
        : kinds.has("citation")
          ? "弱证据引用批量找官方原文"
          : "政策文号批量复查";
    const perTask: Array<{
      id: string;
      title: string;
      ran: number;
      matched: number;
      candidate: number;
      empty: number;
      error: number;
    }> = [];
    let ran = 0;
    let matched = 0;
    for (const item of plan) {
      const fresh = await runRefChecks(item.id, item.targets);
      const count = (v: string) => fresh.filter((c) => c.verdict === v).length;
      ran += fresh.length;
      matched += count("matched");
      appendEvent(
        item.id,
        "agent_status",
        `${label}：${fresh.length} 项 · 找到公开出处 ${count("matched")} 项 · 候选待确认 ${count(
          "candidate",
        )} 项 · 未检索到 ${count("empty")} 项`,
        {
          refChecks: {
            total: fresh.length,
            matched: count("matched"),
            candidate: count("candidate"),
            empty: count("empty"),
            error: count("error"),
            batch: true,
            kinds: [...kinds],
            results: fresh.map((c) => ({ key: c.key, text: c.text, verdict: c.verdict, url: c.evidence?.url ?? null })),
          },
        },
      );
      perTask.push({
        id: item.id,
        title: item.title,
        ran: fresh.length,
        matched: count("matched"),
        candidate: count("candidate"),
        empty: count("empty"),
        error: count("error"),
      });
    }
    return { tasks: perTask.length, ran, matched, budget, kinds: [...kinds], perTask };
  });

  /**
   * 重新解析单份上传资料：状态卡在待解析或解析失败时的补救入口，不必重跑整个任务。
   * 复用智能体工具同一个 parseOne，因此解析口径与运行期完全一致。
   */
  app.post("/api/tasks/:id/files/:fileId/reparse", async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    const file = listFiles(id).find((f) => f.id === fileId);
    if (!file) return reply.code(404).send({ error: "资料不存在" });
    try {
      const doc = await parseOne(file);
      setFileParseStatus(fileId, doc.ok ? "parsed" : "failed");
      appendEvent(
        id,
        "agent_status",
        doc.ok
          ? `资料已重新解析：${file.fileName}${doc.error ? `（提示：${doc.error}）` : ""}`
          : `资料重新解析未成功：${file.fileName}`,
      );
      return { ok: doc.ok, warning: doc.error ?? null, doc };
    } catch (err) {
      setFileParseStatus(fileId, "failed");
      const message = err instanceof Error ? err.message : String(err);
      appendEvent(id, "agent_status", `资料重新解析失败：${file.fileName}（${message}）`);
      return { ok: false, warning: message, doc: null };
    }
  });

  /** 底稿比对记录：从工具调用历史中提取 compare_workpapers 的结构化结果，供前端比对视图使用。 */
  app.get("/api/tasks/:id/compares", async (req) => {
    const { id } = req.params as { id: string };
    const rows = listToolCalls(id).filter(
      (r) => String(r.tool_name) === "compare_workpapers" && r.ok === 1 && r.result,
    );
    const compares = rows.map((r) => ({
      id: String(r.id),
      at: r.ended_at ? String(r.ended_at) : null,
      result: JSON.parse(String(r.result)) as unknown,
    }));
    return { compares };
  });
}
