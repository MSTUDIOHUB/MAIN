import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourcePath = path.resolve("src/lib/geminiExtensions.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", transpiled)(module.exports, module);
const {
  inspectGeminiExtensionArchive,
  createGeminiExtensionInstall,
  extensionSkillProjection,
  normalizeGeminiExtensionInstallations,
  isAnonymousGeminiHttpUrl,
} = module.exports;

function archive(manifest, root = "repo-main/") {
  return {
    manifest_json: JSON.stringify({ name: "example", version: "1.0", ...manifest }),
    manifest_path: `${root}gemini-extension.json`,
    files: [`${root}gemini-extension.json`, `${root}skills/review/SKILL.md`, `${root}skills/review/references/check.md`, `${root}vendor/unrelated/SKILL.md`],
    entry_points: [`${root}skills/review/SKILL.md`],
    package_hash: `sha256-${"a".repeat(64)}`,
    local_path: ".protocols/example-unique",
    workspace: "/fixture/project",
  };
}

test("Gemini import registers only manifest-root Skills and anonymous Streamable HTTP", () => {
  const preview = inspectGeminiExtensionArchive(archive({ mcpServers: { tools: { httpUrl: "http://127.0.0.1:9100/mcp" } } }));
  assert.deepEqual(preview.skillEntryPoints, ["repo-main/skills/review/SKILL.md"]);
  assert.deepEqual(preview.mcpServers, [{ key: "tools", url: "http://127.0.0.1:9100/mcp", status: "supported", supported: true, reasons: [], enabled: true }]);
  const installed = createGeminiExtensionInstall(preview, { id: "fixture", sourcePath: "/fixture/extension.zip", now: 100 });
  const skill = extensionSkillProjection(installed);
  assert.equal(skill.type, "package");
  assert.equal(skill.packagePath, preview.packagePath);
  assert.deepEqual(skill.entryPoints, preview.skillEntryPoints);
  assert.equal(skill.workspaceScope, "/fixture/project");
  assert.equal(skill.content, "");
});

test("Gemini HTTP-only packages remain installable without a fabricated Skill", () => {
  const input = archive({ mcpServers: { tools: { httpUrl: "https://example.com/mcp" } } }, "");
  input.files = ["gemini-extension.json"];
  input.entry_points = [];
  const preview = inspectGeminiExtensionArchive(input);
  assert.equal(preview.mcpServers[0].supported, true);
  assert.equal(extensionSkillProjection(createGeminiExtensionInstall(preview, { id: "fixture", sourcePath: "fixture.zip" })), null);
});

test("SSE, stdio, authentication, filtering and unsupported options never downgrade to anonymous HTTP", () => {
  const preview = inspectGeminiExtensionArchive(archive({ mcpServers: {
    sse: { url: "http://localhost/sse" },
    stdio: { command: "node", args: ["server.js"] },
    auth: { httpUrl: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
    oauth: { httpUrl: "https://example.com/mcp", oauth: { enabled: true } },
    filtered: { httpUrl: "https://example.com/mcp", excludeTools: ["write"] },
    timeout: { httpUrl: "https://example.com/mcp", timeout: 1000 },
    pending: { httpUrl: "https://${HOST}/mcp" },
  } }));
  for (const server of preview.mcpServers) {
    assert.equal(server.status, "blocked", server.key);
    assert.equal(server.enabled, false, server.key);
    assert.equal(server.url, undefined, server.key);
  }
  assert.equal(JSON.stringify(preview).includes("Bearer secret"), false);
});

test("unsupported extension instruction and execution features are reported without becoming project rules", () => {
  const input = archive({ contextFileName: "GUIDE.md", settings: [], excludeTools: ["run_shell_command"], mcpServers: { tools: { httpUrl: "https://example.com/mcp" } } });
  input.files.push("repo-main/GEMINI.md", "repo-main/hooks/hooks.json", "repo-main/commands/review.toml", "repo-main/agents/reviewer.md", "repo-main/policies/safety.toml");
  const preview = inspectGeminiExtensionArchive(input);
  for (const feature of ["GEMINI.md", "contextFileName", "settings", "excludeTools", "hooks", "commands", "agents", "policies"]) {
    assert.ok(preview.unsupportedFeatures.includes(feature), feature);
  }
  assert.equal(preview.mcpServers[0].supported, false);
});

test("invalid roots, metadata escapes and mismatched Skill entries are rejected", () => {
  for (const patch of [
    { local_path: "../outside" },
    { manifest_path: "nested/deep/gemini-extension.json" },
    { entry_points: ["repo-main/vendor/unrelated/SKILL.md"] },
    { files: ["repo-main/gemini-extension.json", "../outside"] },
    { manifest_json: "{not-json}" },
    { manifest_json: JSON.stringify({ name: "../escape", version: "1" }) },
  ]) assert.throws(() => inspectGeminiExtensionArchive({ ...archive({}), ...patch }));
});

test("installation selection and hydration keep unsafe or blocked bindings disabled", () => {
  const preview = inspectGeminiExtensionArchive(archive({ mcpServers: { first: { httpUrl: "https://example.com/one" }, second: { httpUrl: "https://example.com/two" } } }));
  const installed = createGeminiExtensionInstall(preview, { id: "fixture", sourcePath: "fixture.zip", skillEntryPoints: [], mcpKeys: ["second"] });
  assert.deepEqual(installed.skillEntryPoints, []);
  assert.deepEqual(installed.mcpServers.map((server) => server.enabled), [false, true]);
  const [restored] = normalizeGeminiExtensionInstallations([installed, installed, { ...installed, id: "escape", packagePath: ".protocols/../../outside" }]);
  assert.equal(normalizeGeminiExtensionInstallations([installed, installed]).length, 1);
  assert.deepEqual(restored.mcpServers.map((server) => server.enabled), [false, true]);
  const [restricted] = normalizeGeminiExtensionInstallations([{ ...installed, unsupportedFeatures: ["excludeTools"] }]);
  assert.ok(restricted.mcpServers.every((server) => !server.enabled && !server.supported));
  const [tampered] = normalizeGeminiExtensionInstallations([{ ...installed, mcpServers: [{ ...installed.mcpServers[1], url: "https://user:secret@example.com/mcp" }] }]);
  assert.equal(tampered.mcpServers[0].enabled, false);
});

test("anonymous endpoint validation does not accept credentials, templates, fragments or URL-carried settings", () => {
  for (const value of ["file:///tmp/mcp", "https://user:secret@example.com/mcp", "https://${HOST}/mcp", "https://example.com/mcp?token=secret", "https://example.com/mcp#fragment", " https://example.com/mcp", "https://%HOST%/mcp"]) {
    assert.equal(isAnonymousGeminiHttpUrl(value), false, value);
  }
});
