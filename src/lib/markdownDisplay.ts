const MATH_INLINE_PREFIX = "math:";

const UNSAFE_HTML_BLOCK_RE =
  /<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi;
const UNSAFE_HTML_TAG_RE =
  /<\/?(?:script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option)\b[^>]*>/gi;
const FENCED_CODE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

function stripUnsafeMarkdownHtml(content: string): string {
  if (!content) return "";
  return content
    .replace(UNSAFE_HTML_BLOCK_RE, "")
    .replace(UNSAFE_HTML_TAG_RE, "");
}

function isLikelyMathExpression(value: string): boolean {
  const text = String(value || "").trim();
  if (!text || text.length > 220) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/[\\^_{}=+\-*/<>|()[\]]/.test(text)) return true;
  return /\b(?:sum|frac|sqrt|alpha|beta|gamma|theta|lambda|int|lim|log|sin|cos|tan)\b/i.test(text);
}

function toInlineMathCode(value: string): string {
  const clean = String(value || "").trim().replace(/`/g, "'");
  return `\`${MATH_INLINE_PREFIX}${clean}\``;
}

function transformMathOutsideCode(content: string): string {
  if (!content) return "";

  return content
    .replace(/(^|\n)[ \t]*\$\$([\s\S]*?)\$\$[ \t]*(?=\n|$)/g, (_match, prefix: string, body: string) => {
      const clean = String(body || "").trim();
      return clean ? `${prefix}\n\`\`\`math\n${clean}\n\`\`\`\n` : prefix;
    })
    .replace(/(^|\n)[ \t]*\\\[([\s\S]*?)\\\][ \t]*(?=\n|$)/g, (_match, prefix: string, body: string) => {
      const clean = String(body || "").trim();
      return clean ? `${prefix}\n\`\`\`math\n${clean}\n\`\`\`\n` : prefix;
    })
    .replace(/\\\(([^()\n]{1,220})\\\)/g, (_match, body: string) => toInlineMathCode(body))
    .replace(/(^|[^\\$])\$([^\n$]{1,220})\$(?!\$)/g, (match: string, prefix: string, body: string) => {
      return isLikelyMathExpression(body) ? `${prefix}${toInlineMathCode(body)}` : match;
    });
}

function transformCjkSoftBreaks(content: string): string {
  return String(content || "")
    .replace(/([\u3400-\u9fff])\n(?=[\u3400-\u9fff])/g, "$1")
    .replace(/([\u3400-\u9fff])\n(?=[A-Za-z0-9])/g, "$1 ")
    .replace(/([A-Za-z0-9])\n(?=[\u3400-\u9fff])/g, "$1 ");
}

function transformOutsideFencedCode(content: string, transform: (chunk: string) => string): string {
  if (!content) return "";
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FENCED_CODE_RE.lastIndex = 0;

  while ((match = FENCED_CODE_RE.exec(content)) !== null) {
    result += transform(content.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }

  result += transform(content.slice(lastIndex));
  return result;
}

export function normalizeMarkdownForDisplay(content: string): string {
  const transformed = transformOutsideFencedCode(String(content || ""), (chunk) =>
    transformCjkSoftBreaks(transformMathOutsideCode(stripUnsafeMarkdownHtml(chunk))),
  );

  return transformed
    .replace(/\n```(?:text|plaintext|markdown)?\n([^\n`]{1,80})\n```\n/g, (_match, shortText: string) => ` \`${shortText.trim()}\` `)
    .replace(/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gim, (_, level: string) => `> **${level.toUpperCase()}**`)
    .replace(/\n{4,}/g, "\n\n\n");
}

export function isInlineMathCode(value: string): boolean {
  return String(value || "").startsWith(MATH_INLINE_PREFIX);
}

export function decodeInlineMathCode(value: string): string {
  return isInlineMathCode(value)
    ? String(value || "").slice(MATH_INLINE_PREFIX.length).trim()
    : String(value || "");
}

export function extractMarkdownNodeSource(
  source: string,
  position?: { start?: { line?: number }; end?: { line?: number } },
): string {
  if (!source || !position?.start?.line || !position?.end?.line) return "";
  const lines = String(source).split(/\r?\n/);
  return lines.slice(position.start.line - 1, position.end.line).join("\n").trim();
}

function splitMarkdownTableRow(line: string): string[] {
  const body = String(line || "").replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    const next = body[i + 1];
    if (char === "\\" && next === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

export function markdownTableToTsv(markdownTable: string): string {
  const lines = String(markdownTable || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));

  return lines
    .filter((line) => !/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line))
    .map((line) => splitMarkdownTableRow(line).join("\t"))
    .join("\n");
}
