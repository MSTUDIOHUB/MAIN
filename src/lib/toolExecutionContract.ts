export const SHELL_EXECUTION_TOOLS = new Set(["run_command", "execute_command"]);

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRelativeCwd(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

export function getShellToolCwd(args: Record<string, unknown>): string | null {
  const raw = asNonEmptyString(args.cwd) ?? asNonEmptyString(args.workdir);
  return raw ? normalizeRelativeCwd(raw) : null;
}

export function validateShellToolCwd(cwd: string | null): string | null {
  if (!cwd) {
    return "Shell tool calls must include `cwd` (or `workdir`). Use `.` for the workspace root.";
  }

  if (cwd.startsWith("/") || /^[A-Za-z]:\//.test(cwd)) {
    return "Shell tool `cwd` must be workspace-relative. Use `.` for the workspace root or a relative subdirectory.";
  }

  const parts = cwd.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    return "Shell tool `cwd` must stay inside the workspace and cannot contain `..` segments.";
  }

  return null;
}

export function validateShellToolContract(name: string, args: Record<string, unknown>): string | null {
  if (!SHELL_EXECUTION_TOOLS.has(name)) return null;

  if (!asNonEmptyString(args.description)) {
    return `Tool '${name}' is missing required execution metadata: description. Provide a concise user-facing reason for the command.`;
  }

  const cwdError = validateShellToolCwd(getShellToolCwd(args));
  if (cwdError) {
    const toolSpecificHint = name === "execute_command"
      ? " If this is a finite one-shot command, prefer `run_command`; otherwise add `cwd` (use `.` for the workspace root)."
      : " Add `cwd` (use `.` for the workspace root).";
    return `Tool '${name}' is missing required execution metadata: cwd. ${cwdError}${toolSpecificHint}`;
  }

  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function applyShellCwd(command: string, args: Record<string, unknown>): string {
  const cwd = getShellToolCwd(args);
  const cwdError = validateShellToolCwd(cwd);
  if (cwdError) throw new Error(cwdError);
  if (!cwd || cwd === "." || cwd === "./") return command;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-[^\n;&|]*r[^\n;&|]*f\b/i,
  /\brm\s+-[^\n;&|]*f[^\n;&|]*r\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\n;&|]*[df][^\n;&|]*[df]?\b/i,
  /\bgit\s+checkout\s+(?:--|\.)\b/i,
  /\bgit\s+restore\b.*(?:\s--staged\b|\s\.\s*$|\s\*\s*$)/i,
  /\bdd\s+if=/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bchmod\s+-R\s+777\b/i,
  />\s*\/dev\/(?:sd|disk|nvme|rdisk)/i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
];

export function looksDangerousShellCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim();
  if (!normalized) return false;
  return DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(normalized));
}
