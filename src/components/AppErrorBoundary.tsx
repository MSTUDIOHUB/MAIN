import React from "react";
import {
  appendDebugLog,
  copyDebugLogToClipboard,
  getLocalDebugLogText,
  readDebugLogSnapshot,
} from "../lib/debugLog";

interface AppErrorBoundaryState {
  hasError: boolean;
  message: string;
  stack: string;
  logText: string;
  copied: boolean;
}

export default class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: "",
    stack: "",
    logText: "",
    copied: false,
  };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      hasError: true,
      message: err.message,
      stack: err.stack || "",
      logText: getLocalDebugLogText(),
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    const err = error instanceof Error ? error : new Error(String(error));
    appendDebugLog("error", "react.error-boundary", {
      message: err.message,
      stack: err.stack,
      componentStack: errorInfo.componentStack,
    });

    void readDebugLogSnapshot().then((snapshot) => {
      this.setState({
        logText: [
          snapshot.content,
          snapshot.truncated ? "\n[Log truncated: showing tail only]" : "",
        ].join(""),
      });
    });
  }

  private handleCopy = async () => {
    const text = [
      "MAIN UI crash",
      this.state.message,
      this.state.stack,
      "",
      this.state.logText,
    ].filter(Boolean).join("\n");
    await copyDebugLogToClipboard(text);
    this.setState({ copied: true });
    window.setTimeout(() => this.setState({ copied: false }), 1600);
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#050505] px-6 text-[#e4e4e7]">
        <div className="w-full max-w-3xl rounded-lg border border-[#27272a] bg-[#09090b] p-6 shadow-2xl">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#71717a]">
            Debug
          </div>
          <h1 className="mt-2 text-xl font-semibold text-white">MAIN 界面遇到了错误</h1>
          <p className="mt-2 text-[13px] leading-6 text-[#a1a1aa]">
            已保留这次崩溃的调试日志。你可以复制日志后重载界面，后续排查会更稳。
          </p>

          <div className="mt-4 rounded-md border border-[#3f3f46] bg-[#000000] p-3 font-mono text-[12px] text-[#fca5a5]">
            {this.state.message || "Unknown render error"}
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-semibold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]"
            >
              重载界面
            </button>
            <button
              onClick={this.handleCopy}
              className="rounded-md border border-[#3f3f46] bg-[#27272a] px-3 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#3f3f46]"
            >
              {this.state.copied ? "已复制" : "复制调试日志"}
            </button>
          </div>

          <pre className="mt-4 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md border border-[#18181b] bg-[#000000] p-3 font-mono text-[11px] leading-5 text-[#a1a1aa]">
            {this.state.logText || this.state.stack || "暂无日志内容"}
          </pre>
        </div>
      </div>
    );
  }
}
