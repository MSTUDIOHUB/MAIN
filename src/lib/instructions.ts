import { globSearch, readFile } from "./ipc";

export type InstructionSourceKind =
  | "legacy"
  | "workspace_agent"
  | "steering"
  | "scoped_rule"
  | "template"
  | "skill";

export interface InstructionSource {
  id: string;
  name: string;
  kind: InstructionSourceKind;
  path?: string;
  enabled: boolean;
  order: number;
  matchedPaths?: string[];
}

export interface InstructionLayer {
  id: string;
  title: string;
  content: string;
  order: number;
  source: InstructionSource;
}

export interface ScopedRule {
  path: string;
  title: string;
  content: string;
  patterns: string[];
  specificity: number;
  matchedPaths: string[];
}

export interface ResolvedInstructionSet {
  layers: InstructionLayer[];
  templates: InstructionLayer[];
  sources: InstructionSource[];
  matchedRules: ScopedRule[];
  associatedPaths: string[];
  loadedAt: number;
  debugSummary: string;
}

/**
 * Render the exact instruction layers admitted at a Turn boundary.
 *
 * This is deliberately not session memory: it contains only live,
 * user-maintained instruction sources and keeps their provenance. Runtime v2
 * snapshots this string once so the parent and any later child use the same
 * rules even if the UI switches workspaces while the Turn is running.
 */
export function renderResolvedInstructionContext(
  resolved: ResolvedInstructionSet | null | undefined,
): string {
  if (!resolved?.layers.length) return "";
  return resolved.layers
    .map((layer) => {
      const source = layer.source.path || layer.source.name || layer.id;
      return [
        `## ${layer.title}`,
        `Source: ${source}`,
        layer.content.trim(),
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export interface InstructionSkillLike {
  id: string;
  name: string;
  content: string;
  active: boolean;
  type?: "instruction" | "tool" | "package";
}

type ParsedFrontmatter = {
  body: string;
  paths: string[];
  inclusion: string;
};

const LEGACY_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
] as const;

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\//, "");
}

function escapeRegExp(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let regex = "^";

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === "*" && next === "*") {
      regex += ".*";
      i += 1;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      continue;
    }

    regex += escapeRegExp(char);
  }

  regex += "$";
  return new RegExp(regex);
}

function computeSpecificity(patterns: string[]): number {
  if (patterns.length === 0) return -1;

  return Math.max(
    ...patterns.map(pattern =>
      normalizePath(pattern)
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .length,
    ),
  );
}

function extractInlineArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];

  return trimmed
    .slice(1, -1)
    .split(",")
    .map(item => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { body: raw.trim(), paths: [], inclusion: "" };
  }

  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 3) {
    return { body: raw.trim(), paths: [], inclusion: "" };
  }

  const frontmatter = parts[1] ?? "";
  const body = parts.slice(2).join("---").trim();
  const lines = frontmatter.split(/\r?\n/);
  const paths: string[] = [];
  let collectingPaths = false;
  let inclusion = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^inclusion\s*:/.test(trimmed)) {
      inclusion = trimmed
        .replace(/^inclusion\s*:\s*/, "")
        .replace(/\s+#.*$/, "")
        .trim()
        .replace(/^['"]|['"]$/g, "");
      collectingPaths = false;
      continue;
    }

    if (/^fileMatchPattern\s*:/.test(trimmed)) {
      const value = trimmed
        .replace(/^fileMatchPattern\s*:\s*/, "")
        .replace(/\s+#.*$/, "")
        .trim();
      const inline = extractInlineArray(value);
      if (inline.length > 0) {
        paths.push(...inline);
      } else if (value && value !== "|") {
        paths.push(value.replace(/^['"]|['"]$/g, ""));
      }
      collectingPaths = false;
      continue;
    }

    if (/^paths\s*:/.test(trimmed)) {
      collectingPaths = true;
      const [, value = ""] = trimmed.split(/:\s*/, 2);
      const inline = extractInlineArray(value);
      if (inline.length > 0) {
        paths.push(...inline);
        collectingPaths = false;
      } else if (value.trim() && value.trim() !== "|") {
        paths.push(value.trim().replace(/^['"]|['"]$/g, ""));
        collectingPaths = false;
      }
      continue;
    }

    if (collectingPaths && trimmed.startsWith("-")) {
      paths.push(trimmed.slice(1).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }

    collectingPaths = false;
  }

  return {
    body,
    paths: paths.map(normalizePath).filter(Boolean),
    inclusion,
  };
}

async function tryRead(
  path: string,
  workspace: string,
): Promise<string | null> {
  try {
    return await readFile(path, workspace);
  } catch {
    return null;
  }
}

function matchPatterns(patterns: string[], associatedPaths: string[]): string[] {
  if (patterns.length === 0) return [];
  if (associatedPaths.length === 0) return [];

  const matchers = patterns.map(globToRegExp);
  return associatedPaths.filter(target =>
    matchers.some(matcher => matcher.test(normalizePath(target))),
  );
}

export async function loadResolvedInstructions(
  workspace: string,
  skills: InstructionSkillLike[],
  associatedPaths: string[] = [],
): Promise<ResolvedInstructionSet> {
  const immutableWorkspace = workspace.trim();
  const normalizedAssociated = associatedPaths.map(normalizePath).filter(Boolean);
  const layers: InstructionLayer[] = [];
  const templates: InstructionLayer[] = [];
  const sources: InstructionSource[] = [];
  const matchedRules: ScopedRule[] = [];
  let order = 0;

  const pushLayer = (
    name: string,
    kind: InstructionSourceKind,
    content: string,
    options?: {
      path?: string;
      matchedPaths?: string[];
      title?: string;
      bucket?: "instructions" | "templates";
    },
  ) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    const source: InstructionSource = {
      id: `${kind}:${options?.path ?? name}:${order}`,
      name,
      kind,
      path: options?.path,
      enabled: true,
      order,
      ...(options?.matchedPaths && options.matchedPaths.length > 0
        ? { matchedPaths: options.matchedPaths }
        : {}),
    };

    const layer: InstructionLayer = {
      id: source.id,
      title: options?.title ?? name,
      content: trimmed,
      order,
      source,
    };
    if (options?.bucket === "templates") {
      templates.push(layer);
    } else {
      layers.push(layer);
    }
    sources.push(source);
    order += 1;
  };

  for (const legacyPath of LEGACY_FILES) {
    const content = await tryRead(legacyPath, immutableWorkspace);
    if (!content) continue;
    pushLayer(legacyPath.split("/").pop() || legacyPath, "legacy", content, {
      path: legacyPath,
    });
  }

  const cursorRuleFiles = await globSearch(
    ".cursor/rules/*.md",
    immutableWorkspace,
  ).catch(() => []);
  for (const rulePath of cursorRuleFiles) {
    const content = await tryRead(rulePath, immutableWorkspace);
    if (!content) continue;
    pushLayer(rulePath.split("/").pop() || rulePath, "legacy", content, {
      path: rulePath,
    });
  }

  const agentContent = await tryRead("AGENT.md", immutableWorkspace);
  if (agentContent) {
    pushLayer("AGENT.md", "workspace_agent", agentContent, { path: "AGENT.md" });
  }

  const steeringFiles = await globSearch(
    ".MAIN/steering/*.md",
    immutableWorkspace,
  ).catch(
    () => [],
  );
  for (const steeringPath of steeringFiles.sort()) {
    if (/\/README\.md$/i.test(normalizePath(steeringPath))) continue;
    const content = await tryRead(steeringPath, immutableWorkspace);
    if (!content) continue;
    const parsed = parseFrontmatter(content);
    const matched = parsed.paths.length > 0
      ? matchPatterns(parsed.paths, normalizedAssociated)
      : [];
    const shouldLoad =
      parsed.inclusion === "always" ||
      (
        parsed.inclusion === "fileMatch" &&
        parsed.paths.length > 0 &&
        matched.length > 0
      );
    if (!shouldLoad) continue;
    pushLayer(
      steeringPath.split("/").pop() || steeringPath,
      "steering",
      parsed.body,
      {
        path: steeringPath,
        matchedPaths: matched,
      },
    );
  }

  const scopedRuleFiles = await globSearch(
    ".MAIN/rules/*.md",
    immutableWorkspace,
  ).catch(() => []);
  const scopedRules: ScopedRule[] = [];

  for (const rulePath of scopedRuleFiles) {
    const content = await tryRead(rulePath, immutableWorkspace);
    if (!content) continue;

    const parsed = parseFrontmatter(content);
    const matched = parsed.paths.length > 0 ? matchPatterns(parsed.paths, normalizedAssociated) : [];

    if (parsed.paths.length > 0 && matched.length === 0) {
      continue;
    }

    scopedRules.push({
      path: rulePath,
      title: rulePath.split("/").pop() || rulePath,
      content: parsed.body,
      patterns: parsed.paths,
      specificity: computeSpecificity(parsed.paths),
      matchedPaths: matched,
    });
  }

  scopedRules
    .sort((a, b) => a.specificity - b.specificity || a.path.localeCompare(b.path))
    .forEach(rule => {
      matchedRules.push(rule);
      pushLayer(rule.title, "scoped_rule", rule.content, {
        path: rule.path,
        matchedPaths: rule.matchedPaths,
        title:
          rule.patterns.length > 0
            ? `${rule.title} (${rule.patterns.join(", ")})`
            : rule.title,
      });
    });

  const templateFiles = await globSearch(
    ".MAIN/templates/**/*.md",
    immutableWorkspace,
  ).catch(() => []);
  for (const templatePath of templateFiles) {
    if (normalizePath(templatePath).startsWith(".MAIN/templates/game-studio/")) {
      continue;
    }
    const content = await tryRead(templatePath, immutableWorkspace);
    if (!content) continue;
    const parsed = parseFrontmatter(content);
    const relativeTitle = templatePath.replace(/^\.MAIN\/templates\//, "");
    pushLayer(relativeTitle, "template", parsed.body, {
      path: templatePath,
      title: relativeTitle,
      bucket: "templates",
    });
  }

  skills
    .filter(skill => skill.active && (!skill.type || skill.type === "instruction"))
    .forEach(skill => {
      pushLayer(skill.name, "skill", skill.content, {
        path: `skill:${skill.id}`,
      });
    });

  const loadedAt = Date.now();
  const debugSummary = sources.length
    ? sources
        .map(source => {
          const parts = [source.kind, source.name];
          if (source.path) parts.push(source.path);
          if (source.matchedPaths?.length) {
            parts.push(`matched ${source.matchedPaths.length}`);
          }
          return parts.join(" · ");
        })
        .join("\n")
    : "No external instruction sources were resolved.";

  return {
    layers,
    templates,
    sources,
    matchedRules,
    associatedPaths: normalizedAssociated,
    loadedAt,
    debugSummary,
  };
}
