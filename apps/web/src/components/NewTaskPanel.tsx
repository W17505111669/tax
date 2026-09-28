import { useState } from "react";
import type { AgentInfo } from "../types.ts";
import { IconFile, IconPlay, IconUpload } from "./Icons.tsx";

interface Props {
  agent: AgentInfo;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { instruction: string; caseId: string; title: string; files: File[] }) => void;
}

const QUICK_EXTRAS = [
  { label: "联网检索缺失资料", snippet: "对缺失资料请联网检索公开业务案例与税务机关公开口径，并列出标题与 URL。" },
  { label: "mermaid 关系图", snippet: "请用 mermaid 图展示关键关系或差异传导。" },
  { label: "表格化比对", snippet: "请用表格比对数据，金额列右对齐并保留两位小数。" },
  { label: "待复核清单", snippet: "请在结尾列出全部待复核与待人工确认事项。" },
];

export function NewTaskPanel({ agent, busy, error, onSubmit }: Props) {
  const [instruction, setInstruction] = useState("");
  const [caseId, setCaseId] = useState("DEMO-001");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [extras, setExtras] = useState<number[]>([]);
  const [dragging, setDragging] = useState(false);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  };

  const submit = () => {
    if (!instruction.trim() || busy) return;
    const extraText = extras.map((i) => QUICK_EXTRAS[i]!.snippet).join("\n");
    const finalInstruction = extraText ? `${instruction.trim()}\n${extraText}` : instruction.trim();
    onSubmit({ instruction: finalInstruction, caseId: caseId.trim() || "DEMO-001", title: title.trim(), files });
  };

  return (
    <section className="px-8 pb-5 pt-6">
      <div className="kicker">New Task</div>
      <h2 className="mt-1 text-[17px] font-semibold text-mist-100">开始新任务</h2>
      <p className="mt-1 text-[12.5px] text-mist-600">
        描述需要完成的涉税专业服务事项，Agent 将自主规划并调用已注册的业务工具执行。
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
            {QUICK_EXTRAS.map((q, i) => {
              const on = extras.includes(i);
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => setExtras((prev) => (on ? prev.filter((x) => x !== i) : [...prev, i]))}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                    on
                      ? "border-glow-500 bg-glow-500/15 text-glow-300"
                      : "border-line bg-night-850 text-mist-500 hover:border-glow-500 hover:text-mist-100"
                  }`}
                >
                  {on ? "✓ " : "+ "}
                  {q.label}
                </button>
              );
            })}
          </div>

      <div className="mt-4">
        <div className="text-[12px] font-medium text-mist-500">推荐问题</div>
            {(agent.recommendedCards?.length ?? 0) > 0 ? (
              <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                {agent.recommendedCards!.map((card, i) => (
                  <button
                    key={card.label}
                    type="button"
                    onClick={() => setInstruction(card.prompt)}
                    className="glow-card px-3 py-2.5 text-left transition-colors hover:border-glow-500"
                  >
                    <div className="flex items-baseline gap-1.5 text-[12.5px] font-medium text-mist-100">
                      <span className="font-mono text-[10.5px] text-glow-400">0{i + 1}</span>
                      {card.label}
                    </div>
                    <div className="mt-1 text-[11px] leading-4 text-mist-600">{card.hint}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-1.5 space-y-1.5">
                {agent.samplePrompts.map((sample, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setInstruction(sample)}
                    className="glow-card block w-full px-3 py-2 text-left text-[12.5px] leading-5 text-mist-500 transition-colors hover:border-glow-500 hover:text-mist-100"
                  >
                    <span className="mr-2 font-mono text-[11px] text-glow-400">示例 {i + 1}</span>
                    {sample.length > 78 ? `${sample.slice(0, 78)}…` : sample}
                  </button>
                ))}
              </div>
            )}
          </div>

      {error && (
        <div className="mt-4 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-300">
          {error}
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`composer sticky bottom-2 z-20 mt-5 px-3.5 pb-2.5 pt-3 ${dragging ? "border-glow-400" : ""}`}
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-night-800 px-2 py-0.5 text-[11px] text-mist-300"
              >
                <IconFile className="h-3 w-3 shrink-0 text-glow-400" />
                <span className="max-w-[180px] truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-mist-600 hover:text-rose-400"
                  aria-label={`移除 ${f.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          id="instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="例如：请核查某项目研发费用归集情况，并测算可加计扣除金额…"
          className="max-h-48 w-full resize-y bg-transparent px-1 text-[13.5px] leading-6 text-mist-100 outline-none placeholder:text-mist-600"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-night-800 px-2.5 py-1 text-[11.5px] text-mist-300 transition-colors hover:border-glow-500">
            <IconUpload className="h-3.5 w-3.5 text-glow-400" />
            资料{files.length > 0 ? ` ${files.length}` : ""}
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <input
            id="caseId"
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            title="案例编号"
            className="w-24 rounded-full border border-line bg-night-800 px-2.5 py-1 text-[11.5px] text-mist-300 outline-none focus:glow-ring"
          />
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="任务名称（自动）"
            className="w-40 rounded-full border border-line bg-night-800 px-2.5 py-1 text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:glow-ring"
          />
          <span className="ml-auto text-[11px] text-mist-600">{busy ? "创建中…" : "Ctrl+Enter 提交 · SSE 实时推送"}</span>
          <button
            type="button"
            className="send-btn"
            onClick={submit}
            disabled={!instruction.trim() || busy}
            title="创建并执行"
          >
            <IconPlay className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}
