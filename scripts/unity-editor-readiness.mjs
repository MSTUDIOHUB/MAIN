import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function unityEditorStatusArgs(project) {
  return ["command", "editor", "status", "--project-path", project, "--caller", "plugin", "--skill", "unity-cli", "--format", "json", "--result-only", "--no-pager"];
}
export function unityEditorReady(result, project) {
  const body = result?.data?.result ?? result?.result ?? result?.data ?? result;
  return body?.status === "ready" && body.compiling === false && body.domainReloadInProgress === false &&
    typeof body.projectPath === "string" && path.resolve(body.projectPath) === path.resolve(project);
}
export async function waitForUnityEditor(cli, project, log, timeout = 180_000) {
  const started = Date.now(), probes = [];
  const args = unityEditorStatusArgs(project);
  while (Date.now() - started < timeout) {
    const probe = await new Promise(resolve => {
      const child = spawn(cli, args, { cwd: project, env: { ...process.env, UNITY_NON_INTERACTIVE: "1", UNITY_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), Math.min(10_000, timeout - (Date.now() - started)));
      child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
      child.on("error", error => { clearTimeout(timer); resolve({ code: null, error: String(error), stdout, stderr }); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    let result = null;
    try { result = JSON.parse(probe.stdout); } catch { /* Keep exact startup failure below. */ }
    probes.push({ at: new Date().toISOString(), ...probe, result });
    await fs.writeFile(log, JSON.stringify({ args, probes }, null, 2));
    if (probe.code === 0 && unityEditorReady(result, project)) return { code: 0, ready: true, elapsedMs: Date.now() - started, probes: probes.length, args };
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return { code: null, ready: false, reason: "editor_readiness_timeout", elapsedMs: Date.now() - started, probes: probes.length, args };
}
