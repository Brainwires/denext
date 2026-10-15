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
import { detachedFromRequest } from "../runtime/root-context-bridge.ts";
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
  // A shared, memoized load: created outside any request so it never carries one.
  return (nodeStreamLoad ??= detachedFromRequest(() =>
    import(spec).then((m) => (nodeStream = m as NodeStreamModule))
  ));
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
 * The stream is **pull-gated** like React's: each chunk after the shell is produced when the
 * consumer reads (`desiredSize`), so a slow consumer applies backpressure rather than the
 * document queueing in memory. Rendering is not gated — every Suspense boundary keeps
 * rendering on its own — so `allReady` resolves (or rejects) when all boundaries have
 * rendered **independently of when the consumer reads**, preserving React's contract that
 * you may `await stream.allReady` before reading (e.g. for crawlers/static generation).
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
  // instead of a stream that errors after the headers went out). The first chunk is the shell.
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
  // The source's `allReady` tracks RENDERING (not flushing): it rejects with the abort
  // reason when the signal aborts before every boundary rendered — reported once here.
  source.allReady.then(ready.resolve, (reason) => {
    options.onError?.(reason);
    ready.reject(reason);
  });

  // Set when the consumer cancels `out` (e.g. client disconnect): a pull in flight then
  // stops quietly rather than treating the closed controller as a render error.
  const state = { cancelled: false };
  const out = new ReadableStream<Uint8Array>({
    start(c) {
      if (!shell.done && shell.value) c.enqueue(shell.value);
    },
    pull: (c) => pullSource(reader, c, source.allReady, state),
    cancel(reason) {
      state.cancelled = true;
      ready.resolve(); // consumer gave up; not an error
      reader.cancel(reason).catch(() => {}); // stop upstream flushing
    },
  }) as ReactDOMServerReadableStream;
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
 * Forward ONE chunk of the denext stream into `controller` per consumer pull. The source
 * closes normally on abort — by then its `allReady` has already rejected with the abort
 * reason (the signal's listener runs synchronously), so the end of the source settles the
 * output from it: an error for an aborted, incomplete render (React's contract) instead of
 * truncated HTML reported as complete.
 */
async function pullSource(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  rendered: Promise<void>,
  state: { cancelled: boolean },
): Promise<void> {
  try {
    const { done, value } = await reader.read();
    if (state.cancelled) return; // consumer cancelled mid-read; nothing more to do
    if (!done) return controller.enqueue(value);
    await rendered;
    controller.close();
  } catch (error) {
    if (state.cancelled) return; // enqueue-after-cancel etc.; not a real render error
    controller.error(error);
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
 * apps use `renderToReadableStream`).
 *
 * As in React, rendering starts at the call: `onShellReady` fires once the shell rendered
 * (so the documented pattern of calling `pipe()` from inside it works), `onShellError` when
 * the shell throws, `onAllReady` once every boundary rendered — whether or not `pipe()` ran.
 * `pipe()` honours the destination's backpressure: when `write()` returns `false` nothing more
 * is written (or produced) until `'drain'`; a destination that closes or errors early
 * cancels the flush, and `abort()` tears the pipe down even while it waits for `'drain'`.
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
  const shell = startPipeableRender(node, options, controller.signal);
  let piped = false;
  return {
    pipe<T extends Writable>(destination: T): T {
      if (piped) throw new Error("renderToPipeableStream: pipe() may only be called once.");
      piped = true;
      shell.then(
        (stream) => pumpInto(stream, destination, controller.signal),
        (error) => destination.destroy(toError(error)),
      );
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
 * Start rendering now and fire React's lifecycle callbacks: `onShellReady` once the shell
 * rendered (the compat stream resolves only then; a shell that throws rejects it — after
 * `onError`, as in React — and fires `onShellError`), then `onAllReady` when every boundary
 * rendered. The returned promise is pre-handled; `pipe()` consumes it.
 */
function startPipeableRender(
  node: VNodeChildren,
  options: RenderToPipeableStreamOptions,
  signal: AbortSignal,
): Promise<ReactDOMServerReadableStream> {
  const shell = renderToReadableStream(node, { signal, onError: options.onError }).then(
    (stream) => {
      options.onShellReady?.();
      // `allReady` rejects on abort (already reported through onError): a no-op handler.
      stream.allReady.then(() => options.onAllReady?.(), () => {});
      return stream;
    },
    (error) => {
      options.onShellError?.(error);
      throw error;
    },
  );
  shell.catch(() => {});
  return shell;
}

/** Waits for a Node destination's `'drain'`, and tracks an early `'close'`/`'error'`. */
interface DestinationGate {
  /** True once the destination closed or errored before the render finished. */
  readonly closed: boolean;
  /** Resolves on `'drain'` (or an early close); rejects with the reason on abort. */
  drained(): Promise<void>;
  /** Remove every listener this gate added. */
  dispose(): void;
}

function destinationGate(
  destination: Writable,
  signal: AbortSignal,
  onClosed: () => void,
): DestinationGate {
  let closed = false;
  let waiter: { resolve: () => void; reject: (reason: unknown) => void } | null = null;
  const release = () => {
    waiter?.resolve();
    waiter = null;
  };
  const onClose = () => {
    closed = true;
    onClosed();
    release();
  };
  const onAbort = () => {
    waiter?.reject(signal.reason);
    waiter = null;
  };
  destination.on("drain", release);
  destination.on("close", onClose);
  destination.on("error", onClose);
  signal.addEventListener("abort", onAbort);
  return {
    get closed() {
      return closed;
    },
    drained(): Promise<void> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (closed) return Promise.resolve();
      return new Promise((resolve, reject) => (waiter = { resolve, reject }));
    },
    dispose() {
      destination.off("drain", release);
      destination.off("close", onClose);
      destination.off("error", onClose);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Write the rendered stream into a Node `Writable`, one chunk per read, honouring
 * backpressure: after `write()` returns `false` the next chunk is neither read nor produced
 * until `'drain'`. A destination with `flush()` (compression middleware) is flushed after
 * each chunk, as React does. The destination is ended when the render completes, destroyed
 * when it fails or is aborted.
 */
async function pumpInto(
  stream: ReactDOMServerReadableStream,
  destination: Writable,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const gate = destinationGate(destination, signal, () => {
    reader.cancel().catch(() => {}); // the client went away: stop flushing
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || gate.closed) break;
      const accepted = destination.write(value);
      (destination as { flush?: () => void }).flush?.();
      if (!accepted) await gate.drained();
    }
    if (!gate.closed) destination.end();
  } catch (error) {
    reader.cancel().catch(() => {});
    if (!gate.closed) destination.destroy(toError(error));
  } finally {
    gate.dispose();
  }
}

/** Static-stream chunk size: a large document is pushed in pieces of at most this many bytes. */
const STATIC_CHUNK = 16 * 1024;

/**
 * React-compatible `renderToStaticNodeStream` — fully static markup as a Node `Readable`,
 * with NO hydration/streaming scaffolding (the static counterpart of `renderToStaticMarkup`,
 * for emails / static generation). Renders the synchronously-renderable subset via
 * {@link renderToStringSync}: a `<Suspense>` renders its fallback, and a genuinely async
 * Server Component outside a boundary destroys the stream with a guided error.
 *
 * Produced on demand, as in React: nothing renders until the consumer first reads, and the
 * document is pushed in bounded chunks only while the readable wants more (`push()` true).
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
  let bytes: Uint8Array | undefined;
  let offset = 0;
  return new mod.Readable({
    read(this: Readable) {
      try {
        bytes ??= new TextEncoder().encode(renderToStringSync(node));
      } catch (error) {
        options.onError?.(error);
        this.destroy(toError(error));
        return;
      }
      while (offset < bytes.byteLength) {
        const chunk = bytes.subarray(offset, offset += STATIC_CHUNK);
        if (!this.push(chunk)) return;
      }
      this.push(null);
    },
  });
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
