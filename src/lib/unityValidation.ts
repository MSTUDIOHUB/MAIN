export type UnityValidationInvocation =
  | { readonly kind: "batch" }
  | { readonly kind: "live_playmode"; readonly filter: string; readonly timeoutSeconds: number }
  | { readonly kind: "recompile"; readonly timeoutSeconds: number };

export function unityCommandArguments(command: string): string[] | null {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [program, ...args] = tokens.map(token => token.replace(/^["']|["']$/g, ""));
  const executable = program?.split(/[/\\]/).pop()?.toLowerCase();
  return ["unity", "unity.exe", "tuanjie", "tuanjie.exe"].includes(executable || "") ? args : null;
}

/** An explicitly reviewed, engine-neutral PlayMode route with no shell
 * composition or additional process arguments. */
export function projectEditorPlayModeFilter(command: string): string | null {
  return /^unity[ \t]+test[ \t]+\.[ \t]+--mode[ \t]+(?:PlayMode|playmode)[ \t]+--filter[ \t]+([A-Za-z_][A-Za-z0-9_.]{0,199})$/.exec(command.trim())?.[1] ?? null;
}

export function isUnmanagedUnityVerification(command: string): boolean {
  const args = unityCommandArguments(command);
  const prefix = args?.slice(0, 3).join(" ").toLowerCase();
  return args?.[0]?.toLowerCase() === "recompile" ||
    prefix === "command test run" || prefix === "command script recompile";
}

function scopedFlags(args: string[], valued: readonly string[], switches: readonly string[]): Map<string, string> | null {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (flags.has(name)) return null;
    if (switches.includes(name)) {
      flags.set(name, "");
    } else if (valued.includes(name)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) return null;
      flags.set(name, value);
    } else return null;
  }
  return flags;
}

/** Runtime has a structured verdict contract only for these CLI invocations.
 * Other Editor commands remain ordinary actions, with no validation authority. */
export function unityValidationInvocation(command: string): UnityValidationInvocation | null {
  const args = unityCommandArguments(command);
  if (!args || args.some(arg => /^(?:--?help|-h|--version)(?:=|$)/i.test(arg))) return null;
  const commandName = args[0]?.toLowerCase();
  if (commandName === "test") {
    return args.some(arg => /^--(?:allow-install|shard|rerun-failed)(?:=|$)|^--?quit(?:=|$)/i.test(arg))
      ? null : { kind: "batch" };
  }
  const live = args.slice(0, 3).join(" ") === "command test run";
  if (live || commandName === "recompile") {
    const flags = scopedFlags(args.slice(live ? 3 : 1),
      ["--project-path", "--format", "--timeout", ...(live ? ["--caller", "--skill", "--mode", "--filter"] : [])],
      ["--non-interactive", "--no-pager", ...(live ? ["--async-tests"] : ["--strict"])]);
    const timeout = flags?.get("--timeout") || "";
    const timeoutSeconds = Number(timeout);
    if (flags?.get("--project-path") !== "." || flags.get("--format") !== "json" ||
      !flags.has("--non-interactive") || !/^[1-9]\d*$/.test(timeout) || timeoutSeconds > 90) return null;
    if (!live) return { kind: "recompile", timeoutSeconds };
    const filter = flags.get("--filter");
    if (!flags.has("--async-tests") || flags.get("--caller") !== "plugin" || flags.get("--skill") !== "unity-cli" ||
      flags.get("--mode")?.toLowerCase() !== "playmode" || !filter) return null;
    return { kind: "live_playmode", filter, timeoutSeconds };
  }
  const lowered = args.map(arg => arg.toLowerCase());
  const projectPath = lowered.indexOf("-projectpath");
  // Unity's -quit can exit before asynchronous tests finish.
  return lowered.includes("-batchmode") && lowered.includes("-runtests") &&
    projectPath !== -1 && !!args[projectPath + 1] && !args[projectPath + 1]!.startsWith("-") &&
    !lowered.includes("-quit") && !lowered.includes("-executemethod") ? { kind: "batch" } : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

export function verifiedUnityValidationResult(
  invocations: readonly UnityValidationInvocation[],
  output: unknown,
  expectedTestCases?: number,
): boolean {
  const result = record(output);
  if (!result || result.timedOut === true || result.exitCode !== 0 || result.success === false) return false;
  const first = invocations[0];
  if (first?.kind === "batch") {
    const reports = Array.isArray(result.unityTestReports) ? result.unityTestReports : [];
    return reports.length === invocations.length && reports.every(report =>
      report?.status === "verified" && Number.isSafeInteger(report?.passed) && report.passed > 0) &&
      (expectedTestCases === undefined || reports.length === 1 && reports[0].passed === expectedTestCases);
  }
  if (!first || invocations.length !== 1 || result.stdoutTruncated === true) return false;
  const envelope = jsonRecord(result.stdout);
  const data = record(envelope?.data);
  if (!envelope || envelope.success === false) return false;
  const verdict = record(data?.result) ?? data ?? envelope;
  if (first.kind === "recompile") {
    return envelope.success === true && verdict.failed === false &&
      ["completed", "up_to_date"].includes(String(verdict.status || ""));
  }
  const summary = record(verdict.summary ?? verdict.Summary);
  const total = summary?.total ?? summary?.Total;
  const outcomes = verdict.results ?? verdict.Results;
  return (verdict.success ?? verdict.Success) === true &&
    String(verdict.mode ?? verdict.Mode).toLowerCase() === "playmode" &&
    String(verdict.filterApplied ?? verdict.FilterApplied).replace(/^testname: /i, "") === first.filter &&
    typeof total === "number" && Number.isSafeInteger(total) && total > 0 &&
    (expectedTestCases === undefined || total === expectedTestCases) &&
    (summary?.passed ?? summary?.Passed) === total && (summary?.failed ?? summary?.Failed) === 0 &&
    (summary?.skipped ?? summary?.Skipped) === 0 && (summary?.inconclusive ?? summary?.Inconclusive) === 0 &&
    Array.isArray(outcomes) && outcomes.length === total && outcomes.every(outcome => {
      const test = record(outcome);
      const name = test?.fullName ?? test?.FullName;
      return (test?.status ?? test?.Status) === "Passed" && typeof name === "string" &&
        name.toLowerCase().includes(first.filter.toLowerCase());
    });
}

export function verifiedProjectEditorPlayModeResult(filter: string, output: unknown, expectedTestCases: number | undefined): boolean {
  if (!expectedTestCases || expectedTestCases < 1) return false;
  return verifiedUnityValidationResult([{ kind: "batch" }], output, expectedTestCases) ||
    verifiedUnityValidationResult([{ kind: "live_playmode", filter, timeoutSeconds: 90 }], output, expectedTestCases);
}
