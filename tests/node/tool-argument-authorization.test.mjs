import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  resolveToolArgumentAuthorization,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolArgumentAuthorization.ts"),
);
const {
  releaseSubagentScopeLease,
  reserveSubagentScope,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/subagents.ts"));

function planTask(evidence) {
  return {
    id: "task-1",
    text: "Approved work",
    status: "in_progress",
    evidence,
  };
}

function childScope(allowedPaths) {
  return {
    subagentId: "child-1",
    parentSessionKey: "session-1",
    scopeKey: "authorized-files",
    workspace: "/workspace",
    allowedPaths,
    allowedFilePaths: allowedPaths,
    allowedDirectoryPaths: [],
    scopeKind: "exact_files",
    blockedToolNames: [],
  };
}

test("PreToolUse cannot rewrite an approved Plan write from file A to file B", () => {
  const tasks = [planTask([{ kind: "file", value: "src/a.ts" }])];
  const before = resolveToolArgumentAuthorization({
    executionName: "replace_in_file",
    args: { path: "src/a.ts", search_text: "old", replace_text: "new" },
    target: "src/a.ts",
    isPlanApproved: true,
    planTasks: tasks,
  });
  const after = resolveToolArgumentAuthorization({
    executionName: "replace_in_file",
    args: { path: "src/b.ts", search_text: "old", replace_text: "new" },
    target: "src/b.ts",
    isPlanApproved: true,
    planTasks: tasks,
  });

  assert.equal(before.allowed, true);
  assert.equal(after.allowed, false);
  assert.equal(after.blockReason, "approved_plan_mutation_scope");
  assert.deepEqual(after.approvedPlanMutationScope.unexpectedTargets, ["src/b.ts"]);
});

test("PreToolUse cannot replace an exactly approved Plan command", () => {
  const tasks = [planTask([{ kind: "cmd", value: "npm test" }])];
  const before = resolveToolArgumentAuthorization({
    executionName: "run_command",
    args: { command: "npm test" },
    isPlanApproved: true,
    planTasks: tasks,
  });
  const after = resolveToolArgumentAuthorization({
    executionName: "run_command",
    args: { command: "npm run build" },
    isPlanApproved: true,
    planTasks: tasks,
  });

  assert.equal(before.allowed, true);
  assert.equal(after.allowed, false);
  assert.equal(after.blockReason, "approved_plan_command_scope");
  assert.equal(after.approvedPlanCommandScope.requestedCommand, "npm run build");
});

test("canonical manage_script uses execution identity for approved mutation scope", () => {
  const tasks = [planTask([{ kind: "file", value: "Assets/Scripts/Foo.cs" }])];
  const canonicalAllowed = resolveToolArgumentAuthorization({
    executionName: "manage_script",
    args: { action: "create", path: "Assets/Scripts", name: "Foo" },
    target: "Assets/Scripts/Foo.cs",
    isPlanApproved: true,
    planTasks: tasks,
  });
  const canonicalBlocked = resolveToolArgumentAuthorization({
    executionName: "manage_script",
    args: { action: "create", path: "Assets/Unplanned", name: "Other" },
    target: "Assets/Unplanned/Other.cs",
    isPlanApproved: true,
    planTasks: tasks,
  });

  assert.equal(canonicalAllowed.allowed, true);
  assert.equal(canonicalBlocked.allowed, false);
  assert.equal(canonicalBlocked.blockReason, "approved_plan_mutation_scope");
  assert.deepEqual(
    canonicalBlocked.approvedPlanMutationScope.unexpectedTargets,
    ["assets/unplanned/other.cs"],
  );
});

test("PreToolUse cannot rewrite a child read beyond allowedPaths or workspace", () => {
  const scope = childScope(["src/a.ts"]);
  const before = resolveToolArgumentAuthorization({
    executionName: "read_file",
    args: { path: "src/a.ts" },
    target: "src/a.ts",
    isPlanApproved: false,
    planTasks: [],
    subagentScope: scope,
  });
  const sibling = resolveToolArgumentAuthorization({
    executionName: "read_file",
    args: { path: "src/b.ts" },
    target: "src/b.ts",
    isPlanApproved: false,
    planTasks: [],
    subagentScope: scope,
  });
  const external = resolveToolArgumentAuthorization({
    executionName: "read_file",
    args: { path: "/tmp/outside.ts" },
    target: "/tmp/outside.ts",
    isPlanApproved: false,
    planTasks: [],
    subagentScope: scope,
  });

  assert.equal(before.allowed, true);
  assert.equal(sibling.allowed, false);
  assert.equal(sibling.blockReason, "subagent_path_scope");
  assert.deepEqual(sibling.blockedSubagentTargets, ["src/b.ts"]);
  assert.equal(external.allowed, false);
  assert.equal(external.blockReason, "subagent_path_scope");
});

test("unchanged in-scope arguments retain their original authorization", () => {
  const decision = resolveToolArgumentAuthorization({
    executionName: "replace_in_file",
    args: { path: "src/a.ts", search_text: "old", replace_text: "new" },
    target: "src/a.ts",
    isPlanApproved: true,
    planTasks: [planTask([{ kind: "file", value: "src/a.ts" }])],
    subagentScope: childScope(["src/a.ts"]),
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.blockReason, null);
  assert.deepEqual(decision.blockedSubagentTargets, []);
});

test("PreToolUse cannot rewrite a parent path into an active child lease", () => {
  reserveSubagentScope({
    threadId: "session-parent",
    parentTurnId: "turn-parent",
    subagentId: "child-active",
    scopeKey: "child-owned-file",
    workspace: "/workspace",
    allowedPaths: ["src/child.ts"],
    createdAt: Date.now(),
  });
  try {
    const before = resolveToolArgumentAuthorization({
      executionName: "read_file",
      args: { path: "src/parent.ts" },
      target: "src/parent.ts",
      isPlanApproved: false,
      planTasks: [],
      threadId: "session-parent",
    });
    const after = resolveToolArgumentAuthorization({
      executionName: "read_file",
      args: { path: "src/child.ts" },
      target: "src/child.ts",
      isPlanApproved: false,
      planTasks: [],
      threadId: "session-parent",
    });

    assert.equal(before.allowed, true);
    assert.equal(after.allowed, false);
    assert.equal(after.blockReason, "parent_subagent_scope_overlap");
    assert.equal(after.parentScopeConflictTarget, "src/child.ts");
    assert.equal(after.parentScopeConflict?.subagentId, "child-active");
  } finally {
    releaseSubagentScopeLease("child-active");
  }
});

test("shell calls cannot bypass active child leases through final command arguments", () => {
  reserveSubagentScope({
    threadId: "session-shell-parent",
    parentTurnId: "turn-shell-parent",
    subagentId: "child-shell-active",
    scopeKey: "child-shell-owned-file",
    workspace: "/workspace",
    allowedPaths: ["src/child.ts"],
    createdAt: Date.now(),
  });
  try {
    const targetedWrite = resolveToolArgumentAuthorization({
      executionName: "run_command",
      args: { command: "touch src/child.ts" },
      isPlanApproved: false,
      planTasks: [],
      threadId: "session-shell-parent",
    });
    const opaqueCommand = resolveToolArgumentAuthorization({
      executionName: "run_command",
      args: { command: "npm test" },
      isPlanApproved: false,
      planTasks: [],
      threadId: "session-shell-parent",
    });
    const scopedChildShell = resolveToolArgumentAuthorization({
      executionName: "run_command",
      args: { command: "npm test" },
      isPlanApproved: false,
      planTasks: [],
      subagentScope: childScope(["src/child.ts"]),
    });

    assert.equal(targetedWrite.allowed, false);
    assert.equal(targetedWrite.blockReason, "parent_subagent_scope_overlap");
    assert.equal(targetedWrite.parentScopeConflictTarget, "src/child.ts");
    assert.equal(opaqueCommand.allowed, false);
    assert.equal(opaqueCommand.blockReason, "parent_subagent_scope_overlap");
    assert.deepEqual(opaqueCommand.scopeTargets, ["."]);
    assert.equal(scopedChildShell.allowed, false);
    assert.equal(scopedChildShell.blockReason, "subagent_path_scope");
  } finally {
    releaseSubagentScopeLease("child-shell-active");
  }
});

test("runtime applies final-argument scope authorization before final risk review", () => {
  const orchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator.ts"),
    "utf8",
  );
  const lifecycle = orchestratorSource.slice(
    orchestratorSource.indexOf("async function executeToolCallWithLifecycle"),
    orchestratorSource.indexOf("export async function autoMaterializePlanArtifactFromVisibleText"),
  );
  const partitionSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"),
    "utf8",
  );

  assert.match(lifecycle, /if \(hookArgumentsChanged\) \{[\s\S]*resolveToolArgumentAuthorization\(\{/);
  assert.ok(
    lifecycle.indexOf("resolveToolArgumentAuthorization({") <
      lifecycle.indexOf("callbacks.requestReview({"),
    "hard Plan/child scope must be checked before a final risk review can be requested",
  );
  assert.match(lifecycle, /resolveToolArgumentAuthorization\(\{[\s\S]*executionName,[\s\S]*args: resolvedArgs/);
  assert.match(lifecycle, /getShellMutationTargetForLoopGuard\(executionName, resolvedArgs\)/);
  assert.match(lifecycle, /pre_tool_hook_shell_source_mutation_blocked/);
  assert.match(partitionSource, /resolveApprovedPlanCommandScope\(\{[\s\S]*toolName: executionName/);
  assert.match(partitionSource, /resolveApprovedPlanMutationScope\(\{[\s\S]*toolName: executionName/);
  assert.match(partitionSource, /resolveToolArgumentAuthorizationTargets\(\{[\s\S]*executionName,[\s\S]*args: toolArgs/);
});
