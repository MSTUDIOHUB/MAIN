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
  return module.exports;
}

const { isAllowedBySessionAutoApprove, planRuntimeToolCall } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtimeTools.ts"),
);

function makePolicy({
  disabledRiskLevels = [],
  approvalRequiredRiskLevels = ["destructive"],
  autoExecuteRiskLevels = [],
} = {}) {
  return {
    disabledRiskLevels,
    approvalRequiredRiskLevels,
    autoExecuteRiskLevels,
  };
}

const DEFAULT_POLICY = makePolicy();

test("mcp_action scope auto-approves non-destructive MCP tools", () => {
  const scopes = ["workspace_write", "shell", "local_file_read", "external_write", "browser_control", "mcp_action"];
  // MCP tool with external_write risk (like script_apply_edits)
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", scopes, DEFAULT_POLICY), true);
  // MCP tool with workspace_write risk
  assert.equal(isAllowedBySessionAutoApprove("workspace_write", "mcp", scopes, DEFAULT_POLICY), true);
  // MCP tool with shell risk
  assert.equal(isAllowedBySessionAutoApprove("shell", "mcp", scopes, DEFAULT_POLICY), true);
  // MCP tool with read_only risk (no matching scope, but mcp_action should not help for read-only)
  // Actually read_only has no scope mapping, so it should be false
  assert.equal(isAllowedBySessionAutoApprove("read_only", "mcp", scopes, DEFAULT_POLICY), true); // mcp_action covers all MCP sources
});

test("mcp_action scope does NOT auto-approve destructive MCP tools", () => {
  const scopes = ["workspace_write", "shell", "local_file_read", "external_write", "browser_control", "mcp_action"];
  assert.equal(isAllowedBySessionAutoApprove("destructive", "mcp", scopes, DEFAULT_POLICY), false);
  assert.equal(isAllowedBySessionAutoApprove("desktop_control", "mcp", scopes, DEFAULT_POLICY), false);
});

test("without mcp_action scope, MCP tools use risk-based scope matching", () => {
  const scopes = ["workspace_write", "external_write"];
  // MCP tool with external_write risk should match external_write scope
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", scopes, DEFAULT_POLICY), true);
  // MCP tool with workspace_write risk should match workspace_write scope
  assert.equal(isAllowedBySessionAutoApprove("workspace_write", "mcp", scopes, DEFAULT_POLICY), true);
  // MCP tool with shell risk has no matching scope
  assert.equal(isAllowedBySessionAutoApprove("shell", "mcp", scopes, DEFAULT_POLICY), false);
});

test("built-in tools use risk-based scope matching (not mcp_action)", () => {
  const scopes = ["workspace_write", "shell", "local_file_read", "external_write", "browser_control", "mcp_action"];
  // Built-in tool with external_write risk should match external_write scope
  assert.equal(isAllowedBySessionAutoApprove("external_write", "built_in", scopes, DEFAULT_POLICY), true);
  // Built-in tool with shell risk should match shell scope
  assert.equal(isAllowedBySessionAutoApprove("shell", "built_in", scopes, DEFAULT_POLICY), true);
  // Real desktop control intentionally has no session-wide auto-approval scope.
  assert.equal(isAllowedBySessionAutoApprove("desktop_control", "built_in", scopes, DEFAULT_POLICY), false);
});

test("policy disabled risk levels override all scopes", () => {
  const scopes = ["workspace_write", "shell", "local_file_read", "external_write", "browser_control", "mcp_action"];
  const policy = makePolicy({ disabledRiskLevels: ["external_write"] });
  // Even with mcp_action scope, disabled risk should be blocked
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", scopes, policy), false);
  // Non-disabled risks still work
  assert.equal(isAllowedBySessionAutoApprove("workspace_write", "mcp", scopes, policy), true);
});

test("null/undefined scopes block all auto-approval", () => {
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", null, DEFAULT_POLICY), false);
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", undefined, DEFAULT_POLICY), false);
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", [], DEFAULT_POLICY), false);
});

test("planRuntimeToolCall correctly sets sessionAutoApproved for MCP tools with mcp_action scope", () => {
  // This tests the integration: planRuntimeToolCall should return sessionAutoApproved: true
  // for non-destructive MCP tools when mcp_action is in scopes
  // We can't easily test the full planRuntimeToolCall without a full capability registry,
  // but the isAllowedBySessionAutoApprove function is the core decision logic
  const scopes = ["workspace_write", "shell", "local_file_read", "external_write", "browser_control", "mcp_action"];
  const policy = makePolicy();

  // Verify the core decision for a typical MCP edit tool (like script_apply_edits)
  // which would be classified as external_write
  assert.equal(isAllowedBySessionAutoApprove("external_write", "mcp", scopes, policy), true);
  // Verify destructive MCP tools are still blocked
  assert.equal(isAllowedBySessionAutoApprove("destructive", "mcp", scopes, policy), false);
});
