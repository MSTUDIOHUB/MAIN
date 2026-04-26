import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { appendDebugLog, installDebugLogCapture } from "./lib/debugLog";

installDebugLogCapture();
appendDebugLog("info", "app.startup", { phase: "before_react_render" });

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
