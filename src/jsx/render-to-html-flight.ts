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
import {
  type Context,
  type Dispatcher,
  MEMO_CACHE_SENTINEL,
  setDispatcher,
} from "../runtime/hooks.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY, isControlSignal, toError } from "../runtime/error-boundary.ts";
import { actionEndpoint, isServerAction } from "../runtime/server-action.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import {
  escapeHtml,
  type HeadCollector,
  HOISTED_TAGS,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
} from "./render-to-string.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";

/** The prop under which a client island carries its `useId` base. */
export const ID_BASE_PROP = "__dnxIdBase";

/** Result of a unified render: SSR HTML plus the serializable Flight tree. */
export interface HtmlFlight {
  /** The server-rendered HTML (first paint). */
  html: string;
  /** The Flight payload (client components referenced, not expanded). */
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
  /** The shared useId counter (mutable). */
  id: { n: number };
}

/** A rendered node's dual output: its HTML string and its Flight node. */
interface Dual {
  html: string;
  flight: FlightNode;
}

/** Build the SSR dispatcher, sharing the id counter so islands can read it. */
function makeDispatcher(scopes: ProviderScope[], id: { n: number }): Dispatcher {
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
      return `:d${id.n++}:`;
    },
    useSyncExternalStore<T>(
      _s: (o: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T {
      return (getServerSnapshot ?? getSnapshot)();
    },
    useLayoutEffect() {},
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
  const id = { n: 0 };
  const dispatcher = makeDispatcher(scopes, id);
  const ctx: Ctx = { scopes, dispatcher, head: options.head ?? null, id };
  const prev = setDispatcher(dispatcher);
  try {
    const dual = await renderChildDual(node as VNodeChild, ctx);
    return { html: dual.html, flight: dual.flight };
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

  // Suspense: resolve inline (no streaming here), retrying on suspension.
  if ((type as unknown) === SUSPENSE) {
    for (;;) {
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
  }

  // Error boundary.
  if ((type as unknown) === ERROR_BOUNDARY) {
    try {
      return await renderChildrenDual(props.children, ctx);
    } catch (err) {
      if (isThenable(err) || isControlSignal(err)) throw err;
      const Fallback = props.fallback as (p: { error: Error; reset: () => void }) => VNode;
      setDispatcher(dispatcher);
      const fb = await Fallback({ error: toError(err), reset: () => {} });
      return renderChildDual(fb as VNodeChild, ctx);
    }
  }

  // Function component.
  if (typeof type === "function") {
    const ref = clientRefOf(type);
    if (ref) {
      // Client island: record the id base, render it to HTML for first paint,
      // but emit only a REFERENCE in the Flight tree.
      const base = ctx.id.n;
      setDispatcher(dispatcher);
      const rendered = await (type as (p: unknown) => VNode | Promise<VNode>)(props as never);
      const htmlDual = await renderChildDual(rendered as VNodeChild, ctx);
      const p = await serializeProps(props, ctx);
      p[ID_BASE_PROP] = base;
      const childFlights = await flightOfChildren(props.children, ctx);
      return {
        html: htmlDual.html,
        flight: { $: "c", i: ref.id, p, c: childFlights },
      };
    }
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
    const result = await type(props as never);
    return renderChildDual(result as VNodeChild, ctx);
  }

  // Intrinsic host element.
  const tag = type as string;
  let attrs = serializeAttributes(props);
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
  if (typeof type === "function") {
    const ref = clientRefOf(type);
    if (ref) {
      const base = ctx.id.n;
      const p = await serializeProps(props, ctx);
      p[ID_BASE_PROP] = base;
      return { $: "c", i: ref.id, p, c: await flightOfChildren(props.children, ctx) };
    }
    // A server component nested inside a hole: expand it (flight-only).
    setDispatcher(ctx.dispatcher);
    if (isClassComponent(type)) {
      if (__DENEXT_CLASS_COMPONENTS__) {
        return flightOfChild(
          renderClassToVNode(type, props, resolveContextType(type, ctx.scopes)) as VNodeChild,
          ctx,
        );
      }
      throw classComponentsDisabledError();
    }
    const result = await type(props as never);
    return flightOfChild(result as VNodeChild, ctx);
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
