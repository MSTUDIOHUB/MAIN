import type { StudioCatalogLanguage, StudioWorkflowCommandSlug } from "./gameStudioCatalog";

export type GameStudioCommandMarkdownFrontmatter = {
  name?: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string;
};

export type ParsedGameStudioCommandMarkdown = {
  frontmatter: GameStudioCommandMarkdownFrontmatter;
  body: string;
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterField(frontmatter: string, field: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? stripQuotes(match[1] || "") || undefined : undefined;
}

export function parseGameStudioCommandMarkdown(raw: string): ParsedGameStudioCommandMarkdown {
  const source = String(raw || "").replace(/\r\n/g, "\n");
  const frontmatterMatch = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatterMatch) {
    return {
      frontmatter: {},
      body: source.trim(),
    };
  }

  const frontmatter = frontmatterMatch[1] || "";
  return {
    frontmatter: {
      name: parseFrontmatterField(frontmatter, "name"),
      description: parseFrontmatterField(frontmatter, "description"),
      argumentHint: parseFrontmatterField(frontmatter, "argument-hint"),
      allowedTools: parseFrontmatterField(frontmatter, "allowed-tools"),
    },
    body: source.slice(frontmatterMatch[0].length).trim(),
  };
}

export function rewriteGameStudioCommandDocDisplayPaths(content: string): string {
  return String(content || "")
    .replace(/\.claude\/docs\/templates\//g, ".MAIN/templates/game-studio/")
    .replace(/\.claude\/skills\/\*\/SKILL\.md/g, ".protocols/game-studio/commands/*.md")
    .replace(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/g, ".protocols/game-studio/commands/$1.md")
    .replace(/\.claude\/docs\//g, ".protocols/game-studio/docs/")
    .replace(/\.claude\/agents\//g, ".protocols/game-studio/agents/");
}

function buildMetadataLines(params: {
  slug: StudioWorkflowCommandSlug;
  language: StudioCatalogLanguage;
  frontmatter: GameStudioCommandMarkdownFrontmatter;
}): string[] {
  const { slug, language, frontmatter } = params;
  const lines: string[] = [];
  const description = frontmatter.description?.trim();
  const argumentHint = frontmatter.argumentHint?.trim();
  const allowedTools = frontmatter.allowedTools?.trim();

  if (description) {
    lines.push(`> ${description}`);
    lines.push("");
  }

  if (language === "en") {
    lines.push(`- Command: \`/${slug}\``);
    if (argumentHint) lines.push(`- Arguments: \`${argumentHint}\``);
    if (allowedTools) lines.push(`- Source tools: \`${allowedTools}\``);
    return lines;
  }

  lines.push(`- 命令：\`/${slug}\``);
  if (argumentHint) lines.push(`- 参数：\`${argumentHint}\``);
  if (allowedTools) lines.push(`- 源项目工具：\`${allowedTools}\``);
  return lines;
}

export function formatGameStudioCommandDocForDisplay(params: {
  slug: StudioWorkflowCommandSlug;
  rawMarkdown: string;
  language: StudioCatalogLanguage;
}): string {
  const parsed = parseGameStudioCommandMarkdown(params.rawMarkdown);
  const body = rewriteGameStudioCommandDocDisplayPaths(parsed.body);
  const metadataLines = buildMetadataLines({
    slug: params.slug,
    language: params.language,
    frontmatter: parsed.frontmatter,
  });

  return [
    `# /${params.slug}`,
    "",
    ...metadataLines,
    "",
    "---",
    "",
    body,
  ]
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function formatMissingGameStudioCommandDoc(params: {
  requested: string;
  language: StudioCatalogLanguage;
  suggestions: StudioWorkflowCommandSlug[];
}): string {
  const requested = params.requested.trim() || "(empty)";
  if (params.language === "en") {
    return [
      `# Command Not Found`,
      "",
      `No Game Studio command document matched \`${requested}\`.`,
      "",
      params.suggestions.length > 0 ? "## Close Matches" : "",
      ...params.suggestions.map((slug) => `- \`/${slug}\``),
    ].filter(Boolean).join("\n");
  }

  return [
    "# 未找到命令文档",
    "",
    `没有匹配 \`${requested}\` 的 Game Studio 命令文档。`,
    "",
    params.suggestions.length > 0 ? "## 相近命令" : "",
    ...params.suggestions.map((slug) => `- \`/${slug}\``),
  ].filter(Boolean).join("\n");
}
