/** Session-owned documents are data, never approval or workspace write authority. */
export interface PlanDocumentScope {
  readonly workspace: string | null;
  readonly sessionKey: string;
}

export interface PlanDocumentOwner extends PlanDocumentScope {
  readonly sessionEpoch: string;
  readonly turnId: string;
}

export interface PlanDocumentRef {
  readonly owner: PlanDocumentOwner;
  readonly documentId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly path: string;
  readonly title: string;
  readonly kind: "plan" | "rules_draft";
}

export interface SavePlanDocumentInput {
  readonly owner: PlanDocumentOwner;
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly expectedContentHash?: string | null;
  readonly title: string;
  readonly markdown: string;
  readonly kind: PlanDocumentRef["kind"];
}

/** Format display metadata only when constructing a new document save input.
 * Persisted retry inputs and returned references must remain exact. */
export function planDocumentDisplayTitle(input: string): string {
  return input.replace(/[\u0000\s]+/g, " ").trim() || "Plan";
}

export function normalizePlanDocumentRef(value: unknown): PlanDocumentRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as PlanDocumentRef;
  const valid = (text: unknown): text is string => typeof text === "string" && !!text.trim() && !/[\u0000\r\n]/.test(text);
  if (!ref.owner || (ref.owner.workspace !== null && !valid(ref.owner.workspace)) || !valid(ref.owner.sessionKey) || !valid(ref.owner.sessionEpoch) || !valid(ref.owner.turnId) ||
    !valid(ref.documentId) || !Number.isSafeInteger(ref.revision) || ref.revision < 1 || !/^[a-f0-9]{64}$/.test(ref.contentHash) || !valid(ref.path) || !valid(ref.title) || !["plan", "rules_draft"].includes(ref.kind)) return null;
  return { owner: { workspace: ref.owner.workspace, sessionKey: ref.owner.sessionKey, sessionEpoch: ref.owner.sessionEpoch, turnId: ref.owner.turnId }, documentId: ref.documentId,
    revision: ref.revision, contentHash: ref.contentHash, path: ref.path, title: ref.title, kind: ref.kind };
}

export function samePlanDocumentRef(left?: PlanDocumentRef, right?: PlanDocumentRef): boolean {
  const a = left ? normalizePlanDocumentRef(left) : null;
  const b = right ? normalizePlanDocumentRef(right) : null;
  return (!left || !!a) && (!right || !!b) && JSON.stringify(a) === JSON.stringify(b);
}
