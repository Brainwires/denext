// The client half of typed-API batching: coalesce the GET/HEAD calls a page makes in one tick
// into a single `POST /_denext/api-batch`, and hand each caller back an ordinary `Response`
// synthesized from its item result — so the typed client's normal result / error-envelope
// parsing applies unchanged.
//
// Scheduling: `enqueue` pushes onto a pending list and schedules ONE microtask flush per turn.
// A flush with a single pending item skips the batch entirely (a plain request, no overhead);
// otherwise the items are chunked by `maxItems` and each chunk POSTed. Per-item abort: an item
// whose signal fires is rejected on its own; the batch request is not aborted for one caller.
// A batch-level failure (403 origin, 413, 400 …) resolves EVERY item to a Response carrying the
// batch's status and body, so the caller sees a consistent `ApiClientError`.
//
// Dependency-free (besides the protocol constants) and side-effect free: it ships only with
// apps that import `createApiClient`.

import {
  API_BATCH_HEADER,
  API_BATCH_PATH,
  type BatchItem,
  type BatchMethod,
  type BatchRequest,
  type BatchResponse,
  type BatchResult,
  MAX_BATCH_ITEMS_DEFAULT,
} from "./api-batch-protocol.ts";

/** Options for {@link createBatcher}. */
export interface BatcherOptions {
  /** The `fetch` to use (default: the global). */
  fetch?: typeof fetch;
  /** Origin/base prefix for the batch POST and for single-item fast-path requests. */
  base?: string;
  /** Max items per batch POST (default 20; a larger set is split into several POSTs). */
  maxItems?: number;
}

/** One call waiting for the next flush. */
interface Pending {
  method: BatchMethod;
  /** The request path + query, relative to the app origin. */
  path: string;
  signal?: AbortSignal;
  timeoutMs: number;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

/** A batcher bound to one client: {@link Batcher.enqueue} returns the item's `Response`. */
export interface Batcher {
  /**
   * Queue one GET/HEAD; it rides the next flush.
   *
   * @param method GET or HEAD.
   * @param path The request path + query (relative).
   * @param signal The caller's abort signal (composed with its timeout already).
   * @param timeoutMs The caller's timeout (the batch waits for the longest).
   * @returns The item's response, synthesized from its batch result.
   */
  enqueue(
    method: BatchMethod,
    path: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Response>;
}

/** Statuses for which a `Response` may not carry a body. */
const BODYLESS = new Set([204, 205, 304]);

/**
 * Create a batcher.
 *
 * @param options fetch / base / maxItems.
 * @returns The batcher.
 */
export function createBatcher(options: BatcherOptions = {}): Batcher {
  const fetchImpl = options.fetch;
  const base = options.base ?? "";
  const maxItems = Math.max(1, options.maxItems ?? MAX_BATCH_ITEMS_DEFAULT);
  let pending: Pending[] = [];
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const batch = pending;
    pending = [];
    const live = batch.filter((p) => !rejectIfAborted(p));
    if (live.length === 1) return void runSingle(live[0], fetchImpl, base);
    for (let i = 0; i < live.length; i += maxItems) {
      void runChunk(live.slice(i, i + maxItems), fetchImpl, base);
    }
  };

  return {
    enqueue(method, path, signal, timeoutMs) {
      return new Promise<Response>((resolve, reject) => {
        pending.push({ method, path, signal, timeoutMs, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
    },
  };
}

/** Reject an item whose signal already fired (it never joins a request). */
function rejectIfAborted(p: Pending): boolean {
  if (!p.signal?.aborted) return false;
  p.reject(p.signal.reason ?? new DOMException("aborted", "AbortError"));
  return true;
}

/** One pending item: a plain request, no batch framing. */
async function runSingle(
  p: Pending,
  fetchImpl: typeof fetch | undefined,
  base: string,
): Promise<void> {
  try {
    p.resolve(await (fetchImpl ?? fetch)(base + p.path, { method: p.method, signal: p.signal }));
  } catch (err) {
    p.reject(err);
  }
}

/** POST one chunk and settle each of its items. */
async function runChunk(
  chunk: Pending[],
  fetchImpl: typeof fetch | undefined,
  base: string,
): Promise<void> {
  const items: BatchItem[] = chunk.map((p, id) => ({ id, m: p.method, p: p.path }));
  const body: BatchRequest = { v: 1, items };
  const timeout = AbortSignal.timeout(Math.max(...chunk.map((p) => p.timeoutMs)));
  let res: Response;
  try {
    res = await (fetchImpl ?? fetch)(base + API_BATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", [API_BATCH_HEADER]: "1" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal: timeout,
    });
  } catch (err) {
    for (const p of chunk) p.reject(err);
    return;
  }
  if (!res.ok) return settleWholeBatch(chunk, res);
  const parsed = (await res.json().catch(() => null)) as BatchResponse | null;
  const byId = new Map<number, BatchResult>();
  for (const r of parsed?.r ?? []) if (typeof r?.id === "number") byId.set(r.id, r);
  chunk.forEach((p, id) => {
    if (rejectIfAborted(p)) return;
    const r = byId.get(id);
    p.resolve(r ? itemResponse(r) : new Response("batch item missing", { status: 502 }));
  });
}

/** A batch-level failure: every item sees the batch's status and body. */
async function settleWholeBatch(chunk: Pending[], res: Response): Promise<void> {
  const text = await res.text().catch(() => "");
  for (const p of chunk) {
    p.resolve(
      new Response(BODYLESS.has(res.status) ? null : text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
    );
  }
}

/** Rebuild an item's `Response` (status, header subset, raw body, `x-denext-wire` from `enc`). */
function itemResponse(r: BatchResult): Response {
  const headers = new Headers(r.h);
  if (r.enc === 1) headers.set("x-denext-wire", "1");
  if (r.t === undefined) headers.set("content-length", "0");
  return new Response(BODYLESS.has(r.s) ? null : r.t ?? null, { status: r.s, headers });
}
