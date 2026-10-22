// The typed-API batch wire — shared by the client batcher and the server handler, dependency-
// free so the browser bundle pays only for the constants and types it uses.
//
// A page that makes N typed calls in one tick sends ONE `POST /_denext/api-batch` and gets N
// results back. Reads (GET/HEAD) fan out concurrently. Mutations (POST/PUT/PATCH/DELETE) ride
// too, with the guarantees separate requests in call order would give: each runs alone, after
// every item queued before it has settled and before any item queued after it starts, and each
// passes its route's own CSRF checks (the batch's `Origin`, verified like a Server Action's, is
// the item's, and an item may carry its double-submit token). Items carry no other headers but
// the ones the app forwards (`apiBatch.forwardHeaders`, e.g. `x-tenant`), each item its own
// value — the batch request's cookies (and a fixed allowlist of its headers) are replayed to
// each item on the server, and no item can set a credential, framing or proxy header.

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

/**
 * Request headers no batch item may carry, whatever an app's `forwardHeaders` lists: framing and
 * hop-by-hop headers, the credentials every item inherits from the batch request itself
 * (`cookie`, `authorization`, a gateway's `apikey`), what the server derives an item's trust
 * from (`origin`, `referer`, `host`, the request id, a method override), and what a reverse
 * proxy, CDN, hosting platform or auth proxy sets or sanitizes on the OUTER request — the client
 * address, scheme, TLS client certificate and signed-in identity it vouches for. An item value
 * would otherwise reach a handler without passing that proxy. Trace context (`traceparent`,
 * `x-cloud-trace-context`) carries no identity or trust, so an app may still forward it.
 */
const NEVER_FORWARDED = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "apikey",
  "authorization",
  "cdn-loop",
  "client-ip",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "forwarded",
  "front-end-https",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "user-agent",
  "via",
  "x-apigateway-api-userinfo",
  "x-bb-ip",
  "x-client-cert",
  "x-client-ip",
  "x-client-verify",
  "x-cluster-client-ip",
  "x-csrf-token",
  "x-endpoint-api-userinfo",
  "x-forwarded",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
  "x-originating-ip",
  "x-real-ip",
  "x-remote-addr",
  "x-remote-ip",
  "x-remote-user",
  "x-request-id",
  "x-scheme",
  "x-serverless-authorization",
  "x-url-scheme",
]);

/** Prefixes of header families no batch item may carry (see {@link NEVER_FORWARDED}). */
const NEVER_FORWARDED_PREFIXES = [
  "access-control-",
  "akamai-",
  "cf-",
  "cloudfront-",
  "fastly-",
  "fly-",
  "proxy-",
  "remote-",
  "sec-",
  "ssl-",
  "x-amz-",
  "x-amzn-",
  "x-appengine-",
  "x-arr-",
  "x-auth-request-",
  "x-azure-",
  "x-cloudtasks-",
  "x-denext-",
  "x-envoy-",
  "x-forwarded-",
  "x-goog-",
  "x-invoke-",
  "x-middleware-",
  "x-ms-client-principal",
  "x-ms-token-",
  "x-nextjs-",
  "x-nf-",
  "x-now-",
  "x-original-",
  "x-pomerium-",
  "x-ssl-",
  "x-vercel-",
];

/** An HTTP header name (RFC 9110 token), lower-case. */
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/**
 * May an app forward `name` per batch item (`apiBatch.forwardHeaders`)? A lower-case header
 * token that is not a framing, credential, trust or proxy header (`x-csrf-token` is always an
 * item header on a mutation, so it is not listed).
 *
 * @param name The lower-case header name.
 * @returns Whether it may be listed.
 */
export function isForwardableBatchHeader(name: string): boolean {
  return HEADER_NAME.test(name) && !NEVER_FORWARDED.has(name) &&
    !NEVER_FORWARDED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * The forwardable names of a `forwardHeaders` list, lower-cased (anything else dropped).
 *
 * @param list The configured names.
 * @returns The names an item may carry.
 */
export function forwardableBatchHeaders(list: readonly unknown[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const name = typeof raw === "string" ? raw.toLowerCase() : "";
    if (isForwardableBatchHeader(name)) out.add(name);
  }
  return out;
}

/** The longest value a batch item header may carry. */
const MAX_BATCH_HEADER_VALUE = 1024;

/**
 * A header value an item may carry: visible ASCII / obs-text and inner spaces or tabs, no
 * leading or trailing whitespace, no control character (no CR / LF / NUL: nothing can split or
 * end a header), at most {@link MAX_BATCH_HEADER_VALUE} characters.
 *
 * @param v The value.
 * @returns Whether it is acceptable.
 */
export function isBatchHeaderValue(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_BATCH_HEADER_VALUE &&
    /^(?:[\x21-\x7e\x80-\xff](?:[\t\x20-\x7e\x80-\xff]*[\x21-\x7e\x80-\xff])?)?$/.test(v);
}

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
  /**
   * Item headers — {@link BATCH_ITEM_HEADERS} on a mutation, and the names the app forwards
   * (`apiBatch.forwardHeaders`) on any item, each with this item's own value.
   */
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
