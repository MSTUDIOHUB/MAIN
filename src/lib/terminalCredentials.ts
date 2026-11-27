const REDACTED = "[REDACTED]";
const TERMINAL_CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\n]*(?:\u0007|\u001b\\)|\u001bP[^\n]*?\u001b\\/g;
const ACCESS_TOKEN_ARGUMENT = /(^|[\s"'`(=\[\]{,:])(--?access[-_]?token(?:(?:[ \t]|\\t)*=(?:[ \t]|\\t)*|(?:[ \t]|\\t)+))(?:((?:\\?")|(?:\\?'))(.*?)\3|(\[REDACTED\]|[^\s\\"',;\]})]+)|(\\?["'])([^\r\n]+))/gi;

/** Unity exposes its Editor credential in process listings as -accessToken. */
export function redactTerminalCredentials(value: string): string {
  if (typeof value !== "string" || !value.includes("-")) return value;
  const visible = value.replace(TERMINAL_CONTROL, "");
  const redacted = visible.replace(ACCESS_TOKEN_ARGUMENT,
    (match, boundary, flag, quote, quoted, plain, openQuote, openValue) => {
      if (quote && !quoted) return match;
      if (plain === REDACTED) return match;
      if (openValue) return `${boundary}${flag}${openQuote}${REDACTED}`;
      return `${boundary}${flag}${quote || ""}${REDACTED}${quote || ""}`;
    });
  return redacted === visible ? value : redacted;
}

/** Learn exact Unity token values only from known terminal receipts. Older
 * transcripts may also contain verbatim copies without the argument name. */
export function collectTerminalCredentialValues(output: string, values: Set<string>): void {
  if (!output.includes("-")) return;
  const visible = output.replace(TERMINAL_CONTROL, "");
  for (const match of visible.matchAll(ACCESS_TOKEN_ARGUMENT)) {
    const value = match[4] || match[5] || match[7] || "";
    if (/^[a-z0-9._~+/=-]{16,}$/i.test(value)) values.add(value);
  }
}

/** Copy changed JSON values only. Runtime ledgers go through their own codec. */
export function mapReceiptText<T>(value: T, map: (text: string) => string): T {
  if (typeof value === "string") return map(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map(item => mapReceiptText(item, map));
    return (items.some((item, index) => item !== value[index]) ? items : value) as T;
  }
  const entries = Object.entries(value);
  const items = entries.map(([key, item]) => [key, mapReceiptText(item, map)]);
  return (items.some((entry, index) => entry[1] !== entries[index][1]) ? Object.fromEntries(items) : value) as T;
}

export function createKnownTerminalCredentialRedactor(values: ReadonlySet<string>): (text: string) => string {
  // A truncated copy may have been found before the complete credential.
  const ordered = [...values].sort((left, right) => right.length - left.length);
  return (text) => {
    for (const value of ordered) if (text.includes(value)) text = text.split(value).join(REDACTED);
    return text;
  };
}
