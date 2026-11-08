import type { KnowledgeReference } from "./knowledgeReferences";

export interface KnowledgePickerSession { readonly anchor: number; readonly query: string }
export interface KnowledgePickerCandidate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: "base" | "source";
  readonly reference: KnowledgeReference;
  readonly ready: boolean;
}

const QUERY = /^[\p{L}\p{N}_.:/-]*$/u;

export function getKnowledgePickerSession(value: string, cursor: number): KnowledgePickerSession | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const before = value.slice(0, cursor);
  const anchor = before.lastIndexOf("#");
  if (anchor < 0 || (anchor > 0 && !/\s/u.test(before[anchor - 1]!))) return null;
  const query = before.slice(anchor + 1);
  return QUERY.test(query) ? { anchor, query } : null;
}

/** Only selecting a concrete candidate creates a reference. Markdown is left intact. */
export function applyKnowledgePickerSelection(value: string, cursor: number, session: KnowledgePickerSession): { value: string; cursor: number } | null {
  const current = getKnowledgePickerSession(value, cursor);
  if (!current || current.anchor !== session.anchor || current.query !== session.query) return null;
  let end = cursor;
  while (end < value.length && QUERY.test(value[end]!) && value[end] !== "") end++;
  return { value: value.slice(0, session.anchor) + value.slice(end), cursor: session.anchor };
}

export function filterKnowledgePickerCandidates(candidates: readonly KnowledgePickerCandidate[], query: string): KnowledgePickerCandidate[] {
  const term = query.toLocaleLowerCase();
  return candidates.filter(item => !term || `${item.label}\n${item.description}`.toLocaleLowerCase().includes(term))
    .sort((a, b) => Number(!a.label.toLocaleLowerCase().startsWith(term)) - Number(!b.label.toLocaleLowerCase().startsWith(term)) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
