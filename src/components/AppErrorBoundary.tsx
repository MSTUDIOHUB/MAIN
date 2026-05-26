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

function getPersistedUiLanguage(): "zh" | "en" {
  try {
    const raw = window.localStorage.getItem("local-agent-ide");
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.state?.config?.language === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
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
    const language = getPersistedUiLanguage();
    const copy = language === "en"
      ? {
          debug: "Debug",
          title: "MAIN UI ran into an error",
          desc: "Debug logs for this crash were preserved. Copy the log, then reload the UI to continue troubleshooting.",
          unknownError: "Unknown render error",
          reload: "Reload UI",
          copied: "Copied",
          copyLog: "Copy Debug Log",
          noLog: "No log content yet",
        }
      : {
          debug: "调试",
          title: "MAIN 界面遇到了错误",
          desc: "已保留这次崩溃的调试日志。你可以复制日志后重载界面，后续排查会更稳。",
          unknownError: "未知渲染错误",
          reload: "重载界面",
          copied: "已复制",
          copyLog: "复制调试日志",
          noLog: "暂无日志内容",
        };

    return (
      <div
        className="flex h-screen w-full items-center justify-center px-6 transition-colors duration-200"
        style={{
          backgroundColor: "var(--surface-0)",
          color: "var(--surface-text-strong)",
        }}
      >
        <div
          className="w-full max-w-3xl rounded-lg border p-6 shadow-2xl transition-colors duration-200"
          style={{
            borderColor: "var(--surface-border)",
            backgroundColor: "var(--surface-2)",
          }}
        >
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.22em]"
            style={{ color: "var(--surface-text-subtle)" }}
          >
            {copy.debug}
          </div>
          <h1 className="mt-2 text-xl font-semibold" style={{ color: "var(--surface-text-strong)" }}>
            {copy.title}
          </h1>
          <p className="mt-2 text-[13px] leading-6" style={{ color: "var(--surface-text-muted)" }}>
            {copy.desc}
          </p>

          <div
            className="mt-4 rounded-md border p-3 font-mono text-[12px] break-all font-semibold"
            style={{
              borderColor: "rgba(239, 68, 68, 0.4)",
              backgroundColor: "color-mix(in srgb, var(--surface-1) 85%, #fee2e2)",
              color: "#dc2626",
            }}
          >
            {this.state.message || copy.unknownError}
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-md border px-3 py-2 text-[12px] font-semibold transition-all hover:opacity-85 active:scale-[0.98]"
              style={{
                borderColor: "var(--surface-border)",
                backgroundColor: "var(--surface-3)",
                color: "var(--surface-text-strong)",
              }}
            >
              {copy.reload}
            </button>
            <button
              onClick={this.handleCopy}
              className="rounded-md border px-3 py-2 text-[12px] font-semibold transition-all hover:opacity-85 active:scale-[0.98]"
              style={{
                borderColor: "var(--surface-border)",
                backgroundColor: "var(--surface-4)",
                color: "var(--surface-text-strong)",
              }}
            >
              {this.state.copied ? copy.copied : copy.copyLog}
            </button>
          </div>

          <pre
            className="mt-4 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md border p-3 font-mono text-[11px] leading-5 transition-colors duration-200"
            style={{
              borderColor: "var(--surface-border-soft)",
              backgroundColor: "var(--surface-1)",
              color: "var(--surface-text)",
            }}
          >
            {this.state.logText || this.state.stack || copy.noLog}
          </pre>
        </div>
      </div>
    );
  }
}
