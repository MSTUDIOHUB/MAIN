import {
  authoritativePlanStructuredEvidenceFacts,
  type PlanStructuredEvidenceFact,
} from "./planStructuredEvidence";
import type { ValidationPrimitiveSpec } from "./validationContract";
import { getBuiltInValidationAdapterCapability } from "./toolCapabilities";
import { workspacePathsReferToSameFile } from "./workspacePaths";

export interface PlanValidationSurfaceEvidenceFact {
  id: string;
  target: string;
  structuredFacts?: readonly unknown[];
}

export interface PlanValidationSurfaceChange {
  id: string;
  targetRef: string;
  evidenceRefs: string[];
  operation: "modify" | "create" | "delete" | "preserve";
  targetOwnerRef?: string;
  plannedValidationHarness?: PlannedValidationHarness;
}

export interface PlanValidationSurfaceValidation {
  id: string;
  changeRefs: string[];
  primitive: ValidationPrimitiveSpec;
  blocking: boolean;
  harnessChangeRef?: string;
}

export type PlannedValidationHarnessBinding =
  | { kind: "direct_target"; targetRef: string }
  | { kind: "manifest_script"; manifestRef: string; scriptName: string };

export interface PlannedValidationHarness {
  surface: "browser" | "desktop";
  ownerRef: string;
  binding: PlannedValidationHarnessBinding;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxChars = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxChars && !/[\u0000-\u001f]/.test(text) ? text : "";
}

export function normalizePlannedValidationHarness(value: unknown): PlannedValidationHarness | null {
  const input = record(value);
  const binding = record(input?.binding);
  if (!input || !binding) return null;
  const surface = input.surface === "browser" || input.surface === "desktop"
    ? input.surface
    : null;
  const ownerRef = boundedString(input.ownerRef);
  if (!surface || !ownerRef) return null;
  if (binding.kind === "direct_target") {
    const targetRef = boundedString(binding.targetRef);
    return targetRef ? { surface, ownerRef, binding: { kind: "direct_target", targetRef } } : null;
  }
  if (binding.kind === "manifest_script") {
    const manifestRef = boundedString(binding.manifestRef);
    const scriptName = boundedString(binding.scriptName, 80);
    if (!manifestRef || !/^[A-Za-z0-9:_-]{1,80}$/.test(scriptName)) return null;
    return { surface, ownerRef, binding: { kind: "manifest_script", manifestRef, scriptName } };
  }
  return null;
}

function normalizeInteractionTarget(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^css=/i, "")
    .replace(/\s+/g, " ");
}

function normalizeExactCommand(value: string): string {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function normalizeWorkspacePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "") || ".";
}

function parentPath(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "." : normalized.slice(0, separator) || ".";
}

function shellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const push = () => {
    if (current) words.push(current);
    current = "";
  };
  for (const char of String(value || "")) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote !== "'") escaped = true;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === "\\") {
      escaped = true;
    } else {
      current += char;
    }
  }
  push();
  return quote || escaped ? [] : words;
}

function commandStructurallyBindsHarness(input: {
  primitive: ValidationPrimitiveSpec;
  harness: PlannedValidationHarness;
}): boolean {
  if (input.primitive.kind !== "finite_command") return false;
  const validatorSegments = input.primitive.segments.filter((segment) => segment.role === "validator");
  if (input.harness.binding.kind === "direct_target") {
    const expected = normalizeWorkspacePath(input.harness.binding.targetRef);
    return validatorSegments.some((segment) => shellWords(segment.command)
      .some((word) => normalizeWorkspacePath(word) === expected));
  }
  const manifestDirectory = parentPath(input.harness.binding.manifestRef);
  const scriptName = input.harness.binding.scriptName;
  const cwd = normalizeWorkspacePath(input.primitive.cwd || ".");
  if (cwd !== manifestDirectory) return false;
  return validatorSegments.some((segment) => {
    const words = shellWords(segment.command);
    const packageManagerIndex = words.findIndex((word) => /^(?:npm|pnpm|yarn|bun)$/.test(word));
    if (packageManagerIndex < 0) return false;
    const invocation = words.slice(packageManagerIndex + 1);
    const script = invocation[0] === "run" ? invocation[1] : invocation[0];
    return script === scriptName;
  });
}

function plannedHarnessDeclarationFailures(change: PlanValidationSurfaceChange): string[] {
  const harness = change.plannedValidationHarness;
  if (!harness) return [];
  const failures: string[] = [];
  if (change.operation !== "create" && change.operation !== "modify") {
    failures.push(`typed_planned_harness_change_operation_invalid:${change.id}`);
  }
  const expectedOwner = change.operation === "create" ? change.targetOwnerRef : change.targetRef;
  if (!expectedOwner || !workspacePathsReferToSameFile(harness.ownerRef, expectedOwner)) {
    failures.push(`typed_planned_harness_owner_mismatch:${change.id}`);
  }
  const boundTarget = harness.binding.kind === "direct_target"
    ? harness.binding.targetRef
    : harness.binding.manifestRef;
  if (!workspacePathsReferToSameFile(boundTarget, change.targetRef)) {
    failures.push(`typed_planned_harness_target_mismatch:${change.id}`);
  }
  return failures;
}

function capabilityOwnerCoversTarget(ownerRef: string, targetRef: string): boolean {
  const normalize = (value: string) => String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "") || ".";
  const owner = normalize(ownerRef);
  const target = normalize(targetRef);
  if (owner === ".") return !!target && target !== ".." && !target.startsWith("../") && !target.startsWith("/");
  return workspacePathsReferToSameFile(owner, target) || target.startsWith(`${owner}/`);
}

function factsForChange(input: {
  change: PlanValidationSurfaceChange;
  factById: Map<string, PlanValidationSurfaceEvidenceFact>;
}): PlanStructuredEvidenceFact[] {
  return input.change.evidenceRefs.flatMap((reference) => {
    const fact = input.factById.get(reference);
    return fact ? authoritativePlanStructuredEvidenceFacts(fact.structuredFacts) : [];
  });
}

function validationCapabilityCovers(input: {
  facts: PlanStructuredEvidenceFact[];
  surface: "browser" | "desktop";
  ownerRef: string;
  command?: string;
  target?: string;
}): boolean {
  return input.facts.some((fact) => {
    if (
      fact.kind !== "validation_capability" ||
      fact.surface !== input.surface ||
      !capabilityOwnerCoversTarget(fact.ownerRef, input.ownerRef)
    ) return false;
    if (input.surface === "desktop") {
      return fact.producer === "native_harness" &&
        normalizeExactCommand(fact.command || "") === normalizeExactCommand(input.command || "");
    }
    const target = normalizeInteractionTarget(input.target || "");
    return fact.producer === "browser_runtime" &&
      (fact.targets || []).some((item) => normalizeInteractionTarget(item) === target);
  });
}

function interactionTargetCovered(input: {
  changes: PlanValidationSurfaceChange[];
  factById: Map<string, PlanValidationSurfaceEvidenceFact>;
  surface: "browser" | "desktop";
  target: string;
}): boolean {
  const target = normalizeInteractionTarget(input.target);
  if (!target) return false;
  return input.changes.some((change) => {
    const facts = factsForChange({ change, factById: input.factById });
    return facts.some((fact) =>
      fact.kind === "interaction_target" &&
      fact.surface === input.surface &&
      normalizeInteractionTarget(fact.target) === target
    ) || validationCapabilityCovers({
      facts,
      surface: input.surface,
      ownerRef: change.targetRef,
      target,
    });
  });
}

function validateInteractionTargets(input: {
  changes: PlanValidationSurfaceChange[];
  validation: PlanValidationSurfaceValidation;
  factById: Map<string, PlanValidationSurfaceEvidenceFact>;
}): string[] {
  const primitive = input.validation.primitive;
  if (primitive.kind !== "browser_interaction" && primitive.kind !== "desktop_interaction") return [];
  const surface = primitive.kind === "browser_interaction" ? "browser" : "desktop";
  const linkedChanges = input.changes.filter((change) => input.validation.changeRefs.includes(change.id));
  const requiredTargets = [
    ...primitive.actions
      // Navigation owns a URL, not an in-page interaction target. Direct
      // actions remain acceptance-bearing and therefore must be grounded.
      .filter((action) => action.kind.trim().toLowerCase() !== "navigate")
      .map((action) => action.target),
    // Every assertion in an interaction primitive is acceptance-bearing;
    // semantic names and URLs are not exempt from runtime grounding.
    ...primitive.assertions.map((assertion) => assertion.target),
  ];
  return [...new Set(requiredTargets.map(normalizeInteractionTarget).filter(Boolean))]
    .filter((target) => !interactionTargetCovered({
      changes: linkedChanges,
      factById: input.factById,
      surface,
      target,
    }))
    .map((target) => `typed_validation_interaction_target_ungrounded:${input.validation.id}:${target}`);
}

function finiteDesktopHarnessCovers(input: {
  change: PlanValidationSurfaceChange;
  validation: PlanValidationSurfaceValidation;
  facts: PlanStructuredEvidenceFact[];
}): boolean {
  const primitive = input.validation.primitive;
  return primitive.kind === "finite_command" && validationCapabilityCovers({
    facts: input.facts,
    surface: "desktop",
    ownerRef: input.change.targetRef,
    command: primitive.command,
  });
}

function plannedHarnessOwnerCoversTarget(
  harness: PlannedValidationHarness,
  targetRef: string,
): boolean {
  const boundary = harness.binding.kind === "manifest_script"
    ? parentPath(harness.binding.manifestRef)
    : (() => {
        const owner = normalizeWorkspacePath(harness.ownerRef);
        const base = owner.split("/").pop() || "";
        return base.includes(".") ? parentPath(owner) : owner;
      })();
  const target = normalizeWorkspacePath(targetRef);
  return boundary === "." || target === boundary || target.startsWith(`${boundary}/`);
}

function finitePlannedHarnessCovers(input: {
  change: PlanValidationSurfaceChange;
  validation: PlanValidationSurfaceValidation;
  changes: PlanValidationSurfaceChange[];
  surface: "browser" | "desktop";
}): boolean {
  const harnessChange = input.changes.find((candidate) =>
    candidate.id === input.validation.harnessChangeRef
  );
  const harness = harnessChange?.plannedValidationHarness;
  return !!harnessChange &&
    !!harness &&
    harness.surface === input.surface &&
    input.validation.changeRefs.includes(harnessChange.id) &&
    commandStructurallyBindsHarness({
      primitive: input.validation.primitive,
      harness,
    }) &&
    plannedHarnessOwnerCoversTarget(harness, input.change.targetRef);
}

/**
 * Validate that an acceptance primitive is bound to the runtime surface it
 * claims to cover. This policy is shared by typed ingress and cold restore.
 */
export function validatePlanValidationSurfaces(input: {
  changes: PlanValidationSurfaceChange[];
  validations: PlanValidationSurfaceValidation[];
  evidenceFacts: PlanValidationSurfaceEvidenceFact[];
}): string[] {
  const factById = new Map(input.evidenceFacts.map((fact) => [fact.id, fact]));
  const allAuthoritativeFacts = input.evidenceFacts.flatMap((fact) =>
    authoritativePlanStructuredEvidenceFacts(fact.structuredFacts)
  );
  const failures = input.validations.flatMap((validation) =>
    validateInteractionTargets({ changes: input.changes, validation, factById })
  );
  failures.push(...input.changes.flatMap(plannedHarnessDeclarationFailures));
  for (const validation of input.validations) {
    if (!validation.harnessChangeRef) continue;
    const harnessChange = input.changes.find((change) => change.id === validation.harnessChangeRef);
    if (!harnessChange?.plannedValidationHarness) {
      failures.push(`typed_validation_harness_change_invalid:${validation.id}`);
      continue;
    }
    if (!validation.changeRefs.includes(harnessChange.id)) {
      failures.push(`typed_validation_harness_change_unlinked:${validation.id}:${harnessChange.id}`);
    }
    if (!commandStructurallyBindsHarness({
      primitive: validation.primitive,
      harness: harnessChange.plannedValidationHarness,
    })) {
      failures.push(`typed_validation_harness_command_unbound:${validation.id}:${harnessChange.id}`);
    }
  }
  for (const change of input.changes) {
    if (
      change.plannedValidationHarness &&
      !input.validations.some((validation) => validation.harnessChangeRef === change.id)
    ) failures.push(`typed_planned_harness_validation_missing:${change.id}`);
  }
  for (const validation of input.validations) {
    const surface = validation.primitive.kind === "browser_interaction"
      ? "browser"
      : validation.primitive.kind === "desktop_interaction"
        ? "desktop"
        : null;
    if (surface && !getBuiltInValidationAdapterCapability(surface)) {
      failures.push(`typed_validation_runtime_adapter_missing:${validation.id}:${surface}`);
    }
  }

  for (const change of input.changes) {
    if (change.operation === "preserve") continue;
    const facts = factsForChange({ change, factById });
    const requiredSurfaces = new Set(facts
      .filter((fact) => fact.kind === "execution_surface")
      .map((fact) => fact.kind === "execution_surface" ? fact.surface : "")
      .filter((surface): surface is "browser" | "desktop" | "service" => !!surface));
    for (const surface of requiredSurfaces) {
      if (surface === "service") continue;
      const surfaceCovered = input.validations.some((validation) => {
        if (!validation.blocking || !validation.changeRefs.includes(change.id)) return false;
        if (surface === "browser") {
          return validation.primitive.kind === "browser_interaction" ||
            finitePlannedHarnessCovers({
              change,
              validation,
              changes: input.changes,
              surface: "browser",
            });
        }
        return validation.primitive.kind === "desktop_interaction" ||
          finiteDesktopHarnessCovers({ change, validation, facts: allAuthoritativeFacts }) ||
          finitePlannedHarnessCovers({
            change,
            validation,
            changes: input.changes,
            surface: "desktop",
          });
      });
      if (!surfaceCovered) {
        failures.push(`typed_change_validation_surface_ungrounded:${change.id}:${surface}`);
      }
    }
  }
  return [...new Set(failures)];
}
