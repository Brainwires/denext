// JSON Schema extraction from a Standard Schema. The Standard Schema spec carries no
// JSON-Schema export of its own; its companion "Standard JSON Schema" spec
// (https://standardschema.dev/json-schema — Zod ≥ 4.2, ArkType ≥ 2.1.28, Valibot via
// @valibot/to-json-schema) does: `schema["~standard"].jsonSchema.input(options)` /
// `.output(options)`. That is the first thing tried here; TypeBox schemas ARE JSON Schema
// (detected by their `TypeBox.Kind` symbol); older ArkType exposes `toJsonSchema()`; and a
// user-supplied converter covers anything else. A schema none of those describe becomes
// `{}` (accepts anything) and the spec build records an `opaque-schema` warning.

/** A JSON Schema object (draft 2020-12, the dialect OpenAPI 3.1 embeds). */
export type JsonSchema = Record<string, unknown>;

/** Which side of a validator to describe: what it accepts (`input`) or what it yields (`output`). */
export type SchemaSide = "input" | "output";

/**
 * A user-supplied converter for validators denext cannot introspect on its own. Return a
 * JSON Schema, or `undefined` to fall through to the built-in detection.
 */
export type SchemaConverter = (schema: unknown, side: SchemaSide) => JsonSchema | undefined;

/** How a JSON Schema was obtained from a validator. */
export type SchemaSource =
  | "converter"
  | "standard-json-schema"
  | "typebox"
  | "to-json-schema"
  | "opaque";

/** The result of {@linkcode toJsonSchema}. */
export interface SchemaConversion {
  /** The JSON Schema (`{}` when the validator is opaque). */
  schema: JsonSchema;
  /** Where it came from. */
  source: SchemaSource;
}

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Drop symbols, functions and `undefined` (a JSON round-trip) and the `$schema` marker. */
function clean(schema: JsonSchema): JsonSchema {
  const out = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  delete out.$schema;
  return out;
}

function standardJsonSchema(schema: unknown, side: SchemaSide): JsonSchema | undefined {
  const std = (schema as { "~standard"?: { jsonSchema?: Record<string, unknown> } })?.["~standard"];
  const convert = std?.jsonSchema?.[side];
  if (typeof convert !== "function") return undefined;
  try {
    const out = convert({ target: "draft-2020-12" });
    return isRecord(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

function methodJsonSchema(schema: unknown): JsonSchema | undefined {
  const method = (schema as { toJsonSchema?: unknown })?.toJsonSchema;
  if (typeof method !== "function") return undefined;
  try {
    const out = method.call(schema);
    return isRecord(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describe a validator as JSON Schema. Tries, in order: the `converter` option, the
 * Standard JSON Schema interface, TypeBox, a `toJsonSchema()` method; otherwise `{}`.
 *
 * @param schema The validator (any Standard Schema).
 * @param side `input` for params / query / body, `output` for the response.
 * @param converter An optional user converter consulted first.
 */
export function toJsonSchema(
  schema: unknown,
  side: SchemaSide,
  converter?: SchemaConverter,
): SchemaConversion {
  const custom = converter?.(schema, side);
  if (custom) return { schema: clean(custom), source: "converter" };
  const std = standardJsonSchema(schema, side);
  if (std) return { schema: clean(std), source: "standard-json-schema" };
  if (isRecord(schema) && TYPEBOX_KIND in schema) {
    return { schema: clean(schema), source: "typebox" };
  }
  const viaMethod = methodJsonSchema(schema);
  if (viaMethod) return { schema: clean(viaMethod), source: "to-json-schema" };
  return { schema: {}, source: "opaque" };
}
