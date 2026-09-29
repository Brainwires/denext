/**
 * The Deno Desktop capability bridge, runtime side: one gated RPC endpoint and one gated event
 * stream that let the page call capabilities running in the desktop app's Deno process. This is
 * the SINGLE seam where an untrusted page reaches OS power, so every check fails closed.
 *
 * Wire contract (matches `denext/desktop/client`'s {@link ./bridge-client.ts}):
 * - `POST /_denext/desktop/rpc` with `{ cap, method, args }` answers `{ ok: true, data }` or
 *   `{ ok: false, error: { code, message, data? } }` (the client reads the envelope at any status).
 * - `GET /_denext/desktop/events` is an SSE stream ({@link ./bridge-events.ts}).
 *
 * The gate, in order, for RPC: POST only; the per-launch token (constant-time); a loopback `Host`
 * header ({@link isLoopbackHostHeader}, the DNS-rebinding defence — a browser puts the URL's DNS
 * NAME in `Host`, so a rebinding domain resolving to 127.0.0.1 carries a non-loopback `Host`); an
 * `Origin` exactly equal to `http://<Host>` (so the origin is derived from the validated Host, NOT
 * from the attacker-controlled request URL); and `content-type: application/json`. A CORS preflight
 * is refused with no `Access-Control-Allow-Origin`. For events (a same-origin GET, which browsers
 * send with no `Origin`): the token, the loopback `Host`, and an `Origin` that is absent OR matches.
 *
 * THREAT MODEL: the token defends against BROWSER cross-origin/subframe/rebinding access. It does
 * NOT defend against another process of the SAME USER, which can read the served HTML (and so the
 * token) over loopback — that is the same trust boundary as an Electron preload, and is expected.
 *
 * `unavailable` is answered ONLY when the capability or method is not enabled — that is the page's
 * signal to fall back to its web path — never for a real failure. Error messages carry a code and a
 * safe string only; handler internals (paths, env, stack) never cross to the page in production.
 *
 * This module is RUNTIME-ONLY (imported by the desktop entry via `runDesktop`, never a client
 * bundle). A non-desktop server (`denext start`) never mounts it, so `/_denext/desktop/*` 404s
 * there; in `desktop dev --lan` the page is served without a token, so every RPC is refused.
 *
 * @module
 */

import { timingSafeEqual } from "./auth-session-runtime.ts";
import { isLoopbackHost } from "../utils/loopback.ts";
import { DesktopEventLog } from "./bridge-events.ts";
import {
  type DesktopCapability,
  type DesktopCapCtx,
  DesktopCapError,
  validateStandard,
} from "./extension.ts";

/** The RPC endpoint path (kept in sync with {@link ./bridge-client.ts}). */
const RPC_PATH = "/_denext/desktop/rpc";
/** The event-stream path. */
const EVENTS_PATH = "/_denext/desktop/events";
/** The header carrying the per-launch token. */
const TOKEN_HEADER = "x-denext-desktop-token";
/** The largest RPC body accepted, in bytes (matches the client's cap). */
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
/** The default per-method handler timeout, in ms. */
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/** Options for {@linkcode createDesktopBridge}. */
export interface DesktopBridgeOptions {
  /** The OS app-support directory handed to handlers as {@link DesktopCapCtx.appSupportDir}. */
  readonly appSupportDir?: string;
  /** A getter for the app window (Deno's `BrowserWindow`), for window/menu/tray capabilities. */
  readonly getWindow?: () => unknown;
  /** When true (dev), an unexpected handler error includes its message; production stays generic. */
  readonly dev?: boolean;
  /** The retained-event buffer size for replay (see {@link DesktopEventLog}). */
  readonly eventBuffer?: number;
}

/** The runtime bridge: a request handler for its two paths, and an event emitter. */
export interface DesktopBridge {
  /**
   * Handle a request when it targets the bridge, else return `null` so the caller falls through.
   * Must run BEFORE any reverse proxy so the endpoints are always served locally.
   */
  handle(request: Request, url: URL, token: string): Promise<Response | null>;
  /** Push an event to the page's stream (its `cap` need not be a registered capability's). */
  emit(cap: string, event: string, data: unknown): void;
  /**
   * The window started a new top-level page load: run every capability's
   * {@link DesktopCapability.onPageLoad} so state the previous page owned is released. Never throws.
   */
  pageLoaded(): Promise<void>;
  /** The event log (tests). */
  readonly events: DesktopEventLog;
}

/** Success envelope. */
function ok(data: unknown): Response {
  return Response.json({ ok: true, data: data ?? null });
}

/** Failure envelope (`code` + safe `message`, optional `data`) at `status`. */
function fail(status: number, code: string, message: string, data?: unknown): Response {
  const error: { code: string; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return Response.json({ ok: false, error }, { status });
}

/** A refused CORS preflight: 403 with NO allow-origin, so the browser blocks the real request. */
function refusePreflight(): Response {
  return new Response(null, { status: 403 });
}

/** The sentinel a raced handler rejects with when its deadline elapses. */
const TIMED_OUT = Symbol("desktop-bridge-timeout");

/** A promise that rejects with {@linkcode TIMED_OUT} when `signal` aborts (the handler deadline). */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(TIMED_OUT);
    else signal.addEventListener("abort", () => reject(TIMED_OUT), { once: true });
  });
}

/**
 * The RPC gate (method, token, loopback Host, exact Origin, JSON content type), failing closed in
 * order. Returns an error {@link Response}, or `null` to proceed. `Origin` is compared to
 * `http://<Host>` where the Host is first proven loopback, so the origin comes from the validated
 * Host and not the attacker-controlled request URL (DNS-rebinding defence).
 */
function gateRpc(request: Request, token: string): Response | null {
  if (request.method === "OPTIONS") return refusePreflight();
  if (request.method !== "POST") return fail(405, "forbidden", "method not allowed");
  const presented = request.headers.get(TOKEN_HEADER) ?? "";
  if (!timingSafeEqual(presented, token)) return fail(403, "forbidden", "bad token");
  // `request.url`'s host IS the Host header under Deno.serve, so a rebinding domain carries a
  // non-loopback host here; refuse it, and compare Origin to this (loopback) origin, not raw Host.
  const self = new URL(request.url);
  if (!isLoopbackHost(self.hostname)) return fail(403, "forbidden", "bad host");
  const origin = request.headers.get("origin");
  if (origin === null || origin !== self.origin) return fail(403, "forbidden", "bad origin");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return fail(415, "forbidden", "content-type must be application/json");
  }
  return null;
}

/** The events gate (a same-origin GET: no `Origin`): method, token, loopback host, matching Origin. */
function gateEvents(request: Request, token: string): Response | null {
  if (request.method === "OPTIONS") return refusePreflight();
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const presented = request.headers.get(TOKEN_HEADER) ?? "";
  if (!timingSafeEqual(presented, token)) return new Response(null, { status: 403 });
  const self = new URL(request.url);
  if (!isLoopbackHost(self.hostname)) return new Response(null, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== self.origin) return new Response(null, { status: 403 });
  return null;
}

/** Read the RPC body: enforce the size cap, parse JSON, check the `{ cap, method, args }` shape. */
async function readRpcCall(
  request: Request,
): Promise<{ cap: string; method: string; args: unknown } | Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RPC_BODY_BYTES) {
    return fail(413, "too_large", `the request is over ${MAX_RPC_BODY_BYTES} bytes`);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RPC_BODY_BYTES) {
    return fail(413, "too_large", `the request is over ${MAX_RPC_BODY_BYTES} bytes`);
  }
  let body: { cap?: unknown; method?: unknown; args?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "validation", "body must be JSON");
  }
  const { cap, method, args } = body ?? {};
  if (typeof cap !== "string" || typeof method !== "string") {
    return fail(400, "validation", "body must be { cap, method, args }");
  }
  return { cap, method, args };
}

/** One capability method (for the helper signatures below). */
type CapMethod = DesktopCapability["methods"][string];

/** Validate a call's args against the method's input schema (a mismatch → 400 validation). */
async function checkInput(
  method: CapMethod,
  args: unknown,
): Promise<{ input: unknown } | Response> {
  if (!method.input) return { input: args ?? undefined };
  const checked = await validateStandard(method.input, args ?? undefined);
  if (!checked.ok) return fail(400, "validation", checked.messages.join("; ") || "invalid input");
  return { input: checked.value };
}

/** Strip a handler result to the method's output schema (a mismatch is an internal error). */
async function checkOutput(
  method: CapMethod,
  result: unknown,
): Promise<{ value: unknown } | Response> {
  if (!method.output) return { value: result };
  const stripped = await validateStandard(method.output, result);
  if (!stripped.ok) return fail(500, "internal", "the capability returned an unexpected shape");
  return { value: stripped.value };
}

/**
 * Run the handler under its deadline, mapping a timeout / {@link DesktopCapError} / unexpected throw
 * to an error envelope. `makeCtx` builds the context from the deadline's abort signal. The handler
 * is raced against the deadline so a non-cooperative handler still can't wedge the request.
 */
async function runHandlerWithDeadline(
  method: CapMethod,
  makeCtx: (signal: AbortSignal) => DesktopCapCtx,
  input: unknown,
  dev: boolean,
): Promise<{ result: unknown } | Response> {
  const timeoutMs = method.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = timeoutMs === false ? undefined : setTimeout(() => abort.abort(), timeoutMs);
  try {
    const run = Promise.resolve().then(() => method.handler(input, makeCtx(abort.signal)));
    if (timeoutMs === false) return { result: await run };
    run.catch(() => {}); // if the deadline wins, swallow a later handler rejection
    return { result: await Promise.race([run, rejectOnAbort(abort.signal)]) };
  } catch (err) {
    if (err === TIMED_OUT || abort.signal.aborted) {
      return fail(408, "timeout", "the capability timed out");
    }
    if (err instanceof DesktopCapError) return fail(err.status, err.code, err.message, err.data);
    return fail(
      500,
      "internal",
      dev && err instanceof Error ? err.message : "the capability failed",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Create a desktop bridge over the enabled capabilities. Rejects duplicate capability names (an
 * extension colliding with a built-in) at construction.
 *
 * @param capabilities The enabled capabilities (the compiled allowlist).
 * @param options Bridge options.
 * @returns The {@linkcode DesktopBridge}.
 */
export function createDesktopBridge(
  capabilities: readonly DesktopCapability[],
  options: DesktopBridgeOptions = {},
): DesktopBridge {
  const registry = new Map<string, DesktopCapability>();
  for (const cap of capabilities) {
    if (registry.has(cap.name)) {
      throw new Error(`desktop bridge: duplicate capability name "${cap.name}"`);
    }
    registry.set(cap.name, cap);
  }
  const events = new DesktopEventLog(options.eventBuffer);
  const dev = options.dev ?? false;

  /** Validate input, run the handler under its deadline, strip output — into an envelope. */
  /** The context a handler runs with; `signal` is the deadline's abort signal. */
  const makeCtx = (cap: DesktopCapability, signal: AbortSignal): DesktopCapCtx => ({
    emit: (event, data) => {
      if (cap.events?.includes(event) !== true) {
        throw new Error(`desktop cap "${cap.name}" emitted undeclared event "${event}"`);
      }
      events.append(cap.name, event, data);
    },
    appSupportDir: options.appSupportDir ?? "",
    os: Deno.build.os as "darwin" | "windows" | "linux",
    window: options.getWindow?.(),
    signal,
  });

  const invokeMethod = async (
    cap: DesktopCapability,
    method: CapMethod,
    args: unknown,
  ): Promise<Response> => {
    const inp = await checkInput(method, args);
    if (inp instanceof Response) return inp;
    const ran = await runHandlerWithDeadline(
      method,
      (signal) => makeCtx(cap, signal),
      inp.input,
      dev,
    );
    if (ran instanceof Response) return ran;
    const out = await checkOutput(method, ran.result);
    return out instanceof Response ? out : ok(out.value);
  };

  const handleRpc = async (request: Request, token: string): Promise<Response> => {
    const gate = gateRpc(request, token);
    if (gate) return gate;
    const call = await readRpcCall(request);
    if (call instanceof Response) return call;
    // Allowlist: an unknown capability or method is `unavailable` (the page falls back to web).
    const cap = registry.get(call.cap);
    // OWN methods only: `methods` is a plain object, so `constructor` / `__proto__` / `toString`
    // would otherwise resolve through the prototype and crash as a 500 instead of `unavailable`.
    const method = cap && Object.hasOwn(cap.methods, call.method)
      ? cap.methods[call.method]
      : undefined;
    if (!cap || !method) {
      return fail(404, "unavailable", `capability ${call.cap}.${call.method} is not enabled`);
    }
    return await invokeMethod(cap, method, call.args);
  };

  const handleEvents = (request: Request, token: string): Response => {
    const gate = gateEvents(request, token);
    if (gate) return gate;
    const stream = events.open(request.headers.get("last-event-id"));
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "connection": "keep-alive",
      },
    });
  };

  return {
    handle: async (request, url, token) => {
      if (url.pathname === RPC_PATH) return await handleRpc(request, token);
      if (url.pathname === EVENTS_PATH) return handleEvents(request, token);
      return null;
    },
    emit: (cap, event, data) => {
      events.append(cap, event, data);
    },
    pageLoaded: async () => {
      for (const cap of registry.values()) {
        if (!cap.onPageLoad) continue;
        try {
          await cap.onPageLoad();
        } catch (err) {
          console.error(`desktop: ${cap.name}.onPageLoad failed`, dev ? err : "");
        }
      }
    },
    events,
  };
}
