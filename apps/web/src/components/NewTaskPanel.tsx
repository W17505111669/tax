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
      <div className="kicker">New Task</div>
      <h2 className="mt-1 text-[17px] font-semibold text-mist-100">开始新任务</h2>
      <p className="mt-1 text-[12.5px] text-mist-600">
        描述需要完成的涉税专业服务事项，Agent 将自主规划并调用已注册的业务工具执行。
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-mist-500" htmlFor="instruction">
            任务指令
          </label>
          <textarea
            id="instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={8}
            placeholder="例如：请核查某项目研发费用归集情况，并测算可加计扣除金额…"
            className="w-full resize-y rounded-lg border border-line bg-night-850 px-3.5 py-3 text-[13.5px] leading-6 text-mist-100 outline-none transition-shadow placeholder:text-mist-600 focus:glow-ring"
          />

          <div className="mt-3">
            <div className="text-[12px] font-medium text-mist-500">示例任务</div>
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
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-mist-500" htmlFor="caseId">
              案例编号
            </label>
            <input
              id="caseId"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="w-full rounded-lg border border-line bg-night-850 px-3 py-2 text-[13px] text-mist-100 outline-none focus:glow-ring"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-mist-500" htmlFor="title">
              任务名称（可选）
            </label>
            <input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="自动生成"
              className="w-full rounded-lg border border-line bg-night-850 px-3 py-2 text-[13px] text-mist-100 outline-none placeholder:text-mist-600 focus:glow-ring"
            />
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-mist-500">业务资料</div>
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
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-3 py-6 text-center transition-colors ${
                dragging ? "border-glow-400 bg-night-700" : "border-line bg-night-850 hover:border-glow-500"
              }`}
            >
              <IconUpload className="h-5 w-5 text-glow-400" />
              <div className="mt-1.5 text-[12.5px] text-mist-300">拖入或点击选择文件</div>
              <div className="mt-0.5 text-[11px] text-mist-600">PDF / Excel / 图片，单文件 ≤ 25MB</div>
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
                  <li
                    key={`${f.name}-${i}`}
                    className="flex items-center justify-between rounded border border-line bg-night-800 px-2 py-1 text-[12px]"
                  >
                    <span className="truncate text-mist-300">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      className="ml-2 shrink-0 text-mist-600 hover:text-rose-400"
                      aria-label={`移除 ${f.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] leading-4 text-mist-600">
              资料解析与底稿填列能力在 Phase 2 起逐步接入，当前上传文件会随任务归档。
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-300">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!instruction.trim() || busy}
          className="user-bubble inline-flex items-center gap-2 px-5 py-2 text-[13px] font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          <IconPlay className="h-3.5 w-3.5" />
          {busy ? "创建中…" : "创建并执行"}
        </button>
        <span className="text-[12px] text-mist-600">执行过程将通过 SSE 实时推送到工作台</span>
      </div>
    </section>
  );
}
