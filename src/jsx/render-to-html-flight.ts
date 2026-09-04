/// <reference path="../globals.d.ts" />
// Unified single-pass renderer: emit BOTH the SSR HTML and the Flight payload
// from ONE traversal of the tree.
//
// Doing this in one pass (rather than a separate renderToString + renderToFlight)
// is what makes `useId` correct across the client boundary: a single `useId`
// counter advances as the tree renders, and each client island records the
// counter value at its entry as `__dnxIdBase`. The browser seeds its own counter
// to that base when it hydrates the island, so ids line up even though the client
// never re-runs the (elided) server components between islands.

import { FRAGMENT, type VNode, type VNodeChild, type VNodeChildren } from "./types.ts";
import { isComponentType } from "../runtime/react-brands.ts";
import { type Dispatcher, setDispatcher } from "../runtime/hooks.ts";
import { SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY } from "../runtime/error-boundary.ts";
import { taintMessageFor } from "../runtime/taint.ts";
import { beginSignalCollection, endSignalCollection } from "../runtime/signal-state.ts";
import { type ClientRefInfo, clientRefOf } from "../runtime/client-reference.ts";
import { parseStrategy } from "../runtime/lazy-directive.ts";
import { islandWrapper } from "./island-wrapper.ts";
import {
  type CarvedIsland,
  type Dual,
  type DualHost,
  flightClientRef,
  flightHost,
  invokeServerComponent,
  type IslandPayload,
  type IslandRenderer,
  providerScopeOf,
  pushScope,
  renderClientIsland,
  renderDualChildren,
  renderErrorBoundaryWith,
  renderHostDual,
  resolveInBoundaryScope,
  type Serialized,
  serializeFlightProps,
  serializeFlightValue,
} from "./render-shared.ts";
import {
  beginServerInsertCollection,
  createSSRDispatcher,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
  type IdHolder,
} from "./render-to-string.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
import { rootScope, scopePrefix } from "./tree-id.ts";

/** Result of a unified render: SSR HTML plus the serializable Flight tree. */
export interface HtmlFlight {
  /** The server-rendered HTML (first paint). */
  html: string;
  /** The Flight payload (client components referenced, not expanded). */
  flight: FlightNode;
  /** Lazy (`client:*`) islands carved out for deferred per-island hydration. */
  islands: IslandPayload[];
  /** Serialized signal state (`useId → value`) adopted by the client on resume. */
  signalState: Record<string, unknown>;
}

export type { IslandPayload } from "./render-shared.ts";

/** Options for {@linkcode renderToHtmlFlight}. */
export interface HtmlFlightOptions {
  /** Collector for hoisted `<title>`/`<meta>`/`<link>` (document head). */
  head?: HeadCollector;
  /**
   * Resumable mode: auto-defer every client island to first-interaction hydration
   * and stamp handler hosts so the client can resume-and-replay. See
   * {@link SegmentConfig.resumable}.
   */
  resumable?: boolean;
}

type ProviderScope = Map<symbol, unknown>;

interface Ctx {
  scopes: ProviderScope[];
  dispatcher: Dispatcher;
  head: HeadCollector | null;
  /** The current id scope (shared with the dispatcher's `useId`). */
  ids: IdHolder;
  /** Accumulates `client:*` islands carved out for deferred hydration. */
  islands: IslandPayload[];
  /** Resumable mode: auto-defer islands + stamp handler hosts. */
  resumable: boolean;
  /** Count of effect hooks invoked so far (for per-island strategy selection). */
  effects: { count: number };
  /**
   * True while rendering *inside* a client island's own subtree. A `client:*`
   * island nested within another island carves independently (its own directive
   * defers it on its own schedule); this flag tells the carve to also record the
   * island in {@link Ctx.carvedNested} so the enclosing island's Flight children
   * emit a matching foreign-host placeholder instead of a client ref (keeping the
   * parent's per-island `hydrateRoot` from reconciling into the child's wrapper).
   */
  insideIsland?: boolean;
  /**
   * Nested islands carved during a parent island's dual render, keyed by the child
   * VNode object. The parent renders `{children}` (the same VNode objects) into its
   * HTML *before* its Flight children are serialized, so Gate 1 populates this and
   * the Flight-children pass (Gate 2) reads it to emit the child's foreign host with
   * the *same* `data-dnx-id` the HTML wrapper got — the two tree walks agree on the
   * id via object identity.
   */
  carvedNested?: WeakMap<VNode, CarvedIsland>;
}

/**
 * Render a VNode tree to HTML and Flight in a single pass.
 *
 * @param node The root to render.
 * @param options Optional head collector.
 * @returns The HTML string and the Flight payload.
 */
export async function renderToHtmlFlight(
  node: VNodeChildren,
  options: HtmlFlightOptions = {},
): Promise<HtmlFlight> {
  const scopes: ProviderScope[] = [];
  const ids: IdHolder = { scope: rootScope() };
  const effects = { count: 0 };
  const dispatcher = createSSRDispatcher(scopes, ids, effects);
  const ctx: Ctx = {
    scopes,
    dispatcher,
    head: options.head ?? null,
    ids,
    islands: [],
    resumable: options.resumable ?? false,
    effects,
    carvedNested: new WeakMap(),
  };
  const prev = setDispatcher(dispatcher);
  beginSignalCollection();
  // Collect `useServerInsertedHTML` callbacks (CSS-in-JS registries) so their <style>
  // markup lands in <head> for client-boundary/Flight routes too, not just plain SSR.
  const sink = beginServerInsertCollection();
  try {
    const dual = await renderChildDual(node as VNodeChild, ctx);
    flushServerInsertedHTML(sink.inserted, ctx.head);
    return {
      html: dual.html,
      flight: dual.flight,
      islands: ctx.islands,
      signalState: endSignalCollection(),
    };
  } finally {
    endSignalCollection(); // ensure the module collector is reset even on throw
    setDispatcher(prev);
    sink.end();
  }
}

function renderChildrenDual(children: VNodeChildren, ctx: Ctx): Promise<Dual> {
  return renderDualChildren(children, (child) => renderChildDual(child, ctx));
}

function renderChildDual(child: VNodeChild, ctx: Ctx): Dual | Promise<Dual> {
  if (child == null || child === false || child === true) return { html: "", flight: null };
  if (typeof child === "string") return { html: escapeHtml(child), flight: child };
  if (typeof child === "number") {
    return { html: escapeHtml(String(child)), flight: child };
  }
  if (Array.isArray(child)) return renderChildrenDual(child, ctx);
  return renderVNodeDual(child as VNode, ctx);
}

function renderVNodeDual(node: VNode, ctx: Ctx): Promise<Dual> {
  const { type } = node;
  // Null `props` (some npm libs) is treated as {} — parity with render-to-string.
  const props = node.props ?? {};
  if (type === FRAGMENT) return renderFragmentDual(props, ctx);
  // Suspense: its own id scope (one slot in its parent; content rooted at its position),
  // resolved inline here, retrying on suspension.
  if ((type as unknown) === SUSPENSE) {
    return resolveInBoundaryScope(ctx.ids, () => renderChildrenDual(props.children, ctx));
  }
  if ((type as unknown) === ERROR_BOUNDARY) return renderErrorBoundaryDual(props, ctx);
  if (isComponentType(type)) return renderComponentDual(node, type, props, ctx);
  return renderHostDual(hostOf(ctx), node, ctx.resumable, ctx.scopes, ctx.head);
}

/** The dual-render operations {@link renderHostDual} composes (a null `head` renders a hoisted `<title>`'s text). */
function hostOf(ctx: Ctx): DualHost {
  return {
    serializeValue: (value) => serializeValue(value, ctx),
    renderChildren: (children, _scopes, head) =>
      renderChildrenDual(children, head === ctx.head ? ctx : { ...ctx, head }),
  };
}

/** A fragment, or a context provider whose scope wraps its children. */
async function renderFragmentDual(props: Record<string, unknown>, ctx: Ctx): Promise<Dual> {
  const scope = providerScopeOf(props);
  if (!scope) return renderChildrenDual(props.children as VNodeChildren, ctx);
  ctx.scopes.push(scope);
  try {
    return await renderChildrenDual(props.children as VNodeChildren, ctx);
  } finally {
    ctx.scopes.pop();
  }
}

/** Error boundary (see {@link renderErrorBoundaryWith}). */
function renderErrorBoundaryDual(props: Record<string, unknown>, ctx: Ctx): Promise<Dual> {
  return renderErrorBoundaryWith(props, ctx.ids, {
    render: (children) => renderChildrenDual(children, ctx),
    renderFallback: (child) => renderChildDual(child, ctx),
    activate: () => setDispatcher(ctx.dispatcher),
  });
}

/**
 * Function component (or a memo/forwardRef object wrapper). Each opens a fresh id scope,
 * consuming a slot in its parent's scope, so ids derive from tree position. A client island
 * renders to HTML for first paint but emits only a REFERENCE in the Flight tree (see
 * {@link renderClientIsland}); a server component is invoked and expanded in both outputs.
 */
async function renderComponentDual(
  node: VNode,
  type: unknown,
  props: Record<string, unknown>,
  ctx: Ctx,
): Promise<Dual> {
  const { parent, scope } = pushScope(ctx.ids);
  try {
    setDispatcher(ctx.dispatcher);
    const ref = clientRefOf(type);
    if (ref) return await renderIslandDual(node, type, ref, props, scopePrefix(scope), ctx);
    return await renderChildDual(await invokeServerComponent(type, props, ctx.scopes), ctx);
  } finally {
    ctx.ids.scope = parent;
  }
}

/**
 * A client island via {@link renderClientIsland}. The island's own subtree renders with
 * `insideIsland` set, so any deeper `client:*` island records itself for the foreign-host
 * placeholder pass; its Flight children serialize through the Flight-only walk below.
 */
function renderIslandDual(
  node: VNode,
  type: unknown,
  ref: ClientRefInfo,
  props: Record<string, unknown>,
  prefix: string,
  ctx: Ctx,
): Promise<Dual> {
  const renderer: IslandRenderer = {
    resumable: ctx.resumable,
    effects: ctx.effects,
    insideIsland: ctx.insideIsland ?? false,
    carvedNested: ctx.carvedNested ?? new WeakMap(),
    recordIsland: (island) => ctx.islands.push(island),
    renderChild: (child) => renderChildDual(child, { ...ctx, insideIsland: true }),
    serializeValue: (value) => serializeValue(value, ctx),
    flightChildren: (children) => flightOfChildren(children, ctx),
  };
  return renderClientIsland(renderer, node, type, ref, props, prefix, ctx.scopes, ctx.head);
}

// ---- Flight-only serialization for props and client-island children --------
//
// Client islands carry their children as serialized "holes"; the reconstructed
// children are what the browser passes to the client component. We serialize
// them without also rendering HTML here (the HTML was produced when the island's
// own render consumed its children).

async function flightOfChildren(children: VNodeChildren, ctx: Ctx): Promise<FlightNode[]> {
  const arr = Array.isArray(children) ? children : children == null ? [] : [children];
  const out: FlightNode[] = [];
  for (const c of arr) out.push(await flightOfChild(c, ctx));
  return out;
}

function flightOfChild(child: VNodeChild, ctx: Ctx): FlightNode | Promise<FlightNode> {
  if (child == null || child === false || child === true) return null;
  if (typeof child === "string") return child;
  if (typeof child === "number") return child;
  if (Array.isArray(child)) return flightOfChildren(child, ctx);
  return flightOfVNode(child as VNode, ctx);
}

async function flightOfVNode(node: VNode, ctx: Ctx): Promise<FlightNode> {
  const { type } = node;
  const props = node.props ?? {};
  if (type === FRAGMENT) return flightOfChildren(props.children, ctx);
  if (!isComponentType(type)) {
    const p = await serializeProps(props, ctx);
    return flightHost(type as string, p, await flightOfChildren(props.children, ctx));
  }
  const { parent, scope } = pushScope(ctx.ids);
  try {
    const ref = clientRefOf(type);
    if (ref) return await flightOfIsland(node, ref, props, scopePrefix(scope), ctx);
    // A server component nested inside a hole: expand it (flight-only).
    setDispatcher(ctx.dispatcher);
    return await flightOfChild(await invokeServerComponent(type, props, ctx.scopes), ctx);
  } finally {
    ctx.ids.scope = parent;
  }
}

/**
 * A client island inside serialized children. One the parent's dual render already carved
 * (wrapper + islands entry) emits a matching FOREIGN HOST — the same node `islandWrapper` puts
 * in the page Flight for a top-level island — so the enclosing island's per-island `hydrateRoot`
 * adopts the child's wrapper element without reconciling into it (it hydrates on its own
 * strategy). Otherwise — an island's children that its component did not itself render, or a
 * Suspense hole — it is a plain client ref, hydrated with the enclosing island's root.
 */
async function flightOfIsland(
  node: VNode,
  ref: { id: string; moduleHydrate?: unknown },
  props: Record<string, unknown>,
  prefix: string,
  ctx: Ctx,
): Promise<FlightNode> {
  const carved = ctx.carvedNested?.get(node);
  if (carved) return islandWrapper(carved.id, carved.strategy, carved.param, "").flight;
  const { rest } = parseStrategy(props, ref.moduleHydrate);
  const p = await serializeProps(rest, ctx);
  const children = await flightOfChildren(rest.children as VNodeChildren, ctx);
  return flightClientRef(ref.id, p, prefix, children);
}

function serializeProps(props: Record<string, unknown>, ctx: Ctx): Promise<FlightProps> {
  return serializeFlightProps(props, (v) => serializeValue(v, ctx));
}

function serializeValue(value: unknown, ctx: Ctx): Promise<Serialized> {
  // Taint check (React `taint*`): refuse to serialize a value marked as secret before it
  // can cross to the client. Two empty-map lookups when nothing is tainted. Runs first so
  // even a tainted scalar / a tainted resolved deferred value (re-checked on the recursive
  // call) is caught.
  const tainted = taintMessageFor(value);
  if (tainted !== undefined) throw new Error(tainted);
  return serializeFlightValue(value, {
    value: (v) => serializeValue(v, ctx),
    vnode: (n) => flightOfVNode(n, ctx) as Promise<FlightValue>,
  });
}

/** Serialize a Flight payload to a JSON string safe to embed in a `<script>`. */
export function serializeFlight(flight: FlightNode): string {
  return JSON.stringify(flight).replace(/</g, "\\u003c");
}

/** The `actionEndpoint` re-export, so callers can build no-JS form URLs. */
