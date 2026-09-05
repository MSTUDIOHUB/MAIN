import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadAdapter(stubs) {
  const sourcePath = path.join(workspaceRoot, "src/lib/projectInitIpc.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const runtimeRequire = (specifier) => {
    if (specifier in stubs) return stubs[specifier];
    if (specifier === "./projectInit") return {};
    throw new Error(`Unexpected require: ${specifier}`);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  return module.exports;
}

function fixture(overrides = {}) {
  const calls = [];
  const adapter = loadAdapter({
    "./ipc": {
      inspectProjectInitTarget: overrides.inspectProjectInitTarget || (async (workspace) => {
        calls.push(["inspect", workspace]);
        return {
          canonicalWorkspace: "/canonical/repo",
          targetPath: "/canonical/repo/AGENTS.md",
          exists: true,
          content: "human\n",
          contentVersion: "sha256-base",
        };
      }),
      commitProjectInit: overrides.commitProjectInit || (async (input) => {
        calls.push(["commit", input]);
        return {
          created: false,
          unchanged: false,
          contentVersion: "sha256-next",
        };
      }),
    },
    "./projectBaseline": {
      buildProjectBaselineContext: async (input) => {
        calls.push(["baseline", input]);
        calls.push(["baselineRoot", await input.io.listDirectory({
          workspace: input.workspace,
          path: "",
        })]);
        try {
          await input.io.readFile({ workspace: input.workspace, path: "AGENTS.md" });
        } catch (error) {
          calls.push(["baselineAgentsRead", error instanceof Error ? error.message : String(error)]);
        }
        return {
          workspace: {
            canonicalPath: input.workspace,
            identity: "project-workspace-sha256-/canonical/repo",
          },
        };
      },
    },
    "./projectBaselineIpc": {
      projectBaselineIpcIo: {
        canonicalizeWorkspace: async (workspace) => workspace,
        resolveVcsRoot: async () => null,
        getFileByteSize: async ({ path }) => path === "AGENTS.md" ? 5 : 10,
        listDirectory: async () => [
          { name: "AGENTS.md", kind: "file" },
          { name: "src", kind: "directory" },
        ],
        readFile: async ({ path }) => `content:${path}`,
      },
    },
    "./sha256": { sha256Hex: (value) => String(value) },
  });
  return { ...adapter, calls };
}

test("project init IPC adapter binds inspect and commit to exact canonical identities", async () => {
  const { projectInitIpcIo, calls } = fixture();
  const inspected = await projectInitIpcIo.inspect({
    workspace: "/requested/repo",
    targetPath: "AGENTS.md",
  });
  assert.deepEqual(inspected, {
    canonicalWorkspace: "/canonical/repo",
    workspaceIdentity: "project-workspace-sha256-/canonical/repo",
    targetPath: "/canonical/repo/AGENTS.md",
    exists: true,
    content: "human\n",
    baseVersion: "sha256-base",
  });

  const committed = await projectInitIpcIo.commit({
    expectedCanonicalWorkspace: inspected.canonicalWorkspace,
    expectedWorkspaceIdentity: inspected.workspaceIdentity,
    expectedTargetPath: inspected.targetPath,
    expectedBaseVersion: inspected.baseVersion,
    proposedContent: "human\nmanaged\n",
  });
  assert.deepEqual(committed, { status: "committed", version: "sha256-next" });
  assert.deepEqual(calls.find(([kind]) => kind === "commit")[1], {
    workspace: "/canonical/repo",
    expectedTargetPath: "/canonical/repo/AGENTS.md",
    expectedBaseVersion: "sha256-base",
    content: "human\nmanaged\n",
  });
});

test("project init IPC adapter rejects forged workspace identities before mutation", async () => {
  const { projectInitIpcIo, calls } = fixture();
  const result = await projectInitIpcIo.commit({
    expectedCanonicalWorkspace: "/canonical/repo",
    expectedWorkspaceIdentity: "forged",
    expectedTargetPath: "/canonical/repo/AGENTS.md",
    expectedBaseVersion: null,
    proposedContent: "managed\n",
  });
  assert.deepEqual(result, { status: "stale", reason: "workspace_identity" });
  assert.equal(calls.some(([kind]) => kind === "commit"), false);
});

test("project init IPC adapter maps Rust stale errors without retrying", async () => {
  let attempts = 0;
  const { projectInitIpcIo } = fixture({
    commitProjectInit: async () => {
      attempts += 1;
      throw new Error("PROJECT_INIT_CONTENT_STALE: changed");
    },
  });
  const result = await projectInitIpcIo.commit({
    expectedCanonicalWorkspace: "/canonical/repo",
    expectedWorkspaceIdentity: "project-workspace-sha256-/canonical/repo",
    expectedTargetPath: "/canonical/repo/AGENTS.md",
    expectedBaseVersion: "sha256-old",
    proposedContent: "next\n",
  });
  assert.deepEqual(result, { status: "stale", reason: "base_version" });
  assert.equal(attempts, 1);
});

test("project init baseline excludes its managed AGENTS.md target", async () => {
  const { projectInitIpcIo, calls } = fixture();
  await projectInitIpcIo.buildBaseline({
    canonicalWorkspace: "/canonical/repo",
    workspaceIdentity: "project-workspace-sha256-/canonical/repo",
  });

  assert.deepEqual(calls.find(([kind]) => kind === "baselineRoot")?.[1], [
    { name: "src", kind: "directory" },
  ]);
  assert.equal(
    calls.find(([kind]) => kind === "baselineAgentsRead")?.[1],
    "PROJECT_INIT_MANAGED_TARGET_EXCLUDED",
  );
});

test("project init normalizes Windows workspace identity before baseline admission", async () => {
  const { projectInitIpcIo, projectWorkspaceIdentity } = fixture({
    inspectProjectInitTarget: async () => ({
      canonicalWorkspace: "C:\\repo\\app",
      targetPath: "C:\\repo\\app\\AGENTS.md",
      exists: false,
      content: "",
      contentVersion: null,
    }),
  });
  const inspected = await projectInitIpcIo.inspect({
    workspace: "C:\\repo\\app",
    targetPath: "AGENTS.md",
  });

  assert.equal(inspected.canonicalWorkspace, "C:/repo/app");
  assert.equal(
    inspected.workspaceIdentity,
    projectWorkspaceIdentity("C:/repo/app"),
  );
  assert.equal(
    projectWorkspaceIdentity("C:\\repo\\app"),
    projectWorkspaceIdentity("C:/repo/app"),
  );
});
