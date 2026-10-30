// `POST /_denext/api-batch` — N typed calls in one round trip.
//
// Every check, in order, before any item runs (any failure → the whole batch fails, nothing
// executes):
//   1. not itself a batch item (no nested batches, no depth games)
//   2. same-origin (`verifyOrigin` — the SAME CSRF gate as Server Actions: the batch replays
//      the caller's cookies into every item), or an origin the app's `cors` lists exactly (never
//      `["*"]`) carrying no cookie (`corsCredentialless`: nothing ambient to replay)
//   3. the `x-denext-api-batch: 1` marker (a plain <form> cannot set a custom header → CORS
//      preflight barrier on top of the origin check)
//   4. `content-type: application/json`
//   5. declared Content-Length under the cap, then the body read under the cap (413 / 408)
//   6. `{ v: 1, items: [1..maxItems] }`
//   7. each item: an integer id unique in the batch; method GET/HEAD, or POST/PUT/PATCH/DELETE
//      (unless `apiBatch.mutations: false`); a body only on a mutation, a string; headers only
//      `BATCH_ITEM_HEADERS` on a mutation and the app's `apiBatch.forwardHeaders` on any item
//      (never a credential, framing, trust or proxy header, nor the app's `rateLimitHeader`),
//      each value a single-line header value of at most 1024 characters; a path string ≤ 2048 chars that starts with `/` (not `//` or
//      `/\`), resolves against the TRUSTED app origin (never a client-supplied one) to the same
//      origin, and does not target `/_denext/*` (no actions, no live upgrade, no batch, no dev
//      endpoints through a batch)
// Items then run as full sub-requests (the whole pipeline: middleware auth on `/api/*` applies
// exactly as to a direct call), sharing the batch's abort signal, under a small gate. Reads run
// concurrently; a mutation runs ALONE, after every item before it settled and before any item
// after it starts — the order the calls were made in. A mutation item gets the batch's
// `Origin` and `Host` (already verified, as for a Server Action) so the route's own `csrf()` sees the same
// proof a direct call would carry, plus its own double-submit token when it sent one. A forwarded
// header reaches its own item's sub-request only: never another item's, and never from the batch
// request itself.
// Non-2xx items are ordinary results; item bodies travel as raw text (never re-parsed here);
// item Set-Cookies are merged onto the batch response; the batch response is
// `cache-control: no-store` (the per-item cache headers are gone).

import type { RequestState } from "./pipeline-state.ts";
import { finalize } from "./pipeline-state.ts";
import { verifyOrigin } from "./origin-check.ts";
import { BATCH_CORS_HEADER, corsCredentialless } from "./cors.ts";
import { originOptions, reportRequestError } from "./app-config.ts";
import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "./body.ts";
import { requestOrigin } from "./absolute-url.ts";
import { createGate, GateOverloadError } from "./gate.ts";
import { isAbortError } from "./abort.ts";
import { type SubRequestRunner, synthesizeSubRequest } from "./sub-request.ts";
import {
  API_BATCH_HEADER,
  API_BATCH_PATH,
  BATCH_ITEM_HEADER,
  BATCH_ITEM_HEADERS,
  BATCH_RESULT_HEADERS,
  type BatchItem,
  type BatchRequest,
  type BatchResponse,
  type BatchResult,
  forwardableBatchHeaders,
  isBatchHeaderValue,
  isBatchMutation,
  MAX_BATCH_ITEMS_DEFAULT,
} from "../runtime/api-batch-protocol.ts";

import type { ApiBatchConfig } from "./config.ts";

const DEFAULTS = {
  maxItems: MAX_BATCH_ITEMS_DEFAULT,
  maxBodyBytes: 1024 * 1024,
  concurrency: 4,
  maxItemResponseBytes: 4 * 1024 * 1024,
  maxTotalResponseBytes: 16 * 1024 * 1024,
} as const;

type BatchCaps = { -readonly [K in keyof typeof DEFAULTS]: number };

/**
 * The effective caps: a key the config leaves `undefined` keeps its default (no object spread —
 * an explicit `undefined` in the config must not lift a cap).
 */
function batchCaps(config: ApiBatchConfig | undefined): BatchCaps {
  const caps: BatchCaps = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof BatchCaps)[]) {
    const v = config?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) caps[key] = v;
  }
  return caps;
}

/** Is this the batch POST? (A batch item can never be one: the marker refuses it later.) */
export function isApiBatchRequest(request: Request, pathname: string): boolean {
  return request.method === "POST" && pathname === API_BATCH_PATH;
}

/** A whole-batch failure. */
function batchError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Handle a batch POST (checks 1–7, then the fan-out). Runs inside the request's async context.
 *
 * @param state The pipeline state of the batch request.
 * @param runSub Runs one item as a sub-request through the full pipeline.
 * @returns The batch response (or the whole-batch failure).
 */
export async function handleApiBatch(
  state: RequestState,
  runSub: SubRequestRunner,
): Promise<Response> {
  const { config } = state.app;
  const cfg = batchCaps(config.apiBatch);
  const { request } = state;
  if (config.apiBatch?.enabled === false) return finalize(state, batchError(404, "not found"));
  if (request.headers.get(BATCH_ITEM_HEADER)) {
    return finalize(state, batchError(400, "nested batch"));
  }
  // A batch let in by the app's `cors` alone (another origin, no cookie) runs each item under
  // that item's route policy too (`BATCH_CORS_HEADER`): a route whose own `cors()` leaves the
  // origin out is no more reachable through the batch than directly.
  const crossOrigin = !verifyOrigin(request, config);
  if (crossOrigin && !corsCredentialless(request, state.app.cors ?? null)) {
    return finalize(state, batchError(403, "forbidden"));
  }
  if (request.headers.get(API_BATCH_HEADER) !== "1") {
    return finalize(state, batchError(400, "missing batch marker"));
  }
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return finalize(state, batchError(415, "expected application/json"));
  }
  const body = await readBatchBody(request, cfg.maxBodyBytes);
  if (body instanceof Response) return finalize(state, body);
  const items = parseBatch(body, cfg.maxItems, requestOrigin(request, originOptions(config)), {
    mutations: config.apiBatch?.mutations !== false,
    forward: forwardedHeaders(config.apiBatch?.forwardHeaders, state.ctx.limitPolicy?.header),
  });
  if (items instanceof Response) return finalize(state, items);
  const results = await runItems(state, items, cfg, runSub, crossOrigin);
  return finalize(state, batchResponse(results));
}

/** Read the batch body under the cap: the bytes, or the 413/408 response. */
async function readBatchBody(request: Request, maxBodyBytes: number): Promise<string | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBodyBytes) return batchError(413, "payload too large");
  const buffered = await readCappedBody(request, maxBodyBytes);
  if (buffered === TOO_LARGE) return batchError(413, "payload too large");
  if (buffered === STALLED) return batchError(408, "request timeout");
  return await bufferedRequest(request, buffered).text();
}

/**
 * The headers an item may carry beyond `x-csrf-token`: the app's `forwardHeaders`, lower-cased,
 * minus anything {@link forwardableBatchHeaders} refuses and the app's `rateLimitHeader` (the
 * client address a limiter keys on comes from the batch request alone).
 */
function forwardedHeaders(
  list: readonly string[] | undefined,
  limitHeader: string | undefined,
): Set<string> {
  const names = forwardableBatchHeaders(list);
  if (limitHeader) names.delete(limitHeader.toLowerCase());
  return names;
}

/** What the app lets a batch carry: mutation items, and the headers forwarded per item. */
interface ItemPolicy {
  mutations: boolean;
  forward: Set<string>;
}

/** A validated item: its URL on the trusted origin. */
interface ResolvedItem extends BatchItem {
  url: URL;
}

/** Checks 6–7: the envelope and every item (any failure fails the whole batch with a 400). */
function parseBatch(
  text: string,
  maxItems: number,
  origin: string,
  policy: ItemPolicy,
): ResolvedItem[] | Response {
  let parsed: Partial<Record<keyof BatchRequest, unknown>> | null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return batchError(400, "malformed batch");
  }
  if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return batchError(400, "malformed batch");
  if (parsed.items.length < 1 || parsed.items.length > maxItems) {
    return batchError(400, `a batch carries 1 to ${maxItems} items`);
  }
  const seen = new Set<number>();
  const out: ResolvedItem[] = [];
  for (const raw of parsed.items) {
    const item = resolveItem(raw, origin, seen, policy);
    if (!item) return batchError(400, "malformed batch item");
    out.push(item);
  }
  return out;
}

/** One item's checks (7): id, method, body, headers, path shape, same trusted origin. */
function resolveItem(
  raw: unknown,
  origin: string,
  seen: Set<number>,
  policy: ItemPolicy,
): ResolvedItem | null {
  const it = raw as Partial<BatchItem> | null;
  if (!it || typeof it !== "object") return null;
  if (!Number.isInteger(it.id) || (it.id as number) < 0 || seen.has(it.id as number)) return null;
  if (!methodAllowed(it, policy.mutations) || !headersAllowed(it.h, policy.forward)) return null;
  const url = itemUrl(it.p, origin);
  if (!url) return null;
  seen.add(it.id as number);
  return {
    id: it.id as number,
    m: it.m!,
    p: it.p!,
    url,
    ...(it.b !== undefined ? { b: it.b } : {}),
    ...(it.benc === 1 ? { benc: 1 as const } : {}),
    ...(it.h ? { h: it.h } : {}),
  };
}

/** A read with no body, or (when allowed) a mutation whose body, if any, is a string. */
function methodAllowed(it: Partial<BatchItem>, mutations: boolean): boolean {
  if (it.m === "GET" || it.m === "HEAD") return it.b === undefined && it.benc === undefined;
  if (!mutations || !isBatchMutation(String(it.m))) return false;
  return bodyAllowed(it.b, it.benc);
}

/** A mutation body: absent, or a string — and the codec flag only on a body. */
function bodyAllowed(b: unknown, benc: unknown): boolean {
  if (b === undefined) return benc === undefined;
  return typeof b === "string" && (benc === undefined || benc === 1);
}

/**
 * Item headers: absent, or only the allowlisted names (`x-csrf-token`, the forwarded ones) —
 * exact lower-case keys — each with a single-line value of at most 1024 characters.
 */
function headersAllowed(h: unknown, forward: Set<string>): boolean {
  if (h === undefined) return true;
  if (!h || typeof h !== "object" || Array.isArray(h)) return false;
  return Object.entries(h).every(([k, v]) =>
    (forward.has(k) || (BATCH_ITEM_HEADERS as readonly string[]).includes(k)) &&
    isBatchHeaderValue(v)
  );
}

/** A relative path a batch may name: `/…`, not protocol-relative, at most 2048 chars. */
function isRelativePath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 2048 && p.startsWith("/") &&
    !p.startsWith("//") && !p.startsWith("/\\");
}

/** The item's URL on the trusted origin: a relative, non-reserved path, or `null`. */
function itemUrl(p: unknown, origin: string): URL | null {
  if (!isRelativePath(p)) return null;
  let url: URL;
  try {
    url = new URL(p, origin);
  } catch {
    return null;
  }
  const sameOrigin = url.origin === new URL(origin).origin;
  return sameOrigin && !url.pathname.startsWith("/_denext") ? url : null;
}

/**
 * One gate per app (process): N concurrent batches share `concurrency` slots and at most
 * `maxItems × 4` waiters, so the endpoint cannot multiply the server's concurrency by the
 * number of clients — overflow is a per-item 503 `overloaded`, never a lost batch. (A per-batch
 * gate could never shed: a batch has at most `maxItems` items.)
 */
const gates = new WeakMap<object, () => Promise<() => void>>();

function gateFor(app: object, cfg: BatchCaps): () => Promise<() => void> {
  let gate = gates.get(app);
  if (!gate) {
    gate = createGate(cfg.concurrency, cfg.maxItems * 4, "api batch overloaded");
    gates.set(app, gate);
  }
  return gate;
}

/**
 * Run the items in call order: consecutive reads together (concurrently, under the gate), each
 * mutation alone once everything before it has settled. Every item settles to a result (an
 * abort rethrows).
 */
async function runItems(
  state: RequestState,
  items: ResolvedItem[],
  cfg: BatchCaps,
  runSub: SubRequestRunner,
  crossOrigin: boolean,
): Promise<BatchResult[]> {
  const acquire = gateFor(state.app, cfg);
  // One budget for the whole batch: N items × the per-item cap must not be N× the memory.
  const budget = { left: cfg.maxTotalResponseBytes };
  const one = async (item: ResolvedItem): Promise<BatchResult> => {
    let release: (() => void) | null = null;
    try {
      release = await acquire();
      return await runItem(
        state,
        item,
        { maxBytes: cfg.maxItemResponseBytes, budget, crossOrigin },
        runSub,
      );
    } catch (err) {
      return itemFailure(state, item, err);
    } finally {
      release?.();
    }
  };
  const results: BatchResult[] = [];
  for (const phase of phasesOf(items)) results.push(...await Promise.all(phase.map(one)));
  return results;
}

/** Split the items into phases: a run of reads, or one mutation — in call order. */
function phasesOf(items: ResolvedItem[]): ResolvedItem[][] {
  const phases: ResolvedItem[][] = [];
  for (const item of items) {
    const last = phases.at(-1);
    if (!isBatchMutation(item.m) && last && !isBatchMutation(last[0].m)) last.push(item);
    else phases.push([item]);
  }
  return phases;
}

/**
 * The headers an item adds to its sub-request: its own forwarded headers; on a mutation also its
 * JSON content type (and codec flag), its `x-csrf-token`, and the batch's verified `Origin`
 * (else `Referer`) — the proof the route's own CSRF check reads. Set after the item's own
 * headers, so none of them can be replaced (the parse refused those names anyway).
 */
function itemHeaders(state: RequestState, item: ResolvedItem, crossOrigin: boolean): Headers {
  const mutation = isBatchMutation(item.m);
  const headers = ownItemHeaders(item, mutation);
  if (crossOrigin) {
    headers.set(BATCH_CORS_HEADER, "1");
    headers.set("origin", state.request.headers.get("origin")!);
  }
  if (mutation) addMutationHeaders(state, item, headers);
  return headers;
}

/**
 * The item's own headers: its forwarded ones, and on a mutation its `x-csrf-token` (the
 * double-submit proof; a read has no use for it).
 */
function ownItemHeaders(item: ResolvedItem, mutation: boolean): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(item.h ?? {})) {
    if (mutation || !(BATCH_ITEM_HEADERS as readonly string[]).includes(k)) headers.set(k, v);
  }
  return headers;
}

/** A mutation's JSON content type (and codec flag), and the batch's verified `Origin` / `Referer`. */
function addMutationHeaders(state: RequestState, item: ResolvedItem, headers: Headers): void {
  if (item.b !== undefined) headers.set("content-type", "application/json");
  if (item.benc === 1) headers.set("x-denext-wire", "1");
  const origin = state.request.headers.get("origin");
  const referer = state.request.headers.get("referer");
  if (origin) headers.set("origin", origin);
  else if (referer) headers.set("referer", referer);
}

/** How one item runs: its response caps, and whether the batch came from another origin. */
interface ItemRun {
  /** The item's response cap. */
  maxBytes: number;
  /** The batch's shared response budget. */
  budget: { left: number };
  /** Let in by the app's `cors` (another origin, no cookie). */
  crossOrigin: boolean;
}

/** Run one item as a sub-request and package its response. */
async function runItem(
  state: RequestState,
  item: ResolvedItem,
  { maxBytes, budget, crossOrigin }: ItemRun,
  runSub: SubRequestRunner,
): Promise<BatchResult> {
  const request = synthesizeSubRequest({
    method: item.m,
    url: item.url,
    parent: state.request,
    parentCtx: state.ctx,
    idSuffix: `#${item.id}`,
    extraHeaders: itemHeaders(state, item, crossOrigin),
    body: item.b,
    inheritHost: isBatchMutation(item.m),
  });
  const res = await runSub(request, state.ctx);
  for (const sc of res.headers.getSetCookie()) state.ctx.outgoingHeaders.append("set-cookie", sc);
  const h: Record<string, string> = {};
  for (const name of BATCH_RESULT_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) h[name] = v;
  }
  const cap = Math.min(maxBytes, Math.max(0, budget.left));
  const text = await readResponseText(res, cap);
  // Items run concurrently: charge the shared budget on completion and let it decide — the
  // item that overdraws it is the one that is too large, whichever finished first.
  if (text !== null) budget.left -= new TextEncoder().encode(text).byteLength;
  if (text === null || budget.left < 0) return tooLarge(item, res.status, h);
  const result: BatchResult = { id: item.id, s: res.status, h };
  if (text.length > 0) result.t = text;
  if (res.headers.get("x-denext-wire") === "1") result.enc = 1;
  return result;
}

/**
 * An item whose response is over its cap. A read is a 500 (asking again is harmless); a
 * mutation already ran, so it keeps its own status with the body dropped (and says so) — a 5xx
 * would invite a retry that applies the change twice.
 */
function tooLarge(item: ResolvedItem, status: number, h: Record<string, string>): BatchResult {
  if (!isBatchMutation(item.m)) return { id: item.id, s: 500, t: "response too large" };
  const { "content-type": _dropped, ...rest } = h;
  return { id: item.id, s: status, h: { ...rest, [BATCH_DROPPED_HEADER]: "response too large" } };
}

/** On a mutation's result whose response body was over the cap: why the body is missing. */
const BATCH_DROPPED_HEADER = "x-denext-batch-dropped";

/**
 * Read a response body under `maxBytes`, STREAMING — the cap is enforced as chunks arrive, so a
 * chunked (no content-length) or endless body never sits in memory past the cap. `null` = over.
 */
async function readResponseText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes || !res.body) {
    await res.body?.cancel();
    return declared > maxBytes ? null : "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** An item that threw: an abort fails the whole batch; overload is a 503 item; else a 500 item. */
function itemFailure(state: RequestState, item: ResolvedItem, err: unknown): BatchResult {
  if (isAbortError(err) || state.ctx.signal?.aborted) throw err;
  if (err instanceof GateOverloadError) return { id: item.id, s: 503, t: "overloaded" };
  void reportRequestError(state.app.config, err, state.request, item.url.pathname, {
    routeType: "route",
  });
  return {
    id: item.id,
    s: 500,
    t: "internal error",
    h: { "x-request-id": `${state.ctx.requestId}#${item.id}` },
  };
}

function batchResponse(results: BatchResult[]): Response {
  const body: BatchResponse = { v: 1, r: results };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
