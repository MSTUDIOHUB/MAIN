export interface RecentToolCall {
  name: string;
  argsKey: string;
}

export interface RepeatLoopCheck {
  repeated: boolean;
  threshold: number;
  argsKey: string;
  signature: string;
}

export function buildRepeatLoopArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(args)
      .filter(([_, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function buildRepeatLoopSignature(name: string, argsKey: string): string {
  return `${name}::${argsKey}`;
}

export function registerToolCallForRepeatGuard(
  history: RecentToolCall[],
  name: string,
  args: Record<string, unknown>,
  readOnly: boolean,
): RepeatLoopCheck {
  const threshold = readOnly ? 6 : 3;
  const argsKey = buildRepeatLoopArgsKey(args);

  history.push({ name, argsKey });
  if (history.length > threshold + 2) history.shift();

  if (history.length >= threshold) {
    const lastN = history.slice(-threshold);
    const repeated = lastN.every(
      (call) => call.name === lastN[0].name && call.argsKey === lastN[0].argsKey,
    );
    if (repeated) {
      return {
        repeated: true,
        threshold,
        argsKey,
        signature: buildRepeatLoopSignature(name, argsKey),
      };
    }
  }

  return {
    repeated: false,
    threshold,
    argsKey,
    signature: buildRepeatLoopSignature(name, argsKey),
  };
}

export function formatRepeatLoopRecoveryMessage(
  name: string,
  target: string,
  threshold: number,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  return `Repeat guard: read-only tool "${name}" was called with identical arguments ${threshold}+ times${suffix}. Reuse the latest result already in context and switch to a more specific tool such as get_project_skeleton, glob_search, grep_search, get_file_outline, or read_file.`;
}

export function formatRepeatLoopFatalMessage(
  name: string,
  target: string,
  threshold: number,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  return `Detected a repetition loop: tool "${name}" called with identical arguments ${threshold}+ times${suffix}. This usually means the model lost context. Reuse earlier tool results or increase the context limit and retry.`;
}
