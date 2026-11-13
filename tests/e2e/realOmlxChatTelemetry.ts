import type { Page, TestInfo } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Test-host diagnostics only. Stable output lives outside Playwright's
 * disposable outputDir and never changes admission or runtime state. */
export async function createRealOmlxChatTelemetry(page: Page, testInfo: TestInfo) {
  const evidenceRoot = String(process.env.REAL_OMLX_PROTOCOL_EVIDENCE_DIR || "").trim() ||
    path.resolve("test-results/main-product-validation/chat-live-telemetry");
  const directory = path.join(evidenceRoot, "chat-telemetry",
    `${createHash("sha256").update(testInfo.testId).digest("hex").slice(0, 12)}-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  let lastGood: any = null;
  let sequence = 0;
  const latestPath = path.join(directory, "chat-live-latest.json");
  const atomicWrite = async (name: string, value: unknown) => {
    const target = path.join(directory, name);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2));
    await fs.rename(temporary, target);
  };
  // Opt-in diagnostic only: CDP can interrupt a busy renderer even when an
  // ordinary page.evaluate cannot run. Never changes the normal test outcome.
  let stopProfile: (() => Promise<void>) | null = null;
  if (process.env.REAL_OMLX_CHAT_PROFILE === "1") {
    const inspector = await page.context().newCDPSession(page);
    const scripts = new Map<string, unknown>();
    inspector.on("Debugger.scriptParsed", script => scripts.set(script.scriptId, script));
    await inspector.send("Debugger.enable");
    await inspector.send("Profiler.enable");
    await inspector.send("Profiler.start");
    let task: Promise<void> | null = null;
    const timer = setTimeout(() => {
      task = (async () => {
        const paused = new Promise<any>(resolve => inspector.once("Debugger.paused", resolve));
        await inspector.send("Debugger.pause");
        const state = await paused;
        try {
          const profile = await inspector.send("Profiler.stop");
          await atomicWrite("renderer-cpu-profile.json", profile);
          await atomicWrite("renderer-paused-stack.json", { hostAt: Date.now(), state,
            scripts: state.callFrames.map((frame: any) => scripts.get(frame.location.scriptId)) });
          const scriptId = state.callFrames[0]?.location.scriptId;
          if (scriptId) {
            const source = await inspector.send("Debugger.getScriptSource", { scriptId });
            await fs.writeFile(path.join(directory, "renderer-top-script.js"), source.scriptSource);
          }
        } finally { await inspector.send("Debugger.resume"); }
      })().catch(async error => {
        await atomicWrite("renderer-profile-error.json", { at: Date.now(), error: String(error) }).catch(() => {});
      });
    }, 15_000);
    stopProfile = async () => {
      clearTimeout(timer);
      if (task) await task;
      await inspector.detach().catch(() => {});
    };
  }
  return {
    directory,
    async capture(stage: string, metadata?: Record<string, unknown>, retainStage = false) {
      const hostAt = Date.now();
      const captured = await page.evaluate(() => {
        const bridge = (window as any).__CODELY_E2E__;
        const snapshot = bridge?.getSnapshot?.() || null;
        const readOnly = bridge?.readOnlySnapshot?.() || null;
        return {
          browserAt: Date.now(), snapshot, readOnly,
          debugTail: ((window as any).__REAL_OMLX_DEBUG_LOGS__ || []).slice(-200),
          owner: {
            workspace: snapshot?.currentWorkspace ?? null,
            sessionId: snapshot?.currentSessionId ?? null,
            turnId: snapshot?.currentTurnId ?? null,
            runId: snapshot?.currentRunId ?? null,
            parentRunId: snapshot?.parentRunId ?? null,
            marker: snapshot?.harnessRunMarker ?? null,
            canonicalTurn: readOnly?.aggregate?.turn ?? null,
            canonicalRun: readOnly?.aggregate?.run ?? null,
          },
        };
      });
      if (!captured.snapshot || !captured.readOnly) throw new Error("CHAT_TELEMETRY_BRIDGE_SNAPSHOT_UNAVAILABLE");
      lastGood = { sequence: ++sequence, stage, hostAt, recordedAt: Date.now(), metadata: metadata || null, ...captured };
      await atomicWrite("chat-live-latest.json", lastGood);
      if (retainStage) await atomicWrite(`${stage}.json`, lastGood);
      return captured;
    },
    async recordFailure(error: unknown) {
      // The page may already be closed. Preserve the last successful capture;
      // a null or failed late page.evaluate must never replace it.
      await atomicWrite("chat-live-failure.json", { at: Date.now(), error: error instanceof Error ?
        { name: error.name, message: error.message, stack: error.stack } : String(error), lastGood });
    },
    async finish() {
      await stopProfile?.();
      await atomicWrite("chat-live-finally.json", { at: Date.now(), lastGood });
      if (lastGood) await testInfo.attach("chat-live-latest", { path: latestPath, contentType: "application/json" });
      console.log(`[real-omlx-chat-telemetry] ${directory}`);
    },
  };
}
