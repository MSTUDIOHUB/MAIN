import { useCallback, useEffect, useState } from "react";
import { openFileExternal } from "./ipc";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error || "").trim();
  return text || "Unknown error";
}

export function useExternalFileOpen({
  path,
  workspace,
  language,
}: {
  path: string;
  workspace?: string;
  language: "zh" | "en";
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpening(false);
    setError(null);
  }, [path, workspace]);

  const clearError = useCallback(() => setError(null), []);

  const openExternalFile = useCallback(async () => {
    if (!path || opening) return null;
    setOpening(true);
    setError(null);
    try {
      const result = await openFileExternal(path, workspace);
      return result;
    } catch (err) {
      const message = getErrorMessage(err);
      if (/^(无法使用系统默认应用打开文件|Could not open the file with the system default app)/i.test(message)) {
        setError(message);
        return null;
      }
      setError(
        language === "zh"
          ? `无法使用系统默认应用打开文件：${message}`
          : `Could not open the file with the system default app: ${message}`,
      );
      return null;
    } finally {
      setOpening(false);
    }
  }, [language, opening, path, workspace]);

  return {
    opening,
    error,
    clearError,
    openExternalFile,
  };
}
