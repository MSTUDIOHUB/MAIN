import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const loopRoot = path.join(workspaceRoot, "src/lib/orchestrator/loop");

test("legacy approved-plan recovery state and no-tool modules stay deleted", () => {
  assert.equal(
    fsSync.existsSync(path.join(loopRoot, "approvedPlanRecoveryRuntime.ts")),
    false,
  );
  assert.equal(
    fsSync.existsSync(path.join(loopRoot, "approvedPlanNoToolRecovery.ts")),
    false,
  );

  const loopSource = fsSync.readdirSync(loopRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fsSync.readFileSync(path.join(loopRoot, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    loopSource,
    /ApprovedPlanRecoveryRuntimeState|approvedPlanRecoveryState|approvedPlanNoProgressRecoveryAttempts/,
  );
  assert.doesNotMatch(
    loopSource,
    /handleApprovedPlanNoToolRecovery|continueApprovedPlanWithStrategySwitch|pauseApprovedPlanNoProgressLoop/,
  );
});

test("approved-plan stream watchdog remains independent of deleted recovery state", () => {
  const actionsSource = fsSync.readFileSync(
    path.join(loopRoot, "approvedPlanRecoveryActions.ts"),
    "utf8",
  );
  const controlSource = fsSync.readFileSync(
    path.join(loopRoot, "loopControlRuntime.ts"),
    "utf8",
  );

  assert.match(actionsSource, /export function pauseApprovedPlanStreamWatchdog/);
  assert.match(actionsSource, /approved_plan_stream_watchdog_paused/);
  assert.match(controlSource, /pauseApprovedPlanStreamWatchdogAction\(\{/);
});
