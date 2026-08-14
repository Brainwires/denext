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
 * denext's SSR renderer is **async by design** (buffered / progressive-streaming)
 * — that is a deliberate, faster divergence from React's synchronous, string-
 * building `renderToString`. The Web-streaming API (`renderToReadableStream`) is
 * fully supported; the legacy synchronous APIs throw a clear, guided error naming
 * the async alternative rather than silently returning a Promise where a string is
 * expected.
 *
 * @module
 */

import { renderToReadableStream as denextRenderToReadableStream } from "../jsx/render-to-stream.ts";
import type { VNodeChildren } from "../jsx/types.ts";

/** The React version denext reports for compatibility. */
export const version = "19.0.0";

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
 * so `allReady` resolves when all boundaries have rendered **independently of when
 * the consumer reads** — this preserves React's contract where you may
 * `await stream.allReady` before piping (e.g. for crawlers/static generation).
 *
 * @param node The element tree to render.
 * @param options React-compatible options (`signal`/`onError` honored).
 * @returns A promise for the React-shaped server stream.
 */
export function renderToReadableStream(
  node: VNodeChildren,
  options: RenderToReadableStreamOptions = {},
): Promise<ReactDOMServerReadableStream> {
  const source = denextRenderToReadableStream(node, { signal: options.signal });

  let resolveAllReady!: () => void;
  let rejectAllReady!: (error: unknown) => void;
  const allReady = new Promise<void>((res, rej) => {
    resolveAllReady = res;
    rejectAllReady = rej;
  });

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const out = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  }) as ReactDOMServerReadableStream;

  // Drain the source eagerly (buffered in `out`'s queue) so allReady is decoupled
  // from consumer backpressure — matching React's internally-buffered semantics.
  (async () => {
    const reader = source.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) controller.enqueue(value);
      }
      controller.close();
      resolveAllReady();
    } catch (error) {
      options.onError?.(error);
      try {
        controller.error(error);
      } catch {
        // controller already closed/errored
      }
      rejectAllReady(error);
    }
  })();

  out.allReady = allReady;
  return Promise.resolve(out);
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

/** Not supported — denext's renderer is async. Use `renderToReadableStream`. */
export function renderToString(): never {
  return notSupported("renderToString");
}

/** Not supported — denext's renderer is async. Use `renderToReadableStream`. */
export function renderToStaticMarkup(): never {
  return notSupported("renderToStaticMarkup");
}

/** Not supported (Node streams) — use `renderToReadableStream`. */
export function renderToPipeableStream(): never {
  return notSupported("renderToPipeableStream");
}

/** Not supported (Node streams) — use `renderToReadableStream`. */
export function renderToStaticNodeStream(): never {
  return notSupported("renderToStaticNodeStream");
}

/** The default `ReactDOMServer` namespace object. */
export default {
  version,
  renderToReadableStream,
  renderToString,
  renderToStaticMarkup,
  renderToPipeableStream,
  renderToStaticNodeStream,
};
