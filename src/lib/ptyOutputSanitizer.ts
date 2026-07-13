/**
 * Convert raw PTY bytes into stable model-readable text. This intentionally
 * preserves status/warning lines while removing terminal-only control data.
 */
export function sanitizePtyOutput(rawText: string): string {
  if (!rawText) return rawText;

  const withoutControlStrings = rawText
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "");
  const noAnsi = withoutControlStrings
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "");

  const collapsedLines = noAnsi.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r");
    // Clearing a progress/status line often emits "message\r<erase>". Prefer
    // the newest non-empty segment so the model sees what xterm displayed.
    return [...parts].reverse().find((part) => part.trim().length > 0) ?? parts[parts.length - 1] ?? "";
  });

  return collapsedLines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd();
}
