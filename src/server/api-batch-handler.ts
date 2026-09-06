// `POST /_denext/api-batch` — N typed GET/HEAD calls in one round trip.
//
// Every check, in order, before any item runs (any failure → the whole batch fails, nothing
// executes):
//   1. not itself a batch item (no nested batches, no depth games)
//   2. same-origin (`verifyOrigin` — the SAME CSRF gate as Server Actions: the batch replays
//      the caller's cookies into every item)
//   3. the `x-denext-api-batch: 1` marker (a plain <form> cannot set a custom header → CORS
//      preflight barrier on top of the origin check)
//   4. `content-type: application/json`
//   5. declared Content-Length under the cap, then the body read under the cap (413 / 408)
//   6. `{ v: 1, items: [1..maxItems] }`
//   7. each item: an integer id unique in the batch; method GET/HEAD; a path string ≤ 2048
//      chars that starts with `/` (not `//` or `/\`), resolves against the TRUSTED app origin
//      (never a client-supplied one) to the same origin, and does not target `/_denext/*`
//      (no actions, no live upgrade, no batch, no dev endpoints through a batch)
// Items then run CONCURRENTLY under a small gate, each as a full sub-request (the whole
// pipeline: middleware auth on `/api/*` applies exactly as to a direct call), sharing the
// batch's abort signal. Non-2xx items are ordinary results; item bodies travel as raw text
// (never re-parsed here); item Set-Cookies are merged onto the batch response; the batch
// response is `cache-control: no-store` (the per-item cache headers are gone).

import type { RequestState } from "./pipeline-state.ts";
import { finalize } from "./pipeline-state.ts";
import { verifyOrigin } from "./origin-check.ts";
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
  BATCH_RESULT_HEADERS,
  type BatchItem,
  type BatchRequest,
  type BatchResponse,
  type BatchResult,
  MAX_BATCH_ITEMS_DEFAULT,
} from "../runtime/api-batch-protocol.ts";

import type { ApiBatchConfig } from "./config.ts";

const DEFAULTS = {
  maxItems: MAX_BATCH_ITEMS_DEFAULT,
  maxBodyBytes: 1024 * 1024,
  concurrency: 4,
  maxItemResponseBytes: 4 * 1024 * 1024,
} as const;

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
  const cfg = { ...DEFAULTS, ...config.apiBatch };
  const { request } = state;
  if (config.apiBatch?.enabled === false) return finalize(state, batchError(404, "not found"));
  if (request.headers.get(BATCH_ITEM_HEADER)) {
    return finalize(state, batchError(400, "nested batch"));
  }
  if (!verifyOrigin(request, config)) return finalize(state, batchError(403, "forbidden"));
  if (request.headers.get(API_BATCH_HEADER) !== "1") {
    return finalize(state, batchError(400, "missing batch marker"));
  }
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return finalize(state, batchError(415, "expected application/json"));
  }
  const body = await readBatchBody(request, cfg.maxBodyBytes);
  if (body instanceof Response) return finalize(state, body);
  const items = parseBatch(body, cfg.maxItems, requestOrigin(request, originOptions(config)));
  if (items instanceof Response) return finalize(state, items);
  const results = await runItems(state, items, cfg, runSub);
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

/** A validated item: its URL on the trusted origin. */
interface ResolvedItem extends BatchItem {
  url: URL;
}

/** Checks 6–7: the envelope and every item (any failure fails the whole batch with a 400). */
function parseBatch(text: string, maxItems: number, origin: string): ResolvedItem[] | Response {
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
    const item = resolveItem(raw, origin, seen);
    if (!item) return batchError(400, "malformed batch item");
    out.push(item);
  }
  return out;
}

/** One item's checks (7): id, method, path shape, same trusted origin, no `/_denext/*`. */
function resolveItem(raw: unknown, origin: string, seen: Set<number>): ResolvedItem | null {
  const it = raw as Partial<BatchItem> | null;
  if (!it || typeof it !== "object") return null;
  if (!Number.isInteger(it.id) || (it.id as number) < 0 || seen.has(it.id as number)) return null;
  if (it.m !== "GET" && it.m !== "HEAD") return null;
  const p = it.p;
  if (typeof p !== "string" || p.length === 0 || p.length > 2048) return null;
  if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return null;
  let url: URL;
  try {
    url = new URL(p, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  if (url.pathname.startsWith("/_denext")) return null;
  seen.add(it.id as number);
  return { id: it.id as number, m: it.m, p, url };
}

/** Fan the items out under the gate; every item settles to a result (an abort rethrows). */
async function runItems(
  state: RequestState,
  items: ResolvedItem[],
  cfg: Required<Omit<ApiBatchConfig, "enabled">>,
  runSub: SubRequestRunner,
): Promise<BatchResult[]> {
  const acquire = createGate(cfg.concurrency, items.length, "api batch overloaded");
  return await Promise.all(items.map(async (item) => {
    let release: (() => void) | null = null;
    try {
      release = await acquire();
      return await runItem(state, item, cfg.maxItemResponseBytes, runSub);
    } catch (err) {
      return itemFailure(state, item, err);
    } finally {
      release?.();
    }
  }));
}

/** Run one item as a sub-request and package its response. */
async function runItem(
  state: RequestState,
  item: ResolvedItem,
  maxBytes: number,
  runSub: SubRequestRunner,
): Promise<BatchResult> {
  const request = synthesizeSubRequest({
    method: item.m,
    url: item.url,
    parent: state.request,
    parentCtx: state.ctx,
    idSuffix: `#${item.id}`,
  });
  const res = await runSub(request, state.ctx);
  for (const sc of res.headers.getSetCookie()) state.ctx.outgoingHeaders.append("set-cookie", sc);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel();
    return { id: item.id, s: 500, t: "response too large" };
  }
  const text = await res.text();
  if (text.length > maxBytes) return { id: item.id, s: 500, t: "response too large" };
  const h: Record<string, string> = {};
  for (const name of BATCH_RESULT_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) h[name] = v;
  }
  const result: BatchResult = { id: item.id, s: res.status, h };
  if (text.length > 0) result.t = text;
  if (res.headers.get("x-denext-wire") === "1") result.enc = 1;
  return result;
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
