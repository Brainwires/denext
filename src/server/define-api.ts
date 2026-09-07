// Schema-validated route handlers — the route-handler twin of `defineAction`.
//
// A plain `route.ts` handler is `(Request, { params }) => Response`: its body is whatever
// `req.json()` yields, its query is unparsed, and its errors are hand-built. `defineApi`
// declares the endpoint once — `params` / `query` / `body` / `response` as Standard Schemas
// (Zod, Valibot, ArkType, TypeBox, or a 20-line hand-rolled one; zero denext dependency) plus
// the `errors` it may fail with — and the handler receives PARSED, TYPED input:
//
//   // app/api/posts/[id]/route.ts
//   import { createApi, requireSession } from "denext/server";
//   export const PATCH = createApi().use(requireSession()).define({
//     params: z.object({ id: z.string() }),
//     body: z.object({ title: z.string().min(1) }),
//     response: z.object({ id: z.string(), title: z.string() }),
//     errors: { not_owner: 403 },
//   }, async ({ params, body, fail, ctx }) => {
//     const post = await db.posts.get(params.id);
//     if (post.owner !== ctx.session.user.id) fail("not_owner");  // → 403 { error: { code: "not_owner" } }
//     return db.posts.update(params.id, body);                      // → 200, validated against `response`
//   });
//   // Without middleware the same endpoint is `defineApi(def, handler)`, and `ctx` is `{}`.
//
// Order per request: body cap (handleApi) → middleware → validate params, query, body →
// handler → response validation. Auth and rate-limit middleware therefore reject BEFORE any
// schema runs, so an unauthenticated caller learns nothing about the endpoint's shape. A
// declared `response` schema always runs for a returned VALUE (also in production): a validator
// that strips unknown keys is a data-leak guard (`passwordHash` never leaves), so it must not be
// dev-only. It is skipped when the handler returns a `Response` itself, or `undefined` (a 204).
//
// Middleware composes through `createApi().use(mw)`: each middleware returns a context
// extension (typed accumulation — `use<Ext>` yields `ApiBuilder<Ctx & Ext>`), a `Response` to
// short-circuit, or nothing; it may also throw (`unauthorized()`, an `ApiError`).
//
// The generated `.denext/api.ts` reads the definition back off the handler's TYPE (the
// phantom `__api`), so `createApiClient` knows each endpoint's body, query, response, and
// error codes. `handleApi` reads it off the FUNCTION (the `API_META` symbol) for the body cap
// and the redacted-500 path; an OpenAPI plugin does the same through `apiDefinitionOf`.

import type { ApiContext, ApiHandler, HttpMethod } from "./types.ts";
import type { RouteParams } from "../router/segments.ts";
import {
  fieldErrorsFrom,
  isStandardSchema,
  type StandardSchemaV1,
} from "../runtime/define-action.ts";
import { ApiError, type ApiErrorInit, ApiValidationError } from "./api-error.ts";
import { json } from "./typed-response.ts";
import { decodeWire, WIRE_HEADER } from "../runtime/wire-codec.ts";

/** How a declared error code maps to HTTP: a status, or a status with a default message. */
export type ErrorSpec = number | { status: number; message?: string };

/** What an endpoint declares: its schemas, error codes, and per-method body cap. */
export interface ApiDefinition {
  /** One-line summary (for generated docs / OpenAPI). */
  summary?: string;
  /** Longer description (for generated docs / OpenAPI). */
  description?: string;
  /** Validates the route's dynamic params (`{ id: "7" }`). */
  params?: StandardSchemaV1;
  /** Validates the query string as a record (repeated keys become arrays). */
  query?: StandardSchemaV1;
  /** Validates the JSON request body. Declaring it requires `content-type: application/json`. */
  body?: StandardSchemaV1;
  /** Validates (and strips) the VALUE the handler returns before it is serialized (a returned `Response` or `undefined` bypasses it). */
  response?: StandardSchemaV1;
  /** The error codes the handler may `fail()` with, each mapped to a status. */
  errors?: Record<string, ErrorSpec>;
  /** Per-method body cap in bytes (`false` = unbounded). Overrides the module and app caps. */
  maxBodyBytes?: number | false;
}

/** The value a Standard Schema produces. */
export type SchemaOutput<S> = S extends StandardSchemaV1<infer O> ? O : never;

/** The value a Standard Schema accepts (what a client must send); its output when unknown. */
export type SchemaInput<S> = S extends { "~standard": { types?: { input: infer I } } }
  ? (unknown extends I ? SchemaOutput<S> : I)
  : never;

/** The error codes an endpoint declares (`keyof def.errors`). */
export type ApiErrorCodes<D extends ApiDefinition> = D extends { errors: infer E }
  ? keyof E & string
  : never;

/** The query string as a record: repeated keys become arrays. */
export type QueryRecord = Record<string, string | string[]>;

/** What a `defineApi` handler receives: parsed input, the request, the middleware context. */
export interface ApiHandlerInput<D extends ApiDefinition, Ctx extends object> {
  /** The dynamic params — validated when `def.params` is declared, else the raw record. */
  params: D["params"] extends StandardSchemaV1 ? SchemaOutput<D["params"]> : RouteParams;
  /** The query record — validated when `def.query` is declared. */
  query: D["query"] extends StandardSchemaV1 ? SchemaOutput<D["query"]> : QueryRecord;
  /** The parsed JSON body — validated when `def.body` is declared, else `undefined`. */
  body: D["body"] extends StandardSchemaV1 ? SchemaOutput<D["body"]> : undefined;
  /** The (body-capped, adapted) request, for headers/cookies/streaming. */
  request: Request;
  /** What the middleware chain accumulated (`{}` with no middleware). */
  ctx: Ctx;
  /** Fail with one of the endpoint's declared codes (typed): throws the matching `ApiError`. */
  fail(code: ApiErrorCodes<D>, init?: ApiErrorInit): never;
}

/** What a handler may return: a value matching `def.response` (or anything), or a `Response`. */
export type ApiHandlerResult<D extends ApiDefinition> = D extends { response: infer S }
  ? SchemaInput<S> | Response
  : unknown;

/**
 * The route handler `defineApi` returns: a plain {@link ApiHandler} at runtime, carrying the
 * definition and the handler's result type as a phantom for the typed-API-client generator.
 */
export interface ApiRouteHandler<D extends ApiDefinition, R> extends ApiHandler {
  /** Phantom — never present at runtime; read by the generated `ApiSchema`. */
  readonly __api?: { def: D; result: R };
}

/** What a middleware receives. */
export interface ApiMiddlewareInput<Ctx extends object> {
  /** The (body-capped, adapted) request. */
  request: Request;
  /** The raw dynamic params. */
  params: RouteParams;
  /** The context accumulated by earlier middleware. */
  ctx: Ctx;
  /** The HTTP method. */
  method: HttpMethod;
}

/**
 * A "before" middleware: return an object to extend the context (typed), a `Response` to
 * short-circuit, or nothing. Throw (`unauthorized()`, an `ApiError`) to fail.
 */
export type ApiMiddleware<Ctx extends object, Ext extends object = Record<never, never>> = (
  input: ApiMiddlewareInput<Ctx>,
) => Ext | Response | void | Promise<Ext | Response | void>;

/** A chain of middleware with a typed accumulated context, ending in `.define()`. */
export interface ApiBuilder<Ctx extends object> {
  /** Append a middleware; its returned extension joins the context type. */
  use<Ext extends object>(mw: ApiMiddleware<Ctx, Ext>): ApiBuilder<Ctx & Ext>;
  /** Define the endpoint: its schemas/errors and the handler over the parsed input. */
  define<const D extends ApiDefinition, R extends ApiHandlerResult<D>>(
    def: D,
    handler: (input: ApiHandlerInput<D, Ctx>) => R | Promise<R>,
  ): ApiRouteHandler<D, R>;
}

/** The metadata attached to a `defineApi` handler (what `handleApi` and plugins read). */
export interface ApiRouteMeta {
  /** The endpoint definition. */
  def: ApiDefinition;
  /** The middleware chain, in order. */
  middleware: readonly ApiMiddleware<object, object>[];
}

/** The symbol under which a `defineApi` handler carries its {@link ApiRouteMeta}. */
const API_META: unique symbol = Symbol.for("denext.api") as never;

/**
 * Start a middleware chain for one or more endpoints:
 * `const authed = createApi().use(requireSession()); export const GET = authed.define(...)`.
 *
 * @returns A builder with an empty context.
 */
export function createApi(): ApiBuilder<Record<never, never>> {
  return builder([]);
}

/**
 * Define a schema-validated route handler with no middleware
 * (`createApi().define(def, handler)`). Export it as the method: `export const POST = defineApi(…)`.
 *
 * @param def The endpoint definition (schemas, error codes).
 * @param handler Runs over the parsed, typed input.
 * @returns A route handler `handleApi` dispatches like any other.
 */
export function defineApi<const D extends ApiDefinition, R extends ApiHandlerResult<D>>(
  def: D,
  handler: (input: ApiHandlerInput<D, Record<never, never>>) => R | Promise<R>,
): ApiRouteHandler<D, R> {
  return createApi().define(def, handler);
}

/**
 * The definition + middleware attached to a `defineApi` handler, or `undefined` for a plain
 * function. The seam `handleApi` reads (body cap, error redaction) and the accessor an
 * OpenAPI/docs plugin uses to describe an app's endpoints.
 *
 * @param handler A route module export.
 * @returns The metadata, or `undefined`.
 */
export function apiDefinitionOf(handler: unknown): ApiRouteMeta | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as { [API_META]?: ApiRouteMeta })[API_META];
}

// ── Runtime ──────────────────────────────────────────────────────────────────

function builder<Ctx extends object>(
  chain: readonly ApiMiddleware<object, object>[],
): ApiBuilder<Ctx> {
  return {
    use(mw) {
      return builder([...chain, mw as unknown as ApiMiddleware<object, object>]);
    },
    define(def, handler) {
      const meta: ApiRouteMeta = { def, middleware: chain };
      const run: ApiHandler = (request, context) =>
        runDefined(meta, request, context, handler as DefinedHandler);
      Object.defineProperty(run, API_META, { value: meta });
      return run as ApiRouteHandler<typeof def, Awaited<ReturnType<typeof handler>>>;
    },
  };
}

type DefinedHandler = (input: ApiHandlerInput<ApiDefinition, object>) => unknown;

/** One request through a defined endpoint: middleware → validation → handler → response. */
async function runDefined(
  meta: ApiRouteMeta,
  request: Request,
  context: ApiContext,
  handler: DefinedHandler,
): Promise<Response> {
  const params: RouteParams = { ...context.params };
  const method = request.method.toUpperCase() as HttpMethod;
  const ctx = await runMiddleware(meta.middleware, { request, params, method });
  if (ctx instanceof Response) return ctx;
  const { def } = meta;
  // Erased generics: the concrete shapes are whatever the schemas produced.
  const input = {
    params: await parseSection(def.params, params, "params"),
    query: await parseSection(def.query, queryRecord(request), "query"),
    body: def.body ? await parseSection(def.body, await readJsonBody(request), "body") : undefined,
    request,
    ctx,
    fail: (code: string, init?: ApiErrorInit) => failWith(def, code, init),
  } as unknown as ApiHandlerInput<ApiDefinition, object>;
  return await respond(def, await handler(input));
}

/** Run the chain: an extension merges into `ctx`; a `Response` ends the request. */
async function runMiddleware(
  chain: readonly ApiMiddleware<object, object>[],
  base: { request: Request; params: RouteParams; method: HttpMethod },
): Promise<object | Response> {
  let ctx: object = {};
  for (const mw of chain) {
    const out = await mw({ ...base, ctx });
    if (out instanceof Response) return out;
    if (out && typeof out === "object") ctx = { ...ctx, ...out };
  }
  return ctx;
}

/** Validate one request section (or pass it through when no schema is declared). */
async function parseSection<T>(
  schema: StandardSchemaV1 | undefined,
  raw: T,
  source: "params" | "query" | "body",
): Promise<unknown> {
  if (!schema) return raw;
  if (!isStandardSchema(schema)) {
    throw new TypeError(`defineApi: \`${source}\` is not a Standard Schema`);
  }
  const result = await schema["~standard"].validate(raw);
  if (result.issues) throw new ApiValidationError(source, fieldErrorsFrom(result.issues));
  return result.value;
}

/** The query string as a record; a key repeated becomes an array of its values. */
function queryRecord(request: Request): QueryRecord {
  const out: QueryRecord = {};
  for (const [k, v] of new URL(request.url).searchParams) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[k] = [prev, v];
  }
  return out;
}

/** The JSON body of a request whose endpoint declares `body`; an empty body is `undefined`. */
async function readJsonBody(request: Request): Promise<unknown> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new ApiError(400, "bad_request", { message: "expected an application/json body" });
  }
  const text = await request.text(); // reads through the body cap (→ 413 on overflow)
  if (text.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_request", { message: "malformed JSON body" });
  }
  // A codec-flagged body (a Date / Map / BigInt from the typed client) is decoded before the
  // schema sees it; a malformed tag is the WireCodecError → handleApi's 400.
  return request.headers.get(WIRE_HEADER) === "1" ? decodeWire(parsed) : parsed;
}

/** `fail(code)`: the declared status/message for `code`, merged with the caller's init. */
function failWith(def: ApiDefinition, code: string, init: ApiErrorInit = {}): never {
  const spec = def.errors?.[code];
  const status = typeof spec === "number" ? spec : spec?.status ?? 400;
  const message = init.message ?? (typeof spec === "object" ? spec.message : undefined) ?? code;
  throw new ApiError(status, code, { ...init, message });
}

/** A returned `Response` passes through; a value is validated (when declared) and JSON-encoded. */
async function respond(def: ApiDefinition, result: unknown): Promise<Response> {
  if (result instanceof Response) return result;
  if (result === undefined) return new Response(null, { status: 204 });
  if (!def.response) return json(result);
  const schema = def.response;
  if (!isStandardSchema(schema)) {
    throw new TypeError("defineApi: `response` is not a Standard Schema");
  }
  const checked = await schema["~standard"].validate(result);
  if (checked.issues) {
    // A server bug (the handler returned the wrong shape), not a client error: redacted 500.
    const fields = Object.entries(fieldErrorsFrom(checked.issues)).map(([k, m]) => `${k}: ${m}`);
    throw new Error(`defineApi: response failed validation — ${fields.join("; ")}`);
  }
  return json(checked.value);
}
