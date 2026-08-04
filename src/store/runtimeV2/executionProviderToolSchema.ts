import type {
  ToolDefinition,
  ToolParameterSchema,
} from "../../lib/toolSchemas";
import type { RuntimeV2NormalizedToolCall } from "../../lib/runtime-v2";
import { normalizeToolCallForExecution } from "../../lib/toolCallNormalization";

function normalizedSchemaScalar(
  schema: ToolParameterSchema | undefined,
  value: unknown,
): unknown {
  if (!schema) return value;
  if (schema.anyOf?.length) {
    // Preserve values that already satisfy an advertised branch. This keeps
    // genuinely string-valued unions stable while still allowing the second
    // pass below to repair transport encodings such as `"{...}"` for an
    // object-only union emitted by some native function-calling providers.
    const direct = schema.anyOf.find((candidate) =>
      runtimeV2ToolSchemaMismatch(candidate, value, "value") === null
    );
    if (direct) return normalizedSchemaScalar(direct, value);
    for (const candidate of schema.anyOf) {
      const normalized = normalizedSchemaScalar(candidate, value);
      if (
        runtimeV2ToolSchemaMismatch(candidate, normalized, "value") === null
      ) {
        return normalized;
      }
    }
    return value;
  }
  if (schema.type === "number" && typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed &&
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)
    ) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (schema.type === "boolean" && typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  if (
    schema.type === "string" &&
    (typeof value === "number" || typeof value === "boolean")
  ) {
    return String(value);
  }
  if (
    schema.type === "array" &&
    typeof value === "string"
  ) {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return normalizedSchemaScalar(schema, parsed);
        }
      } catch {
        // Keep malformed transport text unchanged for the schema gate to
        // reject with the exact advertised-type failure.
      }
    }
  }
  if (
    schema.type === "array" &&
    Array.isArray(value) &&
    schema.items
  ) {
    return value.map((item) =>
      normalizedSchemaScalar(schema.items, item)
    );
  }
  if (
    schema.type === "object" &&
    typeof value === "string"
  ) {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return normalizedSchemaScalar(schema, parsed);
        }
      } catch {
        // Keep malformed transport text unchanged for the schema gate to
        // reject with the exact advertised-type failure.
      }
    }
  }
  if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    const schemaPropertyName = (inputKey: string): string | null => {
      if (schema.properties?.[inputKey]) return inputKey;
      const snakeCase = inputKey
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[\s-]+/g, "_")
        .toLowerCase();
      return snakeCase !== inputKey && schema.properties?.[snakeCase]
        ? snakeCase
        : null;
    };
    return Object.fromEntries(
      Object.entries(record).flatMap(
        ([key, item]) => {
          const canonicalKey = schemaPropertyName(key);
          // An exact schema key always wins over a transport alias if a
          // provider emits both spellings.
          if (
            canonicalKey &&
            canonicalKey !== key &&
            Object.prototype.hasOwnProperty.call(record, canonicalKey)
          ) {
            return [];
          }
          const propertySchema = canonicalKey
            ? schema.properties?.[canonicalKey]
            : undefined;
          if (propertySchema) {
            return [[
              canonicalKey,
              normalizedSchemaScalar(propertySchema, item),
            ]];
          }
          if (schema.additionalProperties === true) {
            return [[key, item]];
          }
          if (
            schema.additionalProperties &&
            typeof schema.additionalProperties === "object"
          ) {
            return [[
              key,
              normalizedSchemaScalar(
                schema.additionalProperties,
                item,
              ),
            ]];
          }
          return [];
        },
      ),
    );
  }
  return value;
}

function schemaValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => schemaValuesEqual(item, right[index]));
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightRecord = right as Record<string, unknown>;
  const rightKeys = Object.keys(rightRecord);
  return leftEntries.length === rightKeys.length &&
    leftEntries.every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      schemaValuesEqual(value, rightRecord[key])
    );
}

function normalizeIdentityDefault(
  schema: ToolParameterSchema | undefined,
  value: unknown,
): unknown {
  if (
    !schema ||
    !Object.prototype.hasOwnProperty.call(schema, "runtimeIdentityDefault")
  ) {
    return value;
  }
  const identityDefault = normalizedSchemaScalar(
    schema,
    schema.runtimeIdentityDefault,
  );
  return schemaValuesEqual(value, identityDefault) ? undefined : value;
}

/** Normalize transport-level scalar drift through the advertised schema
 * before action identity, scheduling, authorization, and execution see it. */
export function normalizeRuntimeV2ProviderToolCalls(
  calls: readonly RuntimeV2NormalizedToolCall[],
  tools: readonly ToolDefinition[],
  workspace?: string | null,
): RuntimeV2NormalizedToolCall[] {
  const schemas = new Map(
    tools.map((tool) => [
      tool.function.name,
      {
        properties: tool.function.parameters.properties,
        required: new Set(tool.function.parameters.required),
      },
    ]),
  );
  return calls.map((call) => {
    const schema = schemas.get(call.name);
    if (!schema) return call;
    const canonicalArguments = normalizeToolCallForExecution(
      call.name,
      call.arguments,
      workspace,
    );
    const normalizedArguments = Object.fromEntries(
      Object.entries(canonicalArguments).flatMap(([key, value]) => {
        const propertySchema = schema.properties[key];
        if (!propertySchema) return [];
        const normalizedValue = normalizedSchemaScalar(propertySchema, value);
        const identityValue = schema.required.has(key)
          ? normalizedValue
          : normalizeIdentityDefault(propertySchema, normalizedValue);
        return identityValue === undefined ? [] : [[key, identityValue]];
      }),
    );
    return {
      ...call,
      arguments: normalizedArguments,
    };
  });
}

function runtimeV2ToolSchemaMismatch(
  schema: ToolParameterSchema,
  value: unknown,
  path: string,
): string | null {
  if (schema.anyOf?.length) {
    const accepted = schema.anyOf.some((candidate) =>
      runtimeV2ToolSchemaMismatch(candidate, value, path) === null
    );
    if (!accepted) return `${path} does not match any advertised shape`;
  }
  if (
    schema.not &&
    runtimeV2ToolSchemaMismatch(schema.not, value, path) === null
  ) {
    return `${path} matches a forbidden advertised shape`;
  }
  if (schema.enum?.length) {
    if (typeof value !== "string" || !schema.enum.includes(value)) {
      return `${path} must be one of ${JSON.stringify(schema.enum)}`;
    }
  }
  if (!schema.type) return null;
  if (schema.type === "null") {
    return value === null ? null : `${path} must be null`;
  }
  if (schema.type === "string") {
    return typeof value === "string" ? null : `${path} must be a string`;
  }
  if (schema.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : `${path} must be a finite number`;
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? null : `${path} must be a boolean`;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (value.length < Math.max(0, Number(schema.minItems) || 0)) {
      return `${path} must contain at least ${schema.minItems} item(s)`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const mismatch = runtimeV2ToolSchemaMismatch(
          schema.items,
          value[index],
          `${path}[${index}]`,
        );
        if (mismatch) return mismatch;
      }
    }
    return null;
  }
  if (schema.type !== "object") return `${path} has an unsupported type`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${path} must be an object`;
  }
  const record = value as Record<string, unknown>;
  const properties = schema.properties || {};
  for (const required of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(record, required)) {
      return `${path}.${required} is required`;
    }
  }
  for (const [key, item] of Object.entries(record)) {
    const property = properties[key];
    if (property) {
      const mismatch = runtimeV2ToolSchemaMismatch(
        property,
        item,
        `${path}.${key}`,
      );
      if (mismatch) return mismatch;
      continue;
    }
    if (schema.additionalProperties === true) continue;
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      const mismatch = runtimeV2ToolSchemaMismatch(
        schema.additionalProperties,
        item,
        `${path}.${key}`,
      );
      if (mismatch) return mismatch;
      continue;
    }
    return `${path}.${key} is not advertised`;
  }
  return null;
}

/** Native function-calling transports are not trusted to enforce the JSON
 * schema they were given. Validate their normalized arguments exactly before
 * scheduling so enum-locked paths and commands remain authorization facts,
 * not advisory prompt text. */
export function runtimeV2ProviderToolArgumentViolation(
  calls: readonly RuntimeV2NormalizedToolCall[],
  tools: readonly ToolDefinition[],
): {
  readonly call: RuntimeV2NormalizedToolCall;
  readonly reason: string;
} | null {
  const definitions = new Map(
    tools.map((tool) => [tool.function.name, tool] as const),
  );
  for (const call of calls) {
    const definition = definitions.get(call.name);
    if (!definition) continue;
    const reason = runtimeV2ToolSchemaMismatch(
      definition.function.parameters,
      call.arguments,
      "arguments",
    );
    if (reason) return { call, reason };
  }
  return null;
}

export function buildRuntimeV2TextEnvelopeCatalog(
  tools: readonly ToolDefinition[],
): string {
  const entries = tools.map((definition) => ({
    name: definition.function.name,
    required: definition.function.parameters.required,
    properties: Object.fromEntries(
      Object.entries(definition.function.parameters.properties).map(
        ([name, schema]) => [
          name,
          {
            type: schema.type,
            ...(schema.enum ? { enum: schema.enum } : {}),
          },
        ],
      ),
    ),
  }));
  return [
    "[runtime-v2 allowed tool catalog]",
    JSON.stringify(entries),
  ].join("\n").slice(0, 12_000);
}
