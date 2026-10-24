import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export async function snapshotUnityProject(project, prefixes) {
  const files = {}, directories = [];
  const visit = async relative => {
    const absolute = path.join(project, relative);
    const stat = await fs.lstat(absolute).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Refusing to snapshot a linked project path: ${relative}`);
    if (stat.isDirectory()) {
      directories.push(relative);
      for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const content = await fs.readFile(absolute);
      files[relative] = { sha256: createHash("sha256").update(content).digest("hex"), content: content.toString("base64"), mode: stat.mode };
    }
  };
  for (const prefix of prefixes) await visit(prefix);
  return { prefixes, directories, files };
}

export const snapshotHashes = snapshot => Object.fromEntries(Object.entries(snapshot.files).map(([name, value]) => [name, value.sha256]));
export async function writeUnitySnapshot(file, snapshot) { await fs.writeFile(file, gzipSync(JSON.stringify(snapshot))); }
export async function readUnitySnapshot(file) { return JSON.parse(gunzipSync(await fs.readFile(file))); }

/** Restore only this test's known file delta in the existing project. A user
 * edit after the recorded end-of-round snapshot blocks the entire restore. */
export async function restoreUnityProjectSnapshot(project, baseline, expectedHashes) {
  const current = await snapshotUnityProject(project, baseline.prefixes);
  const currentHashes = snapshotHashes(current);
  const names = [...new Set([...Object.keys(currentHashes), ...Object.keys(expectedHashes)])];
  const concurrent = names.filter(name => currentHashes[name] !== expectedHashes[name]);
  if (concurrent.length) throw new Error(`Project changed after the test snapshot; restore refused: ${concurrent.join(", ")}`);
  const changed = [...new Set([...names, ...Object.keys(baseline.files)])].filter(name => currentHashes[name] !== baseline.files[name]?.sha256);
  for (const name of changed) {
    const absolute = path.resolve(project, name);
    if (!absolute.startsWith(path.resolve(project) + path.sep)) throw new Error("Snapshot path escaped the project");
    const saved = baseline.files[name];
    if (saved) {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, Buffer.from(saved.content, "base64"), { mode: saved.mode });
      await fs.chmod(absolute, saved.mode & 0o777);
    } else {
      await fs.unlink(absolute);
      // Remove only newly empty test directories; keep all unrelated content.
      let parent = path.dirname(absolute);
      while (parent !== path.resolve(project)) {
        if (baseline.directories.includes(path.relative(project, parent))) break;
        try { await fs.rmdir(parent); } catch { break; }
        parent = path.dirname(parent);
      }
    }
  }
  for (const relative of baseline.directories) await fs.mkdir(path.join(project, relative), { recursive: true });
  return { restored: changed, hashes: snapshotHashes(await snapshotUnityProject(project, baseline.prefixes)) };
}
