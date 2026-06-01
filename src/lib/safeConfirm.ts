import { appendDebugLog } from "./debugLog";

interface SafeConfirmOptions {
  source: string;
  action: string;
  commandName?: string;
}

function extractAclCommandName(errorMessage: string): string | null {
  const aclMatch = errorMessage.match(/Command\s+([^\s]+)\s+not allowed by ACL/i);
  if (aclMatch && aclMatch[1]) return aclMatch[1];
  const pluginMatch = errorMessage.match(/plugin:[\w.-]+\|[\w.-]+/i);
  return pluginMatch?.[0] ?? null;
}

export function safeConfirm(message: string, options: SafeConfirmOptions): boolean {
  try {
    if (typeof window === "undefined" || typeof window.confirm !== "function") {
      appendDebugLog("warn", "ui.confirm", {
        source: options.source,
        action: options.action,
        commandName: options.commandName || "window.confirm",
        error: "window.confirm_unavailable",
      });
      return false;
    }
    const result = window.confirm(message) as boolean | Promise<boolean>;
    if (result && typeof (result as any).then === "function") {
      void Promise.resolve(result).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error || "");
        appendDebugLog("warn", "ui.confirm", {
          source: options.source,
          action: options.action,
          commandName: options.commandName || extractAclCommandName(errorMessage) || "window.confirm",
          error: errorMessage || "confirm_failed",
        });
      });
      appendDebugLog("warn", "ui.confirm", {
        source: options.source,
        action: options.action,
        commandName: options.commandName || "window.confirm",
        error: "confirm_returned_promise",
      });
      return false;
    }
    return result === true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || "");
    appendDebugLog("warn", "ui.confirm", {
      source: options.source,
      action: options.action,
      commandName: options.commandName || extractAclCommandName(errorMessage) || "window.confirm",
      error: errorMessage || "confirm_failed",
    });
    return false;
  }
}
