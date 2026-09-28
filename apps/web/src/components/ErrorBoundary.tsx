import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** 演示保险：任何渲染异常都落到可读的深色错误页，而不是白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-night-900 px-8 text-center">
        <div className="kicker">Render Error</div>
        <h1 className="text-[18px] font-semibold text-mist-100">界面渲染出现异常</h1>
        <p className="max-w-md text-[13px] leading-6 text-mist-500">
          任务与数据在服务端完好。请刷新页面重试；若持续出现，请将以下错误信息反馈给开发侧。
        </p>
        <pre className="max-w-lg overflow-auto rounded-md border border-line bg-night-950 px-4 py-3 text-left font-mono text-[11.5px] leading-5 text-rose-300">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="user-bubble px-4 py-2 text-[13px] font-semibold"
        >
          刷新页面
        </button>
      </div>
    );
  }
}
