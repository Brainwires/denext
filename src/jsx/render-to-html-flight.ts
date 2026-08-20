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
import {
  type Context,
  type Dispatcher,
  MEMO_CACHE_SENTINEL,
  setDispatcher,
} from "../runtime/hooks.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import {
  ERROR_BOUNDARY,
  isControlSignal,
  reportBoundaryError,
  toClientError,
} from "../runtime/error-boundary.ts";
import { actionEndpoint, isServerAction } from "../runtime/server-action.ts";
import { isQrl } from "../runtime/qrl.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import {
  FOREIGN_PROP,
  type HydrationStrategy,
  ISLAND_ID_ATTR,
  ISLAND_STRATEGY_ATTR,
  ISLAND_TAG,
  parseStrategy,
} from "../runtime/lazy-directive.ts";
import {
  escapeHtml,
  type HeadCollector,
  HOISTED_TAGS,
  type IdHolder,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
import { enterScope, ID_PATH_PROP, nextId, rootScope, scopePrefix } from "./tree-id.ts";

/** Result of a unified render: SSR HTML plus the serializable Flight tree. */
export interface HtmlFlight {
  /** The server-rendered HTML (first paint). */
  html: string;
  /** The Flight payload (client components referenced, not expanded). */
  flight: FlightNode;
  /** Lazy (`client:*`) islands carved out for deferred per-island hydration. */
  islands: IslandPayload[];
}

/** A deferred-hydration island: its tree-path id, strategy, and own Flight tree. */
export interface IslandPayload {
  /** The island's tree-path prefix (client discovery key = `data-dnx-id`). */
  id: string;
  /** When to hydrate it. */
  strategy: HydrationStrategy;
  /** The island's own Flight tree, hydrated on its wrapper when the strategy fires. */
  flight: FlightNode;
}

/** Options for {@linkcode renderToHtmlFlight}. */
export interface HtmlFlightOptions {
  /** Collector for hoisted `<title>`/`<meta>`/`<link>` (document head). */
  head?: HeadCollector;
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
}

/** A rendered node's dual output: its HTML string and its Flight node. */
interface Dual {
  html: string;
  flight: FlightNode;
}

/** Build the SSR dispatcher, reading the current id scope for `useId`. */
function makeDispatcher(scopes: ProviderScope[], ids: IdHolder): Dispatcher {
  return {
    useState<S>(initial: S | (() => S)) {
      const value = typeof initial === "function" ? (initial as () => S)() : initial;
      return [value, () => {}];
    },
    useReducer<S, A, I>(_r: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
      return [init ? init(initialArg) : (initialArg as unknown as S), () => {}];
    },
    useEffect() {},
    useMemo<T>(factory: () => T) {
      return factory();
    },
    useRef<T>(initial: T) {
      return { current: initial };
    },
    useContext<T>(context: Context<T>): T {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(context._id)) return scopes[i].get(context._id) as T;
      }
      return context._defaultValue;
    },
    useId(): string {
      return nextId(ids.scope);
    },
    useSyncExternalStore<T>(
      _s: (o: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T {
      return (getServerSnapshot ?? getSnapshot)();
    },
    useLayoutEffect() {},
    useInsertionEffect() {},
    useMemoCache(size: number): unknown[] {
      return new Array(size).fill(MEMO_CACHE_SENTINEL);
    },
  };
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
  const dispatcher = makeDispatcher(scopes, ids);
  const ctx: Ctx = { scopes, dispatcher, head: options.head ?? null, ids, islands: [] };
  const prev = setDispatcher(dispatcher);
  try {
    const dual = await renderChildDual(node as VNodeChild, ctx);
    return { html: dual.html, flight: dual.flight, islands: ctx.islands };
  } finally {
    setDispatcher(prev);
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
        const { strategy, rest } = parseStrategy(props);
        const rendered = await invokeComponent(resolveComponentType(type), rest);
        const htmlDual = await renderChildDual(rendered as VNodeChild, ctx);
        const p = await serializeProps(rest, ctx);
        const prefix = scopePrefix(scope);
        p[ID_PATH_PROP] = prefix;
        const childFlights = await flightOfChildren(rest.children as VNodeChildren, ctx);
        const islandFlight: FlightNode = { $: "c", i: ref.id, p, c: childFlights };
        if (strategy) {
          // Lazy island: nest its server HTML in a layout-neutral wrapper the page
          // root adopts but does not own (foreign host), and stash the island's own
          // Flight for a per-island hydrateRoot when the strategy fires.
          ctx.islands.push({ id: prefix, strategy, flight: islandFlight });
          return {
            html: `<${ISLAND_TAG} ${ISLAND_ID_ATTR}="${prefix}" ` +
              `${ISLAND_STRATEGY_ATTR}="${strategy}" style="display:contents">` +
              `${htmlDual.html}</${ISLAND_TAG}>`,
            flight: {
              $: "h",
              t: ISLAND_TAG,
              p: {
                [FOREIGN_PROP]: true,
                [ISLAND_ID_ATTR]: prefix,
                [ISLAND_STRATEGY_ATTR]: strategy,
                style: "display:contents",
              },
              c: [],
            },
          };
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
  let attrs = serializeAttributes(props, tag);
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
        const p = await serializeProps(props, ctx);
        p[ID_PATH_PROP] = scopePrefix(scope);
        return { $: "c", i: ref.id, p, c: await flightOfChildren(props.children, ctx) };
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
  if (value === undefined) return SKIP;
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value as FlightValue;
  if (isServerAction(value)) return { $: "a", i: value.denextActionId };
  if (isQrl(value)) return { $: "e", i: value.denextQrlId };
  if (t === "function") return SKIP;
  if (value instanceof Date) return { $: "D", v: value.toISOString() };
  if (Array.isArray(value)) {
    const items: FlightValue[] = [];
    for (const el of value) {
      const sv = await serializeValue(el, ctx);
      if (sv !== SKIP) items.push(sv as FlightValue);
    }
    return items;
  }
  if (isVNode(value)) return flightOfVNode(value, ctx) as Promise<FlightValue>;
  if (t === "object") {
    const obj: Record<string, FlightValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = await serializeValue(v, ctx);
      if (sv !== SKIP) obj[k] = sv as FlightValue;
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
