import { buildRepositoryIndex, type RepositoryIndex, type SymbolEntry, type ImportEdge } from "./ipc";

interface RepositoryIndexWithCalls extends RepositoryIndex {
  calls?: Array<{
    from: string;
    symbol: string;
    line: number;
  }>;
}

function normalizeText(value: string): string {
  return String(value || "").toLowerCase();
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function scoreSymbol(symbol: SymbolEntry, query: string): number {
  const q = normalizeText(query);
  const name = normalizeText(symbol.name);
  const file = normalizeText(symbol.file);
  const signature = normalizeText(symbol.signature);
  let score = 0;
  if (name === q) score += 100;
  if (name.includes(q)) score += 40;
  if (file.includes(q)) score += 24;
  if (signature.includes(q)) score += 12;
  for (const part of q.split(/[^a-z0-9_$]+/i).filter((item) => item.length >= 3)) {
    if (name.includes(part)) score += 12;
    if (file.includes(part)) score += 8;
    if (signature.includes(part)) score += 4;
  }
  return score;
}

function collectFiles(index: RepositoryIndexWithCalls): Map<string, {
  file: string;
  symbols: SymbolEntry[];
  imports: ImportEdge[];
  importedBy: ImportEdge[];
  calls: NonNullable<RepositoryIndexWithCalls["calls"]>;
}> {
  const files = new Map<string, {
    file: string;
    symbols: SymbolEntry[];
    imports: ImportEdge[];
    importedBy: ImportEdge[];
    calls: NonNullable<RepositoryIndexWithCalls["calls"]>;
  }>();
  const ensure = (file: string) => {
    if (!files.has(file)) {
      files.set(file, { file, symbols: [], imports: [], importedBy: [], calls: [] });
    }
    return files.get(file)!;
  };
  for (const symbol of index.symbols || []) ensure(symbol.file).symbols.push(symbol);
  for (const edge of index.imports || []) {
    ensure(edge.from).imports.push(edge);
    if (/^(?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)/.test(edge.to)) ensure(edge.to).importedBy.push(edge);
  }
  for (const call of index.calls || []) ensure(call.from).calls.push(call);
  return files;
}

async function loadRepoMap(workspace?: string): Promise<RepositoryIndexWithCalls> {
  return await buildRepositoryIndex(workspace) as RepositoryIndexWithCalls;
}

export async function repoMapStatus(workspace?: string): Promise<string> {
  const index = await loadRepoMap(workspace);
  const files = collectFiles(index);
  return JSON.stringify({
    ok: true,
    root: index.root,
    generatedAtMs: index.generatedAtMs,
    files: files.size,
    symbols: index.symbols?.length || 0,
    imports: index.imports?.length || 0,
    calls: index.calls?.length || 0,
    storage: ".MAIN/index/repo_map.db",
    note: "MAIN built-in repo_map is local and does not require external codegraph.",
  });
}

export async function repoMapSearch(args: Record<string, unknown>, workspace?: string): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("Missing required parameter 'query'.");
  const kind = String(args.kind || "").trim().toLowerCase();
  const limit = clampLimit(args.limit, 12, 50);
  const index = await loadRepoMap(workspace);
  const matches = (index.symbols || [])
    .filter((symbol) => !kind || symbol.kind.toLowerCase() === kind)
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.line - b.symbol.line)
    .slice(0, limit)
    .map(({ symbol, score }) => ({
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      line: symbol.line,
      signature: symbol.signature,
      score,
    }));
  return JSON.stringify({ query, count: matches.length, matches });
}

export async function repoMapFiles(args: Record<string, unknown>, workspace?: string): Promise<string> {
  const filter = normalizeText(String(args.filter || ""));
  const limit = clampLimit(args.limit, 80, 240);
  const maxDepth = clampLimit(args.max_depth, 12, 32);
  const index = await loadRepoMap(workspace);
  const files = [...collectFiles(index).values()]
    .filter((entry) => !filter || normalizeText(entry.file).includes(filter))
    .filter((entry) => entry.file.split("/").length <= maxDepth)
    .sort((a, b) => a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => ({
      file: entry.file,
      symbols: entry.symbols.length,
      imports: entry.imports.length,
      calls: entry.calls.length,
      topSymbols: entry.symbols.slice(0, 6).map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.line}`),
    }));
  return JSON.stringify({ count: files.length, files });
}

export async function repoMapContext(args: Record<string, unknown>, workspace?: string): Promise<string> {
  const task = String(args.task || "").trim();
  if (!task) throw new Error("Missing required parameter 'task'.");
  const maxNodes = clampLimit(args.max_nodes, 16, 40);
  const index = await loadRepoMap(workspace);
  const scored = (index.symbols || [])
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, task) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNodes);
  const selectedFiles = new Set(scored.map((item) => item.symbol.file));
  const imports = (index.imports || [])
    .filter((edge) => selectedFiles.has(edge.from) || selectedFiles.has(edge.to))
    .slice(0, maxNodes * 2);
  const calls = (index.calls || [])
    .filter((call) => selectedFiles.has(call.from) || scored.some((item) => item.symbol.name === call.symbol))
    .slice(0, maxNodes * 2);
  return JSON.stringify({
    task,
    symbols: scored.map(({ symbol, score }) => ({
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      line: symbol.line,
      signature: symbol.signature,
      score,
    })),
    files: [...selectedFiles],
    imports,
    calls,
    note: "Use read_file with a small start_line/end_line window only for the exact file range you need to edit.",
  });
}

export async function repoMapImpact(args: Record<string, unknown>, workspace?: string): Promise<string> {
  const target = String(args.target || "").trim();
  if (!target) throw new Error("Missing required parameter 'target'.");
  const depth = clampLimit(args.depth, 2, 6);
  const index = await loadRepoMap(workspace);
  const targetText = normalizeText(target);
  const targetSymbols = (index.symbols || []).filter((symbol) =>
    normalizeText(symbol.name) === targetText ||
    normalizeText(symbol.file).includes(targetText) ||
    normalizeText(symbol.signature).includes(targetText)
  );
  const targetFiles = new Set(targetSymbols.map((symbol) => symbol.file));
  if (target.includes("/") || /\.[A-Za-z0-9]+$/.test(target)) targetFiles.add(target.replace(/^\.\//, ""));

  const impacted = new Set<string>(targetFiles);
  for (let round = 0; round < depth; round += 1) {
    for (const edge of index.imports || []) {
      if (impacted.has(edge.to) || [...impacted].some((file) => edge.to.includes(file.replace(/\.[^.]+$/, "")))) {
        impacted.add(edge.from);
      }
    }
    for (const call of index.calls || []) {
      if (targetSymbols.some((symbol) => symbol.name === call.symbol)) impacted.add(call.from);
    }
  }

  const tests = [...impacted].filter((file) => /(?:test|spec|e2e)\.(?:tsx?|jsx?|mjs|py|rs)$/i.test(file));
  return JSON.stringify({
    target,
    depth,
    targetSymbols: targetSymbols.slice(0, 16),
    impactedFiles: [...impacted].slice(0, 80),
    testCandidates: tests.slice(0, 24),
  });
}
