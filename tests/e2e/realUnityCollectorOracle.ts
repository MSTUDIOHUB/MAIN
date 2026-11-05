import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { assessUnityConsole } from "./unityConsoleAssessment";

const cli = process.env.MAIN_UNITY_CLI || path.join(process.env.HOME || "", ".unity/bin/unity");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runUnityCli(project: string, args: string[], timeout = 60_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const separator = args.indexOf("--");
    const before = separator < 0 ? args : args.slice(0, separator);
    const after = separator < 0 ? [] : args.slice(separator);
    const child = spawn(cli, [...before, "--caller", "plugin", "--skill", "unity-cli", "--format", "json", "--no-pager", ...after],
      { env: { ...process.env, UNITY_NON_INTERACTIVE: "1", UNITY_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"], cwd: project });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Unity CLI timeout: ${args.slice(0, 3).join(" ")}`)); }, timeout);
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code) return reject(new Error(`Unity CLI exit ${code}: ${(stdout || stderr).slice(-3000)}`));
      try {
        const result = JSON.parse(stdout);
        if (result.success === false || result.Success === false) throw new Error(JSON.stringify(result));
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

const readStateCode = `
var objects = UnityEngine.Resources.FindObjectsOfTypeAll<UnityEngine.GameObject>();
var list = new System.Collections.Generic.List<object>();
object score = null, won = null; bool readOnlyContract = false;
foreach (var go in objects) {
  if (!go.scene.IsValid()) continue;
  if (go.name == "Player" || go.name == "Coin_1" || go.name == "Coin_2" || go.name == "Coin_3") {
    var p = go.transform.position;
    list.Add(new { name = go.name, active = go.activeInHierarchy, position = new [] { p.x, p.y, p.z } });
  }
  if (go.name != "CollectorGame") continue;
  foreach (var component in go.GetComponents<UnityEngine.MonoBehaviour>()) {
    if (component == null || component.GetType().Name != "CollectorGame") continue;
    var type = component.GetType(); var s = type.GetProperty("Score"); var w = type.GetProperty("Won");
    if (s != null && w != null) { score = s.GetValue(component); won = w.GetValue(component);
      readOnlyContract = s.GetSetMethod() == null && w.GetSetMethod() == null; }
  }
}
return new { playing = UnityEngine.Application.isPlaying, paused = UnityEditor.EditorApplication.isPaused,
  frame = UnityEngine.Time.frameCount, score, won, readOnlyContract, objects = list };
`;

/** Independent input-path oracle. Eval reads state only; all interaction uses Pipeline Input System injection. */
export async function verifyUnityCollector(project: string, evidenceDir: string) {
  const consoleBaseline = process.env.REAL_UNITY_CONSOLE_BASELINE ? JSON.parse(process.env.REAL_UNITY_CONSOLE_BASELINE) : undefined;
  const observations: any[] = [], gaps: string[] = [];
  const report = { gaps, observations, sceneSaved: false, framesAdvanced: false, movementVerified: false,
    collectionVerified: false, victoryVerified: false, restartVerified: false, screenshotPath: "", consoleChecked: false,
    userInteractionVerified: false, inputPath: "Pipeline runtime simulate_key → Input System → game Update" };
  const invoke = async (command: string, parameters: Record<string, unknown> = {}) => {
    const args = ["command", ...command.split(" "), "--project-path", project, "--result-only", "--"];
    for (const [key, value] of Object.entries(parameters)) args.push(`--${key}`, typeof value === "string" ? value : JSON.stringify(value));
    const result = await runUnityCli(project, args);
    const body = result.data?.result ?? result.result ?? result.data ?? result;
    observations.push({ at: new Date().toISOString(), command, parameters, result: body });
    if (body?.success === false || body?.Success === false) throw new Error(JSON.stringify(body));
    return body;
  };
  const read = async () => await invoke("eval", { code: readStateCode });
  const key = async (name: string, duration = 100) => {
    await invoke("runtime simulate_key", { key: name, action: "down" });
    try { await delay(duration); } finally { await invoke("runtime simulate_key", { key: name, action: "up" }); }
  };
  const player = (state: any) => state.objects?.find((object: any) => object.name === "Player" && object.active);
  let enteredPlay = false;
  try {
    report.sceneSaved = (await fs.stat(path.join(project, "Assets/Scenes/CollectorTest.unity")).catch(() => null))?.isFile() === true;
    if (!report.sceneSaved) { gaps.push("CollectorTest.unity was not saved; actual game interaction cannot start."); return report; }
    // Background Editor progress and compilation health precede script eval.
    // A failed compilation cannot be assessed by queuing eval and treating a
    // Pipeline timeout as a game/input failure.
    await invoke("editor set_auto_tick", { enable: true, interval_ms: 16, persist: false });
    const beforeErrors = await invoke("console get", { tail: 100, level: "error" });
    const beforeHealth = assessUnityConsole(beforeErrors, consoleBaseline);
    report.consoleChecked = true;
    if (beforeHealth.compilationFailed || beforeHealth.errors.length) throw new Error(`Console compilationFailed=${beforeHealth.compilationFailed}, newErrors=${beforeHealth.errors.length} before Play; input verification did not start.`);
    const state = await read();
    if (state.playing) await invoke("editor.playmode stop");
    await invoke("scene open", { path: "Assets/Scenes/CollectorTest.unity" });
    await invoke("editor.playmode set_run_in_background", { enable: true });
    await invoke("editor.playmode start"); enteredPlay = true;
    // Starting Play may reload the domain. Reachability, then actual frame change, are separate checks.
    let initial: any;
    for (let retry = 0; retry < 15; retry++) {
      try { initial = await read(); if (initial.playing) break; } catch { /* bounded domain-reload wait */ }
      await delay(500);
    }
    if (!initial?.playing) throw new Error("Play did not become reachable.");
    await delay(250); let current = await read();
    report.framesAdvanced = current.frame > initial.frame;
    if (!report.framesAdvanced) throw new Error("Play entered but no real frame advanced.");
    if (!current.readOnlyContract || !player(current) || current.score !== 0 || current.won !== false)
      throw new Error("Initial public Score/Won contract or initial Player/game state is invalid.");
    const start = [...player(current).position];
    await key("W", 100); current = await read();
    report.movementVerified = Math.hypot(player(current).position[0] - start[0], player(current).position[1] - start[1]) > 0.02;
    if (!report.movementVerified) throw new Error("Pipeline W input did not move Player.");
    await key("R", 80); current = await read();
    let previousScore = current.score;
    const collected: number[] = [];
    // Feedback control uses observed positions; it never writes coordinates or invokes game methods.
    for (let move = 0; move < 45 && current.score < 3; move++) {
      const p = player(current)?.position;
      const coin = current.objects?.filter((object: any) => /^Coin_[123]$/.test(object.name) && object.active)
        .sort((a: any, b: any) => Math.hypot(a.position[0] - p[0], a.position[1] - p[1]) - Math.hypot(b.position[0] - p[0], b.position[1] - p[1]))[0];
      if (!p || !coin) throw new Error("Active Player or remaining coin is missing before Score reached 3.");
      const dx = coin.position[0] - p[0], dy = coin.position[1] - p[1];
      const name = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "D" : "A" : dy > 0 ? "W" : "S";
      await key(name, 20); current = await read();
      if (current.score > previousScore) { collected.push(current.score); previousScore = current.score; }
    }
    report.collectionVerified = collected.includes(1) && collected.includes(2) && collected.includes(3) &&
      current.objects.filter((object: any) => /^Coin_[123]$/.test(object.name) && object.active).length === 0;
    report.victoryVerified = current.score === 3 && current.won === true;
    if (!report.collectionVerified || !report.victoryVerified) throw new Error("Three separate input-driven collections and victory were not observed within the bounded control run.");
    report.screenshotPath = path.join(evidenceDir, "unity-victory.png");
    await invoke("capture game_view", { source: "screen", save_path: "Screenshots/oracle-victory.png" });
    await fs.copyFile(path.join(project, "Screenshots/oracle-victory.png"), report.screenshotPath);
    if (!(await fs.stat(report.screenshotPath)).size) throw new Error("HUD screenshot was not saved.");
    await key("R", 80); current = await read();
    report.restartVerified = current.score === 0 && current.won === false &&
      current.objects.filter((object: any) => /^Coin_[123]$/.test(object.name) && object.active).length === 3 &&
      Math.hypot(player(current).position[0] - start[0], player(current).position[1] - start[1]) < 0.1;
    if (!report.restartVerified) throw new Error("R input failed to restore Player, coins, Score and Won.");
    const errors = await invoke("console get", { tail: 100, level: "error" });
    const finalHealth = assessUnityConsole(errors, consoleBaseline);
    report.consoleChecked = true;
    if (finalHealth.compilationFailed || finalHealth.errors.length) throw new Error("Console contains new errors or a compilation failure after input verification.");
    report.userInteractionVerified = true;
  } catch (error) { gaps.push(error instanceof Error ? error.message : String(error)); }
  finally {
    if (enteredPlay) { try { await invoke("editor.playmode stop"); } catch (error) { gaps.push(`Play cleanup failed: ${String(error)}`); report.userInteractionVerified = false; } }
    await fs.writeFile(path.join(evidenceDir, "unity-oracle.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
