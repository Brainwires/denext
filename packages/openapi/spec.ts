/**
 * The OpenAPI 3.1 document builder behind `@denext/openapi`: walk an app's API routes,
 * read the definition each `defineApi` handler carries (`apiDefinitionOf`), and describe
 * every endpoint — path and query parameters, request body, response, declared error
 * codes — plus a lint pass (what could not be described, and why). Pure: no I/O beyond the
 * module loader you hand it, so a CI step can build and diff a spec without a server.
 *
 * ```ts
 * import { buildOpenApi } from "@denext/openapi/spec";
 * import { scanRoutes } from "@denext/denext/server";
 * const { document, warnings } = await buildOpenApi({
 *   manifest: await scanRoutes("./app"),
 *   load: (file) => import(file),
 *   info: { title: "My API", version: "1.0.0" },
 * });
 * ```
 *
 * @module
 */

import { type ApiDefinition, apiDefinitionOf } from "@denext/denext/plugin-kit";
import type { ApiRoute, RouteManifest, Segment } from "@denext/denext/server";
import { type JsonSchema, type SchemaConverter, toJsonSchema } from "./json-schema.ts";

export type {
  JsonSchema,
  SchemaConversion,
  SchemaConverter,
  SchemaSide,
  SchemaSource,
} from "./json-schema.ts";
export { toJsonSchema } from "./json-schema.ts";
// Types referenced by this module's public signatures (doc completeness).
export type { ApiDefinition, ApiRoute, RouteManifest, Segment };

/** The `info` object of the document. */
export interface OpenApiInfo {
  /** The API's title. */
  title: string;
  /** The API's version (yours, not denext's). */
  version: string;
  /** A longer description (CommonMark). */
  description?: string;
}

/** A `servers` entry. */
export interface OpenApiServer {
  /** The base URL. */
  url: string;
  /** What this server is (`"production"`, …). */
  description?: string;
}

/** One operation (`paths./x.get`). Kept loose: the OpenAPI operation object. */
export type OpenApiOperation = Record<string, unknown>;

/**
 * An OpenAPI [security scheme object](https://spec.openapis.org/oas/v3.1.0#security-scheme-object)
 * — e.g. `{ type: "http", scheme: "bearer" }` or `{ type: "apiKey", in: "header", name: "X-Api-Key" }`.
 * Declared under {@link OpenApiOptions.securitySchemes}; Swagger UI / Scalar render an
 * "Authorize" button from these so a token is entered once and sent with each request.
 * Kept loose (the scheme object varies by `type`).
 */
export type OpenApiSecurityScheme = Record<string, unknown>;

/**
 * A [security requirement](https://spec.openapis.org/oas/v3.1.0#security-requirement-object):
 * scheme name → the scopes it needs (usually `[]` for bearer/apiKey). `[{ bearerAuth: [] }]`
 * means "this operation needs the `bearerAuth` scheme"; an empty array `[]` means "no auth".
 */
export type SecurityRequirement = Record<string, string[]>;

/** The generated document. */
export interface OpenApiDocument {
  /** The spec version. */
  openapi: "3.1.0";
  /** The API's metadata. */
  info: OpenApiInfo;
  /** Base URLs, when given. */
  servers?: OpenApiServer[];
  /** Every path, sorted, each holding its lower-cased methods. */
  paths: Record<string, Record<string, OpenApiOperation>>;
  /** A document-wide default security requirement (an operation's own `security` overrides it). */
  security?: SecurityRequirement[];
  /** Shared schemas — the `ApiError` envelope every error response references — and security schemes. */
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

/** What the lint pass flags. */
export type OpenApiWarningCode =
  /** A validator no strategy could turn into JSON Schema (emitted as `{}`). */
  | "opaque-schema"
  /** A plain route handler with no `defineApi` definition — only its path is known. */
  | "undescribed-route"
  /** A defined endpoint without a `summary`. */
  | "missing-summary"
  /** A catch-all segment, which OpenAPI can only express as one `/`-joined parameter. */
  | "catch-all-path"
  /** The route module failed to load; the route is skipped. */
  | "load-failed"
  /** Two routes describe the same path + method (an optional catch-all beside a static route); the later one is dropped. */
  | "path-collision";

/** One lint finding. */
export interface OpenApiWarning {
  /** The finding's kind. */
  code: OpenApiWarningCode;
  /** The denext route path (`/api/todos/[id]`). */
  routePath: string;
  /** The HTTP method, when the finding is per operation. */
  method?: string;
  /** Which schema, for `opaque-schema`. */
  part?: "params" | "query" | "body" | "response";
  /** Human-readable detail. */
  message: string;
}

/** A module loader: absolute route file → its exports. */
export type RouteModuleLoader = (filePath: string) => Promise<unknown>;

/** Options for {@linkcode buildOpenApi}. */
export interface BuildOpenApiOptions {
  /** The route manifest (or anything exposing its `api` routes). */
  manifest: Pick<RouteManifest, "api">;
  /** Loads a route module by file path. */
  load: RouteModuleLoader;
  /** `info` fields; defaults to `{ title: "API", version: "0.0.0" }`. */
  info?: Partial<OpenApiInfo>;
  /** `servers` entries. */
  servers?: OpenApiServer[];
  /** The app's `basePath`, prefixed onto every path. */
  basePath?: string;
  /** A converter for validators the built-in detection cannot describe. */
  toJsonSchema?: SchemaConverter;
  /** Keep a route in the document (default: every API route). */
  include?: (route: ApiRoute) => boolean;
  /** Tag an operation (default: the first path segment after `/api`, else `"default"`). */
  tags?: (route: ApiRoute) => string[];
  /**
   * The security schemes the document advertises (→ `components.securitySchemes`, and Swagger
   * UI's "Authorize" button). E.g. `{ bearerAuth: { type: "http", scheme: "bearer" } }`.
   */
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  /**
   * Which scheme(s) an operation requires. An **array** is a document-wide default (`doc.security`);
   * a **function** is applied per route (return `[{ bearerAuth: [] }]` to require it, `[]` for a
   * public route like `/api/login`, or `undefined` to leave the operation at the document default).
   * Declaring `security` here is DOCUMENTATION — enforce the token with route middleware.
   */
  security?:
    | SecurityRequirement[]
    | ((route: ApiRoute) => SecurityRequirement[] | undefined);
}

/** What {@linkcode buildOpenApi} returns. */
export interface OpenApiBuild {
  /** The document. */
  document: OpenApiDocument;
  /** The lint findings, in route order. */
  warnings: OpenApiWarning[];
}

/** The methods a route module may export as handlers (HEAD is derived from GET, so not listed). */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** The error envelope every `ApiError` response carries (`src/server/api-error.ts`). */
export const API_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "status", "message"],
      properties: {
        code: { type: "string" },
        status: { type: "integer" },
        message: { type: "string" },
        data: {},
        fieldErrors: { type: "object", additionalProperties: { type: "string" } },
        digest: { type: "string" },
      },
    },
  },
};

/** Build the OpenAPI document for an app's API routes. */
export async function buildOpenApi(options: BuildOpenApiOptions): Promise<OpenApiBuild> {
  const warnings: OpenApiWarning[] = [];
  const paths: OpenApiDocument["paths"] = {};
  const ids = new Set<string>();
  const routes = options.manifest.api.filter(options.include ?? (() => true));
  for (const route of routes) {
    const mod = await loadRoute(route, options.load, warnings);
    if (!mod) continue;
    for (const method of METHODS) {
      const handler = mod[method];
      if (typeof handler !== "function") continue;
      placeOperations({ route, method, handler, options, warnings, ids, paths });
    }
  }
  return { document: assemble(paths, options), warnings };
}

interface Placement {
  route: ApiRoute;
  method: string;
  handler: unknown;
  options: BuildOpenApiOptions;
  warnings: OpenApiWarning[];
  ids: Set<string>;
  paths: OpenApiDocument["paths"];
}

/**
 * Describe one handler under every path variant of its route. Each variant gets its OWN
 * operation: the bare form of an optional catch-all has no `{x}` template, so it must not
 * declare that path parameter, and needs its own id. A method already described under a path
 * (a static sibling of an optional catch-all) is kept; the newcomer is dropped with a warning.
 */
function placeOperations(p: Placement): void {
  const variants = pathVariants(p.route.pattern, p.options.basePath ?? "");
  for (const path of variants) {
    const bare = variants.length > 1 && !path.endsWith("}");
    const op = describe(p.route, p.method, p.handler, p.options, p.warnings, bare);
    op.operationId = uniqueId(p.ids, String(op.operationId) + (bare ? "Root" : ""));
    const item = p.paths[path] ??= {};
    const key = p.method.toLowerCase();
    if (item[key]) {
      p.warnings.push({
        code: "path-collision",
        routePath: p.route.routePath,
        method: p.method,
        message: `${path} is already described by another route — this operation is dropped`,
      });
      continue;
    }
    item[key] = op;
  }
}

async function loadRoute(
  route: ApiRoute,
  load: RouteModuleLoader,
  warnings: OpenApiWarning[],
): Promise<Record<string, unknown> | null> {
  try {
    const mod = await load(route.filePath);
    if (typeof mod === "object" && mod !== null) return mod as Record<string, unknown>;
    return {};
  } catch (err) {
    warnings.push({
      code: "load-failed",
      routePath: route.routePath,
      message: `${route.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
}

function assemble(paths: OpenApiDocument["paths"], options: BuildOpenApiOptions): OpenApiDocument {
  const sorted: OpenApiDocument["paths"] = {};
  for (const key of Object.keys(paths).sort()) sorted[key] = paths[key];
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title: "API", version: "0.0.0", ...options.info },
    paths: sorted,
    components: { schemas: { ApiError: API_ERROR_SCHEMA } },
  };
  if (options.servers?.length) doc.servers = options.servers;
  if (options.securitySchemes && Object.keys(options.securitySchemes).length) {
    doc.components.securitySchemes = options.securitySchemes;
  }
  if (Array.isArray(options.security)) doc.security = options.security;
  return doc;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/**
 * The OpenAPI path template(s) for a route pattern: `[id]` → `{id}`, `[...rest]` →
 * `{rest}`; an optional catch-all yields both the bare path and the parameterised one.
 */
export function pathVariants(pattern: Segment[], basePath = ""): string[] {
  const parts: string[] = [];
  let optionalTail = false;
  for (const seg of pattern) {
    if (seg.kind === "static") parts.push(seg.value);
    else if (seg.kind === "optionalCatchAll") optionalTail = true;
    else parts.push(`{${seg.value}}`);
  }
  const base = basePath.replace(/\/$/, "");
  const full = base + "/" + parts.join("/");
  if (!optionalTail) return [full === base + "/" && base ? base : full];
  const tail = pattern[pattern.length - 1];
  return [full, (full === "/" ? "" : full) + `/{${tail.value}}`];
}

/** `getApiTodosById` for `GET /api/todos/[id]`. */
function operationId(method: string, pattern: Segment[]): string {
  const pascal = (s: string) =>
    s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())
      .replace(/^./, (c) => c.toUpperCase());
  const parts = pattern.map((seg) =>
    seg.kind === "static" ? pascal(seg.value) : "By" + pascal(seg.value)
  );
  return method.toLowerCase() + (parts.join("") || "Root");
}

function uniqueId(ids: Set<string>, id: string): string {
  let out = id;
  for (let n = 2; ids.has(out); n++) out = `${id}${n}`;
  ids.add(out);
  return out;
}

function defaultTags(route: ApiRoute): string[] {
  const statics = route.pattern.filter((s) => s.kind === "static").map((s) => s.value);
  const first = statics[0] === "api" ? statics[1] : statics[0];
  return [first ?? "default"];
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * An operation's security requirement, by precedence: the endpoint's own `security` (per method,
 * co-located) wins; else the plugin's per-route `security` function; else `undefined` (the
 * document-level default in {@link assemble} applies). An array `options.security` is the
 * document default and is not consulted here.
 */
function securityFor(
  perEndpoint: SecurityRequirement[] | undefined,
  route: ApiRoute,
  option: BuildOpenApiOptions["security"],
): SecurityRequirement[] | undefined {
  if (perEndpoint) return perEndpoint;
  return typeof option === "function" ? option(route) : undefined;
}

/** Warn once per catch-all segment: OpenAPI can only express it as one `/`-joined parameter. */
function warnCatchAll(
  pattern: Segment[],
  warn: (w: Omit<OpenApiWarning, "routePath" | "method">) => void,
): void {
  for (const seg of pattern) {
    if (seg.kind === "catchAll" || seg.kind === "optionalCatchAll") {
      warn({ code: "catch-all-path", message: `[...${seg.value}] is one "/"-joined parameter` });
    }
  }
}

function describe(
  route: ApiRoute,
  method: string,
  handler: unknown,
  options: BuildOpenApiOptions,
  warnings: OpenApiWarning[],
  bare = false,
): OpenApiOperation {
  // The bare variant of an optional catch-all has no catch-all segment in its template.
  const pattern = bare ? route.pattern.filter((s) => s.kind !== "optionalCatchAll") : route.pattern;
  const meta = apiDefinitionOf(handler);
  const op: OpenApiOperation = {
    operationId: operationId(method, pattern),
    tags: (options.tags ?? defaultTags)(route),
  };
  const security = securityFor(meta?.def.security, route, options.security);
  if (security) op.security = security;
  const warn = (w: Omit<OpenApiWarning, "routePath" | "method">) =>
    warnings.push({ ...w, routePath: route.routePath, method });
  warnCatchAll(route.pattern, warn);
  if (!meta) {
    warn({
      code: "undescribed-route",
      message: "plain handler — wrap it in defineApi to describe it",
    });
    op.parameters = pathParameters(pattern, {});
    op.responses = { "200": { description: "OK" } };
    return op;
  }
  const def = meta.def;
  if (def.summary) op.summary = def.summary;
  else warn({ code: "missing-summary", message: "no `summary` in the definition" });
  if (def.description) op.description = def.description;
  const convert = (schema: unknown, part: OpenApiWarning["part"]) =>
    schemaFor(
      schema,
      part,
      options.toJsonSchema,
      (m) => warn({ code: "opaque-schema", part, message: m }),
    );
  op.parameters = [
    ...pathParameters(pattern, def.params ? convert(def.params, "params") : {}),
    ...queryParameters(def.query ? convert(def.query, "query") : undefined),
  ];
  if (def.body) {
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: convert(def.body, "body") } },
    };
  }
  if (def.maxBodyBytes !== undefined) op["x-denext-max-body-bytes"] = def.maxBodyBytes;
  op.responses = responses(def, def.response ? convert(def.response, "response") : undefined);
  return op;
}

function schemaFor(
  schema: unknown,
  part: OpenApiWarning["part"],
  converter: SchemaConverter | undefined,
  onOpaque: (message: string) => void,
): JsonSchema {
  const side = part === "response" ? "output" : "input";
  const { schema: json, source } = toJsonSchema(schema, side, converter);
  if (source === "opaque") {
    const vendor = (schema as { "~standard"?: { vendor?: string } })?.["~standard"]?.vendor;
    onOpaque(
      `the ${part} schema${vendor ? ` (${vendor})` : ""} exposes no JSON Schema — ` +
        "emitted as {}; implement Standard JSON Schema or pass `toJsonSchema`",
    );
  }
  return json;
}

/** Path parameters: every dynamic segment, typed from the params schema's properties when known. */
function pathParameters(pattern: Segment[], params: JsonSchema): OpenApiOperation[] {
  const props = (params.properties ?? {}) as Record<string, JsonSchema>;
  return pattern.filter((s) => s.kind !== "static").map((seg) => ({
    name: seg.value,
    in: "path",
    required: true,
    schema: props[seg.value] ?? { type: "string" },
    ...(seg.kind === "static" || seg.kind === "dynamic"
      ? {}
      : { description: 'One or more path segments, "/"-joined.' }),
  }));
}

/** Query parameters: one per property of an object query schema. */
function queryParameters(query: JsonSchema | undefined): OpenApiOperation[] {
  if (!query || typeof query.properties !== "object" || query.properties === null) return [];
  const required = new Set(Array.isArray(query.required) ? query.required as string[] : []);
  return Object.entries(query.properties as Record<string, JsonSchema>).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema,
  }));
}

/** The success response plus one response per declared error status (codes as an enum). */
function responses(def: ApiDefinition, response: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "200": response
      ? { description: "OK", content: { "application/json": { schema: response } } }
      : { description: "OK (a handler that returns nothing answers 204)" },
  };
  const byStatus = new Map<number, { codes: string[]; messages: string[] }>();
  const add = (status: number, code: string, message?: string) => {
    const entry = byStatus.get(status) ?? { codes: [], messages: [] };
    entry.codes.push(code);
    if (message) entry.messages.push(message);
    byStatus.set(status, entry);
  };
  if (def.params || def.query || def.body) add(400, "validation", "Validation failed");
  if (def.body) add(400, "bad_request", "Malformed or non-JSON body");
  for (const [code, spec] of Object.entries(def.errors ?? {})) {
    if (typeof spec === "number") add(spec, code);
    else add(spec.status, code, spec.message);
  }
  for (const [status, { codes, messages }] of [...byStatus].sort(([a], [b]) => a - b)) {
    out[String(status)] = {
      description: messages.length ? messages.join("; ") : codes.join(" | "),
      content: {
        "application/json": {
          schema: {
            allOf: [
              { $ref: "#/components/schemas/ApiError" },
              { properties: { error: { properties: { code: { enum: codes } } } } },
            ],
          },
        },
      },
    };
  }
  // Everything the dispatch seam and middleware may answer with that the definition cannot
  // name (401/429 from `requireSession`/`rateLimit`, 413, a redacted 500 `internal`, …).
  out.default = {
    description: "Any other error — middleware and framework responses (ApiError envelope)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  };
  return out;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

/** One difference between two documents. */
export interface SpecChange {
  /** What happened to the operation or schema. */
  kind: "added" | "removed" | "changed";
  /** `GET /api/todos` for an operation, `components.schemas.X` for a schema. */
  subject: string;
}

/** Compare two documents operation by operation (and shared schema by schema). */
export function diffSpecs(before: OpenApiDocument, after: OpenApiDocument): SpecChange[] {
  const flat = (doc: OpenApiDocument): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        out.set(`${method.toUpperCase()} ${path}`, JSON.stringify(op));
      }
    }
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      out.set(`components.schemas.${name}`, JSON.stringify(schema));
    }
    return out;
  };
  const a = flat(before), b = flat(after);
  const changes: SpecChange[] = [];
  for (const [subject, body] of a) {
    if (!b.has(subject)) changes.push({ kind: "removed", subject });
    else if (b.get(subject) !== body) changes.push({ kind: "changed", subject });
  }
  for (const subject of b.keys()) if (!a.has(subject)) changes.push({ kind: "added", subject });
  return changes;
}
