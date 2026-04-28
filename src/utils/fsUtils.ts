// utils/fsUtils.ts
// Workspace file scanning utilities using Tauri IPC (invoke)
// All file operations go through Rust backend via std::fs — no plugin-fs.
// ────────────────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";

/**
 * Directories to always skip during recursive traversal.
 * These are either massive (node_modules), VCS metadata (.git),
 * IDE config, or build output that would blow up token counts.
 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  ".idea", ".vscode", ".vs",
  "dist", "build", "out", "bin", "obj",
  "target", "vendor", "__pycache__", ".next",
  ".nuxt", ".cache", ".turbo", "coverage",
  ".gradle", ".dart_tool", ".fvm",
  ".cargo", ".rustup",
  "Pods", ".gradle", ".swiftpm",
]);

const SKIP_ENTRY_NAMES = new Set([
  ".DS_Store",
]);

export function shouldHideWorkspaceEntry(name: string, isDir: boolean): boolean {
  // 隐藏目录（例如 .MAIN / .protocols）需要保留给 Game Studio 访问。
  if (SKIP_ENTRY_NAMES.has(name)) return true;
  return isDir && SKIP_DIRS.has(name);
}

/**
 * Recursively walk the workspace directory and collect all file paths.
 * Returns relative paths (e.g. "src/App.tsx") to keep the list compact.
 *
 * Skips directories listed in SKIP_DIRS to prevent OOM / hang on large repos.
 * Limits total results to `maxFiles` to cap memory and token usage.
 */
export async function getAllWorkspaceFiles(
  workspacePath: string,
  maxFiles = 2000,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    if (results.length >= maxFiles) return;

    let entries;
    try {
      entries = await invoke<Array<{ name: string; is_dir: boolean }>>("list_directory", { path: dir, workspace: workspacePath });
    } catch {
      // Permission denied or path gone — skip silently
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (shouldHideWorkspaceEntry(entry.name, entry.is_dir)) continue;

      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.is_dir) {
        await walk(`${dir}/${entry.name}`, rel);
      } else {
        results.push(rel);
      }
    }
  }

  await walk(workspacePath, "");
  return results;
}

/**
 * Simple fuzzy match: checks whether every character in `query`
 * appears in `target` in order (case-insensitive).
 * Returns a score (higher = better match) or -1 if no match.
 *
 * This is intentionally lightweight — no external deps needed.
 */
export function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Bonus for consecutive matches
      score += lastMatchIdx === ti - 1 ? 3 : 1;
      // Bonus for matching at word boundary (after / _ . - or at start)
      if (ti === 0 || "/._-".includes(t[ti - 1])) score += 2;
      // Bonus for exact case match
      if (target[ti] === query[qi]) score += 1;
      lastMatchIdx = ti;
      qi++;
    }
  }

  // Must have matched all query characters
  return qi === q.length ? score : -1;
}

/**
 * Filter and rank a list of file paths by fuzzy query.
 * Returns paths sorted by match quality (best first), capped at `limit`.
 */
export function fuzzyFilterFiles(
  files: string[],
  query: string,
  limit = 20,
): string[] {
  if (!query) return files.slice(0, limit);

  const scored: Array<{ path: string; score: number }> = [];
  for (const f of files) {
    const score = fuzzyMatch(query, f);
    if (score >= 0) scored.push({ path: f, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.path);
}
