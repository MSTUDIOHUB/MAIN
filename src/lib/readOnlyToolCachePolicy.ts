// These tools observe external state that changes while the agent is running.
// Identical arguments do not imply identical results, so the normal read-only
// result cache must never suppress a fresh call.
const VOLATILE_READ_ONLY_TOOL_NAMES = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "read_console",
]);

export function isVolatileReadOnlyToolName(name: string): boolean {
  return VOLATILE_READ_ONLY_TOOL_NAMES.has(String(name || ""));
}

export function shouldCacheReadOnlyToolResult(name: string): boolean {
  return !isVolatileReadOnlyToolName(name);
}
