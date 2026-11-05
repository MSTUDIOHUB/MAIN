import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

export async function invokeRuntimeToolBridge(workspace: string, cmd: string, args: unknown = {}): Promise<any> {
  const started = Date.now();
  const audit = (result: unknown) => {
    if (!process.env.REAL_OMLX_EVIDENCE_DIR) return;
    // Full Session input is retained by the real SQLite store and the final
    // evidence export. Avoid quadratic copies of the entire growing ledger
    // on every save; retain the exact input hash and CAS owner in this audit.
    const session = (args as any)?.session;
    const auditArgs = cmd === "save_project_session" && session ? {
      workspace: (args as any).workspace, mutationDeadlineMs: (args as any).mutationDeadlineMs,
      session: { id: session.id, storageRevision: session.storageRevision, updatedAtMs: session.updatedAtMs },
      sessionInputSha256: createHash("sha256").update(JSON.stringify(session)).digest("hex"),
    } : args;
    fs.appendFileSync(path.join(process.env.REAL_OMLX_EVIDENCE_DIR, "production-tool-audit.jsonl"), JSON.stringify({
      at: new Date(started).toISOString(), elapsedMs: Date.now() - started, workspace, cmd, args: auditArgs, result,
    }) + "\n");
  };
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve("src-tauri/target/debug/examples/runtime_tool_bridge"), [], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`Production tool bridge exit ${code}: ${stderr.slice(-1000)}`));
      try { const result = JSON.parse(output); audit(cmd === "shell_permission_preflight" || cmd === "run_command" ? result : { ok: result.ok, error: result.error }); if (result.ok) resolve(result.body); else reject(new Error(result.error)); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ workspace, cmd, args, sessionStorePath: process.env.REAL_OMLX_SESSION_STORE_PATH,
      skillAppData: process.env.MAIN_SKILL_APP_DATA || path.join(process.env.HOME || "", "Library/Application Support/com.localagent.ide") }));
  });
}
