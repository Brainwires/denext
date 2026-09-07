// Typed API errors — the error half of network-boundary type safety.
//
// A route handler that fails has two honest options today: return a hand-built error
// `Response` (untyped, shape drifts per route) or throw (→ an opaque 500). `ApiError` gives
// handlers, `defineApi` middleware, and the framework's own guards ONE way to fail with a
// status, a machine-readable `code`, and optional structured `data` / per-field messages —
// and the client's `ApiClientError` reads the same envelope back, narrowed to the codes an
// endpoint declares.
//
// Wire envelope (only for failures — success bodies are NOT wrapped, so a plain
// `TypedResponse` route stays byte-identical):
//
//   HTTP <status>  content-type: application/json  x-request-id: <id>
//   { "error": { "code": "conflict", "status": 409, "message": "…", "data"?: …,
//                "fieldErrors"?: { field: message }, "digest"?: "…" } }
//
// Redaction: an `ApiError` is AUTHORED for the client, so it passes through `toClientError`
// unredacted in production (it carries the `EXPOSE_ERROR` brand). An unknown throw is still
// redacted to `{ code: "internal", message: "Internal Server Error", digest }` by the dispatch
// seam (`src/server/api.ts`), exactly like a `defineAction` handler error (KNOWN-DIFFERENCES.md).

import { EXPOSE_ERROR } from "../runtime/error-boundary.ts";

/**
 * The error codes the framework itself may produce for any endpoint. An endpoint's declared
 * `errors` (see `defineApi`) are unioned with these on the client. Two are reserved rather
 * than emitted as envelopes today: a 405 is plain text and a batch 408 is `{ error: string }`,
 * so a client sees them as `http_error`.
 */
export type BuiltinApiErrorCode =
  | "validation"
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "request_timeout"
  | "rate_limited"
  | "internal";

/** Optional parts of an {@link ApiError}. */
export interface ApiErrorInit {
  /** Human-readable message (defaults to the code). Safe to show to the caller. */
  message?: string;
  /** Structured, JSON-serializable detail for the client (never internal state). */
  data?: unknown;
  /** Per-field validation messages, keyed by field name. */
  fieldErrors?: Record<string, string>;
  /** Extra response headers (e.g. `retry-after` on a 429). */
  headers?: HeadersInit;
}

/** The JSON body of a failed API response. */
export interface ApiErrorBody {
  /** The error envelope. */
  error: {
    /** Machine-readable code — an endpoint's declared code or a {@link BuiltinApiErrorCode}. */
    code: string;
    /** The HTTP status the response carried. */
    status: number;
    /** Human-readable message. */
    message: string;
    /** Structured detail, when the thrower attached any. */
    data?: unknown;
    /** Per-field validation messages, when applicable. */
    fieldErrors?: Record<string, string>;
    /** Present on a redacted internal error: correlates with the server log line. */
    digest?: string;
  };
}

/** Brand shared across module instances (a route module may load its own copy of denext). */
const API_ERROR_BRAND: unique symbol = Symbol.for("denext.apiError") as never;

/**
 * A typed API failure: an HTTP `status`, a machine-readable `code`, and optional `data` /
 * `fieldErrors` / `headers`. Throw it from a route handler (plain or `defineApi`) or from
 * `defineApi` middleware; the dispatch seam turns it into the JSON error envelope and the
 * client rebuilds it as an `ApiClientError` with the same fields.
 *
 * Authored for the caller: it is NOT redacted in production (unlike an arbitrary throw), so
 * never put internal detail in `message` or `data`.
 */
export class ApiError extends Error {
  /** The HTTP status to respond with. */
  readonly status: number;
  /** The machine-readable code the client branches on. */
  readonly code: string;
  /** Structured, client-safe detail. */
  readonly data?: unknown;
  /** Per-field validation messages. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Extra response headers. */
  readonly headers?: HeadersInit;

  /**
   * Create a typed API error.
   *
   * @param status The HTTP status (4xx/5xx).
   * @param code The machine-readable code (an endpoint's declared code or a builtin).
   * @param init Message, data, field errors, headers.
   */
  constructor(status: number, code: string, init: ApiErrorInit = {}) {
    super(init.message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (init.data !== undefined) this.data = init.data;
    if (init.fieldErrors) this.fieldErrors = init.fieldErrors;
    if (init.headers) this.headers = init.headers;
    // Brands are non-enumerable so `{ ...err }` / JSON never carry them.
    Object.defineProperty(this, API_ERROR_BRAND, { value: true });
    Object.defineProperty(this, EXPOSE_ERROR, { value: true });
  }
}

/**
 * Is `value` an {@link ApiError} (from any loaded copy of denext)?
 *
 * @param value The caught value.
 * @returns True for an `ApiError`.
 */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof Error &&
    (value as { [API_ERROR_BRAND]?: boolean })[API_ERROR_BRAND] === true;
}

/** Which part of the request a validation failure came from. */
export type ApiValidationSource = "params" | "query" | "body";

/**
 * A request that failed schema validation: a 400 with code `"validation"`, the per-field
 * messages, and `data.source` naming the offending part of the request.
 */
export class ApiValidationError extends ApiError {
  /** The part of the request that failed. */
  readonly source: ApiValidationSource;

  /**
   * Create a validation error.
   *
   * @param source Which request part failed (`params` / `query` / `body`).
   * @param fieldErrors Per-field messages (a Standard Schema's issues, keyed by top path).
   * @param message Overall message (default `"Validation failed"`).
   */
  constructor(
    source: ApiValidationSource,
    fieldErrors: Record<string, string>,
    message = "Validation failed",
  ) {
    super(400, "validation", { message, fieldErrors, data: { source } });
    this.name = "ApiValidationError";
    this.source = source;
  }
}

/**
 * Build the JSON error `Response` for an {@link ApiError}: the envelope body, the error's
 * status and extra headers, `x-request-id` when known, and `digest` on a redacted internal
 * error.
 *
 * @param err The error to serialize.
 * @param requestId The request's correlation id (echoed as `x-request-id`).
 * @param digest The redaction digest (only for a redacted `internal` error).
 * @returns The response to send.
 */
export function apiErrorResponse(err: ApiError, requestId?: string, digest?: string): Response {
  const body: ApiErrorBody = {
    error: { code: err.code, status: err.status, message: err.message },
  };
  if (err.data !== undefined) body.error.data = err.data;
  if (err.fieldErrors) body.error.fieldErrors = { ...err.fieldErrors };
  if (digest) body.error.digest = digest;
  const headers = new Headers(err.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (requestId) headers.set("x-request-id", requestId);
  return new Response(JSON.stringify(body), { status: err.status, headers });
}
