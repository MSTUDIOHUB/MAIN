import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { appendDebugLog, installDebugLogCapture } from "./lib/debugLog";
import { markHarnessInstanceClosed, markHarnessInstanceStarted } from "./lib/harnessCrashTelemetry";

installDebugLogCapture();
markHarnessInstanceStarted();
appendDebugLog("info", "app.startup", { phase: "before_react_render" });

window.addEventListener("pagehide", () => markHarnessInstanceClosed("pagehide"));
window.addEventListener("beforeunload", () => markHarnessInstanceClosed("beforeunload"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  appendDebugLog("info", "app.startup", { phase: "after_first_react_frame" });
});
