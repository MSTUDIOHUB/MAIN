/**
 * Runtime-owned structured observations used by Plan evidence gates.
 *
 * The old implementation encoded these facts as strings such as
 * `command_invoke_argument_contract(save_file,file_path)`.  Those strings are
 * still accepted at the persistence/import boundary, but their authority is
 * explicitly `legacy_import`: they may be displayed as context and may guide
 * another read, but cannot close an acceptance gate.
 */

export type PlanStructuredEvidenceAuthority =
  | "runtime_observation"
  | "legacy_import";

interface PlanStructuredEvidenceBase {
  authority: PlanStructuredEvidenceAuthority;
  /** Exact runtime source observations from which this fact was extracted. */
  sourceObservationRefs?: string[];
}

export interface PlanCommandContractFact extends PlanStructuredEvidenceBase {
  kind: "command_contract";
  relation: "transport" | "invoke" | "handler" | "registration";
  transport?: string;
  command?: string;
  commands?: string[];
  arguments?: string[];
}

export interface PlanEventContractFact extends PlanStructuredEvidenceBase {
  kind: "event_contract";
  relation: "emit" | "dom_listener" | "dom_dispatch" | "tauri_listener";
  event: string;
}

export interface PlanPermissionContractFact extends PlanStructuredEvidenceBase {
  kind: "permission_contract";
  permissions: string[];
}

export interface PlanFieldContractFact extends PlanStructuredEvidenceBase {
  kind: "field_contract";
  relation: "declaration" | "returned" | "read" | "fallback" | "selector";
  field?: string;
  optionality?: "required" | "optional";
  fallbackFields?: [string, string];
}

export interface PlanSymbolRelationFact extends PlanStructuredEvidenceBase {
  kind: "symbol_relation";
  relation: "listener_calls";
  symbols: string[];
}

export interface PlanConfigurationFact extends PlanStructuredEvidenceBase {
  kind: "configuration";
  key: "development_server_url" | "development_server_port";
  value: string;
}

/** Exact interaction target extracted from runtime-owned source bytes. */
export interface PlanInteractionTargetFact extends PlanStructuredEvidenceBase {
  kind: "interaction_target";
  surface: "browser" | "desktop";
  target: string;
}

export interface PlanExecutionSurfaceFact extends PlanStructuredEvidenceBase {
  kind: "execution_surface";
  surface: "browser" | "desktop" | "service";
}

/**
 * Runtime-discovered validation adapter. This is deliberately object-only:
 * model-authored prose and the historical string mini-DSL cannot mint a
 * harness capability. The exact source observation remains its authority.
 */
export interface PlanValidationCapabilityFact extends PlanStructuredEvidenceBase {
  kind: "validation_capability";
  surface: "browser" | "desktop";
  producer: "browser_runtime" | "native_harness";
  ownerRef: string;
  /** Exact finite command accepted by a native harness capability. */
  command?: string;
  /** Exact action/assertion targets accepted by an interaction runtime. */
  targets?: string[];
}

export type PlanStructuredEvidenceFact =
  | PlanCommandContractFact
  | PlanEventContractFact
  | PlanPermissionContractFact
  | PlanFieldContractFact
  | PlanSymbolRelationFact
  | PlanConfigurationFact
  | PlanInteractionTargetFact
  | PlanExecutionSurfaceFact
  | PlanValidationCapabilityFact;

const MAX_FACT_VALUE_CHARS = 160;
const MAX_FACT_LIST_ITEMS = 16;

function normalizeFactValue(value: unknown): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    normalized.length > MAX_FACT_VALUE_CHARS ||
    /[\r\n(),]/.test(normalized)
  ) return "";
  return normalized;
}

function normalizeFactList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = normalizeFactValue(raw);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_FACT_LIST_ITEMS) break;
  }
  return result;
}

function normalizeInteractionTarget(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    /[\u0000-\u001f\r\n]/.test(normalized)
  ) return "";
  return normalized;
}

function normalizeAuthority(
  value: unknown,
  fallback: PlanStructuredEvidenceAuthority,
): PlanStructuredEvidenceAuthority {
  return value === "runtime_observation" || value === "legacy_import"
    ? value
    : fallback;
}

function normalizeSourceObservationRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || "").trim())
    .filter((item) => /^source-observation-sha256-[a-f0-9]{64}$/.test(item)))]
    .slice(0, 8);
}

function withSourceObservationRefs<T extends PlanStructuredEvidenceFact>(
  fact: T,
  record: Record<string, unknown>,
): T {
  const sourceObservationRefs = normalizeSourceObservationRefs(record.sourceObservationRefs);
  return sourceObservationRefs.length > 0
    ? { ...fact, sourceObservationRefs }
    : fact;
}

/** Validate an object-shaped fact before it enters the evidence ledger. */
export function normalizePlanStructuredEvidenceFact(
  value: unknown,
  fallbackAuthority: PlanStructuredEvidenceAuthority = "legacy_import",
): PlanStructuredEvidenceFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const authority = normalizeAuthority(record.authority, fallbackAuthority);

  if (record.kind === "command_contract") {
    const relation = record.relation;
    if (
      relation !== "transport" &&
      relation !== "invoke" &&
      relation !== "handler" &&
      relation !== "registration"
    ) return null;
    if (relation === "registration") {
      const commands = normalizeFactList(record.commands);
      return commands.length > 0
        ? withSourceObservationRefs({ kind: "command_contract", authority, relation, commands }, record)
        : null;
    }
    if (relation === "transport") {
      const transport = normalizeFactValue(record.transport);
      const command = normalizeFactValue(record.command);
      return transport
        ? withSourceObservationRefs({
            kind: "command_contract",
            authority,
            relation,
            transport,
            ...(command ? { command } : {}),
          }, record)
        : null;
    }
    const command = normalizeFactValue(record.command);
    if (!command) return null;
    const args = normalizeFactList(record.arguments);
    return withSourceObservationRefs({
      kind: "command_contract",
      authority,
      relation,
      command,
      ...(args.length > 0 ? { arguments: args } : {}),
    }, record);
  }

  if (record.kind === "event_contract") {
    const relation = record.relation;
    if (
      relation !== "emit" &&
      relation !== "dom_listener" &&
      relation !== "dom_dispatch" &&
      relation !== "tauri_listener"
    ) return null;
    const event = normalizeFactValue(record.event);
    return event ? withSourceObservationRefs({ kind: "event_contract", authority, relation, event }, record) : null;
  }

  if (record.kind === "permission_contract") {
    const permissions = normalizeFactList(record.permissions);
    return permissions.length > 0
      ? withSourceObservationRefs({ kind: "permission_contract", authority, permissions }, record)
      : null;
  }

  if (record.kind === "field_contract") {
    const relation = record.relation;
    if (
      relation !== "declaration" &&
      relation !== "returned" &&
      relation !== "read" &&
      relation !== "fallback" &&
      relation !== "selector"
    ) return null;
    if (relation === "fallback") {
      const fields = normalizeFactList(record.fallbackFields);
      return fields.length === 2
        ? withSourceObservationRefs({
            kind: "field_contract",
            authority,
            relation,
            fallbackFields: [fields[0]!, fields[1]!],
          }, record)
        : null;
    }
    const field = normalizeFactValue(record.field);
    if (!field) return null;
    if (relation === "declaration") {
      const optionality = record.optionality;
      return optionality === "required" || optionality === "optional"
        ? withSourceObservationRefs({ kind: "field_contract", authority, relation, field, optionality }, record)
        : null;
    }
    return withSourceObservationRefs({ kind: "field_contract", authority, relation, field }, record);
  }

  if (record.kind === "symbol_relation") {
    if (record.relation !== "listener_calls") return null;
    const symbols = normalizeFactList(record.symbols);
    return symbols.length > 0
      ? withSourceObservationRefs({ kind: "symbol_relation", authority, relation: "listener_calls", symbols }, record)
      : null;
  }

  if (record.kind === "configuration") {
    if (
      record.key !== "development_server_url" &&
      record.key !== "development_server_port"
    ) return null;
    const normalizedValue = normalizeFactValue(record.value);
    return normalizedValue
      ? withSourceObservationRefs({ kind: "configuration", authority, key: record.key, value: normalizedValue }, record)
      : null;
  }

  if (record.kind === "interaction_target") {
    if (record.surface !== "browser" && record.surface !== "desktop") return null;
    const target = normalizeInteractionTarget(record.target);
    return target
      ? withSourceObservationRefs({ kind: "interaction_target", authority, surface: record.surface, target }, record)
      : null;
  }

  if (record.kind === "execution_surface") {
    return record.surface === "browser" ||
      record.surface === "desktop" ||
      record.surface === "service"
      ? withSourceObservationRefs({ kind: "execution_surface", authority, surface: record.surface }, record)
      : null;
  }

  if (record.kind === "validation_capability") {
    if (record.surface !== "browser" && record.surface !== "desktop") return null;
    if (record.producer !== "browser_runtime" && record.producer !== "native_harness") return null;
    if (
      (record.surface === "desktop" && record.producer !== "native_harness") ||
      (record.surface === "browser" && record.producer !== "browser_runtime")
    ) return null;
    const ownerRef = normalizeInteractionTarget(record.ownerRef);
    const command = normalizeInteractionTarget(record.command);
    const targets = Array.isArray(record.targets)
      ? [...new Set(record.targets.map(normalizeInteractionTarget).filter(Boolean))].slice(0, MAX_FACT_LIST_ITEMS)
      : [];
    if (!ownerRef) return null;
    if (record.producer === "native_harness" && !command) return null;
    if (record.producer === "browser_runtime" && targets.length === 0) return null;
    return withSourceObservationRefs({
      kind: "validation_capability",
      authority,
      surface: record.surface,
      producer: record.producer,
      ownerRef,
      ...(command ? { command } : {}),
      ...(targets.length > 0 ? { targets } : {}),
    }, record);
  }

  return null;
}

function commaSeparatedValues(value: string): string[] {
  return normalizeFactList(value.split(","));
}

/** Strict, finite import of the historical string mini-DSL. Unknown text is dropped. */
export function importLegacyPlanStructuredEvidenceFact(
  value: unknown,
): PlanStructuredEvidenceFact | null {
  const text = String(value ?? "").trim();
  if (!text || text.length > 260 || /[\r\n]/.test(text)) return null;

  let match = /^command_transport_contract\(\s*([^,()]+?)(?:\s*,\s*([^,()]+?))?\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "command_contract",
      authority: "legacy_import",
      relation: "transport",
      transport: match[1],
      command: match[2],
    });
  }
  match = /^command_invoke_contract\(\s*([^,()]+?)\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "command_contract",
      authority: "legacy_import",
      relation: "invoke",
      command: match[1],
    });
  }
  match = /^command_invoke_argument_contract\(\s*([^,()]+?)\s*,\s*([^()]*)\)$/i.exec(text);
  if (match) {
    const args = commaSeparatedValues(match[2] || "");
    return args.length > 0
      ? normalizePlanStructuredEvidenceFact({
          kind: "command_contract",
          authority: "legacy_import",
          relation: "invoke",
          command: match[1],
          arguments: args,
        })
      : null;
  }
  match = /^command_handler_argument_contract\(\s*([^,()]+?)(?:\s*,\s*([^()]*))?\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "command_contract",
      authority: "legacy_import",
      relation: "handler",
      command: match[1],
      arguments: commaSeparatedValues(match[2] || ""),
    });
  }
  match = /^handler_contract\(\s*([^()]*)\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "command_contract",
      authority: "legacy_import",
      relation: "registration",
      commands: commaSeparatedValues(match[1] || ""),
    });
  }
  match = /^permission_contract\(\s*([^()]*)\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "permission_contract",
      authority: "legacy_import",
      permissions: commaSeparatedValues(match[1] || ""),
    });
  }
  match = /^event_(emit|dom_listener|dom_dispatch|tauri_listener)_contract\(\s*([^,()]+?)\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "event_contract",
      authority: "legacy_import",
      relation: String(match[1] || "").toLowerCase(),
      event: match[2],
    });
  }
  match = /^field_contract\(\s*([^,()]+?)\s*,\s*(required|optional)\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "field_contract",
      authority: "legacy_import",
      relation: "declaration",
      field: match[1],
      optionality: String(match[2] || "").toLowerCase(),
    });
  }
  match = /^(returned_field|field_read|field_selector)_contract\(\s*([^,()]+?)\s*\)$/i.exec(text);
  if (match) {
    const relation = String(match[1] || "").toLowerCase() === "returned_field"
      ? "returned"
      : String(match[1] || "").toLowerCase() === "field_read"
        ? "read"
        : "selector";
    return normalizePlanStructuredEvidenceFact({
      kind: "field_contract",
      authority: "legacy_import",
      relation,
      field: match[2],
    });
  }
  match = /^field_fallback_contract\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "field_contract",
      authority: "legacy_import",
      relation: "fallback",
      fallbackFields: [match[1], match[2]],
    });
  }
  match = /^listener_calls\(\s*([^()]*)\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "symbol_relation",
      authority: "legacy_import",
      relation: "listener_calls",
      symbols: commaSeparatedValues(match[1] || ""),
    });
  }

  const urlMatch = /^(?:devUrl\s*["']?\s*[:=]\s*["']?)?(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5})["']?$/i.exec(text);
  if (urlMatch) {
    return normalizePlanStructuredEvidenceFact({
      kind: "configuration",
      authority: "legacy_import",
      key: "development_server_url",
      value: urlMatch[1],
    });
  }
  const portMatch = /^port\s*["']?\s*[:=]\s*["']?(\d{1,5})["']?$/i.exec(text);
  if (portMatch) {
    return normalizePlanStructuredEvidenceFact({
      kind: "configuration",
      authority: "legacy_import",
      key: "development_server_port",
      value: portMatch[1],
    });
  }
  match = /^interaction_target_contract\(\s*(browser|desktop)\s*,\s*([^()]+?)\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "interaction_target",
      authority: "legacy_import",
      surface: String(match[1] || "").toLowerCase(),
      target: match[2],
    });
  }
  match = /^execution_surface_contract\(\s*(browser|desktop|service)\s*\)$/i.exec(text);
  if (match) {
    return normalizePlanStructuredEvidenceFact({
      kind: "execution_surface",
      authority: "legacy_import",
      surface: String(match[1] || "").toLowerCase(),
    });
  }
  return null;
}

/** Promote only facts extracted at a trusted runtime source/tool boundary. */
export function createRuntimePlanStructuredEvidenceFacts(
  values: Iterable<unknown> | null | undefined,
  options: { sourceObservationRefs?: string[] } = {},
): PlanStructuredEvidenceFact[] {
  const result: PlanStructuredEvidenceFact[] = [];
  for (const value of values || []) {
    const parsed = typeof value === "string"
      ? importLegacyPlanStructuredEvidenceFact(value)
      : normalizePlanStructuredEvidenceFact(value, "runtime_observation");
    if (!parsed) continue;
    result.push({
      ...parsed,
      authority: "runtime_observation",
      ...(normalizeSourceObservationRefs(options.sourceObservationRefs).length > 0
        ? { sourceObservationRefs: normalizeSourceObservationRefs(options.sourceObservationRefs) }
        : {}),
    } as PlanStructuredEvidenceFact);
  }
  return mergePlanStructuredEvidenceFacts(result);
}

const NATIVE_UI_HARNESS_COMMAND_RE = /\b(?:tauri-driver|webdriverio|wdio|appium|spectron)\b/i;

/**
 * Discover finite native UI harnesses from an exact runtime-read manifest.
 * The caller must attach the source observation ref before the fact can become
 * authoritative. Unknown manifests and dynamic script composition fail closed.
 */
export function extractRuntimeValidationCapabilityFacts(input: {
  path: string;
  source: string;
}): PlanValidationCapabilityFact[] {
  const path = String(input.path || "").replace(/\\/g, "/").toLowerCase();
  if (!path.endsWith("package.json")) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(String(input.source || ""));
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .flatMap(([name, value]) => {
      const scriptName = String(name || "").trim();
      const commandBody = typeof value === "string" ? value.trim() : "";
      if (
        !scriptName ||
        !/^[A-Za-z0-9:_-]{1,80}$/.test(scriptName) ||
        !commandBody ||
        !NATIVE_UI_HARNESS_COMMAND_RE.test(commandBody)
      ) return [];
      return [{
        kind: "validation_capability" as const,
        authority: "runtime_observation" as const,
        surface: "desktop" as const,
        producer: "native_harness" as const,
        ownerRef: ".",
        command: `npm run ${scriptName}`,
      }];
    })
    .slice(0, 8);
}

export function importLegacyPlanStructuredEvidenceFacts(
  values: Iterable<unknown> | null | undefined,
): PlanStructuredEvidenceFact[] {
  const result: PlanStructuredEvidenceFact[] = [];
  for (const value of values || []) {
    const parsed = typeof value === "string"
      ? importLegacyPlanStructuredEvidenceFact(value)
      : normalizePlanStructuredEvidenceFact(value, "legacy_import");
    if (!parsed) continue;
    result.push({ ...parsed, authority: "legacy_import" } as PlanStructuredEvidenceFact);
  }
  return mergePlanStructuredEvidenceFacts(result);
}

export function formatPlanStructuredEvidenceFact(
  fact: PlanStructuredEvidenceFact,
): string {
  switch (fact.kind) {
    case "command_contract":
      if (fact.relation === "registration") {
        return `handler_contract(${(fact.commands || []).join(",")})`;
      }
      if (fact.relation === "transport") {
        return `command_transport_contract(${fact.transport || ""}${fact.command ? `,${fact.command}` : ""})`;
      }
      if (fact.relation === "handler") {
        return `command_handler_argument_contract(${fact.command || ""}${fact.arguments?.length ? `,${fact.arguments.join(",")}` : ""})`;
      }
      return fact.arguments?.length
        ? `command_invoke_argument_contract(${fact.command || ""},${fact.arguments.join(",")})`
        : `command_invoke_contract(${fact.command || ""})`;
    case "event_contract":
      return `event_${fact.relation}_contract(${fact.event})`;
    case "permission_contract":
      return `permission_contract(${fact.permissions.join(",")})`;
    case "field_contract":
      if (fact.relation === "declaration") {
        return `field_contract(${fact.field || ""},${fact.optionality || ""})`;
      }
      if (fact.relation === "returned") return `returned_field_contract(${fact.field || ""})`;
      if (fact.relation === "read") return `field_read_contract(${fact.field || ""})`;
      if (fact.relation === "selector") return `field_selector_contract(${fact.field || ""})`;
      return `field_fallback_contract(${(fact.fallbackFields || []).join(",")})`;
    case "symbol_relation":
      return `listener_calls(${fact.symbols.join(",")})`;
    case "configuration":
      return fact.key === "development_server_port"
        ? `port=${fact.value}`
        : `devUrl=${fact.value}`;
    case "interaction_target":
      return `interaction_target_contract(${fact.surface},${fact.target})`;
    case "execution_surface":
      return `execution_surface_contract(${fact.surface})`;
    case "validation_capability":
      return `validation_capability_contract(${fact.surface},${fact.producer},${fact.ownerRef},${fact.command || ""},${(fact.targets || []).join("|")})`;
  }
}

function structuredFactPriority(fact: PlanStructuredEvidenceFact): number {
  if (fact.kind === "command_contract") return 120;
  if (fact.kind === "event_contract") return 115;
  if (fact.kind === "interaction_target") return 112;
  if (fact.kind === "validation_capability") return 112;
  if (fact.kind === "execution_surface") return 111;
  if (fact.kind === "symbol_relation") return 110;
  if (fact.kind === "permission_contract") return 105;
  if (fact.kind === "configuration") return 100;
  if (fact.kind === "field_contract" && fact.relation !== "read") return 90;
  return 70;
}

export function mergePlanStructuredEvidenceFacts(
  ...groups: Array<Iterable<PlanStructuredEvidenceFact> | null | undefined>
): PlanStructuredEvidenceFact[] {
  const byIdentity = new Map<string, PlanStructuredEvidenceFact>();
  for (const group of groups) {
    for (const raw of group || []) {
      const fact = normalizePlanStructuredEvidenceFact(raw);
      if (!fact) continue;
      const identity = formatPlanStructuredEvidenceFact(fact).toLowerCase();
      const existing = byIdentity.get(identity);
      if (
        !existing ||
        (existing.authority === "legacy_import" && fact.authority === "runtime_observation")
      ) {
        byIdentity.set(identity, fact);
      } else if (existing && fact.authority === "runtime_observation") {
        const sourceObservationRefs = normalizeSourceObservationRefs([
          ...(existing.sourceObservationRefs || []),
          ...(fact.sourceObservationRefs || []),
        ]);
        if (sourceObservationRefs.length > 0) {
          byIdentity.set(identity, { ...existing, sourceObservationRefs } as PlanStructuredEvidenceFact);
        }
      }
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) =>
      structuredFactPriority(right) - structuredFactPriority(left) ||
      formatPlanStructuredEvidenceFact(left).localeCompare(formatPlanStructuredEvidenceFact(right))
    )
    .slice(0, 24);
}

export function authoritativePlanStructuredEvidenceFacts(
  values: readonly unknown[] | undefined,
): PlanStructuredEvidenceFact[] {
  return (values || [])
    .map((value) => normalizePlanStructuredEvidenceFact(value))
    .filter((fact): fact is PlanStructuredEvidenceFact =>
      !!fact &&
      fact.authority === "runtime_observation" &&
      normalizeSourceObservationRefs(fact.sourceObservationRefs).length > 0
    );
}

export function formatPlanStructuredEvidenceFacts(
  values: readonly unknown[] | undefined,
): string[] {
  const typed = (values || [])
    .filter((value) => typeof value !== "string")
    .map((value) => normalizePlanStructuredEvidenceFact(value))
    .filter((fact): fact is PlanStructuredEvidenceFact => !!fact);
  const legacy = importLegacyPlanStructuredEvidenceFacts(
    (values || []).filter((value): value is string => typeof value === "string"),
  );
  return mergePlanStructuredEvidenceFacts(typed, legacy)
    .map(formatPlanStructuredEvidenceFact);
}
