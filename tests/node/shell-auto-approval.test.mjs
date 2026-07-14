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
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const shellAutoApproval = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/shellAutoApproval.ts"));

const {
  buildShellPermissionApproval,
  getShellPermissionCommandForTool,
  resolveShellAutoApproval,
  suggestedShellPermissionRules,
} = shellAutoApproval;

function createDecision(patch = {}) {
  return {
    command: "git clone https://github.com/example/repo.git .",
    decision: "ask",
    source: "builtin_default",
    sourcePath: null,
    segmentDecisions: [
      {
        command: "git clone https://github.com/example/repo.git .",
        decision: "ask",
        matchedRule: null,
        suggestedRule: "git",
        riskLevel: "medium",
        reviewReason: "Shell segment is not in the low-risk allow list",
      },
    ],
    allowedBy: null,
    matchedRule: null,
    suggestedRule: "git",
    suggestedRules: ["git"],
    riskLevel: "medium",
    reviewReason: "Shell segment is not in the low-risk allow list",
    requiresApproval: true,
    ...patch,
  };
}

test("shell auto approval resolves command text for shell tools", () => {
  assert.equal(
    getShellPermissionCommandForTool("run_command", {
      command: "git clone https://github.com/example/repo.git .",
      cwd: ".",
    }),
    "git clone https://github.com/example/repo.git .",
  );

  assert.equal(
    getShellPermissionCommandForTool("execute_command", {
      command: "npm run dev",
      cwd: "tools/dev server",
    }),
    "cd 'tools/dev server' && npm run dev",
  );

  assert.equal(
    getShellPermissionCommandForTool("send_pty_input", {
      input: "godot --headless --export-release macOS",
      append_newline: true,
    }),
    "godot --headless --export-release macOS",
  );

  assert.equal(
    getShellPermissionCommandForTool("send_pty_input", {
      input: "y",
      append_newline: false,
    }),
    null,
  );

  assert.equal(
    getShellPermissionCommandForTool("send_pty_input", {
      control: "interrupt",
    }),
    null,
  );

  assert.equal(
    getShellPermissionCommandForTool("send_pty_input", {
      input: "\\u0003",
      append_newline: true,
    }),
    null,
  );
});

test("shell auto approval builds approval for ask decisions", async () => {
  const decision = createDecision();
  const resolution = await resolveShellAutoApproval({
    toolName: "run_command",
    args: {
      command: "git clone https://github.com/example/repo.git .",
      cwd: ".",
    },
    workspace: "/tmp/project",
    preflight: async (command, workspace) => {
      assert.equal(command, "git clone https://github.com/example/repo.git .");
      assert.equal(workspace, "/tmp/project");
      return decision;
    },
  });

  assert.equal(resolution.command, decision.command);
  assert.equal(resolution.decision, decision);
  assert.equal(resolution.approval.command, decision.command);
  assert.equal(resolution.approval.scope, "session");
  assert.deepEqual(resolution.approval.rules, ["git"]);
});

test("shell auto approval leaves allow and deny decisions to the permission guard", async () => {
  const allowResolution = await resolveShellAutoApproval({
    toolName: "run_command",
    args: {
      command: "git status --short",
      cwd: ".",
    },
    workspace: "/tmp/project",
    preflight: async () => createDecision({
      command: "git status --short",
      decision: "allow",
      requiresApproval: false,
      suggestedRule: null,
      suggestedRules: [],
      segmentDecisions: [],
    }),
  });
  assert.equal(allowResolution.approval, undefined);
  assert.equal(allowResolution.decision.decision, "allow");

  const denyResolution = await resolveShellAutoApproval({
    toolName: "execute_command",
    args: {
      command: "rm -rf build",
      cwd: ".",
    },
    workspace: "/tmp/project",
    preflight: async () => createDecision({
      command: "rm -rf build",
      decision: "deny",
      requiresApproval: false,
      matchedRule: "rm -rf",
      segmentDecisions: [
        {
          command: "rm -rf build",
          decision: "deny",
          matchedRule: "rm -rf",
          suggestedRule: null,
          riskLevel: "critical",
          reviewReason: "Destructive command is denied",
        },
      ],
      suggestedRule: null,
      suggestedRules: [],
      riskLevel: "critical",
    }),
  });
  assert.equal(denyResolution.approval, undefined);
  assert.equal(denyResolution.decision.decision, "deny");
});

test("shell approval rules are deduped across decision and segments", () => {
  const decision = createDecision({
    suggestedRules: ["git", "git"],
    segmentDecisions: [
      {
        command: "git clone https://github.com/example/repo.git .",
        decision: "ask",
        suggestedRule: "git",
      },
      {
        command: "npm install",
        decision: "ask",
        suggestedRule: "npm install",
      },
    ],
  });

  assert.deepEqual(suggestedShellPermissionRules(decision), ["git", "npm install"]);
  assert.deepEqual(buildShellPermissionApproval(decision, "once").rules, ["git", "npm install"]);
});

test("game studio shell commands use the same auto approval path", async () => {
  const resolution = await resolveShellAutoApproval({
    toolName: "execute_command",
    args: {
      command: "godot --headless --export-release macOS",
      cwd: ".",
      description: "Export the Godot build from Game Studio workflow.",
    },
    workspace: "/tmp/game-project",
    preflight: async (command) => createDecision({
      command,
      suggestedRule: "godot",
      suggestedRules: ["godot"],
      segmentDecisions: [
        {
          command,
          decision: "ask",
          suggestedRule: "godot",
          riskLevel: "medium",
          reviewReason: "Shell segment is not in the low-risk allow list",
        },
      ],
    }),
  });

  assert.equal(resolution.command, "godot --headless --export-release macOS");
  assert.equal(resolution.approval.command, "godot --headless --export-release macOS");
  assert.deepEqual(resolution.approval.rules, ["godot"]);
});
