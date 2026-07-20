import { isFinitePlanValidationCommand } from "./workflowModels";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type ProjectValidationCommandResolutionReason =
  | "invalid_package_manifest_json"
  | "invalid_package_manifest_shape"
  | "unsupported_package_manager"
  | "missing_package_scripts"
  | "no_finite_validation_script";

export interface TrustedProjectValidationCommand {
  command: string;
  packageManager: NodePackageManager;
  scriptName: string;
  manifestPath: "package.json";
}

export type ProjectValidationCommandResolution =
  | {
      ok: true;
      commands: TrustedProjectValidationCommand[];
      reason: null;
    }
  | {
      ok: false;
      commands: [];
      reason: ProjectValidationCommandResolutionReason;
    };

const SCRIPT_PRIORITY = [
  "test:unit",
  "test",
  "typecheck",
  "check",
  "lint",
  "build",
  "test:e2e",
] as const;

const FINITE_TEST_SCRIPT_RE = /^test(?::(?!watch\b|dev\b|serve\b|start\b)[A-Za-z0-9_.-]+)?$/i;
const FINITE_NAMED_SCRIPT_RE = /^(?:typecheck|check|build|lint)$/i;
const DEFAULT_NPM_TEST_PLACEHOLDER_RE = /no test specified/i;
const LONG_RUNNING_SCRIPT_BODY_RE =
  /(?:^|\s)--watch(?:all)?(?:[=\s]|$)|(?:^|\s)--ui(?:[=\s]|$)|(?:^|\s)-w(?:\s|$)|\b(?:tsc|vitest|jest|mocha|ava)\s+watch\b|\b(?:vite|next|nuxt|nuxi|astro|webpack(?:-dev-server)?)\s+(?:dev|start|serve|preview)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|storybook|[A-Za-z0-9_.:-]*watch)\b|\bstorybook(?:\s+dev)?\b|\breact-scripts\s+test\b/i;

function scriptBodyLooksLongRunning(value: string): boolean {
  if (LONG_RUNNING_SCRIPT_BODY_RE.test(value)) return true;
  // `vitest` enters watch mode by default in an interactive workspace. Only
  // its explicit finite forms are suitable for a reviewed run_command task.
  return /\bvitest\b/i.test(value) && !/\bvitest(?:\s+run|[^\n]*\s--run(?:\s|$))/i.test(value);
}

function parsePackageManager(value: unknown): NodePackageManager | null {
  if (value == null || value === "") return "npm";
  const name = String(value).trim().split("@", 1)[0]?.toLowerCase();
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun"
    ? name
    : null;
}

function commandForScript(
  packageManager: NodePackageManager,
  scriptName: string,
): string {
  if (packageManager === "npm" && scriptName === "test") return "npm test";
  return `${packageManager} run ${scriptName}`;
}

function collectCandidateScriptNames(scripts: Record<string, unknown>): string[] {
  const names = Object.keys(scripts).filter((scriptName) =>
    FINITE_TEST_SCRIPT_RE.test(scriptName) || FINITE_NAMED_SCRIPT_RE.test(scriptName)
  );
  const priority = new Map<string, number>(
    SCRIPT_PRIORITY.map((scriptName, index) => [scriptName, index]),
  );
  return names.sort((left, right) => {
    const leftPriority = priority.get(left) ?? 100;
    const rightPriority = priority.get(right) ?? 100;
    return leftPriority - rightPriority || left.localeCompare(right);
  });
}

/**
 * Resolve bounded validation commands exclusively from scripts declared in a
 * workspace package manifest. Source-file extensions and model prose are not
 * evidence that a build/test command exists.
 */
export function resolveTrustedProjectValidationCommands(
  packageManifest: string | Record<string, unknown>,
  options: { maxCommands?: number } = {},
): ProjectValidationCommandResolution {
  let parsed: unknown = packageManifest;
  if (typeof packageManifest === "string") {
    try {
      parsed = JSON.parse(packageManifest);
    } catch {
      return { ok: false, commands: [], reason: "invalid_package_manifest_json" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, commands: [], reason: "invalid_package_manifest_shape" };
  }

  const manifest = parsed as Record<string, unknown>;
  const packageManager = parsePackageManager(manifest.packageManager);
  if (!packageManager) {
    return { ok: false, commands: [], reason: "unsupported_package_manager" };
  }
  if (!manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) {
    return { ok: false, commands: [], reason: "missing_package_scripts" };
  }

  const scripts = manifest.scripts as Record<string, unknown>;
  const requestedMax = Number(options.maxCommands);
  const maxCommands = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.max(1, Math.floor(requestedMax))
    : 1;
  const commands: TrustedProjectValidationCommand[] = [];
  for (const scriptName of collectCandidateScriptNames(scripts)) {
    const scriptBody = scripts[scriptName];
    if (typeof scriptBody !== "string" || !scriptBody.trim()) continue;
    if (scriptName === "test" && DEFAULT_NPM_TEST_PLACEHOLDER_RE.test(scriptBody)) continue;
    if (scriptBodyLooksLongRunning(scriptBody)) continue;
    const command = commandForScript(packageManager, scriptName);
    if (!isFinitePlanValidationCommand(command)) continue;
    commands.push({
      command,
      packageManager,
      scriptName,
      manifestPath: "package.json",
    });
    if (commands.length >= maxCommands) break;
  }

  return commands.length > 0
    ? { ok: true, commands, reason: null }
    : { ok: false, commands: [], reason: "no_finite_validation_script" };
}
