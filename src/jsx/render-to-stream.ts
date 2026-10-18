/// <reference path="../globals.d.ts" />
// Streaming server rendering with Suspense.
//
// The shell is flushed first. A Suspense boundary whose content has finished by then is
// written inline (between React's `<!--$-->` / `<!--/$-->` markers), as React does; one still
// rendering is a placeholder <div> showing its fallback, and its real content streams in as it
// resolves, revealed by the one inline swap runtime (see stream-boundaries.ts).
//
// Concurrency note: async boundary renders interleave, but the global hook
// dispatcher is only read during a component's *synchronous* execution, so we
// bind the active provider scopes immediately before each component call.

import { abortedPromise } from "../runtime/abort-promise.ts";
import type { VNode, VNodeChild, VNodeChildren } from "./types.ts";
import {
  beginServerInsertCollection,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
} from "./render-to-string.ts";
import { hostAttrs, renderHostHtml, reportHoleError } from "./render-shared.ts";
import { VNodeRenderer } from "./renderer-base.ts";
export type { HeadCollector };
import { enterScope, rootScope, scopePrefix } from "./tree-id.ts";
import { SWAP_RUNTIME } from "../server/swap-runtime.ts";
import { StreamBoundaries } from "./stream-boundaries.ts";

type ProviderScope = Map<symbol, unknown>;

/**
 * A pending streamed Suspense hole. It **resolves, never rejects**: on success
 * `{ id, html, ok: true }`; on a render error `{ id, html: "", ok: false }` (the
 * error is logged and the hole's shell fallback is left in place). Consumed by the
 * document stream assemblers, so one failing hole never tears down the response.
 * A control signal thrown in the hole resolves `ok: true` with the hole's replacement:
 * a client-side redirect for `redirect()`, the nearest signal boundary's UI for
 * `notFound()`/`forbidden()`/`unauthorized()` (the shell that would have unwound has
 * already flushed, so the response's status and headers stay as sent — as in Next).
 */
export type PendingHole = Promise<
  { id: string; html: string; ok: boolean; ms?: number }
>;

class StreamRenderer extends VNodeRenderer<string> {
  private id = 0;
  protected override isoIslands = true;
  /** Dev-only: record each boundary's server resolve duration (see StreamOptions). */
  collectTiming = false;
  /** Told each error a streamed hole's render threw that nothing inside the hole caught. */
  onHoleError?: (error: unknown) => void;
  /**
   * In-flight boundary renders. Each **resolves, never rejects**, to its id + html
   * + an `ok` flag: a boundary whose render throws is logged and resolves `ok:false`
   * (its shell fallback stays) so ONE failing hole can't reject the race and tear
   * down the whole streamed document.
   */
  readonly active = new Set<PendingHole>();
  /** Every boundary's token in the HTML, decided inline or streamed when it flushes. */
  readonly boundaries = new StreamBoundaries<Awaited<PendingHole>>();

  // Path-based useId state: each Suspense boundary's content is rooted at the boundary's
  // position. Sibling subtrees render concurrently (Promise.all), so — as with the
  // pre-existing counter — the interior useId ordering of concurrently rendering
  // siblings/boundaries keeps the documented streaming caveat. No `effects` ⇒ effect
  // hooks no-op.

  async renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): Promise<string> {
    if (Array.isArray(children)) {
      const parts = await Promise.all(
        children.map((c) => this.renderChild(c, scopes, head)),
      );
      return parts.join("");
    }
    return this.renderChild(children as VNodeChild, scopes, head);
  }

  protected empty(): string {
    return "";
  }

  protected override suspended(scopes: ProviderScope[]): void {
    this.boundaries.suspendedIn(scopes);
  }

  protected text(value: string | number): string {
    return escapeHtml(String(value));
  }

  /**
   * Suspense boundary: start its content rendering on its own and emit a token that the flush
   * decides — the content inline when it has finished by then, else the fallback now and the
   * content streamed later (see {@link StreamBoundaries}). The boundary is its own id scope
   * (one slot in its parent); its content is rooted at that position so it reproduces the
   * client's ids.
   */
  protected async renderSuspense(
    props: Record<string, unknown>,
    scopes: ProviderScope[],
  ): Promise<string> {
    const id = `dnx${this.id++}`;
    const parentScope = this.ids.scope;
    const boundaryScope = enterScope(parentScope);
    // Dev-only: time how long this boundary takes to resolve on the server.
    const t0 = this.collectTiming ? performance.now() : 0;
    const elapsed = () => (this.collectTiming ? performance.now() - t0 : 0);
    // The hole's own render (and the fallback) do NOT hoist into `head`: they resolve after
    // the head has already flushed, so their head tags stay inline. The id is captured here,
    // so even a rejected render still reports it (ok:false) — the hole's fallback stays and
    // the rest of the document streams unaffected. A control signal (`redirect()`,
    // `notFound()`, …) thrown in the hole is not a failure: it resolves to the hole's
    // replacement (see `resolveHoleSignal`), since the shell it would have unwound has flushed.
    const holeScope = rootScope(scopePrefix(boundaryScope));
    const holeScopes = this.boundaries.open(id, scopes);
    const render: PendingHole = this.resolve(
      props.children as VNodeChildren,
      holeScopes,
      holeScope,
      null,
    )
      .catch((err) => this.resolveHoleSignal(err, holeScopes, holeScope, (html) => html))
      .then((html) => ({ id, html, ok: true, ms: elapsed() }))
      .catch((err) => {
        console.error("denext: streamed Suspense boundary failed to resolve:", id, err);
        reportHoleError(this.onHoleError, err);
        return { id, html: "", ok: false, ms: elapsed() };
      });
    this.active.add(this.boundaries.track(id, render));
    this.ids.scope = boundaryScope;
    try {
      const fallback = await this.renderChildren(props.fallback as VNodeChildren, scopes, null);
      return this.boundaries.token(id, fallback);
    } finally {
      this.ids.scope = parentScope;
    }
  }

  /**
   * Host element. React 19 document metadata: in-tree <title>/<meta>/<link> hoist into the
   * head collector (shell render only) instead of emitting inline.
   */
  protected renderHost(
    node: VNode,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<string> {
    const props = node.props ?? {};
    const tag = node.type as string;
    return renderHostHtml(tag, props, hostAttrs(props, tag), head, {
      renderChildren: (c) => this.renderChildren(c, scopes, head),
      renderTitle: (c) => this.renderChildren(c, scopes, null),
    }, node.key);
  }
}

/** Options for {@link renderToReadableStream}. */
export interface StreamOptions {
  /** Aborts streaming when signaled; pending boundaries stop being flushed. */
  signal?: AbortSignal;
  /** Root `useId` prefix (React's `identifierPrefix`); must match the client's. */
  idPrefix?: string;
  /** Prepended to the very first chunk (e.g. "<!DOCTYPE html>..."). */
  shellPrefix?: string;
  /** Appended after all boundaries resolve (e.g. "</body></html>"). */
  shellSuffix?: string;
  /**
   * Dev-only: record each Suspense boundary's server resolve duration and emit a
   * `#__denext_boundary_timing` JSON island (a CSP-safe data block, not executed) at
   * the end of the stream for the DevTools per-boundary timeline. Off in production.
   */
  collectBoundaryTiming?: boolean;
  /**
   * React's document rendering: when the shell is an `<html>` element, it opens with
   * `<!DOCTYPE html>`, the reveal runtime goes inside the document (at the end of the shell's
   * body) and the closing `</body></html>` is held to the end of the stream, after every
   * streamed boundary — as `react-dom/server` writes a document. Other shells are unchanged.
   */
  documentShell?: boolean;
}

/**
 * A document shell (`<html>…</html>`) split around its closing tags; `null` for any other shell.
 *
 * @param shell The rendered shell HTML.
 */
function splitDocumentShell(shell: string): { open: string; close: string } | null {
  if (!/^<html[\s>]/i.test(shell)) return null;
  const close = /<\/body>\s*<\/html>\s*$/i.exec(shell) ?? /<\/html>\s*$/i.exec(shell);
  if (!close) return { open: shell, close: "" };
  return { open: shell.slice(0, close.index), close: close[0] };
}

/** A streaming render: the HTML byte stream plus React's `allReady` signal. */
export interface RenderStream extends ReadableStream<Uint8Array> {
  /**
   * Resolves once the shell and every Suspense boundary have **rendered** — independent of
   * how far the consumer has read (the flush is demand-gated, the rendering is not), so
   * `await stream.allReady` before reading never deadlocks. Rejects with the error when the
   * shell fails, or with the abort reason when `signal` aborts before every boundary rendered.
   * Always carries an internal handler, so an unobserved rejection never crashes the process.
   */
  allReady: Promise<void>;
  /**
   * Resolves once the shell has rendered — React's `onShellReady` point — without reading
   * it: the shell is written on the first read, with every boundary rendered by then inline.
   * Rejects with the error when the shell fails. Pre-handled, like {@link allReady}.
   */
  shellReady: Promise<void>;
}

/** Flush at most about this many characters of settled boundaries per consumer pull. */
const FLUSH_BUDGET = 16 * 1024;

/**
 * Settled-boundary bookkeeping for a pull-gated stream. Every hole in the renderer's
 * `active` set (nested ones join it while their parent renders, before the parent settles)
 * is observed once; a settled hole moves into `ready` until the consumer's next pull
 * flushes it. Rendering never waits on the consumer — only the flush does.
 */
class HoleQueue {
  readonly ready: Awaited<PendingHole>[] = [];
  private readonly seen = new WeakSet<PendingHole>();
  private pending = 0;
  private wake: (() => void) | null = null;
  private onIdle: (() => void) | null = null;

  /**
   * @param active The holes to observe (joined by nested ones as their parents render).
   * @param keep Whether settled holes wait in {@link ready} for a flush; false when only
   *   {@link settled} / the idle callback matter.
   */
  constructor(private readonly active: Set<PendingHole>, private readonly keep = true) {}

  /** Start observing `active`; `idle` runs once every boundary (nested included) settled. */
  start(idle: () => void): void {
    this.onIdle = idle;
    this.adopt();
  }

  /** True once no boundary is still rendering. */
  get settled(): boolean {
    return this.pending === 0;
  }

  /** Resolves when a boundary settles (or none is left rendering). */
  next(): Promise<void> {
    if (this.ready.length > 0 || this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => (this.wake = resolve));
  }

  private adopt(): void {
    for (const hole of this.active) {
      if (this.seen.has(hole)) continue;
      this.seen.add(hole);
      this.pending++;
      hole.then((settled) => this.settle(hole, settled));
    }
    if (this.pending === 0) this.onIdle?.();
  }

  private settle(hole: PendingHole, settled: Awaited<PendingHole>): void {
    this.active.delete(hole);
    this.pending--;
    if (this.keep) this.ready.push(settled);
    this.adopt(); // the hole's own nested boundaries joined `active` while it rendered
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A deferred whose rejection is pre-handled (an unobserved `allReady` must not crash). */
function handledDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Reject `ready` with the abort reason when `signal` aborts (now or later). */
function rejectOnAbort(signal: AbortSignal | undefined, ready: Deferred): void {
  if (!signal) return;
  const fire = () => ready.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  if (signal.aborted) fire();
  else signal.addEventListener("abort", fire, { once: true });
}

/**
 * Render a VNode tree to a streaming HTML `ReadableStream<Uint8Array>`,
 * resolving Suspense boundaries progressively.
 *
 * The stream is **pull-gated**: nothing is produced ahead of a read. The first read gets the
 * shell — every Suspense boundary that has finished by then inline, as React writes it, the
 * rest as fallback placeholders — and each later chunk (a batch of settled boundaries, then
 * the tail) is produced only when the consumer asks for more, so a slow consumer applies
 * backpressure instead of the whole document queueing in memory as encoded chunks. Boundary
 * rendering is not gated — see {@link RenderStream.allReady}: a consumer that awaits it before
 * reading gets every boundary inline.
 */
export function renderToReadableStream(
  node: VNodeChildren,
  options: StreamOptions = {},
): RenderStream {
  const encoder = new TextEncoder();
  const renderer = new StreamRenderer(options.idPrefix ?? "");
  renderer.collectTiming = options.collectBoundaryTiming === true;
  const timings: Array<{ id: string; ms: number }> = [];
  // Every boundary (nested ones included): `allReady` waits for all of them to render.
  const rendering = new HoleQueue(renderer.active, false);
  // The boundaries the flushed HTML left to stream (each joins once its parent flushed).
  const streamed = new Set<PendingHole>();
  const queue = new HoleQueue(streamed);
  const ready = handledDeferred();
  const shellReady = handledDeferred();
  rejectOnAbort(options.signal, ready);
  // A boundary that never settles must not pin a pull past an abort (a client
  // disconnect / request deadline): every wait races the abort signal.
  const aborted = abortedPromise(options.signal);

  const write = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) =>
    controller.enqueue(encoder.encode(text));

  /** One settled hole as its `<template>` (empty for a failed hole: its fallback stays). */
  const template = ({ id, html, ok, ms }: Awaited<PendingHole>): string => {
    const roundedMs = Math.round((ms ?? 0) * 100) / 100;
    if (renderer.collectTiming) timings.push({ id, ms: roundedMs });
    if (!ok) return "";
    // In dev, stamp the server resolve time on the template so the swap runtime can
    // surface a real-time reveal timeline (client reveal + server resolve) as holes
    // land — attributes don't affect the swap-runtime script's fixed CSP hash.
    const msAttr = renderer.collectTiming ? ` data-dnx-ms="${roundedMs}"` : "";
    return `<template data-dnx-r="${id}"${msAttr}>${html}</template>`;
  };

  /** Drain up to {@link FLUSH_BUDGET} characters of settled holes into one string. */
  const takeReady = (): string => {
    let out = "";
    while (queue.ready.length > 0 && out.length < FLUSH_BUDGET) {
      out += template(queue.ready.shift()!);
    }
    return out;
  };

  /** A document shell's closing tags, held until every boundary has streamed. */
  let heldClose = "";
  /** The rendered shell (boundary tokens undecided) until the first pull flushes it. */
  let shell: string | null = null;

  /** The tail: the dev timeline island, a held document close and `shellSuffix`, then close. */
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    // Dev-only per-boundary timeline: a CSP-safe JSON data block (not executed).
    if (renderer.collectTiming && timings.length > 0) {
      const json = JSON.stringify(timings).replace(/</g, "\\u003c");
      write(
        controller,
        `<script type="application/json" id="__denext_boundary_timing">${json}</script>`,
      );
    }
    if (heldClose) write(controller, heldClose);
    if (options.shellSuffix) write(controller, options.shellSuffix);
    controller.close();
  };

  /**
   * The first pull: the shell, every boundary that has rendered by now written inline (all of
   * them when the consumer awaited `allReady` first, as React's). The reveal runtime ships only
   * when a boundary is left to stream; with none, the tail follows at once.
   */
  const flushShell = (controller: ReadableStreamDefaultController<Uint8Array>, html: string) => {
    const body = renderer.boundaries.expand(html, streamed);
    const runtime = streamed.size > 0 ? SWAP_RUNTIME : "";
    const doc = options.documentShell ? splitDocumentShell(body) : null;
    if (doc) heldClose = doc.close;
    write(
      controller,
      (options.shellPrefix ?? "") + (doc ? `<!DOCTYPE html>${doc.open}${runtime}` : runtime + body),
    );
    queue.start(() => {});
    if (queue.settled) finish(controller);
  };

  /**
   * One consumer pull: the next batch of settled holes, or the tail once none are left.
   * Loops until it enqueues (a failed hole flushes nothing): a pull that returns without
   * enqueuing would not be called again for the waiting read.
   */
  const flushNext = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (;;) {
      if (!options.signal?.aborted) await Promise.race([queue.next(), aborted]);
      const batch = takeReady();
      if (batch) return write(controller, batch);
      if (queue.settled || options.signal?.aborted) return finish(controller);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const rendered = await renderer.resolve(node, []);
        // React's shell pass: boundaries that never suspend finish here (the flush writes them
        // inline); suspended ones stream unless they finish before the consumer reads.
        await renderer.boundaries.quiet();
        shell = rendered;
        rendering.start(ready.resolve);
        shellReady.resolve();
      } catch (err) {
        ready.reject(err);
        shellReady.reject(err);
        controller.error(err);
      }
    },
    async pull(controller) {
      try {
        if (shell !== null) {
          const html = shell;
          shell = null;
          return flushShell(controller, html);
        }
        await flushNext(controller);
      } catch (err) {
        ready.reject(err); // a flush failure errors the stream; never leave allReady pending
        throw err;
      }
    },
    cancel() {
      ready.resolve(); // the consumer gave up; rendering already ran on its own
    },
    // Nothing is produced ahead of a read: the shell is decided when the consumer first reads.
  }, { highWaterMark: 0 }) as RenderStream;
  stream.allReady = ready.promise;
  stream.shellReady = shellReady.promise;
  return stream;
}

/** A rendered shell plus its still-pending Suspense holes. */
export interface ShellRender {
  /**
   * The shell HTML: each Suspense boundary that finished during the shell render inline
   * (between `<!--$-->` / `<!--/$-->`), each still rendering a `data-dnx-b` placeholder.
   */
  shell: string;
  /**
   * The pending Suspense holes — the placeholders' content. A hole's nested boundaries are
   * decided when it settles; those still rendering then join this set. Each {@link PendingHole} resolves (never rejects)
   * to its id + html + `ok` flag, so a document assembler can stream them via the
   * shared `streamHoles` helper: a failed hole (`ok:false`) is skipped (its shell
   * fallback stays) without tearing down the rest of the response.
   */
  holes: Set<PendingHole>;
}

/**
 * Two-phase streaming render: render the **shell** eagerly (awaitable, so a
 * control signal — `notFound()`/`redirect()`/… — thrown during it can be caught
 * and turned into a buffered response BEFORE any bytes flush), then expose the
 * pending Suspense holes for a document assembler to stream and frame.
 *
 * @param node The tree to render.
 * @param head Collector for in-tree `<title>`/`<meta>`/`<link>` (shell only), or null.
 * @param collectTiming Dev-only: record each boundary's server resolve time.
 * @param onHoleError Told each error a streamed hole threw that nothing inside it caught
 *   (the hole keeps its fallback); the server reports it to `onRequestError`.
 * @returns The shell HTML and the pending {@link PendingHole holes}.
 */
export async function renderShell(
  node: VNodeChildren,
  head: HeadCollector | null,
  collectTiming = false,
  onHoleError?: (error: unknown) => void,
): Promise<ShellRender> {
  const renderer = new StreamRenderer();
  renderer.collectTiming = collectTiming;
  renderer.onHoleError = onHoleError;
  // Collect `useServerInsertedHTML` callbacks (CSS-in-JS registries) fired during the
  // shell render and hoist their <style> markup into `head.serverInserted` BEFORE the
  // head flushes. Without this, styled-components/emotion styles are dropped on the
  // default streaming path (holes resolve after the head, so only shell callbacks hoist).
  const sink = beginServerInsertCollection();
  try {
    const rendered = await renderer.resolve(node, [], undefined, head);
    // React's shell pass: boundaries that never suspend finish here, so the shell writes them
    // inline (and their `useServerInsertedHTML` markup is collected with the shell's).
    await renderer.boundaries.quiet();
    flushServerInsertedHTML(sink.inserted, head);
    const holes = new Set<PendingHole>();
    const shell = renderer.boundaries.expand(rendered, holes);
    return { shell, holes };
  } finally {
    sink.end();
  }
}

/** Collect a render stream into a single string (useful for tests/SSR-to-string). */
export async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk);
  return out;
}
