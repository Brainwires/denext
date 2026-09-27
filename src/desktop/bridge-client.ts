/**
 * The page side of the Deno Desktop capability bridge: one gated RPC endpoint and one event
 * stream, both served by the desktop runtime under `/_denext/desktop/*` (see the bridge
 * interface, §1–§2).
 *
 * - `POST /_denext/desktop/rpc` with `{ cap, method, args }` answers `{ ok: true, data }` or
 *   `{ ok: false, error: { code, message, data? } }`.
 * - `GET /_denext/desktop/events` is a server-sent-event stream read through `fetch` (so the
 *   token rides in a header, which `EventSource` cannot send). Each frame's `data:` is
 *   `{ cap, event, data }`; a reconnect sends `Last-Event-ID` so the runtime can replay.
 *
 * Every request carries the per-launch token the runtime injects into the served shell
 * (`globalThis.__denext.token`, read through a cast: JSR refuses a published module that
 * declares globals) and `content-type: application/json`. Off desktop there is no token, and
 * nothing here ever touches the network: calls reject `unavailable` and subscriptions are
 * no-ops, so a web or mobile page never probes for bridge endpoints.
 *
 * Client-only: web APIs, no Deno APIs. Internal to denext (`denext/desktop/client` and the
 * `denext/mobile` desktop branches build on it). Nothing runs at import.
 *
 * @module
 */

/** The runtime's RPC endpoint. */
export const RPC_PATH = "/_denext/desktop/rpc";
/** The runtime's event stream. */
export const EVENTS_PATH = "/_denext/desktop/events";
/** The header that carries the per-launch token. */
export const TOKEN_HEADER = "x-denext-desktop-token";
/**
 * The largest RPC body the page sends (bytes of the JSON). The runtime refuses larger bodies
 * too; checking here fails fast with `too_large` instead of streaming megabytes into a 413.
 */
export const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
/** How long an RPC may take by default before it rejects `timeout`. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** The longest error message kept from a runtime answer (the rest is cut). */
const MAX_MESSAGE_CHARS = 500;
/** How many undelivered frames are kept per `cap:event` until a listener subscribes. */
const MAX_BUFFERED_PER_KEY = 32;
/** The largest partial SSE frame the reader accumulates before it drops the connection. */
const MAX_FRAME_CHARS = 1024 * 1024;
/** The first reconnect delay, doubled per failure up to {@linkcode MAX_RETRY_MS}. */
const BASE_RETRY_MS = 1_000;
/** The longest reconnect delay. */
const MAX_RETRY_MS = 30_000;

/**
 * Why a desktop call failed:
 *
 * - `unavailable`: not inside a Deno Desktop window, or the capability / method is not enabled
 *   in `desktop.capabilities` (the runtime's allowlist), or no runtime answered.
 * - `forbidden`: the runtime's gate refused the request (token, origin or content type).
 * - `validation`: the arguments did not match the method's input schema.
 * - `timeout`: no answer in time.
 * - `too_large`: the request body is over {@linkcode MAX_RPC_BODY_BYTES}.
 * - `bridge_error`: the runtime answered without the bridge envelope.
 *
 * A capability may fail with its own codes too (`not_found`, `cancelled`, …).
 */
export type DesktopErrorCode =
  | "unavailable"
  | "forbidden"
  | "validation"
  | "timeout"
  | "too_large"
  | "bridge_error"
  | (string & Record<never, never>);

/** A failed desktop bridge call. Narrow with {@linkcode isDesktopBridgeError}. */
export interface DesktopBridgeError extends Error {
  /** Always `"DesktopBridgeError"`. */
  readonly name: "DesktopBridgeError";
  /** The machine-readable code. */
  readonly code: DesktopErrorCode;
  /** The capability that was called. */
  readonly cap: string;
  /** The method that was called. */
  readonly method: string;
  /** Structured detail the runtime attached, if any. */
  readonly data?: unknown;
}

/**
 * Whether `value` is a {@linkcode DesktopBridgeError}.
 *
 * @param value The caught value.
 * @returns `true` for a failed desktop bridge call.
 */
export function isDesktopBridgeError(value: unknown): value is DesktopBridgeError {
  return value instanceof Error && value.name === "DesktopBridgeError";
}

/**
 * A {@linkcode DesktopBridgeError}. The message names the call and the code only, plus the
 * runtime's (trimmed) message: never the arguments or the token.
 */
export function desktopError(
  cap: string,
  method: string,
  code: DesktopErrorCode,
  message: string,
  data?: unknown,
): DesktopBridgeError {
  const err = new Error(`desktop ${cap}.${method}: ${code}: ${message}`) as Error & {
    code: string;
    cap: string;
    method: string;
    data?: unknown;
  };
  err.name = "DesktopBridgeError";
  err.code = code;
  err.cap = cap;
  err.method = method;
  if (data !== undefined) err.data = data;
  return err as DesktopBridgeError;
}

/** The per-launch token the runtime injected into this document, when there is one. */
function desktopToken(): string | undefined {
  const g = (globalThis as { __denext?: { desktop?: unknown; token?: unknown } }).__denext;
  if (typeof g !== "object" || g === null || g.desktop !== true) return undefined;
  return typeof g.token === "string" && g.token !== "" ? g.token : undefined;
}

/** Whether this document can reach the desktop bridge (a desktop window with a token). */
export function hasDesktopBridge(): boolean {
  return desktopToken() !== undefined;
}

/** Options for {@linkcode desktopRpc}. */
export interface DesktopRpcOptions {
  /**
   * Reject `timeout` after this many ms (30 s by default);
   * `false` waits as long as the call takes (a native dialog the user is looking at).
   */
  readonly timeoutMs?: number | false;
}

/** A runtime message as the page keeps it: a string, trimmed to a bounded length. */
function cleanMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value === "") return fallback;
  return value.length > MAX_MESSAGE_CHARS ? `${value.slice(0, MAX_MESSAGE_CHARS)}…` : value;
}

/** The request body, or a `too_large` rejection. */
function encodeBody(cap: string, method: string, args: unknown): string {
  const body = JSON.stringify({ cap, method, args: args === undefined ? null : args });
  // UTF-8 length: cheap upper bound first, exact count only near the limit.
  if (
    body.length * 3 > MAX_RPC_BODY_BYTES &&
    new TextEncoder().encode(body).byteLength > MAX_RPC_BODY_BYTES
  ) {
    throw desktopError(
      cap,
      method,
      "too_large",
      `the request is over ${MAX_RPC_BODY_BYTES} bytes`,
    );
  }
  return body;
}

/** An envelope answer as the call's result, or the error it carries. */
function fromEnvelope<O>(cap: string, method: string, status: number, body: unknown): O {
  const env = body as { ok?: unknown; data?: unknown; error?: unknown } | null;
  if (env?.ok === true) return env.data as O;
  const error = env?.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
  if (env?.ok === false && typeof error?.code === "string") {
    throw desktopError(cap, method, error.code, cleanMessage(error.message, "failed"), error.data);
  }
  throw desktopError(
    cap,
    method,
    "bridge_error",
    `the runtime answered ${status} without an envelope`,
  );
}

/**
 * Call `cap.method(args)` in the desktop runtime.
 *
 * @param cap The capability (`"secureStore"`, or an extension's name).
 * @param method The method.
 * @param args The arguments (JSON-serialisable).
 * @param options `timeoutMs`.
 * @returns The method's result. Rejects with a {@linkcode DesktopBridgeError}; off desktop
 * with `unavailable`, before any request is made.
 */
export async function desktopRpc<O = unknown>(
  cap: string,
  method: string,
  args?: unknown,
  options: DesktopRpcOptions = {},
): Promise<O> {
  const token = desktopToken();
  if (token === undefined) {
    throw desktopError(cap, method, "unavailable", "not running in a Deno Desktop window");
  }
  const body = encodeBody(cap, method, args);
  const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = timeout === false ? undefined : setTimeout(() => abort.abort(), timeout);
  const timedOut = () => desktopError(cap, method, "timeout", `no answer in ${timeout} ms`);
  try {
    let res: Response;
    try {
      res = await fetch(RPC_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
        body,
        signal: abort.signal,
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      if (abort.signal.aborted) throw timedOut();
      throw desktopError(cap, method, "unavailable", "the desktop runtime did not answer");
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      if (abort.signal.aborted) throw timedOut();
      throw desktopError(
        cap,
        method,
        "bridge_error",
        `the runtime answered ${res.status}, not JSON`,
      );
    }
    return fromEnvelope<O>(cap, method, res.status, parsed);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- events -----------------------------------------------------------------

/** A handler for one `cap:event`. */
type EventHandler = (data: unknown) => void;

/** The shared event-stream state (one connection per document). */
interface StreamState {
  readonly handlers: Map<string, Set<EventHandler>>;
  readonly buffered: Map<string, unknown[]>;
  lastEventId?: string;
  abort?: AbortController;
  retryMs: number;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
}

let stream: StreamState | undefined;

/** The `cap:event` key a frame is routed by. */
function keyOf(cap: string, event: string): string {
  return `${cap}\u0000${event}`;
}

/** Hand `data` to every handler of `key`, or keep it (bounded) until one subscribes. */
function dispatch(state: StreamState, key: string, data: unknown): void {
  const set = state.handlers.get(key);
  if (set && set.size > 0) {
    for (const handler of [...set]) {
      try {
        handler(data);
      } catch (err) {
        // One throwing handler must not starve the others or kill the stream.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return;
  }
  const queue = state.buffered.get(key) ?? [];
  queue.push(data);
  if (queue.length > MAX_BUFFERED_PER_KEY) queue.shift();
  state.buffered.set(key, queue);
}

/** One parsed SSE frame's fields. */
interface SseFrame {
  id?: string;
  data: string[];
}

/** Split an SSE line into its field and value (`field: value`; one leading space dropped). */
function sseField(line: string): [string, string] {
  const colon = line.indexOf(":");
  if (colon < 0) return [line, ""];
  const value = line.slice(colon + 1);
  return [line.slice(0, colon), value.startsWith(" ") ? value.slice(1) : value];
}

/** Apply one SSE line to `frame` (a leading `:` is a comment; unknown fields are ignored). */
function applyLine(state: StreamState, frame: SseFrame, line: string): void {
  if (line.startsWith(":")) return;
  const [field, value] = sseField(line);
  if (field === "data") frame.data.push(value);
  else if (field === "id" && !value.includes("\u0000")) frame.id = value;
  else if (field === "retry" && /^\d+$/.test(value)) state.retryMs = Number(value);
}

/** Deliver a complete frame: remember its id, route its `{ cap, event, data }`. */
function deliverFrame(state: StreamState, frame: SseFrame): void {
  if (frame.id !== undefined) state.lastEventId = frame.id;
  if (frame.data.length === 0) return;
  let parsed: { cap?: unknown; event?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(frame.data.join("\n"));
  } catch {
    return;
  }
  if (typeof parsed?.cap !== "string" || typeof parsed.event !== "string") return;
  dispatch(state, keyOf(parsed.cap, parsed.event), parsed.data);
}

/** Read an SSE body to its end, delivering each frame. */
async function readEvents(state: StreamState, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let frame: SseFrame = { data: [] };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.search(/\r\n|\r|\n/)) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(pending[nl] === "\r" && pending[nl + 1] === "\n" ? nl + 2 : nl + 1);
        if (line === "") {
          deliverFrame(state, frame);
          frame = { data: [] };
        } else applyLine(state, frame, line);
      }
      if (pending.length > MAX_FRAME_CHARS) return; // a runaway frame: drop the connection
      state.failures = 0;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Whether any handler is still subscribed. */
function wanted(state: StreamState): boolean {
  for (const set of state.handlers.values()) if (set.size > 0) return true;
  return false;
}

/** The events request's headers: the token, and the last id seen so the runtime can replay. */
function eventHeaders(state: StreamState, token: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "text/event-stream", [TOKEN_HEADER]: token };
  if (state.lastEventId !== undefined) headers["last-event-id"] = state.lastEventId;
  return headers;
}

/**
 * One connection: read the stream to its end. Resolves `true` when retrying cannot help (the
 * gate refused it, or there is no events endpoint).
 */
async function readOnce(state: StreamState, token: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(EVENTS_PATH, {
      method: "GET",
      headers: eventHeaders(state, token),
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok && res.body) {
      await readEvents(state, res.body);
      return false;
    }
    await res.body?.cancel();
    return res.status === 401 || res.status === 403 || res.status === 404;
  } catch {
    return false; // a network error or an abort: the caller decides whether to retry
  }
}

/** Whether `state` is still the live stream and someone listens. */
function live(state: StreamState): boolean {
  return stream === state && wanted(state);
}

/** Open (or reopen) the stream; reconnects with backoff while anyone listens. */
async function connect(state: StreamState): Promise<void> {
  const token = desktopToken();
  if (token === undefined || !live(state)) return;
  const abort = new AbortController();
  state.abort = abort;
  const fatal = await readOnce(state, token, abort.signal);
  if (abort.signal.aborted || fatal || !live(state)) return;
  const delay = Math.min(MAX_RETRY_MS, state.retryMs * 2 ** state.failures++);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void connect(state);
  }, delay);
}

/** Close the stream and forget its state (no listener is left). */
function disconnect(state: StreamState): void {
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.abort?.abort();
  if (stream === state) stream = undefined;
}

/**
 * Subscribe to `event` of `cap` on the desktop event stream. The first subscription opens the
 * stream; the last unsubscribe closes it. Frames that arrived for this `cap:event` before any
 * handler subscribed are delivered to the first handler (a bounded buffer), so a click that
 * raced the subscribing code is not lost. Off desktop it does nothing.
 *
 * @param cap The capability.
 * @param event The event name.
 * @param handler Called with each frame's `data`.
 * @returns A function that unsubscribes.
 */
export function subscribeDesktopEvent(
  cap: string,
  event: string,
  handler: (data: unknown) => void,
): () => void {
  if (!hasDesktopBridge()) return () => {};
  const state: StreamState = stream ??= {
    handlers: new Map(),
    buffered: new Map(),
    retryMs: BASE_RETRY_MS,
    failures: 0,
  };
  const key = keyOf(cap, event);
  const set = state.handlers.get(key) ?? new Set<EventHandler>();
  const first = !wanted(state);
  set.add(handler);
  state.handlers.set(key, set);
  const queued = state.buffered.get(key);
  if (queued) {
    state.buffered.delete(key);
    queueMicrotask(() => {
      for (const data of queued) dispatch(state, key, data);
    });
  }
  if (first && state.abort === undefined) void connect(state);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    set.delete(handler);
    if (!wanted(state)) disconnect(state);
  };
}

/** Close the event stream and drop all state (tests only). */
export function resetDesktopBridgeForTesting(): void {
  if (stream) disconnect(stream);
  stream = undefined;
}
