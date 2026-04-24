import { readFile, runHookCommand, type HookCommandOutput } from "./ipc";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse";

export type HookDecision = "allow" | "deny" | "block";

export interface HookDefinition {
  id: string;
  event: HookEvent;
  command: string;
  enabled: boolean;
  timeoutMs?: number;
  description?: string;
}

export interface HooksConfig {
  path: string | null;
  hooks: Record<HookEvent, HookDefinition[]>;
  loadedAt: number;
}

export interface HookExecutionRecord {
  id: string;
  event: HookEvent;
  hookId: string;
  command: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  status: "success" | "error" | "blocked" | "denied" | "timeout";
  stdout: string;
  stderr: string;
  exitCode: number;
  additionalContext?: string;
  reason?: string;
}

export interface HookRunResult {
  blocked: boolean;
  blockedReason?: string;
  additionalContexts: string[];
  updatedToolArgs?: Record<string, unknown>;
  records: HookExecutionRecord[];
}

type ParsedHookOutput = {
  decision?: HookDecision;
  block?: boolean;
  reason?: string;
  additionalContext?: string | string[];
  updatedToolArgs?: Record<string, unknown>;
};

const EMPTY_HOOKS: Record<HookEvent, HookDefinition[]> = {
  SessionStart: [],
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
};

function normalizeHookEvent(input: string): HookEvent | null {
  if (
    input === "SessionStart" ||
    input === "UserPromptSubmit" ||
    input === "PreToolUse" ||
    input === "PostToolUse"
  ) {
    return input;
  }
  return null;
}

function parseHookOutput(raw: HookCommandOutput): ParsedHookOutput | null {
  const stdout = raw.stdout.trim();
  if (!stdout) return null;

  const candidates = [stdout, stdout.split(/\r?\n/).slice(-1)[0] ?? ""];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      return JSON.parse(trimmed) as ParsedHookOutput;
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeAdditionalContext(
  parsed: ParsedHookOutput | null,
  raw: HookCommandOutput,
): string[] {
  if (parsed?.additionalContext) {
    return Array.isArray(parsed.additionalContext)
      ? parsed.additionalContext.map(value => String(value).trim()).filter(Boolean)
      : [String(parsed.additionalContext).trim()].filter(Boolean);
  }

  if (raw.exitCode === 0 && raw.stdout.trim() && !parsed) {
    return [raw.stdout.trim()];
  }

  return [];
}

function normalizeHookDefinition(
  event: HookEvent,
  raw: unknown,
  index: number,
): HookDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const command = String(candidate.command ?? "").trim();
  if (!command) return null;

  const id = String(candidate.id ?? `${event.toLowerCase()}-${index + 1}`).trim();
  return {
    id,
    event,
    command,
    enabled: candidate.enabled !== false,
    ...(typeof candidate.timeoutMs === "number"
      ? { timeoutMs: candidate.timeoutMs }
      : {}),
    ...(typeof candidate.description === "string" && candidate.description.trim()
      ? { description: candidate.description.trim() }
      : {}),
  };
}

export async function loadHooksConfig(workspace: string): Promise<HooksConfig> {
  if (!workspace.trim()) {
    return { path: null, hooks: EMPTY_HOOKS, loadedAt: Date.now() };
  }

  try {
    const raw = await readFile(".MAIN/hooks.json");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const hooksNode =
      parsed && typeof parsed.hooks === "object" && parsed.hooks !== null
        ? (parsed.hooks as Record<string, unknown>)
        : {};

    const hooks: Record<HookEvent, HookDefinition[]> = {
      SessionStart: [],
      UserPromptSubmit: [],
      PreToolUse: [],
      PostToolUse: [],
    };

    for (const [eventName, eventValue] of Object.entries(hooksNode)) {
      const event = normalizeHookEvent(eventName);
      if (!event || !Array.isArray(eventValue)) continue;
      hooks[event] = eventValue
        .map((value, index) => normalizeHookDefinition(event, value, index))
        .filter((value): value is HookDefinition => Boolean(value));
    }

    return {
      path: ".MAIN/hooks.json",
      hooks,
      loadedAt: Date.now(),
    };
  } catch {
    return {
      path: null,
      hooks: EMPTY_HOOKS,
      loadedAt: Date.now(),
    };
  }
}

export async function runHookEvent(
  config: HooksConfig,
  event: HookEvent,
  payload: Record<string, unknown>,
): Promise<HookRunResult> {
  const hooks = config.hooks[event].filter(hook => hook.enabled);
  if (hooks.length === 0) {
    return { blocked: false, additionalContexts: [], records: [] };
  }

  const records: HookExecutionRecord[] = [];
  const additionalContexts: string[] = [];
  let currentArgs =
    event === "PreToolUse" && payload.toolArgs && typeof payload.toolArgs === "object"
      ? { ...(payload.toolArgs as Record<string, unknown>) }
      : undefined;

  for (const hook of hooks) {
    const startedAt = Date.now();
    const raw = await runHookCommand(
      hook.command,
      JSON.stringify({
        ...payload,
        ...(currentArgs ? { toolArgs: currentArgs } : {}),
      }),
      hook.timeoutMs,
    ).catch(
      (error): HookCommandOutput => ({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        timedOut: false,
      }),
    );
    const finishedAt = Date.now();
    const parsed = parseHookOutput(raw);
    const contexts = normalizeAdditionalContext(parsed, raw);
    additionalContexts.push(...contexts);

    let status: HookExecutionRecord["status"] = "success";
    let reason = parsed?.reason?.trim() || raw.stderr.trim() || undefined;

    if (raw.timedOut) {
      status = "timeout";
    } else if (parsed?.decision === "block" || parsed?.block) {
      status = "blocked";
    } else if (parsed?.decision === "deny") {
      status = "denied";
    } else if (raw.exitCode !== 0) {
      status = "error";
    }

    const record: HookExecutionRecord = {
      id: `${event}:${hook.id}:${startedAt}`,
      event,
      hookId: hook.id,
      command: hook.command,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      status,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      ...(contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : {}),
      ...(reason ? { reason } : {}),
    };
    records.push(record);

    if (event === "PreToolUse" && parsed?.updatedToolArgs && typeof parsed.updatedToolArgs === "object") {
      currentArgs = {
        ...(currentArgs ?? {}),
        ...parsed.updatedToolArgs,
      };
    }

    if (status === "blocked" || status === "denied") {
      return {
        blocked: true,
        blockedReason: reason || `${hook.id} blocked ${event}`,
        additionalContexts,
        ...(currentArgs ? { updatedToolArgs: currentArgs } : {}),
        records,
      };
    }
  }

  return {
    blocked: false,
    additionalContexts,
    ...(currentArgs ? { updatedToolArgs: currentArgs } : {}),
    records,
  };
}
