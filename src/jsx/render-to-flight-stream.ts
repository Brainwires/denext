/// <reference path="../globals.d.ts" />
// Streaming Flight rendering: stream the HTML shell (Suspense boundaries as
// placeholders that stream in as they resolve) while building the complete
// Flight payload in the SAME single pass, so `useId` stays aligned across the
// client boundary. The finished Flight payload is emitted as a `#__denext_flight`
// island at the end of the stream, its Suspense holes already filled — so the
// client hydrates the final tree without a row assembler.
//
// This mirrors `render-to-stream.ts` (HTML-only) for the Flight world. It is a
// capability module; the default request path renders non-streaming.

import type { VNode, VNodeChildren } from "./types.ts";
import {
  beginServerInsertCollection,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
} from "./render-to-string.ts";
import { beginSignalCollection, endSignalCollection } from "../runtime/signal-state.ts";
import { CLASS_MARKER_ID, takeClassRendered } from "../runtime/render-scope.ts";
import type { ClientRefInfo } from "../runtime/client-reference.ts";
import { serializeFlight } from "./render-to-html-flight.ts";
import { inlinedRootFlight } from "./flight-inline.ts";
import { fillFlightHoles, substituteValueHoles } from "./flight-holes.ts";
import { deferErrorMarker, serializeScalar } from "./flight-scalar.ts";
import {
  type CarvedIsland,
  type Dual,
  dualBoundary,
  flightOnlyChildren,
  type FlightWalker,
  type IslandPayload,
  type IslandRenderer,
  renderClientIsland,
  renderDualChildren,
  renderHostDual,
  serializeCompound,
  type Serialized,
  serializeFlightProps,
  SKIP,
} from "./render-shared.ts";
import { VNodeRenderer } from "./renderer-base.ts";
import type { FlightNode, FlightValue } from "./render-to-flight.ts";
import { enterScope, rootScope, scopePrefix } from "./tree-id.ts";

import { SWAP_RUNTIME } from "../server/swap-runtime.ts";

type ProviderScope = Map<symbol, unknown>;

/** A Suspense hole in the Flight tree, filled once the boundary resolves. */
interface FlightHole {
  /** Discriminant: streamed Suspense hole. */
  $: "$";
  /** Boundary id (matches the streamed HTML swap id). */
  r: string;
}

class StreamFlightRenderer extends VNodeRenderer<Dual> implements IslandRenderer {
  /** A client `error.tsx` fallback becomes a Flight boundary node around its children. */
  protected override wrapErrorBoundary(props: Record<string, unknown>, rendered: Dual): Dual {
    return dualBoundary(props, rendered);
  }

  private id = 0;
  /**
   * In-flight boundary renders: each **resolves, never rejects**, to id + streamed
   * html + resolved flight + an `ok` flag (a failed boundary streams nothing extra,
   * leaving its shell fallback — see {@link streamFlightHoles}).
   */
  readonly active = new Set<
    Promise<{ id: string; html: string; flight: FlightNode; ok: boolean }>
  >();
  /** Resolved boundary flights, spliced into the shell flight at the end. */
  readonly holes = new Map<string, FlightNode>();
  /**
   * Deferred promise props (Remix `defer()` fields) encountered while serializing props,
   * each settling to its value-hole id and serialized value. The shell emits a
   * `{$:"vh"}` placeholder for each instead of awaiting it (so first paint isn't blocked);
   * a streamed document sends each value as its own chunk the moment it settles, and
   * {@link resolveValueHoles} waits for the rest. Each serializes in the provider scopes
   * active where its promise was met, so a VNode-valued result renders in context.
   */
  readonly valueActive = new Set<Promise<ValueChunk>>();
  /** Every settled deferred value so far, by value-hole id. */
  readonly resolvedValues = new Map<string, FlightValue>();
  private valueHoleId = 0;
  /**
   * Lazy (`client:*`/resumable) islands carved out during the shell AND hole renders
   * (holes append as they resolve), emitted as `#__denext_islands` in the tail.
   */
  readonly islands: IslandPayload[] = [];
  /** Effect-hook invocations so far (for per-island resumable strategy selection). */
  readonly effects: { count: number };
  /** Resumable mode: auto-defer islands + stamp handler hosts. */
  readonly resumable: boolean;
  /** True while rendering inside a client island's subtree — see render-to-html-flight. */
  insideIsland = false;
  /**
   * Nested islands carved during a parent island's dual render, keyed by the child
   * VNode. The Flight-children re-walk (pass 2) re-enters scope with an advanced
   * counter, so it would assign a different prefix; this pins each nested island's
   * foreign host to the id its HTML wrapper (pass 1) got. See render-to-html-flight.
   */
  readonly carvedNested = new WeakMap<VNode, CarvedIsland>();

  // Path-based useId state: the shell renders sequentially so its scopes are deterministic;
  // a streamed boundary's content is rooted at the boundary's position. (Multiple boundaries
  // streaming concurrently share this one holder, so their interior useId ordering keeps the
  // pre-existing streaming caveat — the shell and any single boundary are correct.)

  constructor(resumable = false) {
    // `effects` makes effect hooks bump the counter so an island that runs an effect is
    // picked for hydration.
    const effects = { count: 0 };
    super("", effects);
    this.effects = effects;
    this.resumable = resumable;
  }

  renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): Promise<Dual> {
    return renderDualChildren(children, (child) => this.renderChild(child, scopes, head));
  }

  protected empty(): Dual {
    return { html: "", flight: null };
  }

  protected text(value: string | number): Dual {
    return { html: escapeHtml(String(value)), flight: value };
  }

  /**
   * Suspense: stream the HTML; the Flight tree gets a hole filled on resolve. The boundary
   * is its own id scope (one slot in its parent); its streamed content is rooted at that
   * position so it reproduces the client's ids.
   */
  protected async renderSuspense(
    props: Record<string, unknown>,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    const id = `dnx${this.id++}`;
    const parentScope = this.ids.scope;
    const boundaryScope = enterScope(parentScope);
    // The id is captured in closure, so a rejected boundary still reports it (ok:false):
    // its shell fallback stays and the rest of the stream is unaffected. A control signal
    // thrown in the hole resolves to its replacement instead (`resolveHoleSignal`): a
    // client-side redirect carries no Flight (the client is leaving), a signal boundary's
    // UI carries its own so the tail Flight hydrates what was streamed.
    const holeScope = rootScope(scopePrefix(boundaryScope));
    this.active.add(
      this.resolve(props.children as VNodeChildren, scopes, holeScope)
        .catch((err) =>
          this.resolveHoleSignal(err, scopes, holeScope, (html) => ({ html, flight: null }))
        )
        .then((d) => {
          this.holes.set(id, d.flight);
          return { id, html: d.html, flight: d.flight, ok: true };
        })
        .catch((err) => {
          console.error("denext: streamed Flight boundary failed to resolve:", id, err);
          return { id, html: "", flight: null, ok: false };
        }),
    );
    this.ids.scope = boundaryScope;
    try {
      const fallback = await this.renderChildren(props.fallback as VNodeChildren, scopes);
      // The hole is a transient node type filled by fillFlightHoles before emit.
      const hole = { $: "$", r: id } as FlightHole;
      return {
        html: `<div data-dnx-b="${id}">${fallback.html}</div>`,
        flight: hole as unknown as FlightNode,
      };
    } finally {
      this.ids.scope = parentScope;
    }
  }

  /**
   * <title>/<meta>/<link> hoist into the head collector (shell render only) — parity with
   * render-to-html-flight and the HTML stream renderer.
   */
  protected renderHost(
    node: VNode,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<Dual> {
    return renderHostDual(this, node, this.resumable, scopes, head);
  }

  /** A client island (mirrors renderToHtmlFlight's carve-out so streamed + buffered agree). */
  protected override renderClientRef(
    node: VNode,
    type: unknown,
    ref: ClientRefInfo,
    props: Record<string, unknown>,
    prefix: string,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<Dual> {
    return renderClientIsland(this, node, type, ref, props, prefix, scopes, head);
  }

  /**
   * An island's serialized children, walked WITHOUT invoking client components (the shared
   * Flight-only walk): rendering them through `renderChild` would run a consumer island
   * outside the providers its parent island rendered around it.
   */
  flightChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<FlightNode[]> {
    const walker: FlightWalker = {
      ids: this.ids,
      activate: (s) => this.activate(s),
      carvedNested: this.carvedNested,
      serializeProps: (props, s) => serializeFlightProps(props, (v) => this.serializeValue(v, s)),
    };
    return flightOnlyChildren(children, walker, scopes);
  }

  /** Lazy islands are emitted as `#__denext_islands` in the tail (shell and hole renders alike). */
  recordIsland(island: IslandPayload): void {
    this.islands.push(island);
  }

  /**
   * Like the buffered serializers, except a thenable (a Remix `defer()` field / promise
   * data) is NOT awaited here — that would block the shell. It leaves a value hole; the
   * promise settles as the deferred `<Await>`'s Suspense hole streams, and its resolved value
   * is substituted into the tail Flight (see resolveValueHoles / substituteValueHoles).
   */
  async serializeValue(value: unknown, scopes: ProviderScope[]): Promise<Serialized> {
    const scalar = serializeScalar(value);
    if (scalar.kind === "value") return scalar.value;
    if (scalar.kind === "skip") return SKIP;
    if (scalar.kind === "thenable") {
      const id = `dnxv${this.valueHoleId++}`;
      this.valueActive.add(this.settleValueHole(id, scalar.promise, scopes));
      return { $: "vh", r: id } as unknown as FlightValue;
    }
    return await serializeCompound(value, {
      value: (v) => this.serializeValue(v, scopes),
      vnode: async (n) => (await this.renderChild(n, scopes)).flight as FlightValue,
    });
  }

  /**
   * Settle one deferred value hole: serialize its resolved value (which may register MORE
   * holes — a `defer()` value that itself contains a promise). A rejected deferred value
   * settles to an error marker ({@link deferErrorMarker}) so a migrated Remix `<Await>`
   * renders its `errorElement` (via `useAsyncError`) rather than its children with `null`.
   * Never rejects.
   */
  private async settleValueHole(
    id: string,
    promise: PromiseLike<unknown>,
    scopes: ProviderScope[],
  ): Promise<ValueChunk> {
    let value: FlightValue;
    try {
      const sv = await this.serializeValue(await promise, scopes);
      value = sv === SKIP ? null : sv as FlightValue;
    } catch (err) {
      value = deferErrorMarker(err) as FlightValue;
    }
    this.resolvedValues.set(id, value);
    return { id, value };
  }

  /**
   * Wait for every deferred value hole still pending and return `id → serialized value`.
   * Loops because settling one can register more. By the time this runs (after the
   * Suspense holes drained) a hole consumed by `<Await>` is already settled, so this only
   * truly waits on a deferred field nothing rendered.
   */
  async resolveValueHoles(): Promise<Map<string, FlightValue>> {
    while (this.valueActive.size > 0) {
      const batch = [...this.valueActive];
      this.valueActive.clear();
      await Promise.all(batch);
    }
    return this.resolvedValues;
  }
}

/** A settled deferred value: its value-hole id and serialized value. */
interface ValueChunk {
  id: string;
  value: FlightValue;
}

/** The trailing Flight/islands/state payload of a streamed Flight document. */
export interface FlightStreamTail {
  /**
   * The Flight tree for `#__denext_flight`: complete (holes filled) when the holes were
   * drained without streaming their data; the shell tree, its holes unfilled, when each
   * hole's subtree and each deferred value already streamed as its own chunk (the client
   * puts them back — `assembleStreamedFlight`). `null` for a root-less islands page.
   */
  flight: FlightNode;
  /** Lazy (`client:*`/resumable) islands, keyed by tree-path id, or undefined if none. */
  islands?: IslandPayload[];
  /** Serialized signal state (`useId → value`), or undefined if none. */
  signalState?: Record<string, unknown>;
}

/** Options for {@linkcode renderToFlightStream}. */
export interface FlightStreamOptions {
  /** Aborts streaming when signaled. */
  signal?: AbortSignal;
  /** Prepended to the first chunk (e.g. the document head + opening body). */
  shellPrefix?: string;
  /** Appended after the trailing islands (e.g. the client entry script + `</body>`). */
  shellSuffix?: string;
  /** Resumable mode: auto-defer islands + stamp handler hosts (see SegmentConfig). */
  resumable?: boolean;
}

/**
 * A rendered Flight shell plus its pending Suspense holes and payload accumulators.
 * The document assembler flushes {@link shellHtml}, streams the holes (each as a
 * `<template data-dnx-r>`), then emits the {@link tail} — Flight + islands + signal
 * state — so the client hydrates the complete tree with its islands wired up.
 */
export interface FlightShellRender {
  /** The shell HTML (Suspense boundaries as `data-dnx-b` placeholders). */
  shellHtml: string;
  /**
   * Whether the shell has any pending Suspense holes. When false there is nothing to
   * stream, so the caller can drain the tail (via {@link streamHoles} with a
   * discarding controller — nothing is enqueued) and serve a buffered document.
   */
  hasHoles: boolean;
  /**
   * Drain the pending holes into `controller`, then return the tail payload. Each Suspense
   * hole streams as a `<template data-dnx-r>` plus, with `streamData` (the default), its
   * Flight subtree as a `<script type="application/json" data-dnx-f>`; each deferred value
   * streams as a `<script type="application/json" data-dnx-v>` the moment it settles — so
   * the data of an early boundary is on the wire before a slow one resolves. Without
   * `streamData` (a buffered document) nothing but the templates is enqueued and the tail
   * carries the complete tree.
   */
  streamHoles(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    signal?: AbortSignal,
    streamData?: boolean,
  ): Promise<FlightStreamTail>;
}

/**
 * Render the Flight **shell** eagerly (so a control signal thrown before any flush
 * is catchable by the caller) and return it plus a `streamHoles` drainer. Signal
 * collection spans the whole render (shell + holes), so the tail's `signalState`
 * captures every island's `useSignal`/`useStore`. The shared module-global signal
 * collector means concurrent Flight renders can interleave — the same constraint as
 * the buffered Flight path, widened by the streaming window (documented limitation).
 *
 * @param node The tree to render.
 * @param resumable Auto-defer islands + stamp handler hosts.
 * @param head Collector for in-tree `<title>`/`<meta>`/`<link>` hoisted from the
 *   shell (holes resolve after the head flush, so their head tags stay inline).
 */
export async function renderFlightShell(
  node: VNodeChildren,
  resumable = false,
  head: HeadCollector | null = null,
): Promise<FlightShellRender> {
  const renderer = new StreamFlightRenderer(resumable);
  beginSignalCollection();
  // Hoist `useServerInsertedHTML` (CSS-in-JS) markup produced during the shell render
  // into <head> before it flushes — the client-boundary streaming counterpart of the
  // same collection in renderToHtmlFlight; otherwise styled-components/emotion styles
  // are dropped on the default streaming Flight path.
  const sink = beginServerInsertCollection();
  let shell: Dual;
  try {
    shell = await renderer.resolve(node, [], undefined, head);
    flushServerInsertedHTML(sink.inserted, head);
  } catch (err) {
    endSignalCollection(); // reset the module collector even if the shell throws
    throw err;
  } finally {
    sink.end();
  }
  return {
    shellHtml: shell.html,
    hasHoles: renderer.active.size > 0,
    async streamHoles(controller, encoder, signal, streamData = true) {
      try {
        await drainShellHoles(renderer, controller, encoder, signal, streamData);
        return await finishFlightTail(renderer, shell.flight, streamData);
      } catch (err) {
        endSignalCollection();
        throw err;
      }
    },
  };
}

/** A settled Suspense hole (`ok: false` when it failed and keeps its shell fallback). */
interface HoleChunk {
  id: string;
  html: string;
  flight: FlightNode;
  ok: boolean;
}

/** The next settled piece of the stream: a Suspense hole or a deferred value. */
type StreamChunk = { hole: HoleChunk } | { value: ValueChunk };

/** Wait for the next hole (and, with `values`, deferred value) to settle and take it. */
async function nextChunk(renderer: StreamFlightRenderer, values: boolean): Promise<StreamChunk> {
  type Taken = { p: Promise<unknown>; chunk: StreamChunk };
  const pending: Promise<Taken>[] = [...renderer.active].map((p) =>
    p.then((hole) => ({ p, chunk: { hole } }))
  );
  if (values) {
    for (const p of renderer.valueActive) {
      pending.push(p.then((value) => ({ p, chunk: { value } })));
    }
  }
  const { p, chunk } = await Promise.race(pending);
  renderer.active.delete(p as Promise<HoleChunk>);
  renderer.valueActive.delete(p as Promise<ValueChunk>);
  return chunk;
}

/** A JSON chunk script (inert: `type="application/json"`, so CSP needs no hash for it). */
function dataScript(attr: "data-dnx-f" | "data-dnx-v", id: string, json: FlightValue): string {
  return `<script type="application/json" ${attr}="${id}">${
    serializeFlight(json as FlightNode)
  }</script>`;
}

/** A settled chunk as the bytes it streams (empty for a failed hole). */
function chunkHtml(chunk: StreamChunk, streamData: boolean): string {
  if ("value" in chunk) return dataScript("data-dnx-v", chunk.value.id, chunk.value.value);
  const { id, html, flight, ok } = chunk.hole;
  if (!ok) return ""; // failed hole: leave its shell fallback
  const template = `<template data-dnx-r="${id}">${html}</template>`;
  return streamData ? template + dataScript("data-dnx-f", id, flight as FlightValue) : template;
}

/**
 * Stream each Suspense hole — and, with `streamData`, each deferred value — as it settles,
 * in the order they settle.
 */
async function drainShellHoles(
  renderer: StreamFlightRenderer,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  signal: AbortSignal | undefined,
  streamData: boolean,
): Promise<void> {
  while (renderer.active.size > 0 || (streamData && renderer.valueActive.size > 0)) {
    if (signal?.aborted) break;
    const html = chunkHtml(await nextChunk(renderer, streamData), streamData);
    if (html) controller.enqueue(encoder.encode(html));
  }
}

/**
 * All Suspense holes resolved: the tail Flight tree and the islands/signal-state
 * accumulated across the shell and every hole. Deferred `defer()` props left value-hole
 * placeholders so the shell could flush. When their data and the holes' subtrees already
 * streamed (`streamData`), the tail is the shell tree with its holes left in place (the
 * client assembles it); otherwise the holes are filled and the resolved values substituted
 * here. The complete tree decides whether the root hydrates at all (a root-less islands
 * page inlines `null`). Resolved BEFORE endSignalCollection in case a resolved deferred
 * VNode touched a signal.
 */
async function finishFlightTail(
  renderer: StreamFlightRenderer,
  shellFlight: FlightNode,
  streamData: boolean,
): Promise<Awaited<ReturnType<FlightShellRender["streamHoles"]>>> {
  let root = shellFlight;
  if (Array.isArray(root) && root.length === 1) root = root[0];
  let flight = fillFlightHoles(root, renderer.holes);
  const resolvedValues = await renderer.resolveValueHoles();
  if (resolvedValues.size > 0) {
    flight = substituteValueHoles(flight, resolvedValues) as FlightNode;
  }
  if (streamData && inlinedRootFlight(flight) !== null) flight = root;
  const signalState = endSignalCollection();
  return {
    flight,
    islands: renderer.islands.length > 0 ? renderer.islands : undefined,
    signalState: Object.keys(signalState).length > 0 ? signalState : undefined,
  };
}

/**
 * Render a VNode tree to a self-contained streaming HTML `ReadableStream` carrying
 * the complete Flight payload (plus islands + signal state) as trailing islands.
 * Suspense boundaries stream progressively; the payload is emitted once all resolve.
 * A convenience wrapper over {@link renderFlightShell} (used by tests/tools); the
 * request pipeline composes {@link renderFlightShell} into a full document instead.
 *
 * @param node The tree to render.
 * @param options Shell prefix/suffix, resumable mode, and abort signal.
 */
export function renderToFlightStream(
  node: VNodeChildren,
  options: FlightStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const shell = await renderFlightShell(node, options.resumable);
        controller.enqueue(
          encoder.encode(
            (options.shellPrefix ?? "") + SWAP_RUNTIME + shell.shellHtml,
          ),
        );
        const tail = await shell.streamHoles(
          controller,
          encoder,
          options.signal,
        );
        controller.enqueue(encoder.encode(flightTailScripts(tail)));
        if (options.shellSuffix) {
          controller.enqueue(encoder.encode(options.shellSuffix));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Serialize a {@link FlightStreamTail} to the trailing `<script type="application/json">`
 * islands: `#__denext_flight` (always), then `#__denext_islands` and `#__denext_state`
 * when present. Exposed so the document assembler can emit the same tail.
 */
export function flightTailScripts(tail: FlightStreamTail): string {
  // An all-islands page inlines `null` for its root (see flight-inline.ts).
  let out = `<script id="__denext_flight" type="application/json">${
    serializeFlight(inlinedRootFlight(tail.flight))
  }</script>`;
  if (tail.islands && tail.islands.length > 0) {
    const map: Record<string, unknown> = {};
    for (const island of tail.islands) map[island.id] = island.flight;
    out += `<script id="__denext_islands" type="application/json">${
      JSON.stringify(map).replace(/</g, "\\u003c")
    }</script>`;
  }
  if (tail.signalState && Object.keys(tail.signalState).length > 0) {
    out += `<script id="__denext_state" type="application/json">${
      JSON.stringify(tail.signalState).replace(/</g, "\\u003c")
    }</script>`;
  }
  // The render produced a class component → the browser entry loads the class runtime
  // before hydrating (the same marker the document assembler emits).
  if (takeClassRendered()) {
    out += `<script id="${CLASS_MARKER_ID}" type="application/json">1</script>`;
  }
  return out;
}
