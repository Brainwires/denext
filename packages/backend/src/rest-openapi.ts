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

/** A relation's definition. */
function definition(table: RestTable, keys: readonly RestForeignKey[]): Json {
  const properties: Json = {};
  for (const column of table.columns) {
    const notes = keyNotes(table, column, keys);
    properties[column.name] = {
      ...(notes.length ? { description: `Note:\n${notes.join("\n")}` } : {}),
      ...typeOf(column),
    };
  }
  const required = table.columns.filter((c) => !c.nullable && !c.hasDefault && !c.readOnly)
    .map((c) => c.name);
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
