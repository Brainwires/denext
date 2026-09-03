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
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { type Dispatcher, setDispatcher } from "../runtime/hooks.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import {
  ERROR_BOUNDARY,
  isControlSignal,
  reportBoundaryError,
  toClientError,
} from "../runtime/error-boundary.ts";
import { actionEndpoint, isServerAction } from "../runtime/server-action.ts";
import { taintMessageFor } from "../runtime/taint.ts";
import { DNX_H_ATTR } from "../runtime/qrl.ts";
import { serializeScalar, serializeThenable } from "./flight-scalar.ts";
import { beginSignalCollection, endSignalCollection } from "../runtime/signal-state.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import { type HydrationStrategy, parseStrategy } from "../runtime/lazy-directive.ts";
import { islandWrapper, warnClientOnlySeoContent } from "./island-wrapper.ts";
import {
  beginServerInsertCollection,
  createSSRDispatcher,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
  HOISTED_TAGS,
  type IdHolder,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
import { enterScope, ID_PATH_PROP, rootScope, scopePrefix } from "./tree-id.ts";

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

/** A deferred-hydration island: its tree-path id, strategy, and own Flight tree. */
export interface IslandPayload {
  /** The island's tree-path prefix (client discovery key = `data-dnx-id`). */
  id: string;
  /** When to hydrate it. */
  strategy: HydrationStrategy;
  /** Strategy parameter (the media query, for a `media` island). */
  param?: string;
  /** The island's own Flight tree, hydrated on its wrapper when the strategy fires. */
  flight: FlightNode;
}

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
  carvedNested?: WeakMap<VNode, { id: string; strategy: HydrationStrategy; param?: string }>;
}

/** A rendered node's dual output: its HTML string and its Flight node. */
interface Dual {
  html: string;
  flight: FlightNode;
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

async function renderChildrenDual(children: VNodeChildren, ctx: Ctx): Promise<Dual> {
  const arr = Array.isArray(children) ? children : children == null ? [] : [children];
  // Render sequentially so the shared useId counter advances in tree order
  // (matching how the browser will re-run the islands).
  const flights: FlightNode[] = [];
  let html = "";
  for (const child of arr) {
    const d = await renderChildDual(child, ctx);
    html += d.html;
    flights.push(d.flight);
  }
  return { html, flight: flights };
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

async function renderVNodeDual(node: VNode, ctx: Ctx): Promise<Dual> {
  const { type } = node;
  // Null `props` (some npm libs) is treated as {} — parity with render-to-string.
  const props = node.props ?? {};
  const { scopes, dispatcher } = ctx;

  // Fragment / context provider.
  if (type === FRAGMENT) {
    const providerInfo = props[PROVIDER as unknown as string] as
      | { id: symbol; value: unknown }
      | undefined;
    if (providerInfo) {
      const scope: ProviderScope = new Map();
      scope.set(providerInfo.id, providerInfo.value);
      scopes.push(scope);
      try {
        return await renderChildrenDual(props.children, ctx);
      } finally {
        scopes.pop();
      }
    }
    return renderChildrenDual(props.children, ctx);
  }

  // Suspense: its own id scope (one slot in its parent; content rooted at its
  // position). Resolve inline here, retrying on suspension — each retry resets the
  // boundary scope's own counters (its parent slot is already fixed).
  if ((type as unknown) === SUSPENSE) {
    const parentScope = ctx.ids.scope;
    const boundaryScope = enterScope(parentScope);
    try {
      for (;;) {
        boundaryScope.count = 0;
        boundaryScope.local = 0;
        ctx.ids.scope = boundaryScope;
        try {
          return await renderChildrenDual(props.children, ctx);
        } catch (err) {
          if (isThenable(err)) {
            await err;
            continue;
          }
          throw err;
        }
      }
    } finally {
      ctx.ids.scope = parentScope;
    }
  }

  // Error boundary. The fallback renders from the pre-children scope state.
  if ((type as unknown) === ERROR_BOUNDARY) {
    const idScope = ctx.ids.scope;
    const savedCount = idScope.count;
    const savedLocal = idScope.local;
    try {
      return await renderChildrenDual(props.children, ctx);
    } catch (err) {
      if (isThenable(err) || isControlSignal(err)) throw err;
      ctx.ids.scope = idScope;
      idScope.count = savedCount;
      idScope.local = savedLocal;
      const Fallback = props.fallback as (p: { error: Error; reset: () => void }) => VNode;
      setDispatcher(dispatcher);
      reportBoundaryError(props, err);
      const fb = await Fallback({ error: toClientError(err), reset: () => {} });
      return renderChildDual(fb as VNodeChild, ctx);
    }
  }

  // Function component (or a memo/forwardRef object wrapper). Each opens a fresh id
  // scope, consuming a slot in its parent's scope, so ids derive from tree position.
  if (isComponentType(type)) {
    const ref = clientRefOf(type);
    const parentScope = ctx.ids.scope;
    const scope = enterScope(parentScope);
    ctx.ids.scope = scope;
    try {
      if (ref) {
        // Client island: render it to HTML for first paint, but emit only a
        // REFERENCE in the Flight tree — tagged with its tree-path prefix so the
        // client roots the island's id scope there and re-renders identical ids.
        // A `client:*` directive strips out and defers the island (below).
        setDispatcher(dispatcher);
        const parsed = parseStrategy(props, ref.moduleHydrate);
        const rest = parsed.rest;
        const prefix = scopePrefix(scope);

        // Record a carved nested island so the enclosing island's Flight children
        // emit a matching foreign host (keyed by this VNode) instead of a client ref.
        const recordNested = (strategy: HydrationStrategy, param?: string): void => {
          if (ctx.insideIsland) ctx.carvedNested?.set(node, { id: prefix, strategy, param });
        };

        // client:only — skip SSR entirely: render no island HTML, emit an empty
        // foreign wrapper + the island's own Flight. The client mounts it with
        // createRoot (no server DOM to adopt). No first paint (SEO/CLS tradeoff).
        if (parsed.strategy === "only") {
          const p = await serializeProps(rest, ctx);
          p[ID_PATH_PROP] = prefix;
          const childFlights = await flightOfChildren(rest.children as VNodeChildren, ctx);
          const islandFlight: FlightNode = { $: "c", i: ref.id, p, c: childFlights };
          ctx.islands.push({ id: prefix, strategy: "only", flight: islandFlight });
          recordNested("only");
          warnClientOnlySeoContent(rest.children as VNodeChildren, prefix);
          return islandWrapper(prefix, "only", undefined, "");
        }

        // Observe what this island actually does, to auto-pick its strategy in
        // resumable mode: an effect (useEffect/useLayoutEffect/useSyncExternalStore)
        // means it must hydrate to run, so it can't wait for an interaction.
        const effectsBefore = ctx.effects.count;
        const rendered = await invokeComponent(resolveComponentType(type), rest);
        const ranEffect = ctx.effects.count > effectsBefore;
        // Render the island's own subtree with `insideIsland` set, so any deeper
        // `client:*` island records itself for the foreign-host placeholder pass.
        const htmlDual = await renderChildDual(rendered as VNodeChild, {
          ...ctx,
          insideIsland: true,
        });
        // Resumable mode auto-defers every island: interaction if it only has
        // handlers (maximal laziness), idle if it runs an effect (or neither).
        const hasHandlers = htmlDual.html.includes(DNX_H_ATTR);
        const strategy = parsed.strategy ??
          (ctx.resumable ? (ranEffect || !hasHandlers ? "idle" : "interaction") : null);
        const p = await serializeProps(rest, ctx);
        p[ID_PATH_PROP] = prefix;
        const childFlights = await flightOfChildren(rest.children as VNodeChildren, ctx);
        const islandFlight: FlightNode = { $: "c", i: ref.id, p, c: childFlights };
        if (strategy) {
          // Lazy island (top-level OR nested): nest its server HTML in a
          // layout-neutral wrapper the enclosing root adopts but does not own
          // (foreign host), and stash the island's own Flight for a per-island
          // hydrateRoot when the strategy fires.
          ctx.islands.push({ id: prefix, strategy, param: parsed.param, flight: islandFlight });
          recordNested(strategy, parsed.param);
          return islandWrapper(prefix, strategy, parsed.param, htmlDual.html);
        }
        return { html: htmlDual.html, flight: islandFlight };
      }
      return await renderServerComponentDual(type, props, ctx);
    } finally {
      ctx.ids.scope = parentScope;
    }
  }

  return renderHostDual(node, ctx);
}

/** Invoke and expand a server component into both outputs (in the active scope). */
async function renderServerComponentDual(
  type: unknown,
  props: Record<string, unknown>,
  ctx: Ctx,
): Promise<Dual> {
  const { scopes, dispatcher } = ctx;
  // Server component: invoke and expand in both outputs.
  setDispatcher(dispatcher);
  if (isClassComponent(type)) {
    if (__DENEXT_CLASS_COMPONENTS__) {
      return renderChildDual(
        renderClassToVNode(type, props, resolveContextType(type, scopes)) as VNodeChild,
        ctx,
      );
    }
    throw classComponentsDisabledError();
  }
  const result = await invokeComponent(resolveComponentType(type), props);
  return renderChildDual(result as VNodeChild, ctx);
}

/** Render an intrinsic host element into both outputs. */
async function renderHostDual(node: VNode, ctx: Ctx): Promise<Dual> {
  const props = node.props ?? {};
  const tag = node.type as string;
  let attrs = serializeAttributes(props, tag, ctx.resumable);
  if (tag === "form" && isServerAction(props.action) && props.method == null) {
    attrs += ` method="post"`;
  }

  // Hoist <title>/<meta>/<link> into the head collector (in HTML only).
  if (ctx.head && HOISTED_TAGS.has(tag)) {
    if (tag === "title") {
      ctx.head.title = (await renderChildrenDual(props.children, { ...ctx, head: null })).html;
    } else {
      ctx.head.tags.push(`<${tag}${attrs}>`);
    }
    return { html: "", flight: null };
  }

  const p = await serializeProps(props, ctx);

  if (VOID_ELEMENTS.has(tag)) {
    return { html: `<${tag}${attrs}>`, flight: { $: "h", t: tag, p, c: [] } };
  }

  const dangerous = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (dangerous && typeof dangerous.__html === "string") {
    warnDangerousHtml(tag);
    return {
      html: `<${tag}${attrs}>${dangerous.__html}</${tag}>`,
      flight: { $: "h", t: tag, p, c: [] },
    };
  }

  const inner = await renderChildrenDual(props.children, ctx);
  return {
    html: `<${tag}${attrs}>${inner.html}</${tag}>`,
    flight: { $: "h", t: tag, p, c: asFlightArray(inner.flight) },
  };
}

/** Normalize a children Dual's flight (always an array) for a host node's `c`. */
function asFlightArray(flight: FlightNode): FlightNode[] {
  return Array.isArray(flight) ? flight : [flight];
}

// ---- Flight-only serialization for props and client-island children --------
//
// Client islands carry their children as serialized "holes"; the reconstructed
// children are what the browser passes to the client component. We serialize
// them without also rendering HTML here (the HTML was produced when the island's
// own render consumed its children).

const SKIP = Symbol("skip");

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
  if (isComponentType(type)) {
    const ref = clientRefOf(type);
    const parentScope = ctx.ids.scope;
    const scope = enterScope(parentScope);
    ctx.ids.scope = scope;
    try {
      if (ref) {
        // A nested `client:*` island that the parent's dual render already carved
        // (wrapper + islands entry): emit a matching FOREIGN HOST — the same node
        // `islandWrapper` puts in the page Flight for a top-level island — so the
        // enclosing island's per-island `hydrateRoot` adopts the child's wrapper
        // element without reconciling into it. It hydrates on its own strategy.
        const carved = ctx.carvedNested?.get(node);
        if (carved) {
          return islandWrapper(carved.id, carved.strategy, carved.param, "").flight;
        }
        // Otherwise a client island in serialized children (an island's children
        // that its component did not itself render, or a Suspense hole): emit a plain
        // client ref, hydrated with the enclosing island's root (no separate record).
        const { rest } = parseStrategy(props, ref.moduleHydrate);
        const p = await serializeProps(rest, ctx);
        p[ID_PATH_PROP] = scopePrefix(scope);
        return {
          $: "c",
          i: ref.id,
          p,
          c: await flightOfChildren(rest.children as VNodeChildren, ctx),
        };
      }
      // A server component nested inside a hole: expand it (flight-only).
      setDispatcher(ctx.dispatcher);
      if (isClassComponent(type)) {
        if (__DENEXT_CLASS_COMPONENTS__) {
          return await flightOfChild(
            renderClassToVNode(type, props, resolveContextType(type, ctx.scopes)) as VNodeChild,
            ctx,
          );
        }
        throw classComponentsDisabledError();
      }
      const result = await invokeComponent(resolveComponentType(type), props);
      return await flightOfChild(result as VNodeChild, ctx);
    } finally {
      ctx.ids.scope = parentScope;
    }
  }
  return {
    $: "h",
    t: type as string,
    p: await serializeProps(props, ctx),
    c: await flightOfChildren(props.children, ctx),
  };
}

async function serializeProps(props: Record<string, unknown>, ctx: Ctx): Promise<FlightProps> {
  const out: FlightProps = {};
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "key" || name === "ref" || name === PROVIDER.toString()) {
      continue;
    }
    const sv = await serializeValue(value, ctx);
    if (sv !== SKIP) out[name] = sv as FlightValue;
  }
  return out;
}

async function serializeValue(value: unknown, ctx: Ctx): Promise<FlightValue | typeof SKIP> {
  // Taint check (React `taint*`): refuse to serialize a value marked as secret before it
  // can cross to the client. Two empty-map lookups when nothing is tainted. Runs first so
  // even a tainted scalar / a tainted resolved deferred value is caught.
  const tainted = taintMessageFor(value);
  if (tainted !== undefined) throw new Error(tainted);
  // Shared leaf cascade (primitives, action/qrl refs, dropped functions, Date, thenables).
  const scalar = serializeScalar(value);
  if (scalar.kind === "value") return scalar.value;
  if (scalar.kind === "skip") return SKIP;
  // A Remix `defer()` field / promise data: resolve then re-serialize (the resolved value is
  // re-taint-checked on the recursive call); a rejection becomes the error marker so `<Await>`
  // renders its `errorElement`.
  if (scalar.kind === "thenable") {
    return await serializeThenable(scalar.promise, (v) => serializeValue(v, ctx));
  }
  if (Array.isArray(value)) {
    const items: FlightValue[] = [];
    for (const el of value) {
      const sv = await serializeValue(el, ctx);
      if (sv !== SKIP) items.push(sv as FlightValue);
    }
    return items;
  }
  if (isVNode(value)) return flightOfVNode(value, ctx) as Promise<FlightValue>;
  if (typeof value === "object") {
    const obj: Record<string, FlightValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = await serializeValue(v, ctx);
      if (sv === SKIP) continue;
      // Escape a leading `$` in a user-object key. Otherwise a plain data object shaped
      // like `{ $: "h", t: "div", p: {...}, c: [] }` — e.g. a document from a store that
      // permits `$`-prefixed keys, or `searchParams` `?$=h` — would be re-read on the
      // client as a Flight control tag and forge a VNode / client component (→ XSS) or
      // crash hydration. Reversed by the parser's plain-object branch.
      obj[k.startsWith("$") ? "$" + k : k] = sv as FlightValue;
    }
    return obj;
  }
  return SKIP;
}

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/** Serialize a Flight payload to a JSON string safe to embed in a `<script>`. */
export function serializeFlight(flight: FlightNode): string {
  return JSON.stringify(flight).replace(/</g, "\\u003c");
}

/** The `actionEndpoint` re-export, so callers can build no-JS form URLs. */
export { actionEndpoint };
