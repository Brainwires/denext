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
import type { ClientRefInfo } from "../runtime/client-reference.ts";
import { serializeFlight } from "./render-to-html-flight.ts";
import { deferErrorMarker, serializeScalar } from "./flight-scalar.ts";
import {
  type CarvedIsland,
  type Dual,
  type IslandPayload,
  type IslandRenderer,
  renderClientIsland,
  renderDualChildren,
  renderHostDual,
  serializeCompound,
  type Serialized,
  SKIP,
} from "./render-shared.ts";
import { takeSettled, VNodeRenderer } from "./renderer-base.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
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

/**
 * A **value hole** in the Flight tree: the placeholder a deferred promise prop
 * (a Remix `defer()` field) leaves behind so the shell can flush WITHOUT awaiting
 * it. The promise settles as the deferred `<Await>`'s Suspense hole streams; the
 * resolved value is substituted into the tail Flight before it is emitted, so the
 * client hydrates with real data instead of the `{}` a bare `Object.entries(promise)`
 * would have produced. Ids are prefixed `dnxv` so a user data object shaped like a
 * value hole can't be mistaken for one during substitution.
 */
interface FlightValueHole {
  /** Discriminant: deferred value hole. */
  $: "vh";
  /** Value-hole id (a `dnxv<n>` key into the resolved-values map). */
  r: string;
}

class StreamFlightRenderer extends VNodeRenderer<Dual> implements IslandRenderer {
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
   * Deferred promise props (Remix `defer()` fields) encountered while serializing
   * props, keyed by value-hole id. The shell emits a `{$:"vh"}` placeholder for
   * each instead of awaiting it (so first paint isn't blocked); {@link resolveValueHoles}
   * drains them at tail time and their resolved values are substituted into the
   * final Flight. Each captures the provider scopes active at serialization so a
   * VNode-valued deferred result serializes in the right context.
   */
  readonly valueHoles = new Map<
    string,
    { promise: PromiseLike<unknown>; scopes: ProviderScope[] }
  >();
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
    // its shell fallback stays and the rest of the stream is unaffected.
    this.active.add(
      this.resolve(props.children as VNodeChildren, scopes, rootScope(scopePrefix(boundaryScope)))
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
      // The hole is a transient node type filled by fillHoles before emit.
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
      this.valueHoles.set(id, { promise: scalar.promise, scopes });
      return { $: "vh", r: id } as unknown as FlightValue;
    }
    return await serializeCompound(value, {
      value: (v) => this.serializeValue(v, scopes),
      vnode: async (n) => (await this.renderChild(n, scopes)).flight as FlightValue,
    });
  }

  /**
   * Await every deferred value hole and serialize its resolved value, returning
   * `id → serialized value`. Loops because serializing a resolved value can register
   * MORE holes (a `defer()` whose value itself contains a promise). A rejected
   * deferred value resolves to an error marker ({@link deferErrorMarker}) so a migrated
   * Remix `<Await>` renders its `errorElement` (via `useAsyncError`) rather than its
   * children with `null`. By the time this runs (after the Suspense holes drained) a hole
   * consumed by `<Await>` is already settled, so this only truly waits on a deferred field
   * nothing rendered.
   */
  async resolveValueHoles(): Promise<Map<string, FlightValue>> {
    const resolved = new Map<string, FlightValue>();
    while (this.valueHoles.size > 0) {
      const batch = [...this.valueHoles];
      this.valueHoles.clear();
      await Promise.all(batch.map(async ([id, { promise, scopes }]) => {
        try {
          const sv = await this.serializeValue(await promise, scopes);
          resolved.set(id, sv === SKIP ? null : sv as FlightValue);
        } catch (err) {
          resolved.set(id, deferErrorMarker(err) as FlightValue);
        }
      }));
    }
    return resolved;
  }
}

/** Serialized-leaf discriminants that carry no nested value holes to substitute. */
const LEAF_FLIGHT_TAGS = new Set(["a", "D", "e"]);

/** Resolve a `{$:"vh",r}` placeholder to its deferred value, or leave a look-alike as data. */
function fillValueHole(value: FlightValue, resolved: Map<string, FlightValue>): FlightValue {
  const r = (value as unknown as FlightValueHole).r;
  const filled = typeof r === "string" && r.startsWith("dnxv") ? resolved.get(r) : undefined;
  return filled === undefined ? value : substituteValueHoles(filled, resolved);
}

/**
 * Substitute resolved deferred values (`resolveValueHoles`) into a Flight tree,
 * replacing every `{$:"vh",r}` placeholder — in node children AND in props (where
 * a `defer()` field lives, e.g. the `loaderData` prop of a migrated Remix route).
 * A placeholder whose id isn't a resolved `dnxv` key is left as data (so a user
 * object shaped like a value hole is never corrupted).
 */
function substituteValueHoles(value: FlightValue, resolved: Map<string, FlightValue>): FlightValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => substituteValueHoles(v, resolved));
  const tag = (value as { $?: string }).$;
  if (tag === "vh") return fillValueHole(value, resolved);
  if (tag && LEAF_FLIGHT_TAGS.has(tag)) return value;
  if (tag === "h" || tag === "c") {
    const n = value as unknown as { p: FlightProps; c: FlightNode[] };
    const c = n.c.map((child) =>
      substituteValueHoles(child as FlightValue, resolved) as FlightNode
    );
    return { ...value, p: substitutePropsValueHoles(n.p, resolved), c } as unknown as FlightValue;
  }
  // A plain (data) object nested in a prop: recurse its values.
  return substitutePropsValueHoles(value as FlightProps, resolved);
}

/** Substitute value holes across a serialized props/object map. */
function substitutePropsValueHoles(
  props: FlightProps,
  resolved: Map<string, FlightValue>,
): FlightProps {
  const out: FlightProps = {};
  for (const [k, v] of Object.entries(props)) out[k] = substituteValueHoles(v, resolved);
  return out;
}

/** Recursively fill `{$:"$",r}` Suspense holes with their resolved Flight. */
function fillHoles(
  node: FlightNode,
  holes: Map<string, FlightNode>,
): FlightNode {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => fillHoles(n, holes));
  const tag = (node as { $?: string }).$;
  if (tag === "$") {
    const filled = holes.get((node as unknown as FlightHole).r);
    return filled === undefined ? null : fillHoles(filled, holes);
  }
  if (tag === "h" || tag === "c") {
    const n = node as { c: FlightNode[] };
    return { ...node, c: n.c.map((c) => fillHoles(c, holes)) } as FlightNode;
  }
  return node;
}

/** The trailing Flight/islands/state payload of a streamed Flight document. */
export interface FlightStreamTail {
  /** The complete Flight tree (holes filled), for `#__denext_flight`. */
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
  /** Drain the pending holes into `controller`, then return the tail payload. */
  streamHoles(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    signal?: AbortSignal,
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
    async streamHoles(controller, encoder, signal) {
      try {
        await drainShellHoles(renderer, controller, encoder, signal);
        return await finishFlightTail(renderer, shell.flight);
      } catch (err) {
        endSignalCollection();
        throw err;
      }
    },
  };
}

/** Stream each Suspense hole as it settles; a failed hole leaves its shell fallback. */
async function drainShellHoles(
  renderer: StreamFlightRenderer,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  signal: AbortSignal | undefined,
): Promise<void> {
  while (renderer.active.size > 0) {
    if (signal?.aborted) break;
    const { id, html, ok } = await takeSettled(renderer.active);
    if (!ok) continue; // failed hole: leave its shell fallback
    controller.enqueue(encoder.encode(`<template data-dnx-r="${id}">${html}</template>`));
  }
}

/**
 * All Suspense holes resolved: build the complete Flight tree (holes filled) and the
 * islands/signal-state accumulated across the shell and every hole. Deferred `defer()`
 * props left value-hole placeholders so the shell could flush; their promises have
 * settled as the holes streamed, so substitute the resolved values into the tail Flight
 * (the client hydrates with real data, not the `{}` a bare promise would serialize to).
 * Resolved BEFORE endSignalCollection in case a resolved deferred VNode touched a signal.
 */
async function finishFlightTail(
  renderer: StreamFlightRenderer,
  shellFlight: FlightNode,
): Promise<Awaited<ReturnType<FlightShellRender["streamHoles"]>>> {
  let root = shellFlight;
  if (Array.isArray(root) && root.length === 1) root = root[0];
  let flight = fillHoles(root, renderer.holes);
  const resolvedValues = await renderer.resolveValueHoles();
  if (resolvedValues.size > 0) {
    flight = substituteValueHoles(flight, resolvedValues) as FlightNode;
  }
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
  let out = `<script id="__denext_flight" type="application/json">${
    serializeFlight(tail.flight)
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
  return out;
}
