import type { Skill } from "./appTypes";
import { loadSkillCatalog, skillReference, type SkillCatalogSnapshot } from "./agentSkills";
import type { ExternalSkillSelection } from "./externalSkillSelections";
import type { ExternalSkillSources } from "./externalSkillSources";

export interface SkillPickerSession {
  readonly anchor: number;
  readonly query: string;
}

export interface SkillPickerCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceLabel: string;
  readonly packageName?: string;
  readonly entryPath: string | null;
  readonly manualOnly: boolean;
  readonly insertText: string;
}

const TOKEN = /^[\p{L}\p{N}_.:/-]*$/u;
const TOKEN_CHARACTER = /^[\p{L}\p{N}_.:/-]$/u;
const RESERVED_REFERENCE = /^s:[a-f0-9]{8}(?::[1-9]\d*)?$/;

/** Open only at a word boundary, never for escaped dollars or shell ${...}. */
export function getSkillPickerSession(value: string, cursor: number): SkillPickerSession | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const before = value.slice(0, cursor);
  const anchor = before.lastIndexOf("$");
  if (anchor < 0 || (anchor > 0 && !/\s/u.test(before[anchor - 1]!))) return null;
  const query = before.slice(anchor + 1);
  return TOKEN.test(query) ? { anchor, query } : null;
}

/** Raw admitted entries include manual-only Skills for the user to select.
 * The model's implicit catalog deliberately omits those entries. */
export function buildSkillPickerCandidates(snapshot: SkillCatalogSnapshot): SkillPickerCandidate[] {
  const names = new Map<string, number>();
  for (const entry of snapshot.entries) {
    const key = entry.name.toLocaleLowerCase();
    names.set(key, (names.get(key) || 0) + 1);
  }
  return snapshot.entries.map((entry) => {
    const safeName = /^[\p{L}\p{N}_-]+$/u.test(entry.name) && !RESERVED_REFERENCE.test(entry.name)
      && names.get(entry.name.toLocaleLowerCase()) === 1;
    const sourceLabel = entry.source === "panel" ? "自定义规则"
      : entry.source === "package" ? "技能包"
        : entry.source === "workspace" ? "项目技能"
          : entry.platformSource === "codex" ? "Codex"
            : entry.platformSource === "claude" ? "Claude Code"
              : entry.platformSource === "gemini" ? "Gemini / Antigravity" : "本机技能";
    return {
      id: entry.id, name: entry.name, description: entry.description, sourceLabel,
      ...(entry.packageName ? { packageName: entry.packageName } : {}),
      entryPath: entry.entryPath, manualOnly: !entry.allowImplicitInvocation,
      insertText: `$${safeName ? entry.name : skillReference(snapshot, entry.id)}`,
    };
  });
}

export function filterSkillPickerCandidates(
  candidates: readonly SkillPickerCandidate[], query: string,
): SkillPickerCandidate[] {
  const search = query.toLocaleLowerCase();
  const rank = (item: SkillPickerCandidate): number => item.name.toLocaleLowerCase().startsWith(search) ? 0
    : item.name.toLocaleLowerCase().includes(search) ? 1 : 2;
  return candidates.filter((item) => !search || `${item.name}\n${item.description}\n${item.sourceLabel}\n${item.packageName || ""}`.toLocaleLowerCase().includes(search))
    .sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function loadSkillPickerCandidates(input: {
  readonly workspace: string;
  readonly skills: readonly Skill[];
  readonly externalSkillSelections: readonly ExternalSkillSelection[];
  readonly externalSkillSources?: ExternalSkillSources;
}): Promise<SkillPickerCandidate[]> {
  const snapshot = await loadSkillCatalog({
    workspace: input.workspace,
    skills: [...input.skills],
    externalSkillSelections: input.externalSkillSelections.map((selection) => ({ ...selection })),
    externalSkillSources: input.externalSkillSources ? { ...input.externalSkillSources } : undefined,
  });
  return buildSkillPickerCandidates(snapshot);
}

/** Reject a stale anchor/query instead of replacing unrelated draft text. */
export function applySkillPickerSelection(
  value: string, cursor: number, session: SkillPickerSession, candidate: SkillPickerCandidate,
): { value: string; cursor: number } | null {
  const current = getSkillPickerSession(value, cursor);
  if (!current || current.anchor !== session.anchor || current.query !== session.query) return null;
  let end = cursor;
  while (end < value.length) {
    const character = String.fromCodePoint(value.codePointAt(end)!);
    if (!TOKEN_CHARACTER.test(character)) break;
    end += character.length;
  }
  // Dots/colons can occur inside a name or reference, but trailing sentence
  // punctuation belongs to the draft rather than to the completion token.
  while (end > cursor && /[.:/]/u.test(value[end - 1]!)) end--;
  const suffix = value.slice(end);
  const space = /^(?:\s|[.,;:!?，。；：！？])/u.test(suffix) ? "" : " ";
  const inserted = candidate.insertText + space;
  return { value: value.slice(0, session.anchor) + inserted + suffix, cursor: session.anchor + inserted.length };
}
