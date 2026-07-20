// lib/goalVerification.ts
// Automatic verification engine for Goal Mode.
// After each iteration, determines what verification to run
// and checks whether the goal's definition of done is satisfied.
// ────────────────────────────────────────────────────────────────────

import type { GoalDefinition } from "./goalState";
import { resolveTrustedProjectValidationCommands } from "./projectValidationCommands";

export type VerificationStrategyKind =
  | "test_command"    // npm test, cargo test, pytest, etc.
  | "build_check"     // npm run build, cargo build, etc.
  | "lint_check"      // npm run lint, eslint, etc.
  | "type_check"      // tsc --noEmit, mypy, etc.
  | "custom_script"   // User-defined command
  | "llm_judgment";   // LLM evaluates whether the goal is met

export interface VerificationStrategy {
  kind: VerificationStrategyKind;
  /** Shell command to run (not used for llm_judgment) */
  command?: string;
  /** Human-readable label */
  label: string;
  /** Expected success pattern in stdout/stderr (regex) */
  successPattern?: string;
  /** Expected failure pattern */
  failurePattern?: string;
  /** Timeout in ms (default: 120s) */
  timeoutMs?: number;
}

export interface VerificationResult {
  /** Whether all verification strategies passed */
  passed: boolean;
  /** Per-strategy results */
  strategyResults: VerificationStrategyResult[];
  /** LLM judgment of whether the overall goal is met */
  goalMet: boolean | null;
  /** Human-readable summary */
  summary: string;
  /** Timestamp */
  timestamp: number;
}

export interface VerificationStrategyResult {
  strategy: VerificationStrategy;
  passed: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

// ── Default timeout ──────────────────────────────────────────────

const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000; // 2 minutes

// ── Strategy inference from project files ────────────────────────

export interface ProjectContext {
  /** Contents of package.json (parsed) */
  packageJson?: Record<string, unknown> | null;
  /** Whether Cargo.toml exists */
  hasCargoToml?: boolean;
  /** Whether pyproject.toml or setup.py exists */
  hasPythonProject?: boolean;
  /** Whether go.mod exists */
  hasGoMod?: boolean;
  /** Workspace root path */
  workspacePath: string;
}

export function inferVerificationStrategies(input: {
  project: ProjectContext;
  goal: GoalDefinition;
}): VerificationStrategy[] {
  const strategies: VerificationStrategy[] = [];
  const { project } = input;

  // ── Node.js / JavaScript / TypeScript ──
  if (project.packageJson) {
    const resolved = resolveTrustedProjectValidationCommands(project.packageJson, {
      maxCommands: 10,
    });
    const commands = resolved.ok ? resolved.commands : [];

    // Type check
    const typeCheck = commands.find((entry) => entry.scriptName === "typecheck") ||
      commands.find((entry) => entry.scriptName === "lint");
    if (typeCheck) {
      const cmd = typeCheck.command;
      strategies.push({
        kind: "type_check",
        command: cmd,
        label: `TypeScript type check (${cmd})`,
        failurePattern: "error TS|Error:|\\d+ error",
        timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
      });
    }

    // Test
    const testCommand = commands.find((entry) => entry.scriptName.startsWith("test"));
    if (testCommand) {
      const cmd = testCommand.command;
      strategies.push({
        kind: "test_command",
        command: cmd,
        label: `Test suite (${cmd})`,
        successPattern: "passed|✓|PASS",
        failurePattern: "failed|✕|FAIL|Error",
        timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS * 2,
      });
    }

    // Build
    const build = commands.find((entry) => entry.scriptName === "build");
    if (build) {
      strategies.push({
        kind: "build_check",
        command: build.command,
        label: `Build check (${build.command})`,
        failurePattern: "error|Error|FAIL|BUILD FAILED",
        timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS * 2,
      });
    }
  }

  // ── Rust ──
  if (project.hasCargoToml) {
    strategies.push({
      kind: "build_check",
      command: "cargo check",
      label: "Cargo check",
      failurePattern: "error\\[E",
      timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS * 2,
    });
    strategies.push({
      kind: "test_command",
      command: "cargo test",
      label: "Cargo test",
      successPattern: "test result: ok",
      failurePattern: "FAILED|panicked",
      timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS * 3,
    });
  }

  // ── Python ──
  if (project.hasPythonProject) {
    strategies.push({
      kind: "test_command",
      command: "python -m pytest",
      label: "Pytest",
      successPattern: "passed",
      failurePattern: "FAILED|ERROR",
      timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS * 2,
    });
  }

  // ── Go ──
  if (project.hasGoMod) {
    strategies.push({
      kind: "build_check",
      command: "go build ./...",
      label: "Go build",
      failurePattern: "cannot|undefined|Error",
      timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    });
    strategies.push({
      kind: "test_command",
      command: "go test ./...",
      label: "Go test",
      successPattern: "PASS",
      failurePattern: "FAIL",
      timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS * 2,
    });
  }

  // Always add LLM judgment as the final strategy
  strategies.push({
    kind: "llm_judgment",
    label: "LLM goal completion judgment",
  });

  return strategies;
}

// ── Verification result analysis ─────────────────────────────────

export function analyzeVerificationOutput(input: {
  output: string;
  strategy: VerificationStrategy;
}): { passed: boolean; evidence: string } {
  const { output, strategy } = input;
  const truncated = output.length > 2000 ? output.slice(-2000) : output;

  // Check failure pattern first (takes priority)
  if (strategy.failurePattern) {
    const failRe = new RegExp(strategy.failurePattern, "im");
    if (failRe.test(truncated)) {
      const match = truncated.match(failRe);
      return {
        passed: false,
        evidence: `Failure pattern matched: "${match?.[0] ?? strategy.failurePattern}"`,
      };
    }
  }

  // Check success pattern
  if (strategy.successPattern) {
    const successRe = new RegExp(strategy.successPattern, "im");
    if (successRe.test(truncated)) {
      return {
        passed: true,
        evidence: `Success pattern matched`,
      };
    }
    // If success pattern was expected but not found, treat as failure
    return {
      passed: false,
      evidence: `Expected success pattern "${strategy.successPattern}" not found in output`,
    };
  }

  // No patterns defined — assume passed if no error indicators
  const hasGenericError = /error|fail|panic|exception|abort/i.test(truncated);
  return {
    passed: !hasGenericError,
    evidence: hasGenericError ? "Generic error pattern detected in output" : "No error indicators found",
  };
}

// ── Build verification summary ───────────────────────────────────

export function buildVerificationSummary(input: {
  result: VerificationResult;
  language: "zh" | "en";
}): string {
  const { result, language } = input;
  const isZh = language === "zh";
  const lines: string[] = [];

  const overallLabel = result.passed
    ? (isZh ? "✅ 验证通过" : "✅ Verification passed")
    : (isZh ? "❌ 验证失败" : "❌ Verification failed");

  lines.push(overallLabel);

  for (const sr of result.strategyResults) {
    if (sr.strategy.kind === "llm_judgment") continue;
    const icon = sr.passed ? "✅" : "❌";
    const duration = `${Math.round(sr.durationMs / 1000)}s`;
    lines.push(`  ${icon} ${sr.strategy.label} (${duration})`);
    if (!sr.passed && sr.error) {
      lines.push(`     ${sr.error.slice(0, 200)}`);
    }
  }

  if (result.goalMet !== null) {
    const goalLabel = result.goalMet
      ? (isZh ? "🎯 LLM 判断目标已达成" : "🎯 LLM judges goal is met")
      : (isZh ? "🔄 LLM 判断目标尚未达成" : "🔄 LLM judges goal is not yet met");
    lines.push(goalLabel);
  }

  return lines.join("\n");
}

// ── Build verification command for the orchestrator ──────────────

export function buildVerificationCommandList(strategies: VerificationStrategy[]): string[] {
  return strategies
    .filter((s) => s.kind !== "llm_judgment" && s.command)
    .map((s) => s.command!);
}
