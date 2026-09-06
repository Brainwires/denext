// The typed-API batch wire — shared by the client batcher and the server handler, dependency-
// free so the browser bundle pays only for the constants and types it uses.
//
// A page that makes N typed GET calls in one tick sends ONE `POST /_denext/api-batch` and gets
// N results back. Only GET/HEAD are batchable: they are idempotent and safe to fan out;
// mutations keep their own request (ordering, side effects, Set-Cookie, and a second CSRF
// surface all argue against batching them). Items carry no headers and no body of their own —
// the batch request's cookies (and a fixed allowlist of its headers) are replayed to each
// item on the server, so a caller can never smuggle a header through an item.

/** The batch endpoint (same reserved prefix as Server Actions). */
export const API_BATCH_PATH = "/_denext/api-batch";

/** Required on the batch POST (`"1"`). A custom header a plain `<form>` cannot set: a CORS
 * preflight barrier on top of the origin check. */
export const API_BATCH_HEADER = "x-denext-api-batch";

/** Set by the SERVER on each synthesized item request (`"1"`): "API only — no page, static, or
 * nested batch". Never copied from the client. */
export const BATCH_ITEM_HEADER = "x-denext-batch-item";

/** Default cap on items per batch. */
export const MAX_BATCH_ITEMS_DEFAULT = 20;

/** The methods a batch may carry. */
export type BatchMethod = "GET" | "HEAD";

/** One request in a batch. */
export interface BatchItem {
  /** Caller-assigned id, unique within the batch; results are matched on it. */
  id: number;
  /** The method. */
  m: BatchMethod;
  /** The request path + query (`/api/user/7?q=9`), relative to the app origin. */
  p: string;
}

/** The batch request body. */
export interface BatchRequest {
  /** Protocol version. */
  v: 1;
  /** The items, in caller order. */
  items: BatchItem[];
}

/** One item's result. The body travels as raw text — the server never re-parses item JSON. */
export interface BatchResult {
  /** The item's id. */
  id: number;
  /** The item's HTTP status. */
  s: number;
  /** A fixed subset of the item's response headers. */
  h?: Record<string, string>;
  /** The item's response body text (absent for an empty body). */
  t?: string;
  /** `1` when the item's body carries wire-codec tags (its `x-denext-wire` header). */
  enc?: 1;
}

/** The batch response body. */
export interface BatchResponse {
  /** Protocol version. */
  v: 1;
  /** The results (one per item; order follows the items). */
  r: BatchResult[];
}

/** The item response headers the batch carries back to the client. */
export const BATCH_RESULT_HEADERS = ["content-type", "x-request-id", "x-denext-wire"] as const;
