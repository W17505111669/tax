import { useState } from "react";
import type { AgentInfo } from "../types.ts";
import { IconAlert } from "./Icons.tsx";

/**
 * 简介主界面（根路由）：大模型对话式极简入口——品牌行 + 渐变标语 + 单一 composer。
 * 发送不直接建任务：指令写入 NewTaskPanel 的草稿存储（taxai-draft-instruction），
 * 跳到对应作品并打开新建任务面板，上传预检与案例编号仍走原流程，不绕过任何校验。
 */
interface Props {
  agents: AgentInfo[];
  backendDown: boolean;
  onSend: (agentId: string, instruction: string) => void;
  onOpenHome: () => void;
}

const QUICK: Array<{ label: string; text: string }> = [
  {
    label: "加计扣除核查",
    text: "请核查某项目研发费用归集情况，并测算可加计扣除金额，用表格比对数据，金额列右对齐并保留两位小数。",
  },
  {
    label: "合同发票核验",
    text: "请解析工程合同与发票，关联账面记录，核验金额一致性，识别异常并请求人工确认。",
  },
  {
    label: "缺失资料检索",
    text: "对缺失资料请联网检索公开业务案例与税务机关公开口径，并列出标题与 URL，弱证据标注清楚。",
  },
];

export function IntroView({ agents, backendDown, onSend, onOpenHome }: Props) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? "");
  const [text, setText] = useState("");
  // 挂载时 agents 可能还在加载：选中值取「用户选择 || 首个作品」的派生值，避免空初值卡死
  const active = agentId || agents[0]?.id || "";
  const send = () => {
    const t = text.trim();
    if (!t || backendDown || !active) return;
    onSend(active, t);
  };
  return (
    <div className="h6-intro">
      <div className="h6-intro-main">
        <div className="h6-intro-brand">
          <span className="h6-logo h6-logo-lg">税</span>
          <b>税务智能审查平台</b>
          <span className="h6-badge acc">双智能体协同</span>
        </div>
        <h1 className="h6-intro-h1">
          让每一条税收结论
          <em className="h6-emp">都能追溯到出处</em>
        </h1>
        <p className="h6-intro-lede">
          描述审查需求、选择作品后发送；政策核验有快照、联网引用有原文、人工复核有处置记录。
        </p>
        <div className="h6-composer">
          <textarea
            className="h6-composer-ta"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send();
            }}
            placeholder="描述你想要构建的审查内容，例如：核查本项目研发费用归集情况，并测算可加计扣除金额…"
          />
          <div className="h6-composer-bar">
            <div className="h6-seg">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="h6-seg-tab"
                  data-on={a.id === active}
                  onClick={() => setAgentId(a.id)}
                >
                  {a.shortName}
                </button>
              ))}
            </div>
            <span className="h6-anno">{text.length} 字 · Ctrl+Enter 发送</span>
            <button
              type="button"
              className="h6-send"
              onClick={send}
              disabled={!text.trim() || backendDown}
              title="发送并新建任务"
            >
              ↑
            </button>
          </div>
        </div>
        <div className="h6-quick">
          {QUICK.map((q) => (
            <button key={q.label} type="button" className="h6-chipbtn" onClick={() => setText(q.text)}>
              {q.label}
            </button>
          ))}
        </div>
        {backendDown ? (
          <p className="h6-anno">
            <IconAlert className="h6-warn-i" />
            后端未连接，发送已禁用
          </p>
        ) : null}
        <button type="button" className="h6-intro-link" onClick={onOpenHome}>
          查看平台运行效果 →
        </button>
      </div>
    </div>
  );
}
