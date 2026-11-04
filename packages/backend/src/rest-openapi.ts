// `GET /rest/v1/`: the OpenAPI (Swagger 2.0) description PostgREST serves at its root — one
// definition per relation, the table routes with their row filters, the `/rpc/<function>` routes
// with their arguments, and PostgREST's shared parameters (`select`, `order`, `Range`, `Prefer`,
// …). It follows privileges: it describes the catalog the requester can use (the RLS roles', or
// the secret key's) in the schema `Accept-Profile` picks, so nothing a caller cannot reach is
// listed. It is generated from the catalog alone; no request text reaches it but the host.

import type {
  RestCatalog,
  RestColumn,
  RestForeignKey,
  RestFunction,
  RestTable,
  RestTypeFacts,
} from "./rest-catalog.ts";

/** A JSON object. */
type Json = Record<string, unknown>;

/** The media types the routes take and give. */
const MEDIA = [
  "application/json",
  "application/vnd.pgrst.object+json;nulls=stripped",
  "application/vnd.pgrst.object+json",
  "text/csv",
];

/** PostgREST's shared parameters, referenced by the paths. */
const PARAMETERS: Json = {
  preferParams: preferParameter("params=single-object"),
  preferReturn: preferParameter("return=representation", "return=minimal", "return=none"),
  preferCount: preferParameter("count=none"),
  preferPost: preferParameter(
    "return=representation",
    "return=minimal",
    "return=none",
    "resolution=ignore-duplicates",
    "resolution=merge-duplicates",
  ),
  select: queryParameter("select", "Filtering Columns"),
  on_conflict: queryParameter("on_conflict", "On Conflict"),
  order: queryParameter("order", "Ordering"),
  range: {
    name: "Range",
    description: "Limiting and Pagination",
    required: false,
    in: "header",
    type: "string",
  },
  rangeUnit: {
    name: "Range-Unit",
    description: "Limiting and Pagination",
    required: false,
    default: "items",
    in: "header",
    type: "string",
  },
  offset: queryParameter("offset", "Limiting and Pagination"),
  limit: queryParameter("limit", "Limiting and Pagination"),
};

/** A `Prefer` header parameter with its allowed values. */
function preferParameter(...values: string[]): Json {
  return {
    name: "Prefer",
    description: "Preference",
    required: false,
    enum: values,
    in: "header",
    type: "string",
  };
}

/** An optional query-string parameter. */
function queryParameter(name: string, description: string): Json {
  return { name, description, required: false, in: "query", type: "string" };
}

/** A column's Swagger type, format and enum. */
function typeOf(facts: RestTypeFacts): Json {
  const format = facts.castType;
  if (facts.typeName === "json" || facts.typeName === "jsonb") return { format };
  if (facts.category === "A") {
    const items = facts.element
      ? typeOf({ ...facts.element, castType: facts.element.typeName })
      : {};
    return { format, type: "array", items: { type: (items.type as string) ?? "string" } };
  }
  if (facts.category === "B") return { format, type: "boolean" };
  if (facts.category === "N") {
    const integer = ["int2", "int4", "int8"].includes(facts.typeName);
    return { format, type: integer ? "integer" : "number" };
  }
  if (facts.category === "E" && facts.enumLabels) {
    return { format, type: "string", enum: [...facts.enumLabels] };
  }
  return { format, type: "string" };
}

/** The notes PostgREST writes into a key column's description. */
function keyNotes(table: RestTable, column: RestColumn, keys: readonly RestForeignKey[]): string[] {
  const notes: string[] = [];
  if (table.primaryKey.includes(column.name)) notes.push("This is a Primary Key.<pk/>");
  for (const fk of keys) {
    const at = fk.columns.indexOf(column.name);
    if (at < 0 || fk.table.schema !== table.schema || fk.table.name !== table.name) continue;
    const target = `${fk.foreignTable.name}.${fk.foreignColumns[at]}`;
    notes.push(
      `This is a Foreign Key to \`${target}\`.<fk table='${fk.foreignTable.name}' ` +
        `column='${fk.foreignColumns[at]}'/>`,
    );
  }
  return notes;
}

/** A relation's columns as schema properties (each built by `property`) and its insert-required ones. */
function columnsOf(
  table: RestTable,
  keys: readonly RestForeignKey[],
  property: (column: RestColumn, notes: string[]) => Json,
): { properties: Json; required: string[] } {
  const properties: Json = {};
  for (const column of table.columns) {
    properties[column.name] = property(column, keyNotes(table, column, keys));
  }
  const required = table.columns.filter((c) => !c.nullable && !c.hasDefault && !c.readOnly)
    .map((c) => c.name);
  return { properties, required };
}

/** A relation's definition. */
function definition(table: RestTable, keys: readonly RestForeignKey[]): Json {
  const { properties, required } = columnsOf(table, keys, (column, notes) => ({
    ...(notes.length ? { description: `Note:\n${notes.join("\n")}` } : {}),
    ...typeOf(column),
  }));
  return { ...(required.length ? { required } : {}), properties, type: "object" };
}

/** A relation's routes. */
function tablePaths(table: RestTable, writable: boolean): Json {
  const ref = (name: string) => ({ $ref: `#/parameters/${name}` });
  const filters = table.columns.map((c) => ref(`rowFilter.${table.name}.${c.name}`));
  const tags = [table.name];
  const get = {
    parameters: [
      ...filters,
      ...["select", "order", "range", "rangeUnit", "offset", "limit", "preferCount"].map(ref),
    ],
    responses: {
      200: {
        description: "OK",
        schema: { items: { $ref: `#/definitions/${table.name}` }, type: "array" },
      },
      206: { description: "Partial Content" },
    },
    tags,
  };
  if (!writable) return { get };
  const body = ref(`body.${table.name}`);
  return {
    get,
    post: {
      parameters: [body, ref("select"), ref("preferPost")],
      responses: { 201: { description: "Created" } },
      tags,
    },
    delete: {
      parameters: [...filters, ref("preferReturn")],
      responses: { 204: { description: "No Content" } },
      tags,
    },
    patch: {
      parameters: [...filters, body, ref("preferReturn")],
      responses: { 204: { description: "No Content" } },
      tags,
    },
  };
}

/** A relation's own parameters: its body and one row filter per column. */
function tableParameters(table: RestTable): Json {
  const out: Json = {
    [`body.${table.name}`]: {
      name: table.name,
      description: table.name,
      required: false,
      in: "body",
      schema: { $ref: `#/definitions/${table.name}` },
    },
  };
  for (const column of table.columns) {
    out[`rowFilter.${table.name}.${column.name}`] = {
      name: column.name,
      required: false,
      format: column.castType,
      in: "query",
      type: "string",
    };
  }
  return out;
}

/** A function's routes (its first overload, as PostgREST lists one per name). */
function functionPaths(fn: RestFunction): Json {
  const named = fn.args.filter((a) => a.name !== "");
  const properties: Json = {};
  for (const arg of named) properties[arg.name] = typeOf(arg);
  const required = named.filter((a) => !a.hasDefault).map((a) => a.name);
  const tags = [`(rpc) ${fn.name}`];
  const post = {
    parameters: [
      {
        in: "body",
        name: "args",
        required: true,
        schema: { ...(required.length ? { required } : {}), properties, type: "object" },
      },
      { $ref: "#/parameters/preferParams" },
    ],
    produces: MEDIA.slice(0, 3),
    responses: { 200: { description: "OK" } },
    tags,
  };
  if (fn.volatility === "v") return { post };
  const get = {
    parameters: named.map((a) => ({
      ...typeOf(a),
      in: "query",
      name: a.name,
      required: !a.hasDefault,
      ...(typeOf(a).type === undefined ? { type: "string" } : {}),
    })),
    produces: MEDIA.slice(0, 3),
    responses: { 200: { description: "OK" } },
    tags,
  };
  return { get, post };
}

/**
 * The OpenAPI document for one schema of `catalog`.
 *
 * @param catalog The catalog the requester may use.
 * @param schema The schema (`Accept-Profile`).
 * @param origin The request's URL (its host and scheme are the document's).
 * @param basePath The routes' base path.
 * @returns The Swagger 2.0 document.
 */
export function openApiDocument(
  catalog: RestCatalog,
  schema: string,
  origin: URL,
  basePath: string,
): Json {
  const tables = [...catalog.tables.get(schema)?.values() ?? []]
    .sort((a, b) => a.name < b.name ? -1 : 1);
  const paths: Json = {
    "/": {
      get: {
        produces: ["application/openapi+json", "application/json"],
        responses: { 200: { description: "OK" } },
        summary: "OpenAPI description (this document)",
        tags: ["Introspection"],
      },
    },
  };
  const definitions: Json = {};
  const parameters: Json = { ...PARAMETERS };
  for (const table of tables) {
    const writable = table.kind === "table" || table.kind === "view";
    paths[`/${table.name}`] = tablePaths(table, writable);
    definitions[table.name] = definition(table, catalog.foreignKeys);
    Object.assign(parameters, tableParameters(table));
  }
  for (const [name, overloads] of [...catalog.functions.get(schema) ?? []].sort()) {
    paths[`/rpc/${name}`] = functionPaths(overloads[0]);
  }
  return {
    swagger: "2.0",
    info: {
      description: "",
      title: schema === "public" ? "standard public schema" : schema,
      version: "12",
    },
    host: origin.host,
    basePath,
    schemes: [origin.protocol.replace(/:$/, "")],
    consumes: MEDIA,
    produces: MEDIA,
    paths,
    definitions,
    parameters,
    externalDocs: {
      description: "PostgREST Documentation",
      url: "https://postgrest.org/en/v12/references/api.html",
    },
  };
}

// ── OpenAPI 3.1, for `@denext/openapi` ───────────────────────────────────────

/**
 * Which schema a contribution's operations belong to: the default one keeps the bare names
 * (`rest.notes`, `rest_select_notes`); another is named by its schema too and takes the header
 * that picks it (`Accept-Profile` for reads, `Content-Profile` for writes).
 */
interface Scope {
  /** The schema. */
  schema: string;
  /** Whether it is the default (the first of `rest.schemas`). */
  isDefault: boolean;
}

/** A relation or function name qualified by its schema outside the default one. */
function scoped(scope: Scope, name: string): string {
  return scope.isDefault ? name : `${scope.schema}.${name}`;
}

/** A component name OpenAPI accepts (`^[A-Za-z0-9._-]+$`) for a relation. */
function componentName(scope: Scope, name: string): string {
  return `rest.${scoped(scope, name).replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** The required profile header of a non-default schema's operation, else nothing. */
function profileParameters(scope: Scope, write: boolean): Json[] {
  if (scope.isDefault) return [];
  const name = write ? "Content-Profile" : "Accept-Profile";
  return [{
    name,
    in: "header",
    required: true,
    description: `The schema (\`${scope.schema}\`)`,
    schema: { type: "string", enum: [scope.schema] },
  }];
}

/** A column or argument's JSON Schema (2020-12): its Swagger type, `null` added when nullable. */
function jsonSchemaOf(facts: RestTypeFacts, nullable: boolean): Json {
  const { format, ...rest } = typeOf(facts);
  const schema: Json = { ...rest, ...(format ? { format } : {}) };
  if (nullable && typeof schema.type === "string") schema.type = [schema.type, "null"];
  return schema;
}

/** A relation's row schema (3.1): typed columns, the key notes, the insert-required columns. */
function rowSchema(table: RestTable, keys: readonly RestForeignKey[]): Json {
  const { properties, required } = columnsOf(table, keys, (column, notes) => ({
    ...jsonSchemaOf(column, column.nullable),
    ...(notes.length ? { description: notes.join(" ").replace(/<[^>]+>/g, "") } : {}),
    ...(column.readOnly ? { readOnly: true } : {}),
  }));
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** PostgREST's error body. */
const REST_ERROR: Json = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    details: { type: ["string", "null"] },
    hint: { type: ["string", "null"] },
  },
};

/** A header parameter. */
const header = (name: string, description: string, values?: string[]): Json => ({
  name,
  in: "header",
  required: false,
  description,
  schema: { type: "string", ...(values ? { enum: values } : {}) },
});

/** A query parameter taking a PostgREST expression. */
const query = (name: string, description: string): Json => ({
  name,
  in: "query",
  required: false,
  description,
  schema: { type: "string" },
});

/** The reads' shaping parameters. */
const READ_PARAMETERS = [
  query("select", "Columns and embedded relations (`id,body,author:users(name)`)"),
  query("order", "Ordering (`created_at.desc.nullslast`)"),
  query("limit", "At most this many rows"),
  query("offset", "Skip this many rows"),
  header("Range", "Limiting and pagination (`0-24`)"),
  header("Prefer", "Preference", ["count=exact", "count=planned", "count=estimated"]),
];

/** The default (error) response. */
const ERROR_RESPONSE: Json = {
  description: "A PostgREST error (`PGRST…` or a SQLSTATE code)",
  content: { "application/json": { schema: { $ref: "#/components/schemas/rest.Error" } } },
};

/** A JSON body or response of `schema`. */
const jsonOf = (schema: Json): Json => ({ "application/json": { schema } });

/** One relation's operations (3.1). */
function tableOperations(table: RestTable, ref: string, scope: Scope): Record<string, Json> {
  const filters = table.columns.map((c) =>
    query(c.name, `A row filter on \`${c.name}\` (\`eq.1\`, \`in.(1,2)\`, \`is.null\`, …)`)
  );
  const row = { $ref: ref };
  const label = scoped(scope, table.name);
  const base = { tags: [label], "x-denext-source": "@denext/backend rest" };
  const reads = profileParameters(scope, false);
  const writes = profileParameters(scope, true);
  const get = {
    ...base,
    operationId: `rest_select_${label}`,
    summary: `Read ${label}`,
    parameters: [...filters, ...READ_PARAMETERS, ...reads],
    responses: {
      200: { description: "OK", content: jsonOf({ type: "array", items: row }) },
      206: { description: "Partial Content (a `Range`)" },
      default: ERROR_RESPONSE,
    },
  };
  if (table.kind !== "table" && table.kind !== "view") return { get };
  const prefer = header("Prefer", "Preference", [
    "return=representation",
    "return=minimal",
    "resolution=merge-duplicates",
    "resolution=ignore-duplicates",
  ]);
  const written = {
    200: {
      description: "The rows (`Prefer: return=representation`)",
      content: jsonOf({ type: "array", items: row }),
    },
    default: ERROR_RESPONSE,
  };
  return {
    get,
    post: {
      ...base,
      operationId: `rest_insert_${label}`,
      summary: `Insert into ${label}`,
      parameters: [
        query("select", "Columns of the returned rows"),
        query("on_conflict", "Upsert key columns"),
        prefer,
        ...writes,
      ],
      requestBody: {
        required: true,
        content: jsonOf({ oneOf: [row, { type: "array", items: row }] }),
      },
      responses: { 201: { description: "Created" }, ...written },
    },
    patch: {
      ...base,
      operationId: `rest_update_${label}`,
      summary: `Update ${label}`,
      parameters: [...filters, prefer, ...writes],
      requestBody: { required: true, content: jsonOf(row) },
      responses: { 204: { description: "No Content" }, ...written },
    },
    delete: {
      ...base,
      operationId: `rest_delete_${label}`,
      summary: `Delete from ${label}`,
      parameters: [...filters, prefer, ...writes],
      responses: { 204: { description: "No Content" }, ...written },
    },
  };
}

/** What a call answers with: its row(s) or value — an array for a set-returning function. */
function resultSchema(fn: RestFunction): Json {
  const { returns } = fn;
  let one: Json = {};
  if (returns.kind === "scalar" && returns.column) one = jsonSchemaOf(returns.column, true);
  if (returns.kind === "composite") {
    const properties: Json = {};
    for (const c of returns.columns ?? []) properties[c.name] = jsonSchemaOf(c, c.nullable);
    one = { type: "object", properties };
  }
  return fn.setOf ? { type: "array", items: one } : one;
}

/** One function's operations (3.1; its first overload, as PostgREST lists one per name). */
function functionOperations(fn: RestFunction, scope: Scope): Record<string, Json> {
  const named = fn.args.filter((a) => a.name !== "");
  const properties: Json = {};
  for (const arg of named) properties[arg.name] = jsonSchemaOf(arg, false);
  const required = named.filter((a) => !a.hasDefault).map((a) => a.name);
  const label = scoped(scope, fn.name);
  const base = {
    tags: [`(rpc) ${label}`],
    summary: `Call ${label}`,
    "x-denext-source": "@denext/backend rest",
    responses: fn.returns.kind === "void"
      ? { 204: { description: "No Content" }, default: ERROR_RESPONSE }
      : { 200: { description: "OK", content: jsonOf(resultSchema(fn)) }, default: ERROR_RESPONSE },
  };
  const post = {
    ...base,
    operationId: `rest_rpc_${label}`,
    ...(scope.isDefault ? {} : { parameters: profileParameters(scope, true) }),
    requestBody: {
      required: required.length > 0,
      content: jsonOf({ type: "object", properties, ...(required.length ? { required } : {}) }),
    },
  };
  if (fn.volatility === "v") return { post };
  const get = {
    ...base,
    operationId: `rest_rpc_${label}_get`,
    parameters: [
      ...named.map((a) => ({
        name: a.name,
        in: "query",
        required: !a.hasDefault,
        schema: jsonSchemaOf(a, false),
      })),
      ...profileParameters(scope, false),
    ],
  };
  return { get, post };
}

/**
 * The auto-REST routes as an OpenAPI 3.1 contribution for `@denext/openapi`'s document: every
 * relation and function of each schema of `schemas` in `catalog` (the RLS roles' view — pass the
 * anonymous catalog so nothing only the secret key reaches is listed), under `basePath`. The
 * first schema is the default; another's operations require the `Accept-Profile` /
 * `Content-Profile` header that selects it. One URL serves every schema, so where two schemas
 * share a relation or function name the path describes the first of them in `schemas` order (the
 * other stays reachable with its profile, and `GET /rest/v1` with that profile describes it).
 *
 * @param catalog The catalog to describe.
 * @param schemas The schemas served, the default first.
 * @param basePath The routes' public prefix (the app's `basePath` + `rest.basePath`).
 * @returns The paths and the row schemas they reference.
 */
export function openApiContribution(
  catalog: RestCatalog,
  schemas: readonly string[],
  basePath: string,
): { paths: Record<string, Record<string, Json>>; schemas: Record<string, Json> } {
  const paths: Record<string, Record<string, Json>> = {};
  const components: Record<string, Json> = { "rest.Error": REST_ERROR };
  schemas.forEach((schema, i) => {
    const scope: Scope = { schema, isDefault: i === 0 };
    for (const table of catalog.tables.get(schema)?.values() ?? []) {
      const path = `${basePath}/${table.name}`;
      if (paths[path]) continue;
      const name = componentName(scope, table.name);
      components[name] = rowSchema(table, catalog.foreignKeys);
      paths[path] = tableOperations(table, `#/components/schemas/${name}`, scope);
    }
    for (const [name, overloads] of catalog.functions.get(schema) ?? []) {
      paths[`${basePath}/rpc/${name}`] ??= functionOperations(overloads[0], scope);
    }
  });
  return { paths, schemas: components };
}
