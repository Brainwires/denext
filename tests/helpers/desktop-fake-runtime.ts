// A fake of the Deno Desktop runtime's bridge endpoints, implementing the gate and wire contract
// of the bridge interface (§1–§2) so the page side can be tested without a desktop build:
//
//   POST /_denext/desktop/rpc     token + exact Origin + application/json + POST, then the
//                                 capability allowlist; answers { ok, data } / { ok:false, error }
//   GET  /_denext/desktop/events  token (+ Origin when sent); SSE frames { cap, event, data } with
//                                 ids, replaying frames after Last-Event-ID (pre-subscribe buffer)
//
// `install()` sets `globalThis.__denext` and routes `fetch` to the handler the way a browser
// would: relative URLs resolve against the window origin, and a POST carries `Origin` (a
// same-origin GET does not).

export const FAKE_ORIGIN = "http://127.0.0.1:65304";
export const FAKE_TOKEN = "tok-launch-1";
const MAX_BODY = 4 * 1024 * 1024;

/** A capability method in the fake: gets the args, returns data or throws `{ code, message }`. */
export type FakeMethod = (args: unknown) => unknown | Promise<unknown>;

/** One recorded call. */
export interface FakeCall {
  cap: string;
  method: string;
  args: unknown;
}

/** One recorded request (for gate assertions). */
export interface FakeRequest {
  method: string;
  path: string;
  headers: Headers;
}

/** The fake runtime. */
export interface FakeRuntime {
  readonly calls: FakeCall[];
  readonly requests: FakeRequest[];
  handler(req: Request): Promise<Response>;
  /** Emit an event (kept in the replay log; pushed to open streams). */
  emit(cap: string, event: string, data: unknown): void;
  /** How many event streams are open. */
  openStreams(): number;
  /** Close every open event stream from the runtime side (a dropped connection). */
  dropStreams(): void;
  /** Install `__denext` + `fetch`; returns the restore function. */
  install(): () => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fail = (status: number, code: string, message: string) =>
  json(status, { ok: false, error: { code, message } });

/**
 * Create a fake runtime whose allowlist is exactly `caps`.
 *
 * @param caps Capability → method → implementation.
 * @param opts `token` / `origin` overrides.
 */
export function createFakeDesktopRuntime(
  caps: Record<string, Record<string, FakeMethod>>,
  opts: { token?: string; origin?: string } = {},
): FakeRuntime {
  const token = opts.token ?? FAKE_TOKEN;
  const origin = opts.origin ?? FAKE_ORIGIN;
  const calls: FakeCall[] = [];
  const requests: FakeRequest[] = [];
  const log: Array<{ id: number; frame: string }> = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  let nextId = 1;

  const frameOf = (id: number, payload: unknown) =>
    `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;

  /** The §2 gate for an RPC (the token was checked by the handler): POST, Origin, JSON. */
  function rpcGate(req: Request): Response | undefined {
    if (req.method !== "POST") return fail(405, "forbidden", "POST only");
    if (req.headers.get("origin") !== origin) return fail(403, "forbidden", "origin");
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    return type === "application/json" ? undefined : fail(415, "forbidden", "content type");
  }

  /** The allowlisted method for a parsed body, if any. */
  function methodOf(body: { cap?: unknown; method?: unknown }) {
    const cap = typeof body.cap === "string" ? body.cap : "";
    const method = typeof body.method === "string" ? body.method : "";
    const methods: Record<string, FakeMethod> = Object.hasOwn(caps, cap) ? caps[cap] : {};
    return { cap, method, impl: Object.hasOwn(methods, method) ? methods[method] : undefined };
  }

  /** Run an allowlisted method, mapping a thrown `{ code, message }` to the error envelope. */
  async function invoke(impl: FakeMethod, args: unknown): Promise<Response> {
    try {
      return json(200, { ok: true, data: (await impl(args)) ?? null });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return fail(400, e.code ?? "internal", e.message ?? "failed");
    }
  }

  async function rpc(req: Request): Promise<Response> {
    const refused = rpcGate(req);
    if (refused) return refused;
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY) {
      return fail(413, "too_large", "body too large");
    }
    let body: { cap?: unknown; method?: unknown; args?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "validation", "not JSON");
    }
    const { cap, method, impl } = methodOf(body);
    if (!impl) return fail(404, "unavailable", `${cap}.${method} is not enabled`);
    calls.push({ cap, method, args: body.args });
    return await invoke(impl, body.args);
  }

  function events(req: Request): Response {
    if (req.method !== "GET") return fail(405, "forbidden", "GET only");
    const sentOrigin = req.headers.get("origin");
    if (sentOrigin !== null && sentOrigin !== origin) return fail(403, "forbidden", "origin");
    const last = Number(req.headers.get("last-event-id") ?? "0") || 0;
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        streams.add(c);
        c.enqueue(enc.encode(": hello\n\n"));
        for (const e of log) if (e.id > last) c.enqueue(enc.encode(e.frame));
      },
      cancel() {
        streams.delete(ctrl);
      },
    });
    req.signal?.addEventListener("abort", () => {
      if (streams.delete(ctrl)) {
        try {
          ctrl.close();
        } catch {
          // already closed
        }
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    requests.push({ method: req.method, path: url.pathname, headers: new Headers(req.headers) });
    if (req.headers.get("x-denext-desktop-token") !== token) {
      return fail(403, "forbidden", "token");
    }
    if (url.pathname === "/_denext/desktop/rpc") return await rpc(req);
    if (url.pathname === "/_denext/desktop/events") return events(req);
    return fail(404, "unavailable", "no such endpoint");
  }

  return {
    calls,
    requests,
    handler,
    emit(cap, event, data) {
      const id = nextId++;
      const frame = frameOf(id, { cap, event, data });
      log.push({ id, frame });
      for (const c of streams) c.enqueue(enc.encode(frame));
    },
    openStreams: () => streams.size,
    dropStreams() {
      for (const c of streams) {
        try {
          c.close();
        } catch {
          // closed
        }
      }
      streams.clear();
    },
    install() {
      const g = globalThis as { __denext?: unknown };
      const prevDenext = g.__denext;
      const prevFetch = globalThis.fetch;
      g.__denext = { desktop: true, token };
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), origin);
        const headers = new Headers(init?.headers);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") headers.set("origin", origin);
        const req = new Request(url, { ...init, headers });
        if (init?.signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
        return handler(req);
      };
      return () => {
        for (const c of streams) {
          try {
            c.close();
          } catch {
            // closed
          }
        }
        streams.clear();
        g.__denext = prevDenext;
        globalThis.fetch = prevFetch;
      };
    },
  };
}

/** Wait until `check()` is true (polling microtasks / short timers), or throw. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
