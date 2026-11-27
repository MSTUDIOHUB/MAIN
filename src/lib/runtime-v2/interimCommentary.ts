import type { RuntimeV2RunIdentity } from "./contracts";
import type { RuntimeV2Event } from "./events";

interface CommentarySentence {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

interface InterimCommentaryHistory {
  readonly publishedCurrent: boolean;
  readonly messages: ReadonlySet<string>;
  readonly sentences: ReadonlySet<string>;
  readonly updates: readonly (readonly CommentarySentence[])[];
}

function comparisonText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

function completeSentences(text: string): CommentarySentence[] {
  const sentences: CommentarySentence[] = [];
  let from = 0;
  for (const match of text.matchAll(/`[^`\r\n]*`|[。！？!?]+|\.(?=\s|$)|\r?\n[\t ]*\r?\n/g)) {
    if (match[0].startsWith("`")) continue;
    const to = match.index! + match[0].length;
    const key = comparisonText(text.slice(from, to));
    if (key) sentences.push({ key, from, to });
    from = to;
  }
  return sentences;
}

/** Only already published provider commentary from this exact Run can be repeated. */
export function buildInterimCommentaryHistory(
  events: readonly RuntimeV2Event[],
  run: RuntimeV2RunIdentity | undefined,
  commandKey: string,
): InterimCommentaryHistory {
  const messages = new Set<string>();
  const sentences = new Set<string>();
  const updates: CommentarySentence[][] = [];
  let publishedCurrent = false;
  if (run) {
    const prefix = `${run.turnId}:provider-commentary:`;
    for (const event of events) {
      if (event.type !== "projection.published" || event.audience !== "chat_milestone" || !event.projection?.dedupeKey.startsWith(prefix)) continue;
      const owner = event.run;
      if (owner.sessionKey !== run.sessionKey || owner.sessionEpoch !== run.sessionEpoch || owner.turnId !== run.turnId ||
        owner.runId !== run.runId || owner.parentRunId !== run.parentRunId || owner.attemptId !== run.attemptId) continue;
      if (event.projection.dedupeKey === `${prefix}${commandKey}`) {
        publishedCurrent = true;
        continue;
      }
      const message = event.projection.markdown;
      const key = comparisonText(message);
      if (!key || messages.has(key)) continue;
      messages.add(key);
      const parts = completeSentences(message);
      parts.forEach((part) => sentences.add(part.key));
      updates.push(parts);
    }
  }
  return { publishedCurrent, messages, sentences, updates };
}

function hasSmallWordingChange(previous: string, next: string): boolean {
  const shorterLength = Math.min(previous.length, next.length);
  const longerLength = Math.max(previous.length, next.length);
  let prefix = 0;
  while (prefix < shorterLength && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorterLength - prefix && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1;
  return prefix >= 12 && suffix >= 4 && longerLength - prefix - suffix <= 3;
}

/** Trim only the published opening. A closely matching sentence is still new
 * text and remains visible, even between two identical sentences. */
export function trimRepeatedInterimCommentary(
  text: string,
  history: InterimCommentaryHistory,
  streaming = false,
): string {
  const source = text.trim();
  if (!source || !history.messages.size) return source;
  if (history.messages.has(comparisonText(source))) return "";

  const parts = completeSentences(source);
  let index = 0;
  while (index < parts.length && history.sentences.has(parts[index].key)) index += 1;
  const remaining = (start: number): string => {
    const tail = source.slice(start).trim();
    if (!streaming || !tail) return tail;
    const key = comparisonText(tail);
    return [...history.sentences, ...history.messages].some((previous) => previous.startsWith(key)) ? "" : tail;
  };
  if (index === parts.length) return remaining(index ? parts[index - 1].to : 0);

  const different = parts[index];
  const preceding = parts[index - 1];
  const following = parts[index + 1];
  const partialFollowing = streaming && !following ? comparisonText(source.slice(different.to)) : "";
  const adjacentMatch = preceding && (following || partialFollowing) && history.updates.some((update) =>
    update.some((candidate, position) => {
      const previousFollowing = update[position + 1]?.key;
      return update[position - 1]?.key === preceding.key && previousFollowing &&
        (following ? following.key === previousFollowing : previousFollowing.startsWith(partialFollowing)) &&
        hasSmallWordingChange(candidate.key, different.key);
    }));
  if (adjacentMatch) {
    const changed = source.slice(different.from, different.to).trim();
    if (!following) return changed;
    index += 2;
    while (index < parts.length && history.sentences.has(parts[index].key)) index += 1;
    return [changed, remaining(parts[index - 1].to)].filter(Boolean).join("\n\n");
  }
  return source.slice(different.from).trimStart();
}
