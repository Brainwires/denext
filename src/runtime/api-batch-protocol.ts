// The typed-API batch wire — shared by the client batcher and the server handler, dependency-
// free so the browser bundle pays only for the constants and types it uses.
//
// A page that makes N typed calls in one tick sends ONE `POST /_denext/api-batch` and gets N
// results back. Reads (GET/HEAD) fan out concurrently. Mutations (POST/PUT/PATCH/DELETE) ride
// too, with the guarantees separate requests in call order would give: each runs alone, after
// every item queued before it has settled and before any item queued after it starts, and each
// passes its route's own CSRF checks (the batch's `Origin`, verified like a Server Action's, is
// the item's, and an item may carry its double-submit token). Items carry no other headers —
// the batch request's cookies (and a fixed allowlist of its headers) are replayed to each item on
// the server, so a caller can never smuggle a header through an item.

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

/** The read methods: batched items that may run concurrently. */
export type BatchReadMethod = "GET" | "HEAD";

/** The mutation methods: batched items that run one at a time, in order. */
export type BatchMutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/** The methods a batch may carry. */
export type BatchMethod = BatchReadMethod | BatchMutationMethod;

/** Is `m` a mutation (runs alone, in call order)? */
export function isBatchMutation(m: string): m is BatchMutationMethod {
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

/**
 * The per-item request headers a batch may carry (lower-case): the double-submit CSRF token
 * `csrf({ doubleSubmit })` checks. Every other header comes from the batch request itself.
 */
export const BATCH_ITEM_HEADERS = ["x-csrf-token"] as const;

/** One request in a batch. */
export interface BatchItem {
  /** Caller-assigned id, unique within the batch; results are matched on it. */
  id: number;
  /** The method. */
  m: BatchMethod;
  /** The request path + query (`/api/user/7?q=9`), relative to the app origin. */
  p: string;
  /** A mutation's JSON body text (already wire-encoded by the client). */
  b?: string;
  /** `1` when {@link b} carries wire-codec tags (sent as the item's `x-denext-wire`). */
  benc?: 1;
  /** Item headers — only {@link BATCH_ITEM_HEADERS}. */
  h?: Record<string, string>;
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
