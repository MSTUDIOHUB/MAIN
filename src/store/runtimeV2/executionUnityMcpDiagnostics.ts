import { readFileWindow } from "../../lib/ipc";
import { executeMcpTool, readBoundUnityMcpEditorState } from "../../lib/mcpClient";
import { isAllowedBySessionAutoApprove } from "../../lib/runtimeTools";
import type { UnityCompilationResult, UnityEditorCheckKind } from "../../lib/runtime-v2/unityCompilation";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import { normalizeMcpWorkspace } from "../../lib/workspaceMcp";
import { authorizeToolForCurrentTurn } from "./executionAuthorization";
import { authorizationFor, runtimeV2ToolRiskForCall } from "./executionAuthorizationContext";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

const CONSOLE_ARGS = { action: "get", types: ["error"], format: "json", page_size: 100, cursor: 0 };
type ConsoleEntry = { readonly type: string; readonly file: string; readonly line: number; readonly message: string };
type Diagnostic = NonNullable<UnityCompilationResult["diagnostics"]>[number];

function parseMcpData(output: string): Record<string, unknown> {
  const envelope = JSON.parse(output);
  const parsed = envelope?.success === undefined && typeof envelope?.result?.success === "boolean" ? envelope.result : envelope;
  if (parsed?.success !== true || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    throw new Error("MCP_UNITY_CHECK_NOT_ACKNOWLEDGED");
  }
  return parsed.data;
}

function parseCompleteConsole(output: string): ConsoleEntry[] {
  const data = parseMcpData(output);
  if (data?.truncated !== false || !Array.isArray(data.items) ||
      data.items.some((item: ConsoleEntry) => typeof item?.type !== "string" || typeof item.message !== "string" ||
        (item.file != null && typeof item.file !== "string") || !Number.isSafeInteger(item.line))) {
    throw new Error("MCP_UNITY_CONSOLE_WINDOW_INCOMPLETE");
  }
  return data.items.map((item: ConsoleEntry) => ({ ...item, file: item.file ?? "" }));
}

function shaderImportVerdict(imports: unknown, targets: readonly string[]):
  Pick<UnityCompilationResult, "status" | "diagnostics" | "errorCount" | "message"> {
  const unavailable = { status: "unavailable" as const,
    message: "UNITY_SHADER_IMPORT_UNVERIFIED: the bound MCP Editor did not verify the exact Shader files." };
  if (!Array.isArray(imports) || imports.length !== targets.length) return unavailable;
  const diagnostics: Diagnostic[] = [];
  let errorCount = 0;
  let complete = true;
  for (const [index, entry] of imports.entries()) {
    const file = targets[index]!;
    if (entry?.path !== file || typeof entry.completed !== "boolean" || !Array.isArray(entry.diagnostics)) return unavailable;
    complete &&= entry.completed;
    for (const error of entry.diagnostics) {
      if (typeof error?.message !== "string" || !error.message.trim() || !Number.isSafeInteger(error.line)) return unavailable;
      errorCount++;
      if (diagnostics.length < 12) diagnostics.push({ file, line: Math.max(0, error.line), column: 0,
        code: "SHADER_IMPORT", message: error.message.trim().slice(0, 320) });
    }
  }
  return errorCount ? { status: "failed", diagnostics, errorCount }
    : complete ? { status: "passed", diagnostics, errorCount } : unavailable;
}

/** Console contents alone have no acceptance authority. Only new errors
 * attributed to exact checked paths are useful as a compiler failure. */
export function newUnityMcpDiagnostics(input: {
  before: readonly ConsoleEntry[];
  after: readonly ConsoleEntry[];
  workspace: string;
  targets: readonly string[];
  kind: UnityEditorCheckKind;
}): Diagnostic[] {
  const identity = (entry: ConsoleEntry) => JSON.stringify([entry.type, entry.file, entry.line, entry.message]);
  const seen = new Map<string, number>();
  for (const item of input.before) {
    const key = identity(item);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return input.after.flatMap(item => {
    const key = identity(item);
    const previous = seen.get(key) || 0;
    if (previous > 0) {
      seen.set(key, previous - 1);
      return [];
    }
    if (item.type !== "Error") return [];
    const csharp = item.message.match(/^(.+?)\((\d+),(\d+)\): error (CS\d+):\s*([^\n]+)/);
    const shader = item.message.match(/^Shader error in '([^']+)':\s*([^\n]+)/i);
    const path = normalizeValidationWorkspaceCwd(csharp?.[1] || item.file, input.workspace);
    const file = path && input.targets.includes(path) ? path : null;
    if (!file || (input.kind === "csharp" ? !csharp : !shader)) return [];
    return [{
      file, line: Number(csharp?.[2] || shader?.[2]?.match(/\bat line (\d+)\b/)?.[1] || item.line),
      column: Number(csharp?.[3] || 0), code: csharp?.[4] || "SHADER_IMPORT",
      message: (csharp?.[5] || shader?.[2] || "").slice(0, 320),
    }];
  }).slice(0, 12);
}

export async function observeBoundUnityMcpDiagnostics(input: {
  ports: RuntimeV2ExecutionPortsInput;
  signal: AbortSignal;
  deadlineAt: number;
  workspace: string;
  kind: UnityEditorCheckKind;
  targets: readonly string[];
  expectedVersions: Readonly<Record<string, string | null>>;
  importTargets?: readonly string[];
}): Promise<UnityCompilationResult | undefined> {
  const { ports, signal, workspace, kind, targets, expectedVersions } = input;
  const snapshot = ports.context.workspaceMcpSnapshot;
  const imports = input.importTargets ?? targets;
  if (!snapshot?.unityBindings || snapshot.workspace !== normalizeMcpWorkspace(workspace) ||
      !targets.length || targets.length > 12 ||
      targets.some(path => normalizeValidationWorkspaceCwd(path, workspace) !== path) ||
      (kind === "shader_import" && (!imports.length || imports.some(path => !targets.includes(path) || !/\.(shader|compute)$/i.test(path))))) return;
  const auth = authorizationFor(ports);
  const names = kind === "csharp" ? ["read_console", "refresh_unity"] : ["read_console", "refresh_unity", "manage_asset"];
  const bindings = Object.values(snapshot.unityBindings);
  const enabledEntry = (serverUrl: string, name: string) => auth.toolCatalog.entries.find(entry =>
    entry.source === "mcp" && entry.serverUrl === serverUrl && entry.executionName === name &&
    auth.capabilityRegistry.tools[entry.exposedName]?.enabled);
  const shaderVerifier = kind === "shader_import" && targets.every(path => /^sha256-[a-f0-9]{64}$/.test(expectedVersions[path] || ""))
    ? bindings.find(binding => enabledEntry(binding.serverUrl, "execute_code")) : undefined;
  const server = shaderVerifier ?? bindings.find(binding => names.every(name => enabledEntry(binding.serverUrl, name)));
  if (!server) return;
  const ensureCurrent = () => {
    signal.throwIfAborted();
    if (Date.now() >= input.deadlineAt) throw new Error("MCP_UNITY_CHECK_DEADLINE");
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    ensureCurrent();
    const entry = enabledEntry(server.serverUrl, name)!;
    const permission = await authorizeToolForCurrentTurn(ports, entry.exposedName, args);
    const risk = runtimeV2ToolRiskForCall(auth, entry.exposedName, args, { workspace });
    const state = ports.get();
    const autoAllowed = risk && state.autoApproveTools === true &&
      isAllowedBySessionAutoApprove(risk, "mcp", state.autoApproveToolScopes, auth.policy);
    if (!permission.allowed || (name !== "read_console" && !autoAllowed)) {
      throw new Error("MCP_UNITY_CHECK_REQUIRES_APPROVAL");
    }
    ensureCurrent();
    return executeMcpTool(server.serverUrl, name, args, server, ensureCurrent);
  };
  const readTargets = async () => {
    const files = [];
    for (const path of targets) {
      ensureCurrent();
      const file = await readFileWindow(path, workspace, 1, 1, 1, 1);
      const version = file.contentVersion;
      if (!/^sha256-[a-f0-9]{64}$/.test(version) ||
          (Object.prototype.hasOwnProperty.call(expectedVersions, path) && expectedVersions[path] !== version)) {
        throw new Error("MCP_UNITY_CHECK_TARGET_CHANGED");
      }
      files.push({ path, version });
    }
    return files;
  };
  const beforeFiles = await readTargets();
  const dataPath = `${snapshot.workspace.replace(/\/+$/, "")}/Assets`;
  const editorIdentityProbe = [
    "var dataPath = UnityEngine.Application.dataPath.Replace((char)92, '/');",
    "var editorVersion = UnityEngine.Application.unityVersion;",
    `if (dataPath != ${JSON.stringify(dataPath)} || editorVersion != ${JSON.stringify(server.editorVersion)})`,
    "    return new { dataPath, editorVersion };",
  ];
  if (shaderVerifier) {
    // The transport receives only the existing Runtime-owned import program
    // with literal paths from the committed mutation, under the MCP policy.
    const { default: body } = await import("../../../src-tauri/Scripts/unity_shader_import.cs?raw");
    const paths = imports.map(path => JSON.stringify(path)).join(", ");
    const code = [
      ...editorIdentityProbe,
      `var paths = new string[] { ${paths} };`,
      body,
      "return new { dataPath, editorVersion, imports = results };",
    ].join("\n");
    const output = parseMcpData(await call("execute_code", { action: "execute", code, safety_checks: true }));
    const receipt = output.result as { dataPath?: unknown; editorVersion?: unknown; imports?: unknown } | undefined;
    if (receipt?.dataPath !== dataPath || receipt.editorVersion !== server.editorVersion) {
      throw new Error("MCP_UNITY_CHECK_EDITOR_MISMATCH");
    }
    const checkedFiles = await readTargets();
    return { kind, editor: "connected", editorInstanceId: server.instanceId, editorVersion: server.editorVersion, targets: checkedFiles,
      importedPaths: imports, ...shaderImportVerdict(receipt.imports, imports) };
  }
  const before = parseCompleteConsole(await call("read_console", CONSOLE_ARGS));
  if (kind === "shader_import") {
    for (const path of imports) {
      const imported = parseMcpData(await call("manage_asset", { action: "import", path }));
      if (imported?.path !== path) return;
    }
  }
  const refreshStartedAt = Date.now();
  const refresh = parseMcpData(await call("refresh_unity", {
    mode: "force", scope: kind === "csharp" ? "scripts" : "all",
    compile: kind === "csharp" ? "request" : "none", wait_for_ready: kind !== "csharp",
  }));
  if (kind === "csharp" ? refresh.compile_requested !== true && refresh.compile_started !== true : refresh.refresh_triggered !== true) return;
  let completed = kind === "shader_import" && refresh.resulting_state === "idle";
  while (!completed && Date.now() < input.deadlineAt) {
    ensureCurrent();
    const state = await readBoundUnityMcpEditorState(server, ensureCurrent).catch(error => {
      if (error instanceof Error && error.message === "MCP_UNITY_WORKSPACE_UNAVAILABLE") return null;
      throw error;
    }) as {
      success?: boolean;
      data?: {
        compilation?: { is_compiling?: boolean; is_domain_reload_pending?: boolean; last_compile_started_unix_ms?: number; last_compile_finished_unix_ms?: number };
        assets?: { is_updating?: boolean };
      };
    } | null;
    const compilation = state?.data?.compilation;
    const started = compilation?.last_compile_started_unix_ms ?? 0;
    const finished = compilation?.last_compile_finished_unix_ms ?? 0;
    completed = state?.success === true && compilation?.is_compiling === false &&
      state.data?.assets?.is_updating === false && compilation?.is_domain_reload_pending === false &&
      (kind === "shader_import" || started >= refreshStartedAt && finished >= started);
    if (!completed) await new Promise(resolve => setTimeout(resolve, Math.min(800, Math.max(0, input.deadlineAt - Date.now()))));
  }
  if (!completed) return;
  let compilerFailed: boolean | undefined;
  if (kind === "csharp" && enabledEntry(server.serverUrl, "execute_code")) {
    // A fresh completion edge establishes when the actual compiler ran. Its
    // failure flag supplies the verdict; the Console supplies diagnostic text.
    const code = [...editorIdentityProbe,
      "return new { dataPath, editorVersion, idle = !UnityEditor.EditorApplication.isCompiling && !UnityEditor.EditorApplication.isUpdating,",
      "    compilerFailed = UnityEditor.EditorUtility.scriptCompilationFailed };",
    ].join("\n");
    try {
      const output = parseMcpData(await call("execute_code", { action: "execute", code, safety_checks: true }));
      const result = output.result as { dataPath?: unknown; editorVersion?: unknown; idle?: unknown; compilerFailed?: unknown } | undefined;
      if (result?.dataPath !== dataPath || result.editorVersion !== server.editorVersion) throw new Error("MCP_UNITY_CHECK_EDITOR_MISMATCH");
      if (result.idle === true && typeof result.compilerFailed === "boolean") compilerFailed = result.compilerFailed;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MCP_UNITY_CHECK_REQUIRES_APPROVAL") throw error;
    }
  }
  const after = compilerFailed === false ? [] : parseCompleteConsole(await call("read_console", CONSOLE_ARGS));
  const afterFiles = await readTargets();
  if (beforeFiles.some((file, index) => file.version !== afterFiles[index]?.version)) return;
  const diagnostics = newUnityMcpDiagnostics({ before, after, workspace, targets, kind });
  const receipt = { kind, editor: "connected" as const, editorInstanceId: server.instanceId, editorVersion: server.editorVersion,
    targets: afterFiles };
  if (compilerFailed === false) return { ...receipt, status: "passed", errorCount: 0 };
  return diagnostics.length || compilerFailed === true ? { ...receipt, status: "failed", diagnostics, errorCount: Math.max(1, diagnostics.length),
    ...(diagnostics.length ? {} : { message: "The bound Editor compiler reported errors. Inspect the existing diagnostic scope." }) } : {
    ...receipt, status: "unavailable",
    message: `${kind === "csharp" ? "UNITY_COMPILE_VERDICT_UNAVAILABLE" : "UNITY_SHADER_IMPORT_UNVERIFIED"}: the bound Editor refreshed without a conclusive check.`,
  };
}
