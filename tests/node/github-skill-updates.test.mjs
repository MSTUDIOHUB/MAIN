import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const saved = new Map();
const writes = [];
let storageFailure = null;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => {
    writes.push({ key, value });
    storageFailure?.(key, value);
    saved.set(key, value);
  },
  removeItem: (key) => saved.delete(key),
} });
// Zustand's browser default captures window.localStorage while the store loads.
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  localStorage: globalThis.localStorage,
  addEventListener: () => {}, removeEventListener: () => {},
} });
test.after(() => {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else delete globalThis.localStorage;
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete globalThis.window;
});

const cache = new Map();
const ipcCalls = [];
let invoke = async () => null;
function load(source) {
  source = path.resolve(source);
  if (cache.has(source)) return cache.get(source);
  const module = { exports: {} };
  cache.set(source, module.exports);
  const require = createRequire(source);
  const code = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: source,
  }).outputText;
  new Function("exports", "module", "require", code)(module.exports, module, (name) => {
    if (name.startsWith("@tauri-apps/")) return {
      invoke: (command, args) => { ipcCalls.push({ command, args }); return invoke(command, args); },
      isTauri: () => false, listen: async () => () => {}, open: async () => null,
      relaunch: async () => {}, exit: async () => {}, check: async () => null,
    };
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(source), name);
      for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (/\.tsx?$/.test(file) && fs.existsSync(file)) return load(file);
      }
    }
    return require(name);
  });
  return module.exports;
}

const { useAppStore } = load("src/store/useAppStore.ts");
const { checkGithubSkillUpdate } = load("src/lib/githubSkillUpdates.ts");
const catalogApi = load("src/lib/agentSkills.ts");
const OLD = "a".repeat(64);
const NEXT = "b".repeat(64);
const LATER = "c".repeat(64);
const SOURCE = { repository: "owner/skills", branch: "feature/skills" };
const registration = (patch = {}) => ({
  id: "original-registration", name: "My package name", desc: "My description", content: "", isBuiltIn: false,
  type: "package", packageStorage: { kind: "global", packageId: OLD }, githubSource: { ...SOURCE },
  entryPoint: "skills/one/SKILL.md", entryPoints: ["skills/one/SKILL.md"],
  active: false, allowImplicitInvocation: false, ...patch,
});
const meta = (packageId = NEXT, patch = {}) => ({
  packageId, name: "Downloaded repository name", entryPoint: "skills/one/SKILL.md",
  entryPoints: ["skills/one/SKILL.md"], files: ["skills/one/SKILL.md", "skills/one/references/details.md"],
  reused: true, githubSource: { ...SOURCE }, ...patch,
});
function reset(skills) {
  storageFailure = null;
  invoke = async () => null;
  useAppStore.setState({ skills, currentWorkspace: "/original-project" });
  writes.length = 0;
  ipcCalls.length = 0;
}
const skills = () => useAppStore.getState().skills;
const apply = (candidate) => useAppStore.getState().applyGithubSkillUpdate(candidate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("checking downloads a detached immutable candidate and requires an explicit store commit", async () => {
  const original = registration();
  reset([original]);
  const before = skills();
  const downloaded = meta();
  const calls = [];
  const candidate = await checkGithubSkillUpdate(original, async (...args) => { calls.push(args); return downloaded; });
  assert.deepEqual(calls, [[SOURCE.repository, SOURCE.branch]]);
  assert.equal(skills(), before);
  assert.equal(writes.length, 0, "checking cannot change a registration or its policy");
  assert.equal(candidate.registration, original);
  for (const value of [candidate, candidate.source, candidate.meta, candidate.meta.githubSource, candidate.meta.entryPoints, candidate.meta.files]) {
    assert.ok(Object.isFrozen(value));
  }
  downloaded.entryPoints.push("changed/SKILL.md");
  downloaded.files.length = 0;
  downloaded.githubSource.branch = "unrelated";
  assert.deepEqual(candidate.meta.entryPoints, ["skills/one/SKILL.md"]);
  assert.equal(candidate.meta.files.length, 2);
  assert.deepEqual(candidate.source, SOURCE);
});

test("applying a verified version preserves registration identity, policy and an active Run's old catalog", async () => {
  const original = registration({ active: true });
  reset([original]);
  const oldArray = skills();
  const body = (id) => `---\nname: fixture-check\n---\n${id === OLD ? "OLD_BODY" : "NEW_BODY"}\n`;
  invoke = async (command, args) => {
    if (command === "load_global_skill_package_catalog") return {
      meta: meta(args.packageId), documents: [{ relativePath: "skills/one/SKILL.md", content: body(args.packageId) }],
    };
    if (command === "read_global_skill_package_file") return args.packageId === OLD ? "OLD_REFERENCE\n" : "NEW_REFERENCE\n";
    if (command === "discover_personal_agent_skills") return [];
    throw new Error(`unexpected IPC: ${command}`);
  };
  const oldCatalog = await catalogApi.loadSkillCatalog({ workspace: "", skills: oldArray, userPrompt: "Use $fixture-check" });
  const candidate = await checkGithubSkillUpdate(original, async () => meta());
  useAppStore.setState({ currentWorkspace: "/different-project" });
  assert.deepEqual(apply(candidate), { status: "updated" });
  const current = skills()[0];
  for (const key of ["id", "name", "desc", "active", "allowImplicitInvocation", "content", "isBuiltIn"]) assert.equal(current[key], original[key]);
  assert.deepEqual(current.packageStorage, { kind: "global", packageId: NEXT });
  assert.equal(useAppStore.getState().currentWorkspace, "/different-project");
  assert.equal(oldArray[0], original);
  assert.equal(original.packageStorage.packageId, OLD);
  assert.match(catalogApi.loadSkillContent(oldCatalog, oldCatalog.entries[0].id).content, /OLD_BODY/);
  assert.equal((await catalogApi.loadSkillResourceContent(oldCatalog, oldCatalog.entries[0].id, "references/details.md")).content, "OLD_REFERENCE\n");
  const nextCatalog = await catalogApi.loadSkillCatalog({ workspace: "", skills: skills(), userPrompt: "Use $fixture-check" });
  assert.match(catalogApi.loadSkillContent(nextCatalog, nextCatalog.entries[0].id).content, /NEW_BODY/);
  assert.equal(nextCatalog.entries[0].globalPackageId, NEXT);
  assert.equal(oldCatalog.entries[0].globalPackageId, OLD);
});

test("identical downloaded bytes do not rewrite a disabled manual registration", async () => {
  const original = registration();
  reset([original]);
  const before = skills();
  const candidate = await checkGithubSkillUpdate(original, async () => meta(OLD));
  assert.deepEqual(apply(candidate), { status: "unchanged" });
  assert.equal(skills(), before);
  assert.equal(skills()[0], original);
  assert.equal(writes.length, 0);
});

test("updating a disabled manual registration does not admit its new payload", async () => {
  const original = registration();
  reset([original]);
  const candidate = await checkGithubSkillUpdate(original, async () => meta());
  assert.deepEqual(apply(candidate), { status: "updated" });
  assert.equal(skills()[0].packageStorage.packageId, NEXT);
  assert.equal(skills()[0].active, false);
  assert.equal(skills()[0].allowImplicitInvocation, false);
  invoke = async (command) => {
    if (command === "discover_personal_agent_skills") return [];
    throw new Error(`disabled package cannot request its payload: ${command}`);
  };
  const catalog = await catalogApi.loadSkillCatalog({ workspace: "", skills: skills() });
  assert.deepEqual(catalog.entries, []);
});

const concurrentChanges = {
  deletion: () => useAppStore.getState().deleteSkill("original-registration"),
  "same-id replacement": () => useAppStore.setState({ skills: [registration({ packageStorage: { kind: "global", packageId: LATER } })] }),
  "same-id same-content replacement": () => useAppStore.setState({ skills: [registration()] }),
  "name and description edit": () => useAppStore.getState().updateSkill("original-registration", { name: "Later choice", desc: "Later description" }),
  "enable toggle": () => useAppStore.getState().toggleSkill("original-registration"),
  "manual policy edit": () => useAppStore.getState().updateSkill("original-registration", { allowImplicitInvocation: true }),
  "source edit": () => useAppStore.getState().updateSkill("original-registration", { githubSource: { repository: "another/skills", branch: "main" } }),
  "conversion to a rule": () => useAppStore.getState().updateSkill("original-registration", { type: "instruction", packageStorage: undefined, content: "New rule" }),
};
for (const [name, change] of Object.entries(concurrentChanges)) {
  test(`a candidate settling after ${name} cannot overwrite or resurrect the current record`, async () => {
    const original = registration();
    reset([original]);
    const download = deferred();
    const pending = checkGithubSkillUpdate(original, () => download.promise);
    change();
    const latest = skills();
    const serialized = JSON.stringify(latest);
    const writeCount = writes.length;
    download.resolve(meta());
    assert.deepEqual(apply(await pending), { status: "stale" });
    assert.equal(skills(), latest);
    assert.equal(JSON.stringify(skills()), serialized);
    assert.equal(writes.length, writeCount);
  });
}

test("two concurrent checks cannot let an older late candidate roll back the first committed version", async () => {
  const original = registration();
  reset([original]);
  const oldDownload = deferred();
  const newDownload = deferred();
  const oldPending = checkGithubSkillUpdate(original, () => oldDownload.promise);
  const newPending = checkGithubSkillUpdate(original, () => newDownload.promise);
  newDownload.resolve(meta(LATER));
  assert.deepEqual(apply(await newPending), { status: "updated" });
  const committed = skills();
  oldDownload.resolve(meta(NEXT));
  assert.deepEqual(apply(await oldPending), { status: "stale" });
  assert.equal(skills(), committed);
  assert.equal(skills()[0].packageStorage.packageId, LATER);
});

test("a concurrently imported disabled/manual target version is a conflict, never a silent merge", async () => {
  const original = registration({ active: true, allowImplicitInvocation: true });
  reset([original]);
  const download = deferred();
  const pending = checkGithubSkillUpdate(original, () => download.promise);
  useAppStore.getState().addSkill(registration({ packageStorage: { kind: "global", packageId: NEXT }, name: "Existing candidate" }));
  const duplicateId = skills().find((record) => record.packageStorage.packageId === NEXT).id;
  useAppStore.getState().toggleSkill(duplicateId);
  const before = skills();
  assert.equal(before[1].active, false);
  assert.equal(before[1].allowImplicitInvocation, false);
  download.resolve(meta());
  const candidate = await pending;
  const writeCount = writes.length;
  assert.deepEqual(apply(candidate), { status: "conflict", conflictId: duplicateId });
  assert.equal(skills(), before);
  assert.equal(writes.length, writeCount);
  useAppStore.getState().deleteSkill(duplicateId);
  assert.deepEqual(apply(candidate), { status: "updated" });
  assert.equal(skills()[0].id, original.id);
  assert.equal(skills()[0].active, true);
});

test("download failures, invalid metadata and a mismatched source never change the registration", async () => {
  const invalid = [
    () => { throw new Error("download unavailable"); },
    () => meta("../outside"),
    () => meta(NEXT, { entryPoints: [] }),
    () => meta(NEXT, { files: [] }),
    () => meta(NEXT, { files: ["skills/one/SKILL.md", "../outside"] }),
    () => meta(NEXT, { entryPoint: "/outside", entryPoints: ["/outside"], files: ["/outside"] }),
    () => meta(NEXT, { githubSource: undefined }),
    () => meta(NEXT, { githubSource: { ...SOURCE, repository: "another/skills" } }),
    () => meta(NEXT, { githubSource: { ...SOURCE, branch: "another-branch" } }),
  ];
  for (const fetcher of invalid) {
    const original = registration();
    reset([original]);
    const before = skills();
    await assert.rejects(() => checkGithubSkillUpdate(original, async () => fetcher()));
    assert.equal(skills(), before);
    assert.equal(writes.length, 0);
  }
});

test("invalid registration sources are rejected before making a network request", async () => {
  for (const patch of [
    { githubSource: undefined }, { githubSource: { repository: "https://github.com/o/r", branch: "main" } },
    { githubSource: { repository: "o/r", branch: "../main" } }, { type: "instruction" },
    { packageStorage: undefined, packagePath: ".protocols/legacy", workspaceScope: "/project" },
  ]) {
    const original = registration(patch);
    reset([original]);
    let requested = false;
    await assert.rejects(() => checkGithubSkillUpdate(original, async () => { requested = true; return meta(); }), /SOURCE_REQUIRED/);
    assert.equal(requested, false);
    assert.equal(skills()[0], original);
    assert.equal(writes.length, 0);
  }
});

test("store persistence failure rolls back only its own exact registration update", async () => {
  const original = registration();
  reset([original]);
  const before = skills();
  const candidate = await checkGithubSkillUpdate(original, async () => meta());
  let failed = false;
  storageFailure = () => { if (!failed) { failed = true; throw new Error("storage quota exceeded"); } };
  assert.throws(() => apply(candidate), /storage quota exceeded/);
  storageFailure = null;
  assert.equal(skills(), before);
  assert.equal(skills()[0], original);
  assert.equal(JSON.parse(saved.get("local-agent-ide")).state.skills[0].packageStorage.packageId, OLD);
});

test("a later user edit from a persistence callback is never undone by rollback", async () => {
  const original = registration();
  reset([original]);
  const candidate = await checkGithubSkillUpdate(original, async () => meta());
  let entered = false;
  storageFailure = () => {
    if (entered) return;
    entered = true;
    useAppStore.getState().updateSkill(original.id, { name: "Later user choice" });
    throw new Error("outer write failed");
  };
  assert.throws(() => apply(candidate), /outer write failed/);
  storageFailure = null;
  assert.equal(skills()[0].name, "Later user choice");
  assert.equal(skills()[0].packageStorage.packageId, NEXT);
  assert.equal(JSON.parse(saved.get("local-agent-ide")).state.skills[0].name, "Later user choice");
});

test("an identical GitHub reimport binds a missing ZIP source without changing existing policy", () => {
  const original = registration({ githubSource: undefined });
  reset([original]);
  useAppStore.getState().addSkill(registration({
    name: "New repository name", active: true, allowImplicitInvocation: true,
    githubSource: { ...SOURCE, token: "DO_NOT_PERSIST", headers: { authorization: "DO_NOT_PERSIST" } },
  }));
  assert.equal(skills().length, 1);
  for (const key of ["id", "name", "desc", "active", "allowImplicitInvocation"]) assert.equal(skills()[0][key], original[key]);
  assert.deepEqual(skills()[0].packageStorage, original.packageStorage);
  assert.deepEqual(skills()[0].githubSource, SOURCE);
  assert.equal(original.githubSource, undefined);
  assert.doesNotMatch(saved.get("local-agent-ide"), /DO_NOT_PERSIST/);
});

test("same-content imports cannot replace an existing GitHub source or clear it through ZIP import", () => {
  const original = registration();
  reset([original]);
  useAppStore.getState().addSkill(registration({ githubSource: { repository: "different/repository", branch: "main" } }));
  useAppStore.getState().addSkill(registration({ githubSource: undefined }));
  assert.equal(skills().length, 1);
  assert.equal(skills()[0], original);
  assert.deepEqual(skills()[0].githubSource, SOURCE);
});
