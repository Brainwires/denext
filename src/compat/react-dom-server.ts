/**
 * React-compatible `react-dom/server` entrypoint for denext.
 *
 * Aliased at bundle time (`react-dom/server`, `react-dom/server.browser`,
 * `react-dom/server.edge`) so npm libraries that import from `react-dom/server`
 * resolve to denext's single React runtime instead of pulling in a second, real
 * `react-dom` (which would give the app two dispatchers → "no dispatcher
 * installed" / broken hooks at SSR). The alias alone fixes the dual-React hazard
 * even for the sync exports that denext deliberately does not implement.
 *
 * denext's SSR renderer is **async by design** (buffered / progressive-streaming).
 * `renderToReadableStream` is the full-featured path. `renderToString` /
 * `renderToStaticMarkup` are supported for the **synchronous-renderable** subset via
 * {@link renderToStringSync} (a Suspense boundary whose children suspend renders its
 * fallback, exactly as React's `renderToString` does); a genuinely async Server
 * Component outside a boundary throws a guided error. The **Node-stream** APIs
 * (`renderToPipeableStream` / `renderToStaticNodeStream`) are supported via a thin
 * `node:stream` adapter over the Web renderer (for npm libraries that hard-code them);
 * `onShellReady` fires at the shell flush (its first chunk), but the document is not
 * `Writable`-backpressured — denext's own apps should use `renderToReadableStream`.
 *
 * @module
 */

import { REACT_COMPAT_VERSION } from "./react-version.ts";
import { renderToReadableStream as denextRenderToReadableStream } from "../jsx/render-to-stream.ts";
import { renderToStringSync } from "../jsx/render-to-string.ts";
import type { VNodeChildren } from "../jsx/types.ts";
import type { Readable, Writable } from "node:stream";

// `node:stream` is loaded LAZILY through a computed specifier. react-dom/server is aliased
// into denext's single React runtime and can end up in a *browser* bundle; a static
// `import ... from "node:stream"` would then break the client build (node:stream is not
// browser-stubbable by design). A computed specifier keeps it out of the browser graph —
// the Node-stream APIs are server-only and never execute on the client. On the server it
// resolves to Deno's Node compat. Warmed at module init so the sync
// `renderToStaticNodeStream` has it ready by the time a request runs.
type NodeStreamModule = typeof import("node:stream");
let nodeStream: NodeStreamModule | undefined;
let nodeStreamLoad: Promise<NodeStreamModule> | undefined;
function loadNodeStream(): Promise<NodeStreamModule> {
  const spec = "node:stream"; // variable specifier → esbuild leaves it a runtime import
  return (nodeStreamLoad ??= import(spec).then((m) => (nodeStream = m as NodeStreamModule)));
}
void loadNodeStream();

/** The React version denext reports for compatibility (aligned with `react`'s
 * reported 19.2 surface). */
export const version: string = REACT_COMPAT_VERSION;

/** A React-`renderToReadableStream`-shaped stream: a Web stream + `allReady`. */
export interface ReactDOMServerReadableStream extends ReadableStream<Uint8Array> {
  /** Resolves once every Suspense boundary has flushed (for bots/static output). */
  allReady: Promise<void>;
}

/**
 * Options accepted by {@link renderToReadableStream} (React-compatible subset).
 * `signal`/`onError` are honored; the bootstrap/identifier options exist on
 * React's signature for source compatibility but are no-ops (denext manages its
 * own hydration bootstrapping).
 */
export interface RenderToReadableStreamOptions {
  /** Aborts rendering; pending boundaries stop flushing. */
  signal?: AbortSignal;
  /** Called on a rendering error (React parity; best-effort). */
  onError?: (error: unknown) => void;
  /** No-op (React parity): denext injects its own hydration bootstrap. */
  bootstrapScripts?: unknown;
  /** No-op (React parity): denext injects its own hydration bootstrap. */
  bootstrapModules?: unknown;
  /** No-op (React parity): denext manages element ids itself. */
  identifierPrefix?: string;
  /** No-op (React parity): set a CSP nonce at the edge instead. */
  nonce?: string;
}

/**
 * React-compatible `renderToReadableStream`. Returns a Promise resolving to a Web
 * `ReadableStream<Uint8Array>` with an `allReady` promise, matching
 * `react-dom/server`'s Web API.
 *
 * The source stream is drained eagerly into the returned stream's internal queue,
 * so `allReady` resolves (or rejects) when all boundaries have rendered
 * **independently of when the consumer reads** — this preserves React's contract
 * where you may `await stream.allReady` before piping (e.g. for crawlers/static
 * generation). It therefore buffers the document in memory rather than applying
 * consumer backpressure; for a very large document use denext's own streaming
 * `renderToReadableStream` (from the framework) instead.
 *
 * Robustness: `allReady` always has an internal handler, so a rejection can never
 * become an unhandled promise rejection (which would crash the Deno process) when
 * a consumer streams without awaiting it. Consumer cancel is propagated to the
 * source; an aborted render rejects `allReady` (React's contract) rather than
 * reporting truncated HTML as complete.
 *
 * @param node The element tree to render.
 * @param options React-compatible options (`signal`/`onError` honored).
 * @returns A promise for the React-shaped server stream.
 */
export async function renderToReadableStream(
  node: VNodeChildren,
  options: RenderToReadableStreamOptions = {},
): Promise<ReactDOMServerReadableStream> {
  const source = denextRenderToReadableStream(node, {
    signal: options.signal,
    idPrefix: options.identifierPrefix,
  });
  const reader = source.getReader();
  // React's contract: the promise resolves once the SHELL has rendered and REJECTS when the
  // shell itself throws (so `await renderToReadableStream()` in a try/catch can send a 500
  // instead of a stream that errors after the headers went out). The first chunk is the
  // shell; it is handed to the drainer below.
  let shell: ReadableStreamReadResult<Uint8Array>;
  try {
    shell = await reader.read();
  } catch (error) {
    options.onError?.(error);
    throw error;
  }
  const ready = deferred();
  // Never let a rejection go unhandled: a consumer that streams without awaiting
  // `allReady` (the idiomatic path) would otherwise crash the process on a render
  // error. Attaching a no-op handler marks the promise handled while a consumer
  // that DOES `await allReady` still observes the rejection through its own handler.
  ready.promise.catch(() => {});

  // Set when the consumer cancels `out` (e.g. client disconnect): the drainer then
  // stops quietly rather than treating the closed controller as a render error.
  const state = { cancelled: false };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const out = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      state.cancelled = true;
      ready.resolve(); // consumer gave up; not an error
      reader.cancel(reason).catch(() => {}); // stop upstream rendering
    },
  }) as ReactDOMServerReadableStream;

  // Drain the source eagerly (buffered in `out`'s queue) so allReady is decoupled
  // from consumer reads (the `await allReady` crawler/static path).
  if (!shell.done && shell.value) controller.enqueue(shell.value);
  drainSource(reader, controller, options, state, ready);
  out.allReady = ready.promise;
  return out;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Pump every chunk of the denext stream into `controller`, settling `ready` when the
 * source ends. The source closes normally on abort too — surface that as a rejection
 * (React's contract) instead of reporting truncated HTML as complete.
 */
async function drainSource(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  options: RenderToReadableStreamOptions,
  state: { cancelled: boolean },
  ready: Deferred,
): Promise<void> {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (state.cancelled) return; // consumer cancelled mid-read; nothing more to do
      if (done) break;
      if (value) controller.enqueue(value);
    }
    if (options.signal?.aborted) {
      const reason = options.signal.reason ?? new DOMException("Aborted", "AbortError");
      options.onError?.(reason);
      controller.error(reason);
      ready.reject(reason);
      return;
    }
    controller.close();
    ready.resolve();
  } catch (error) {
    if (state.cancelled) return; // enqueue-after-cancel etc.; not a real render error
    options.onError?.(error);
    try {
      controller.error(error);
    } catch {
      // controller already closed/errored
    }
    ready.reject(error);
  }
}

/** Throw a guided error for a synchronous React SSR API denext doesn't implement. */
function notSupported(name: string): never {
  throw new Error(
    `denext: react-dom/server '${name}' is not supported. denext's server ` +
      `renderer is async by design — use \`renderToReadableStream\` (from ` +
      `react-dom/server) for streaming, or \`renderToString\` from "denext" ` +
      `(await it) for a buffered string.`,
  );
}

/**
 * Options for the sync {@link renderToString}/{@link renderToStaticMarkup} (React
 * parity). `identifierPrefix` seeds the root `useId` scope — match the client's
 * `hydrateRoot({ identifierPrefix })` so ids align on hydration.
 */
export interface ServerRenderOptions {
  /** Prefix seeded into the root `useId` scope (avoids collisions across roots). */
  identifierPrefix?: string;
}

/**
 * Render `element` to an HTML string synchronously (the sync-renderable subset —
 * Suspense boundaries render their fallback, as React's `renderToString` does). Throws
 * a guided error on a genuinely async Server Component outside a boundary.
 *
 * @param element The element tree to render.
 * @param options React-compatible options (`identifierPrefix` seeds the `useId` scope).
 */
export function renderToString(element: VNodeChildren, options?: ServerRenderOptions): string {
  return renderToStringSync(element, { idPrefix: options?.identifierPrefix });
}

/**
 * Like {@link renderToString} but for fully static markup. denext's base render emits no
 * hydration markers, so the output is identical — this is a straight alias.
 *
 * @param element The element tree to render.
 * @param options React-compatible options (`identifierPrefix` seeds the `useId` scope).
 */
export function renderToStaticMarkup(
  element: VNodeChildren,
  options?: ServerRenderOptions,
): string {
  return renderToStringSync(element, { idPrefix: options?.identifierPrefix });
}

/** Options for {@link renderToPipeableStream} (React-compatible subset). */
export interface RenderToPipeableStreamOptions {
  /** Fired when the shell is rendered and ready to flush (denext: its first chunk). */
  onShellReady?: () => void;
  /** Fired if rendering the shell errors before it can be piped. */
  onShellError?: (error: unknown) => void;
  /** Fired once every Suspense boundary has flushed. */
  onAllReady?: () => void;
  /** Fired on any render error (React parity). */
  onError?: (error: unknown) => void;
  /** No-op (React parity): denext injects its own hydration bootstrap. */
  bootstrapScripts?: unknown;
  /** No-op (React parity): denext injects its own hydration bootstrap. */
  bootstrapModules?: unknown;
  /** No-op (React parity): denext manages element ids itself. */
  identifierPrefix?: string;
  /** No-op (React parity): set a CSP nonce at the edge instead. */
  nonce?: string;
  /** Aborts rendering; pending boundaries stop flushing. */
  signal?: AbortSignal;
}

/** The controller {@link renderToPipeableStream} returns (React-shaped). */
export interface PipeableStream {
  /** Pipe the rendered HTML into a Node `Writable`; returns the destination. */
  pipe<T extends Writable>(destination: T): T;
  /** Abort the in-flight render. */
  abort(reason?: unknown): void;
}

/** Coerce a thrown value to an `Error` for Node stream `destroy`. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * React-compatible `renderToPipeableStream` — a Node-`Writable` adapter over denext's
 * Web-stream renderer (for npm libraries that hard-code the Node-stream API; denext's own
 * apps use `renderToReadableStream`). Bridges the buffered compat {@link renderToReadableStream}
 * to a Node stream via `node:stream`'s `Readable.fromWeb`.
 *
 * `onShellReady` fires at the shell flush (the shell is enqueued as the first chunk, so we
 * peek it before signalling — a shell that throws surfaces as `onShellError`). Fidelity caveat
 * (documented in KNOWN-LIMITATIONS.md): the document is buffered in memory, so a slow
 * `Writable` gets **no upstream backpressure** — a property of denext's push-based streaming
 * core, not of this adapter.
 *
 * @param node The element tree to render.
 * @param options React-compatible options (`onShellReady`/`onAllReady`/`onError`/`signal`).
 */
export function renderToPipeableStream(
  node: VNodeChildren,
  options: RenderToPipeableStreamOptions = {},
): PipeableStream {
  const controller = new AbortController();
  linkAbort(controller, options.signal);
  const streamPromise = renderToReadableStream(node, {
    signal: controller.signal,
    onError: options.onError,
  });
  let piped = false;
  return {
    pipe<T extends Writable>(destination: T): T {
      if (piped) throw new Error("renderToPipeableStream: pipe() may only be called once.");
      piped = true;
      pipeInto(streamPromise, destination, options).catch((error) => {
        // Defensive: an unexpected failure setting up the pipe (e.g. node:stream load).
        options.onShellError?.(error);
        options.onError?.(error);
        destination.destroy(toError(error));
      });
      return destination;
    },
    abort(reason?: unknown): void {
      controller.abort(reason);
    },
  };
}

/** Forward an external abort signal (already aborted, or when it fires) to `controller`. */
function linkAbort(controller: AbortController, external: AbortSignal | undefined): void {
  if (!external) return;
  if (external.aborted) controller.abort(external.reason);
  else external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
}

/**
 * Pipe the rendered stream into a Node `Writable`. React fires onShellReady when the shell
 * is rendered and ready to flush — not when the stream object merely exists. denext's
 * renderer enqueues the entire shell as the FIRST chunk, so we peek that chunk before
 * signalling: a shell that throws lands in this read (→ onShellError), and a shell that
 * renders fires onShellReady with the real shell in hand, matching React's contract.
 */
async function pipeInto(
  streamPromise: Promise<ReactDOMServerReadableStream>,
  destination: Writable,
  options: RenderToPipeableStreamOptions,
): Promise<void> {
  const [stream, { Readable }] = await Promise.all([streamPromise, loadNodeStream()]);
  const reader = stream.getReader();
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await reader.read();
  } catch (error) {
    // The shell itself errored before any bytes: onShellError, then onError (parity).
    options.onShellError?.(error);
    options.onError?.(error);
    destination.destroy(toError(error));
    return;
  }
  options.onShellReady?.();
  // `allReady` resolves once every boundary flushed; it rejects on abort (a no-op
  // handler is already attached), so guard against an unhandled rejection here.
  stream.allReady.then(() => options.onAllReady?.(), () => {});
  const readable = Readable.fromWeb(
    resumeAfter(first, reader) as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  // A later (post-shell) error already reached `onError` via the compat renderer; just
  // tear the pipe down cleanly so the readable's error event can't go unhandled.
  readable.on("error", (err) => destination.destroy(toError(err)));
  readable.pipe(destination);
}

/** Re-emit the peeked shell chunk, then pull the remaining boundary chunks on demand. */
function resumeAfter(
  first: ReadableStreamReadResult<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      if (first.value) c.enqueue(first.value);
      if (first.done) c.close();
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else if (value) c.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * React-compatible `renderToStaticNodeStream` — fully static markup as a Node `Readable`,
 * with NO hydration/streaming scaffolding (the static counterpart of `renderToStaticMarkup`,
 * for emails / static generation). Renders the synchronously-renderable subset via
 * {@link renderToStringSync}: a `<Suspense>` renders its fallback, and a genuinely async
 * Server Component outside a boundary destroys the stream with a guided error.
 *
 * @param node The element tree to render.
 * @param options React-compatible options (`onError` honored; `identifierPrefix` a no-op).
 */
export function renderToStaticNodeStream(
  node: VNodeChildren,
  options: { onError?: (error: unknown) => void } = {},
): Readable {
  // Server-only API: `node:stream` is warmed at module init, so it is loaded well before any
  // request calls this. The guard is a belt-and-braces cold-start check, effectively unreachable.
  const mod = nodeStream;
  if (!mod) {
    void loadNodeStream();
    throw new Error(
      "denext: renderToStaticNodeStream was called before node:stream finished loading — " +
        "retry on the next tick (this API is server-only).",
    );
  }
  try {
    const html = renderToStringSync(node);
    return mod.Readable.from([new TextEncoder().encode(html)]);
  } catch (error) {
    options.onError?.(error);
    const failed = new mod.PassThrough();
    // Defer the error so a synchronous consumer can attach an `error` listener first.
    queueMicrotask(() => failed.destroy(toError(error)));
    return failed;
  }
}

/**
 * React's Partial Prerendering **resume** API (Web stream): continue a prerender from its
 * postponed state. denext implements PPR through its own renderer (not React's
 * `postponedState` format), so this compat entry throws a guided error rather than
 * silently mis-rendering — the symbol exists for source/type compatibility.
 *
 * @param _children The element tree.
 * @param _postponedState React's postponed state from a prior prerender.
 * @param _options React-compatible options.
 */
export function resume(
  _children: VNodeChildren,
  _postponedState: unknown,
  _options?: RenderToReadableStreamOptions,
): Promise<ReactDOMServerReadableStream> {
  return notSupported("resume");
}

/** Not supported (Node streams) — PPR resume targets the Web stream in denext. */
export function resumeToPipeableStream(
  _children: VNodeChildren,
  _postponedState: unknown,
  _options?: unknown,
): never {
  return notSupported("resumeToPipeableStream");
}

/** The default `ReactDOMServer` namespace object. */
export default {
  version,
  renderToReadableStream,
  renderToString,
  renderToStaticMarkup,
  renderToPipeableStream,
  renderToStaticNodeStream,
  resume,
  resumeToPipeableStream,
};

/** The result of {@link prerender}: the complete HTML as a stream, plus React's postponed state (always null). */
export interface PrerenderResult {
  /** The fully rendered document (every Suspense boundary resolved). */
  prelude: ReadableStream<Uint8Array>;
  /** React's PPR postponed state — denext resolves everything, so always `null`. */
  postponed: null;
}

/**
 * `react-dom/static`'s `prerender` — render the whole tree to completion (every boundary
 * resolved) and hand back the HTML as a stream. denext waits for `allReady` before resolving,
 * so a static-generation pipeline can pipe `prelude` straight to a file.
 *
 * @param node The element tree.
 * @param options React-compatible options (`signal`/`onError` honored).
 */
export async function prerender(
  node: VNodeChildren,
  options: RenderToReadableStreamOptions = {},
): Promise<PrerenderResult> {
  const stream = await renderToReadableStream(node, options);
  await stream.allReady;
  return { prelude: stream, postponed: null };
}

/**
 * `react-dom/static`'s `prerenderToNodeStream` — {@link prerender} with a Node `Readable`
 * prelude (server-only; loads `node:stream`).
 */
export async function prerenderToNodeStream(
  node: VNodeChildren,
  options: RenderToReadableStreamOptions = {},
): Promise<{ prelude: Readable; postponed: null }> {
  const [{ prelude }, { Readable }] = await Promise.all([
    prerender(node, options),
    loadNodeStream(),
  ]);
  return { prelude: Readable.fromWeb(prelude as never) as Readable, postponed: null };
}
