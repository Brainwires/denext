/**
 * The language-neutral model the client generators emit from: named types (objects, string
 * enums, aliases), and the operations a REST client calls (or, for a GraphQL schema, the types
 * its `execute` helper's variables and data use). {@linkcode modelFromOpenApi} builds it from an
 * OpenAPI 3.1 document; `@denext/graphql` builds it from a schema's SDL.
 *
 * @module
 */

import type { JsonSchema, OpenApiDocument, OpenApiOperation } from "../spec.ts";

/** A reference to a type, as every emitter understands it. */
export type TypeRef =
  | { kind: "string" | "integer" | "number" | "boolean" | "any" }
  | { kind: "array"; items: TypeRef }
  | { kind: "map"; values: TypeRef }
  | { kind: "named"; name: string }
  | { kind: "nullable"; inner: TypeRef };

/** One field of an object type. */
export interface ModelField {
  /** The name on the wire (JSON key). */
  name: string;
  /** Its type. */
  type: TypeRef;
  /** Whether the key is always present. */
  required: boolean;
  /** Its description, if any. */
  description?: string;
}

/** A named type the client declares. */
export type NamedType =
  | { kind: "object"; name: string; fields: ModelField[]; description?: string }
  | { kind: "enum"; name: string; values: string[]; description?: string }
  | { kind: "alias"; name: string; target: TypeRef; description?: string };

/** One path or query parameter. */
export interface ModelParam {
  /** The name on the wire. */
  name: string;
  /** Its type (path parameters are strings). */
  type: TypeRef;
  /** Whether it must be given. */
  required: boolean;
}

/** One operation of a REST client. */
export interface ModelOperation {
  /** A camelCase identifier (`getApiTodosById`), unique in the model. */
  name: string;
  /** The HTTP method, upper-case. */
  method: string;
  /** The path template (`/api/todos/{id}`). */
  path: string;
  /** Its path parameters, in template order. */
  pathParams: ModelParam[];
  /** Its query parameters. */
  queryParams: ModelParam[];
  /** The JSON request body, if it takes one. */
  body?: TypeRef;
  /** The JSON success response, if it has one (`undefined`: no content). */
  response?: TypeRef;
  /** The error codes it may answer with, by status. */
  errors: Record<string, number>;
  /** One-line summary. */
  summary?: string;
}

/** What a generator emits from. */
export interface ClientModel {
  /** The API's title. */
  title: string;
  /** The API's version. */
  version: string;
  /** Every named type, in a stable order. */
  types: NamedType[];
  /** The REST operations (empty for a GraphQL model). */
  operations: ModelOperation[];
  /** For a GraphQL model: the endpoint path the client posts to. */
  graphqlPath?: string;
}

/** `snake_case` / `kebab` / spaced words → `PascalCase` (digits kept, the rest dropped). */
export function pascalCase(s: string): string {
  const words = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[0-9]/.test(out) ? `T${out}` : out || "T";
}

/** `PascalCase` → `camelCase`. */
export function camelCase(s: string): string {
  const p = pascalCase(s);
  return p[0].toLowerCase() + p.slice(1);
}

/** `camelCase` → `snake_case`. */
export function snakeCase(s: string): string {
  return camelCase(s).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(
    /([A-Z])([A-Z][a-z])/g,
    "$1_$2",
  )
    .toLowerCase();
}

/** Builds the named types while walking schemas (inline objects get names from their context). */
class TypeTable {
  readonly types = new Map<string, NamedType>();
  readonly #components: Record<string, JsonSchema>;
  readonly #componentNames = new Map<string, string>();

  constructor(components: Record<string, JsonSchema>) {
    this.#components = components;
    for (const key of Object.keys(components)) {
      this.#componentNames.set(key, this.#unique(pascalCase(key)));
    }
    for (const [key, schema] of Object.entries(components)) {
      this.#declare(this.#componentNames.get(key)!, schema);
    }
  }

  /** A fresh name based on `base`. */
  #unique(base: string): string {
    let name = base;
    for (
      let n = 2;
      this.types.has(name) || [...this.#componentNames.values()].includes(name) && name !== base;
      n++
    ) {
      name = `${base}${n}`;
    }
    return name;
  }

  /** Declare `schema` under `name` (an object, a string enum, or an alias). */
  #declare(name: string, schema: JsonSchema): void {
    if (this.types.has(name)) return;
    const description = typeof schema.description === "string" ? schema.description : undefined;
    const enumValues = stringEnum(schema);
    if (enumValues) {
      this.types.set(name, { kind: "enum", name, values: enumValues, description });
      return;
    }
    if (objectLike(schema)) {
      // Reserve the name first: a self-referencing object refers to it while its fields resolve.
      const placeholder: NamedType = { kind: "object", name, fields: [], description };
      this.types.set(name, placeholder);
      placeholder.fields = this.#fields(name, schema);
      return;
    }
    this.types.set(name, { kind: "alias", name, target: this.ref(schema, name), description });
  }

  #fields(owner: string, schema: JsonSchema): ModelField[] {
    const props = merged(schema, this.#components).properties as Record<string, JsonSchema> ??
      {};
    const required = new Set(requiredOf(merged(schema, this.#components)));
    return Object.entries(props).map(([name, prop]) => ({
      name,
      type: this.ref(prop, owner + pascalCase(name)),
      required: required.has(name),
      ...(typeof prop.description === "string" ? { description: prop.description } : {}),
    }));
  }

  /** The type of `schema`; an inline object or enum becomes a named type called `context`. */
  ref(schema: JsonSchema | undefined, context: string): TypeRef {
    if (!schema || typeof schema !== "object") return { kind: "any" };
    if (typeof schema.$ref === "string") {
      const key = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)?.[1];
      const name = key ? this.#componentNames.get(key) : undefined;
      return name ? { kind: "named", name } : { kind: "any" };
    }
    const nullable = isNullable(schema);
    const inner = this.#nonNull(schema, context);
    return nullable && inner.kind !== "any" ? { kind: "nullable", inner } : inner;
  }

  #nonNull(schema: JsonSchema, context: string): TypeRef {
    const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
    if (Array.isArray(variants)) {
      const nonNull = variants.filter((v) => v?.type !== "null");
      return nonNull.length === 1 ? this.ref(nonNull[0], context) : { kind: "any" };
    }
    if (Array.isArray(schema.allOf) && (schema.allOf as JsonSchema[]).length === 1) {
      return this.ref((schema.allOf as JsonSchema[])[0], context);
    }
    if (stringEnum(schema) || objectLike(schema)) {
      const name = this.#unique(pascalCase(context));
      this.#declare(name, schema);
      return { kind: "named", name };
    }
    return this.#scalar(schema, context);
  }

  #scalar(schema: JsonSchema, context: string): TypeRef {
    const type = primaryType(schema);
    if (type === "string" || type === "integer" || type === "number" || type === "boolean") {
      return { kind: type };
    }
    if (type === "array") {
      return { kind: "array", items: this.ref(schema.items as JsonSchema, context + "Item") };
    }
    if (type === "object" && typeof schema.additionalProperties === "object") {
      return {
        kind: "map",
        values: this.ref(schema.additionalProperties as JsonSchema, context + "Value"),
      };
    }
    return { kind: "any" };
  }
}

/** The non-null `type` of a schema. */
function primaryType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return (t as string[]).find((x) => x !== "null");
  return typeof t === "string" ? t : undefined;
}

function isNullable(schema: JsonSchema): boolean {
  if (Array.isArray(schema.type)) return (schema.type as string[]).includes("null");
  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  return Array.isArray(variants) && variants.some((v) => v?.type === "null");
}

/** A string-only `enum`'s values. */
function stringEnum(schema: JsonSchema): string[] | null {
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.every((v) => typeof v === "string") ? values as string[] : null;
}

/** An object with declared properties (or an `allOf` of them). */
function isObjectSchema(schema: JsonSchema): boolean {
  const props = schema.properties;
  return typeof props === "object" && props !== null && Object.keys(props).length > 0 &&
    (primaryType(schema) === undefined || primaryType(schema) === "object");
}

/** An object type: declared properties, or an `allOf` of objects / references. */
function objectLike(schema: JsonSchema): boolean {
  if (isObjectSchema(schema)) return true;
  const parts = schema.allOf as JsonSchema[] | undefined;
  return Array.isArray(parts) && parts.length > 1 &&
    parts.every((p) => isObjectSchema(p) || typeof p?.$ref === "string");
}

function requiredOf(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? schema.required as string[] : [];
}

/** An `allOf` of objects (refs followed) flattened into one object schema. */
function merged(schema: JsonSchema, components: Record<string, JsonSchema>): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const part of schema.allOf as JsonSchema[]) {
    const key = typeof part.$ref === "string"
      ? /^#\/components\/schemas\/(.+)$/.exec(part.$ref)?.[1]
      : undefined;
    const resolved = merged(key ? components[key] ?? {} : part, components);
    Object.assign(properties, resolved.properties ?? {});
    required.push(...requiredOf(resolved));
  }
  return { type: "object", properties, required };
}

/** The JSON media schema of a request body or response. */
function jsonSchemaOf(holder: unknown): JsonSchema | undefined {
  const content = (holder as { content?: Record<string, { schema?: JsonSchema }> })?.content;
  return content?.["application/json"]?.schema;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** The JSON schema of an operation's first 2xx response, if it has a body. */
function successSchema(op: OpenApiOperation): JsonSchema | undefined {
  const responses = (op.responses ?? {}) as Record<string, unknown>;
  const success = Object.keys(responses).filter((s) => /^2\d\d$/.test(s)).sort()[0];
  return success ? jsonSchemaOf(responses[success]) : undefined;
}

/** One operation's model. */
function operationOf(
  table: TypeTable,
  path: string,
  method: string,
  op: OpenApiOperation,
  names: Set<string>,
): ModelOperation {
  let name = camelCase(String(op.operationId ?? `${method} ${path}`));
  for (let n = 2; names.has(name); n++) name = `${camelCase(String(op.operationId))}${n}`;
  names.add(name);
  const base = pascalCase(name);
  const params = (Array.isArray(op.parameters) ? op.parameters : []) as Record<string, unknown>[];
  const param = (p: Record<string, unknown>): ModelParam => ({
    name: String(p.name),
    type: p.in === "path"
      ? { kind: "string" }
      : table.ref(p.schema as JsonSchema, base + pascalCase(String(p.name))),
    required: p.required === true,
  });
  const body = jsonSchemaOf(op.requestBody);
  const response = successSchema(op);
  return {
    name,
    method: method.toUpperCase(),
    path,
    pathParams: params.filter((p) => p.in === "path").map(param),
    queryParams: params.filter((p) => p.in === "query").map(param),
    ...(body ? { body: table.ref(body, base + "Body") } : {}),
    ...(response ? { response: table.ref(response, base + "Response") } : {}),
    errors: (op["x-denext-errors"] ?? {}) as Record<string, number>,
    ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
  };
}

/**
 * The client model of an OpenAPI 3.1 document: its component schemas and the inline object
 * schemas its operations use as named types, and one operation per path + method (GET, POST,
 * PUT, PATCH, DELETE), in path order. The shared `ApiError` envelope is left out: every client
 * declares its own error type.
 *
 * @param document The document (`denext openapi emit`'s, or another producer's).
 * @returns The model.
 */
export function modelFromOpenApi(document: OpenApiDocument): ClientModel {
  const components = { ...document.components?.schemas ?? {} };
  delete components.ApiError;
  const table = new TypeTable(components);
  const names = new Set<string>();
  const operations: ModelOperation[] = [];
  for (const path of Object.keys(document.paths ?? {}).sort()) {
    const item = document.paths[path];
    for (const method of METHODS) {
      if (item[method]) operations.push(operationOf(table, path, method, item[method], names));
    }
  }
  return {
    title: String(document.info?.title ?? "API"),
    version: String(document.info?.version ?? "0.0.0"),
    types: [...table.types.values()],
    operations,
  };
}
