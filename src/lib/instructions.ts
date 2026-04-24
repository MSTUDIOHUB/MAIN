import { globSearch, readFile } from "./ipc";

export type InstructionSourceKind =
  | "legacy"
  | "workspace_agent"
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
    return { body: raw.trim(), paths: [] };
  }

  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 3) {
    return { body: raw.trim(), paths: [] };
  }

  const frontmatter = parts[1] ?? "";
  const body = parts.slice(2).join("---").trim();
  const lines = frontmatter.split(/\r?\n/);
  const paths: string[] = [];
  let collectingPaths = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

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
  };
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path);
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
  _workspace: string,
  skills: InstructionSkillLike[],
  associatedPaths: string[] = [],
): Promise<ResolvedInstructionSet> {
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
    const content = await tryRead(legacyPath);
    if (!content) continue;
    pushLayer(legacyPath.split("/").pop() || legacyPath, "legacy", content, {
      path: legacyPath,
    });
  }

  const cursorRuleFiles = await globSearch(".cursor/rules/*.md").catch(() => []);
  for (const rulePath of cursorRuleFiles) {
    const content = await tryRead(rulePath);
    if (!content) continue;
    pushLayer(rulePath.split("/").pop() || rulePath, "legacy", content, {
      path: rulePath,
    });
  }

  const agentContent = await tryRead("AGENT.md");
  if (agentContent) {
    pushLayer("AGENT.md", "workspace_agent", agentContent, { path: "AGENT.md" });
  }

  const scopedRuleFiles = await globSearch(".MAIN/rules/*.md").catch(() => []);
  const scopedRules: ScopedRule[] = [];

  for (const rulePath of scopedRuleFiles) {
    const content = await tryRead(rulePath);
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

  const templateFiles = await globSearch(".MAIN/templates/**/*.md").catch(() => []);
  for (const templatePath of templateFiles) {
    if (normalizePath(templatePath).startsWith(".MAIN/templates/game-studio/")) {
      continue;
    }
    const content = await tryRead(templatePath);
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
