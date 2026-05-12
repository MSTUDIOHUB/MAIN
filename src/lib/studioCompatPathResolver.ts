export type StudioCompatPathAliasRule =
  | "docs"
  | "agents"
  | "skill_command"
  | "templates";

export interface StudioCompatPathAliasHit {
  tool: string;
  field: string;
  from: string;
  to: string;
  rule: StudioCompatPathAliasRule;
}

type PathAliasResolution = {
  path: string;
  rule: StudioCompatPathAliasRule | null;
};

function normalizeSlashPath(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

function stripRelativeDotPrefix(value: string): { value: string; hadDotPrefix: boolean } {
  const normalized = normalizeSlashPath(value);
  if (normalized.startsWith("./")) {
    return { value: normalized.slice(2), hadDotPrefix: true };
  }
  return { value: normalized, hadDotPrefix: false };
}

function restoreRelativeDotPrefix(value: string, hadDotPrefix: boolean): string {
  if (!hadDotPrefix || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return value;
  return `./${value}`;
}

function resolveStudioCompatPath(path: string): PathAliasResolution {
  const { value, hadDotPrefix } = stripRelativeDotPrefix(path);
  if (!value.startsWith(".claude/")) return { path: normalizeSlashPath(path), rule: null };

  let mapped = "";
  let rule: StudioCompatPathAliasRule | null = null;

  if (value === ".claude/docs/templates") {
    mapped = ".MAIN/templates/game-studio";
    rule = "templates";
  } else if (value.startsWith(".claude/docs/templates/")) {
    mapped = `.MAIN/templates/game-studio/${value.slice(".claude/docs/templates/".length)}`;
    rule = "templates";
  } else if (value === ".claude/docs") {
    mapped = ".protocols/game-studio/docs";
    rule = "docs";
  } else if (value.startsWith(".claude/docs/")) {
    mapped = `.protocols/game-studio/docs/${value.slice(".claude/docs/".length)}`;
    rule = "docs";
  } else if (value === ".claude/agents") {
    mapped = ".protocols/game-studio/agents";
    rule = "agents";
  } else if (value.startsWith(".claude/agents/")) {
    mapped = `.protocols/game-studio/agents/${value.slice(".claude/agents/".length)}`;
    rule = "agents";
  } else {
    const skillMatch = value.match(/^\.claude\/skills\/([^/]+)\/SKILL\.md$/i);
    if (skillMatch) {
      mapped = `.protocols/game-studio/commands/${skillMatch[1]}.md`;
      rule = "skill_command";
    }
  }

  if (!mapped || !rule) return { path: normalizeSlashPath(path), rule: null };
  return {
    path: restoreRelativeDotPrefix(mapped, hadDotPrefix),
    rule,
  };
}

function withMappedField(
  tool: string,
  args: Record<string, unknown>,
  field: string,
): { args: Record<string, unknown>; hit: StudioCompatPathAliasHit | null } {
  const raw = args[field];
  if (typeof raw !== "string" || !raw.trim()) return { args, hit: null };
  const resolved = resolveStudioCompatPath(raw);
  if (!resolved.rule || resolved.path === raw) return { args, hit: null };
  return {
    args: {
      ...args,
      [field]: resolved.path,
    },
    hit: {
      tool,
      field,
      from: raw,
      to: resolved.path,
      rule: resolved.rule,
    },
  };
}

export function resolveStudioCompatToolArgs(
  tool: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; hits: StudioCompatPathAliasHit[] } {
  const name = String(tool || "").trim();
  let nextArgs = { ...args };
  const hits: StudioCompatPathAliasHit[] = [];

  const capture = (field: string) => {
    const mapped = withMappedField(name, nextArgs, field);
    nextArgs = mapped.args;
    if (mapped.hit) hits.push(mapped.hit);
  };

  switch (name) {
    case "read_file":
    case "list_directory":
    case "write_file":
    case "replace_in_file":
      capture("path");
      break;
    case "grep_search":
      capture("path");
      break;
    case "glob_search":
      capture("pattern");
      break;
    default:
      break;
  }

  return { args: nextArgs, hits };
}
