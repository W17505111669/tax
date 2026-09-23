import { useRef, useState } from "react";
import type { AgentInfo } from "../types.ts";
import { IconPlay, IconUpload } from "./Icons.tsx";

interface Props {
  agent: AgentInfo;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { instruction: string; caseId: string; title: string; files: File[] }) => void;
}

export function NewTaskPanel({ agent, busy, error, onSubmit }: Props) {
  const [instruction, setInstruction] = useState("");
  const [caseId, setCaseId] = useState("DEMO-001");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  };

  const submit = () => {
    if (!instruction.trim() || busy) return;
    onSubmit({ instruction: instruction.trim(), caseId: caseId.trim() || "DEMO-001", title: title.trim(), files });
  };

  return (
    <section className="px-8 py-6">
      <h2 className="text-[15px] font-semibold text-ink-900">开始新任务</h2>
      <p className="mt-1 text-[12.5px] text-ink-500">
        描述需要完成的涉税专业服务事项，Agent 将自主规划并调用已注册的业务工具执行。
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-ink-600" htmlFor="instruction">
            任务指令
          </label>
          <textarea
            id="instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={8}
            placeholder="例如：请核查某项目研发费用归集情况，并测算可加计扣除金额…"
            className="w-full resize-y rounded-md border border-ink-200 bg-white px-3 py-2.5 text-[13.5px] leading-6 text-ink-900 outline-none transition-colors placeholder:text-ink-400 focus:border-ink-400"
          />

          <div className="mt-3">
            <div className="text-[12px] font-medium text-ink-600">示例任务</div>
            <div className="mt-1.5 space-y-1.5">
              {agent.samplePrompts.map((sample, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setInstruction(sample)}
                  className="block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-left text-[12.5px] leading-5 text-ink-600 transition-colors hover:border-ink-300 hover:bg-ink-50"
                >
                  <span className="mr-2 font-mono text-[11px] text-ink-400">示例 {i + 1}</span>
                  {sample.length > 78 ? `${sample.slice(0, 78)}…` : sample}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-600" htmlFor="caseId">
              案例编号
            </label>
            <input
              id="caseId"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none focus:border-ink-400"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-600" htmlFor="title">
              任务名称（可选）
            </label>
            <input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="自动生成"
              className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400"
            />
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-600">业务资料</div>
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
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-3 py-6 text-center transition-colors ${
                dragging ? "border-ink-500 bg-ink-100" : "border-ink-300 bg-white hover:border-ink-400"
              }`}
            >
              <IconUpload className="h-5 w-5 text-ink-400" />
              <div className="mt-1.5 text-[12.5px] text-ink-600">拖入或点击选择文件</div>
              <div className="mt-0.5 text-[11px] text-ink-400">PDF / Excel / 图片，单文件 ≤ 25MB</div>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded border border-ink-100 bg-ink-50 px-2 py-1 text-[12px]">
                    <span className="truncate text-ink-700">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      className="ml-2 shrink-0 text-ink-400 hover:text-rose-500"
                      aria-label={`移除 ${f.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] leading-4 text-ink-400">
              资料解析与底稿填列能力在 Phase 2 起逐步接入，当前上传文件会随任务归档。
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!instruction.trim() || busy}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: agent.accent }}
        >
          <IconPlay className="h-3.5 w-3.5" />
          {busy ? "创建中…" : "创建并执行"}
        </button>
        <span className="text-[12px] text-ink-400">执行过程将通过 SSE 实时推送到工作台</span>
      </div>
    </section>
  );
}
