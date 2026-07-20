import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && candidate.endsWith(".ts")) {
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  createProjectSessionMutationCoordinator,
  ProjectSessionDeleteFencedError,
  ProjectSessionWorkspaceClearFencedError,
  ProjectSessionStaleWriteFencedError,
  ProjectSessionSaveTimedOutError,
  isProjectSessionAdmissionProjectionOwned,
} = loadTranspiledModuleSync(
  path.join(process.cwd(), "src/lib/projectSessionMutationCoordinator.ts"),
);

test("only an exact admission receipt may serialize a persisting queue projection", () => {
  const session = {
    runtimeSnapshot: {
      workspaceTurnQueue: {
        entries: [{
          status: "persisting",
          receipt: { receiptId: "receipt-1" },
        }],
      },
    },
  };

  assert.equal(isProjectSessionAdmissionProjectionOwned(session), false);
  assert.equal(isProjectSessionAdmissionProjectionOwned(session, "receipt-other"), false);
  assert.equal(isProjectSessionAdmissionProjectionOwned(session, "receipt-1"), true);
  session.runtimeSnapshot.workspaceTurnQueue.entries.push({
    status: "persisting",
    receipt: { receiptId: "receipt-2" },
  });
  assert.equal(isProjectSessionAdmissionProjectionOwned(session, "receipt-1"), false);
  session.runtimeSnapshot.workspaceTurnQueue.entries = [{
    status: "queued",
    receipt: { receiptId: "receipt-1" },
  }];
  assert.equal(isProjectSessionAdmissionProjectionOwned(session), true);
});

test("an owner save rechecks its runtime revision only when it reaches the mutation head", async () => {
  const coordinator = createProjectSessionMutationCoordinator();
  const ownerKey = "workspace-a\u00006";
  const firstGate = deferred();
  let currentRevision = 1;
  const calls = [];
  const firstSave = coordinator.save(ownerKey, async () => {
    calls.push("save-current");
    await firstGate.promise;
    return "saved-current";
  });
  await new Promise((resolve) => setImmediate(resolve));

  const staleSave = coordinator.save(
    ownerKey,
    async () => {
      calls.push("save-stale");
      return "saved-stale";
    },
    { isCurrent: () => currentRevision === 1 },
  );
  currentRevision = 2;
  firstGate.resolve();

  assert.equal(await firstSave, "saved-current");
  await assert.rejects(
    staleSave,
    (error) => error instanceof ProjectSessionStaleWriteFencedError,
  );
  assert.deepEqual(calls, ["save-current"]);
});

test("a never-settling save releases the real owner queue and requires revision reconciliation", async () => {
  const coordinator = createProjectSessionMutationCoordinator(undefined, {
    saveSettlementTimeoutMs: 25,
    deadlineLeadMs: 5,
  });
  const ownerKey = "workspace-timeout\u000061";
  const never = new Promise(() => {});
  let firstLease = null;
  let secondLease = null;
  let thirdLease = null;

  const firstSave = coordinator.save(ownerKey, async (lease) => {
    firstLease = lease;
    return never;
  });
  await assert.rejects(
    firstSave,
    (error) => error instanceof ProjectSessionSaveTimedOutError &&
      error.code === "project_session_save_timed_out",
  );

  assert.ok(firstLease);
  assert.equal(firstLease.revisionReconciliationRequired, false);
  const secondSaved = await coordinator.save(ownerKey, async (lease) => {
    secondLease = lease;
    return "saved-after-timeout";
  });
  assert.equal(secondSaved, "saved-after-timeout");
  assert.equal(secondLease.revisionReconciliationRequired, true);
  assert.ok(secondLease.mutationDeadlineMs > firstLease.mutationDeadlineMs);

  await coordinator.save(ownerKey, async (lease) => {
    thirdLease = lease;
    return "saved-authoritative";
  });
  assert.equal(thirdLease.revisionReconciliationRequired, false);
});

test("an older late response cannot clear uncertainty from a newer timed-out save", async () => {
  const coordinator = createProjectSessionMutationCoordinator(undefined, {
    saveSettlementTimeoutMs: 20,
    deadlineLeadMs: 4,
  });
  const ownerKey = "workspace-timeout\u000062";
  const oldResponse = deferred();
  const never = new Promise(() => {});

  await assert.rejects(
    coordinator.save(ownerKey, async () => oldResponse.promise),
    (error) => error instanceof ProjectSessionSaveTimedOutError,
  );
  await assert.rejects(
    coordinator.save(ownerKey, async () => never),
    (error) => error instanceof ProjectSessionSaveTimedOutError,
  );
  oldResponse.resolve("late-old-success");
  await new Promise((resolve) => setImmediate(resolve));

  let recoveryLease = null;
  await coordinator.save(ownerKey, async (lease) => {
    recoveryLease = lease;
    return "reconciled";
  });
  assert.equal(recoveryLease.revisionReconciliationRequired, true);
});

test("an older late rejection cannot recreate uncertainty after a newer authoritative save", async () => {
  const coordinator = createProjectSessionMutationCoordinator(undefined, {
    saveSettlementTimeoutMs: 20,
    deadlineLeadMs: 4,
  });
  const ownerKey = "workspace-timeout\u000063";
  const oldResponse = deferred();

  await assert.rejects(
    coordinator.save(ownerKey, async () => oldResponse.promise),
    (error) => error instanceof ProjectSessionSaveTimedOutError,
  );
  let reconciliationLease = null;
  await coordinator.save(ownerKey, async (lease) => {
    reconciliationLease = lease;
    return "new-authoritative-save";
  });
  assert.equal(reconciliationLease.revisionReconciliationRequired, true);

  oldResponse.reject(new Error("late transport rejection"));
  await new Promise((resolve) => setImmediate(resolve));

  let nextLease = null;
  await coordinator.save(ownerKey, async (lease) => {
    nextLease = lease;
    return "still-authoritative";
  });
  assert.equal(nextLease.revisionReconciliationRequired, false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("delete fences queued and later stale saves while waiting for an in-flight owner save", async () => {
  const coordinator = createProjectSessionMutationCoordinator();
  const ownerKey = "workspace-a\u00007";
  const firstGate = deferred();
  const calls = [];
  const firstSave = coordinator.save(ownerKey, async () => {
    calls.push("save-1:start");
    await firstGate.promise;
    calls.push("save-1:end");
    return "saved-1";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["save-1:start"]);
  const queuedSave = coordinator.save(ownerKey, async () => {
    calls.push("save-2");
    return "saved-2";
  });
  const deletion = coordinator.delete(ownerKey, async () => {
    calls.push("delete");
    return ["remaining-session"];
  });

  assert.equal(coordinator.isDeleteFenced(ownerKey), true);
  const staleSave = coordinator.save(ownerKey, async () => {
    calls.push("stale-save");
    return "stale";
  });
  const queuedSaveRejected = assert.rejects(
    queuedSave,
    (error) => error instanceof ProjectSessionDeleteFencedError,
  );
  const staleSaveRejected = assert.rejects(
    staleSave,
    (error) => error instanceof ProjectSessionDeleteFencedError,
  );

  firstGate.resolve();
  assert.equal(await firstSave, "saved-1");
  await queuedSaveRejected;
  await staleSaveRejected;
  assert.deepEqual(await deletion, ["remaining-session"]);
  assert.deepEqual(calls, ["save-1:start", "save-1:end", "delete"]);
  assert.equal(coordinator.isDeleteFenced(ownerKey), true);

  await assert.rejects(
    coordinator.save(ownerKey, async () => {
      calls.push("post-delete-save");
      return "resurrected";
    }),
    (error) => error instanceof ProjectSessionDeleteFencedError,
  );
  assert.equal(calls.includes("post-delete-save"), false);
});

test("a failed delete releases a newly established save fence", async () => {
  const coordinator = createProjectSessionMutationCoordinator();
  const ownerKey = "workspace-a\u00008";
  const deletion = coordinator.delete(ownerKey, async () => {
    throw new Error("disk delete unavailable");
  });

  assert.equal(coordinator.isDeleteFenced(ownerKey), true);
  await assert.rejects(deletion, /disk delete unavailable/);
  assert.equal(coordinator.isDeleteFenced(ownerKey), false);
  assert.equal(await coordinator.save(ownerKey, async () => "saved-after-retry"), "saved-after-retry");
});

test("workspace clear fences queued and in-flight saves before durable clear and tombstones old owners", async () => {
  const coordinator = createProjectSessionMutationCoordinator();
  const workspaceKey = "workspace-a";
  const ownerKey = `${workspaceKey}\u00007`;
  const dormantOwnerKey = `${workspaceKey}\u00008`;
  const duringClearOwnerKey = `${workspaceKey}\u00009`;
  const newOwnerKey = `${workspaceKey}\u000010`;
  const firstGate = deferred();
  const calls = [];
  const firstSave = coordinator.save(ownerKey, async () => {
    calls.push("save-1:start");
    await firstGate.promise;
    calls.push("save-1:end");
    return "saved-1";
  });
  const queuedSave = coordinator.save(ownerKey, async () => {
    calls.push("save-2");
    return "saved-2";
  });
  await new Promise((resolve) => setImmediate(resolve));

  const clear = coordinator.clear(workspaceKey, [ownerKey, dormantOwnerKey], async () => {
    calls.push("clear");
  });
  assert.equal(coordinator.isWorkspaceClearFenced(workspaceKey), true);
  assert.equal(coordinator.isDeleteFenced(ownerKey), true);
  assert.equal(coordinator.isDeleteFenced(dormantOwnerKey), true);

  await assert.rejects(
    coordinator.save(duringClearOwnerKey, async () => {
      calls.push("save-during-clear");
    }),
    (error) => error instanceof ProjectSessionWorkspaceClearFencedError,
  );
  assert.equal(coordinator.isDeleteFenced(duringClearOwnerKey), true);

  firstGate.resolve();
  assert.equal(await firstSave, "saved-1");
  await assert.rejects(
    queuedSave,
    (error) => error instanceof ProjectSessionWorkspaceClearFencedError,
  );
  await clear;

  assert.deepEqual(calls, ["save-1:start", "save-1:end", "clear"]);
  assert.equal(coordinator.isWorkspaceClearFenced(workspaceKey), false);
  for (const staleOwnerKey of [ownerKey, dormantOwnerKey, duringClearOwnerKey]) {
    await assert.rejects(
      coordinator.save(staleOwnerKey, async () => "resurrected"),
      (error) => error instanceof ProjectSessionDeleteFencedError,
    );
  }
  assert.equal(
    await coordinator.save(newOwnerKey, async () => "new-session-saved"),
    "new-session-saved",
  );
});

test("failed workspace clear releases its bulk fence and owner claims", async () => {
  const coordinator = createProjectSessionMutationCoordinator();
  const workspaceKey = "workspace-b";
  const ownerKey = `${workspaceKey}\u000011`;
  const clear = coordinator.clear(workspaceKey, [ownerKey], async () => {
    throw new Error("clear unavailable");
  });

  assert.equal(coordinator.isWorkspaceClearFenced(workspaceKey), true);
  assert.equal(coordinator.isDeleteFenced(ownerKey), true);
  await assert.rejects(clear, /clear unavailable/);
  assert.equal(coordinator.isWorkspaceClearFenced(workspaceKey), false);
  assert.equal(coordinator.isDeleteFenced(ownerKey), false);
  assert.equal(await coordinator.save(ownerKey, async () => "retry-saved"), "retry-saved");
});
