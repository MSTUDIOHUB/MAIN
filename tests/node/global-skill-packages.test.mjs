import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
const calls = [];
let invoke = async () => "";
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
      invoke: (name, args) => { calls.push({ name, args }); return invoke(name, args); },
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
const packageId = "a".repeat(64);
const registration = (patch = {}) => ({
  id: "existing", name: "Keep my name", desc: "workflow", content: "", active: false,
  type: "package", packageStorage: { kind: "global", packageId },
  entryPoint: "skills/one/SKILL.md", entryPoints: ["skills/one/SKILL.md"],
  allowImplicitInvocation: false, ...patch,
});

test("real store reimport of identical global package keeps one registration and its user policy", () => {
  const original = registration();
  useAppStore.setState({ skills: [original], currentWorkspace: "" });
  useAppStore.getState().addSkill(registration({ id: "new", name: "New ZIP name", active: true, allowImplicitInvocation: true }));
  assert.equal(useAppStore.getState().skills.length, 1);
  assert.deepEqual(useAppStore.getState().skills[0], original);
});

test("real store owns an awaitable legacy package migration without requiring a current workspace", () => {
  assert.equal(typeof useAppStore.getState().migrateLegacySkillPackages, "function");
});

const api = load("src/lib/globalSkillPackages.ts");
const meta = (id = packageId) => ({ packageId: id, name: "Imported ZIP", entryPoint: "skills/one/SKILL.md", entryPoints: ["skills/one/SKILL.md"], files: ["skills/one/SKILL.md", "skills/one/references/details.md"], reused: true });
const legacy = (id, workspaceScope = `/project-${id}`, patch = {}) => ({
  id, name: "Same package", desc: "", content: "", active: true, type: "package",
  packagePath: `.protocols/${id}`, workspaceScope,
  entryPoint: "skills/one/SKILL.md", entryPoints: ["skills/one/SKILL.md"], ...patch,
});
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(skills, overrides = {}) {
  let current = skills;
  const observed = [];
  return {
    observed, get: () => current, set: (next) => { current = next; },
    io: {
      getSkills: () => current,
      updateSkills: (apply) => { current = apply(current); },
      promote: async (workspace, localPath) => { observed.push({ workspace, localPath }); return meta(); },
      inspect: async () => meta(), backup: () => {}, ...overrides,
    },
  };
}
function localStorageFixture() {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  } });
  return { values, restore() { if (old) Object.defineProperty(globalThis, "localStorage", old); else delete globalThis.localStorage; } };
}

test("same package name with different bytes remains two global registrations", () => {
  useAppStore.setState({ skills: [registration()] });
  useAppStore.getState().addSkill(registration({ packageStorage: { kind: "global", packageId: "b".repeat(64) } }));
  assert.equal(useAppStore.getState().skills.length, 2);
});

test("global uninstall removes only its registration and leaves the shared immutable cache", () => {
  calls.length = 0;
  useAppStore.setState({ skills: [registration()] });
  useAppStore.getState().deleteSkill("existing");
  assert.deepEqual(useAppStore.getState().skills, []);
  assert.deepEqual(calls, []);
});

test("editing a registration to an existing content id preserves the existing user's settings", () => {
  const existing = registration();
  useAppStore.setState({ skills: [existing, registration({ id: "other", packageStorage: { kind: "global", packageId: "b".repeat(64) } })] });
  useAppStore.getState().updateSkill("other", { packageStorage: { kind: "global", packageId }, name: "Replacement", active: true });
  assert.deepEqual(useAppStore.getState().skills, [existing]);
});

test("verified legacy copies atomically become one global registration and preserve live source objects", async () => {
  const originals = [legacy("one"), legacy("two")];
  const f = fixture(originals);
  const result = await api.migrateLegacySkillRegistrations(f.io);
  assert.equal(result.migrated, 2);
  assert.deepEqual(f.observed, [{ workspace: "/project-one", localPath: ".protocols/one" }, { workspace: "/project-two", localPath: ".protocols/two" }]);
  assert.equal(f.get().length, 1);
  assert.equal(f.get()[0].id, "one");
  assert.equal(f.get()[0].active, true);
  assert.deepEqual(f.get()[0].packageStorage, { kind: "global", packageId });
  assert.equal(Object.hasOwn(f.get()[0], "packagePath"), false);
  assert.equal(Object.hasOwn(f.get()[0], "workspaceScope"), false);
  assert.equal(originals[0].packagePath, ".protocols/one", "an admitted catalog may still hold the old object");
});

test("migration duplicates preserve disabled/manual choices conservatively and are idempotent", async () => {
  const f = fixture([legacy("one"), legacy("two", "/two", { active: false, allowImplicitInvocation: false })]);
  await api.migrateLegacySkillRegistrations(f.io);
  assert.equal(f.get()[0].active, false);
  assert.equal(f.get()[0].allowImplicitInvocation, false);
  assert.equal((await api.migrateLegacySkillRegistrations(f.io)).migrated, 0);
  assert.equal(f.observed.length, 2);
});

test("missing legacy owner stays fail-closed and is never promoted", async () => {
  const record = legacy("unknown", null);
  const f = fixture([record]);
  await api.migrateLegacySkillRegistrations(f.io);
  assert.deepEqual(f.observed, []);
  assert.equal(f.get()[0], record);
});

for (const failure of ["copy", "inspection", "mismatched id", "invalid manifest"]) {
  test(`migration ${failure} failure preserves the legacy registration`, async () => {
    const record = legacy("one");
    const f = fixture([record], {
      promote: async () => { if (failure === "copy") throw new Error("source missing"); return meta(); },
      inspect: async () => {
        if (failure === "inspection") throw new Error("cache verification failed");
        if (failure === "mismatched id") return meta("b".repeat(64));
        return { ...meta(), ...(failure === "invalid manifest" ? { files: [] } : {}) };
      },
    });
    const result = await api.migrateLegacySkillRegistrations(f.io);
    assert.equal(result.failures.length, 1);
    assert.equal(result.migrated, 0);
    assert.equal(f.get()[0], record);
  });
}

test("a concurrent toggle of either duplicate does not get overwritten or globally re-enabled", async () => {
  const gate = deferred();
  const first = legacy("one"); const second = legacy("two");
  const f = fixture([first, second], { promote: async () => { await gate.promise; return meta(); } });
  const migration = api.migrateLegacySkillRegistrations(f.io);
  const toggled = { ...second, active: false };
  f.set([first, toggled]); gate.resolve(); await migration;
  assert.deepEqual(f.get(), [first, toggled]);
});

test("same-id replacement and user removal cannot be resurrected by late migration", async () => {
  for (const replacement of [null, legacy("one", "/replacement", { packagePath: ".protocols/replacement" })]) {
    const gate = deferred(); const original = legacy("one");
    const f = fixture([original], { promote: async () => { await gate.promise; return meta(); } });
    const migration = api.migrateLegacySkillRegistrations(f.io);
    f.set(replacement ? [replacement] : []); gate.resolve(); await migration;
    assert.deepEqual(f.get(), replacement ? [replacement] : []);
  }
});

test("new import during migration wins its name/id/disabled/manual policy", async () => {
  const gate = deferred(); const old = legacy("one"); const imported = registration();
  const f = fixture([old], { promote: async () => { await gate.promise; return meta(); } });
  const migration = api.migrateLegacySkillRegistrations(f.io);
  f.set([old, imported]); gate.resolve(); await migration;
  assert.deepEqual(f.get(), [imported]);
});

test("preexisting global plus disabled/manual legacy migrates with the conservative policy", async () => {
  const existing = registration({ active: true, allowImplicitInvocation: true });
  const f = fixture([existing, legacy("one", "/one", { active: false, allowImplicitInvocation: false })]);
  await api.migrateLegacySkillRegistrations(f.io);
  assert.equal(f.get().length, 1);
  assert.equal(f.get()[0].id, existing.id);
  assert.equal(f.get()[0].name, existing.name);
  assert.equal(f.get()[0].active, false);
  assert.equal(f.get()[0].allowImplicitInvocation, false);
});

test("deleting one of two legacy registrations sharing a directory preserves its remaining owner", () => {
  const first = legacy("one"); const second = { ...first, id: "second" };
  calls.length = 0;
  useAppStore.setState({ skills: [first, second] });
  useAppStore.getState().deleteSkill(first.id);
  assert.deepEqual(useAppStore.getState().skills, [second]);
  assert.deepEqual(calls, []);
});

test("real store migration uses captured per-record scopes across a workspace switch and persists typed refs", async () => {
  const storage = localStorageFixture(); const gate = deferred(); calls.length = 0;
  const originals = [legacy("one"), legacy("two")];
  try {
    useAppStore.setState({ skills: originals, currentWorkspace: "/unrelated-before", config: { ...useAppStore.getState().config, apiKey: "CREDENTIAL_MUST_NOT_BE_BACKED_UP" } });
    invoke = async (name) => {
      if (name === "promote_legacy_skill_package") { await gate.promise; return meta(); }
      if (name === "inspect_global_skill_package") return meta();
      throw new Error(`unexpected IPC ${name}`);
    };
    const migration = useAppStore.getState().migrateLegacySkillPackages();
    useAppStore.setState({ currentWorkspace: "/unrelated-after" });
    gate.resolve(); await migration;
    assert.equal(useAppStore.getState().currentWorkspace, "/unrelated-after");
    assert.equal(useAppStore.getState().skills.length, 1);
    assert.deepEqual(calls.filter((x) => x.name === "promote_legacy_skill_package").map((x) => x.args), [
      { workspace: "/project-one", localPath: ".protocols/one" },
      { workspace: "/project-two", localPath: ".protocols/two" },
    ]);
    const backup = storage.values.get(api.SKILL_PACKAGE_BACKUP_KEY);
    assert.equal(JSON.parse(backup).length, 2);
    assert.ok(!backup.includes("CREDENTIAL_MUST_NOT_BE_BACKED_UP"));
    assert.ok(!calls.some((x) => x.name === "delete_protocol_package"));
    const { buildPersistedAppState } = load("src/lib/persistState.ts");
    const saved = JSON.parse(JSON.stringify(buildPersistedAppState(useAppStore.getState())));
    assert.deepEqual(saved.skills[0].packageStorage, { kind: "global", packageId });
    assert.equal(Object.hasOwn(saved.skills[0], "workspaceScope"), false);
  } finally { storage.restore(); invoke = async () => ""; }
});

test("backup failure prevents promotion and leaves legacy files/registration untouched", async () => {
  const original = legacy("one");
  const f = fixture([original], { backup: () => { throw new Error("disk full"); } });
  await assert.rejects(api.migrateLegacySkillRegistrations(f.io), /disk full/);
  assert.deepEqual(f.observed, []);
  assert.equal(f.get()[0], original);
});

test("synchronous persistence failure restores only the exact migration commit", async () => {
  const original = legacy("one");
  const f = fixture([original]);
  f.io.updateSkills = (apply) => {
    f.set(apply(f.get()));
    throw new Error("storage quota exceeded");
  };
  await assert.rejects(api.migrateLegacySkillRegistrations(f.io), /storage quota exceeded/);
  assert.equal(f.get()[0], original);
});
