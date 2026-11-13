/**
 * `denext/preact/render-to-string/stream-node` — `preact-render-to-string/stream-node` on denext
 * (`denext migrate` maps that specifier here): `renderToPipeableStream`, which renders a tree to a
 * Node.js stream (`node:stream`) you `pipe()` into a writable (a Node `http` response, say).
 *
 * The tree renders through denext's server renderer with Preact's markup, as
 * {@link renderToStringAsync} does: denext writes the document once every Suspense boundary has
 * resolved, so `onShellReady` and `onAllReady` both fire once it is ready (`onShellReady`
 * first, on the next microtask at the earliest, and never after `onAllReady`). `abort()` before
 * then ends the stream and reports the reason to `onError`.
 *
 * @module
 */

import { PassThrough, type Writable } from "node:stream";
import type { VNode } from "../../jsx/types.ts";
import { renderToStringAsync } from "./render-to-string.ts";

/** The options of {@link renderToPipeableStream}. */
export interface RenderToPipeableStreamOptions {
  /** A nonce for inline scripts (denext's stream writes none). */
  nonce?: string;
  /** The shell is ready: call `pipe()` from here. */
  onShellReady?: () => void;
  /** The whole document has been written. */
  onAllReady?: () => void;
  /** The shell failed to render: nothing is streamed. */
  onShellError?: (error: unknown) => void;
  /** A render error, or the reason an `abort()` gave. */
  onError?: (error: unknown) => void;
}

/** What {@link renderToPipeableStream} returns. */
export interface PipeableStream {
  /** Stop the render (a no-op once the stream has ended). */
  abort: (reason?: unknown) => void;
  /** Pipe the HTML into `writable` (ended with it). */
  pipe: (writable: Writable) => void;
}

/**
 * Render a tree to a pipeable Node.js stream of UTF-8 HTML.
 *
 * @param vnode The tree.
 * @param options The callbacks.
 * @param _context A legacy context object (ignored on denext).
 * @returns The stream's `pipe` and `abort`.
 */
export function renderToPipeableStream(
  vnode: VNode,
  options: RenderToPipeableStreamOptions = {},
  _context?: unknown,
): PipeableStream {
  const stream = new PassThrough();
  let aborted = false;
  let shellPending = true;
  const shellReady = () => {
    if (!shellPending || aborted) return;
    shellPending = false;
    options.onShellReady?.();
  };
  renderToStringAsync(vnode).then((html) => {
    if (aborted) return;
    shellReady();
    stream.write(new TextEncoder().encode(html));
    options.onAllReady?.();
    stream.end();
  }, (error) => {
    if (aborted) return;
    stream.destroy();
    (options.onError ?? console.error)(error);
    options.onShellError?.(error);
  });
  return {
    abort(reason = new Error("The render was aborted by the server without a reason.")) {
      if (aborted || stream.writableEnded || stream.destroyed) return;
      aborted = true;
      stream.end();
      options.onError?.(reason);
    },
    pipe(writable) {
      stream.pipe(writable, { end: true });
    },
  };
}
