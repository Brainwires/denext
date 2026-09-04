/// <reference path="../globals.d.ts" />
// Flight rendering: turn a VNode tree into a serializable "Flight" payload.
//
// Unlike `renderToString` (which emits HTML), this emits a JSON-friendly tree in
// which server components are fully expanded to host/text/client-reference nodes
// and CLIENT components appear as *references* (an id + serialized props +
// children) WITHOUT being invoked. That is what keeps server-component code off
// the client: only referenced `"use client"` modules ship to the browser, and
// the browser stitches them into the server-produced tree via `parseFlight`.

import { FRAGMENT, type VNode, type VNodeChild, type VNodeChildren } from "./types.ts";
import { type Dispatcher, setDispatcher } from "../runtime/hooks.ts";
import { createSSRDispatcher, type ProviderScope } from "./render-to-string.ts";
import { isComponentType } from "../runtime/react-brands.ts";
import { SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY } from "../runtime/error-boundary.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import { rootScope, scopePrefix } from "./tree-id.ts";
import {
  flightClientRef,
  flightHost,
  invokeServerComponent,
  providerScopeOf,
  pushScope,
  renderErrorBoundaryWith,
  resolveInBoundaryScope,
  type Serialized,
  serializeFlightProps,
  serializeFlightValue,
} from "./render-shared.ts";
import type { IdHolder } from "./render-to-string.ts";

/** A JSON primitive leaf in a Flight tree. */
export type FlightPrimitive = string | number | boolean | null;

/** A serialized server-action reference (as a node or a prop value). */
export interface FlightActionRef {
  /** Discriminant: server-action reference. */
  $: "a";
  /** The action's stable id. */
  i: string;
}

/** A serialized `Date` value. */
export interface FlightDate {
  /** Discriminant: Date. */
  $: "D";
  /** ISO-8601 timestamp. */
  v: string;
}

/** A serialized lazily-loaded event handler ({@link Qrl}) reference. */
export interface FlightEventHandler {
  /** Discriminant: event-handler (qrl) reference. */
  $: "e";
  /** The handler's stable id. */
  i: string;
}

/** A serialized host (intrinsic) element. */
export interface FlightHost {
  /** Discriminant: host element. */
  $: "h";
  /** Tag name. */
  t: string;
  /** Serialized props (no children). */
  p: FlightProps;
  /** Serialized children. */
  c: FlightNode[];
}

/** A serialized client-component reference. */
export interface FlightClient {
  /** Discriminant: client-component reference. */
  $: "c";
  /** Client-reference id (`clientId#export`). */
  i: string;
  /** Serialized props (no children). */
  p: FlightProps;
  /** Serialized children ("holes" filled with server-rendered content). */
  c: FlightNode[];
}

/** A node in a Flight tree. */
export type FlightNode =
  | FlightPrimitive
  | FlightNode[]
  | FlightHost
  | FlightClient
  | FlightActionRef;

/** A serialized prop value. */
export type FlightValue =
  | FlightPrimitive
  | FlightValue[]
  | { [key: string]: FlightValue }
  | FlightNode
  | FlightActionRef
  | FlightDate
  | FlightEventHandler;

/** A serialized props object (VNode-valued props are themselves Flight nodes). */
export type FlightProps = Record<string, FlightValue>;

interface FlightCtx {
  scopes: ProviderScope[];
  dispatcher: Dispatcher;
  /** The current id scope (shared with the dispatcher's `useId`). */
  ids: IdHolder;
}

/**
 * Render a VNode (or renderable child) to a {@linkcode FlightNode} tree.
 * Client components are emitted as references and never invoked here.
 *
 * @param node The root to render.
 * @returns The serializable Flight tree.
 */
export async function renderToFlight(node: VNodeChildren): Promise<FlightNode> {
  const scopes: ProviderScope[] = [];
  const ids: IdHolder = { scope: rootScope() };
  const dispatcher = createSSRDispatcher(scopes, ids);
  const ctx: FlightCtx = { scopes, dispatcher, ids };
  const prev = setDispatcher(dispatcher);
  try {
    return await flightChild(node as VNodeChild, ctx);
  } finally {
    setDispatcher(prev);
  }
}

// Children render **sequentially** (not Promise.all): each component consumes its
// slot in depth-first order, so its path-based useId matches the client's DFS. This
// matches renderToString, which already awaits siblings in order.
async function flightChildren(children: VNodeChildren, ctx: FlightCtx): Promise<FlightNode[]> {
  const arr = Array.isArray(children) ? children : children == null ? [] : [children];
  const out: FlightNode[] = [];
  for (const c of arr) out.push(await flightChild(c, ctx));
  return out;
}

function flightChild(child: VNodeChild, ctx: FlightCtx): FlightNode | Promise<FlightNode> {
  if (child == null || child === false || child === true) return null;
  if (typeof child === "string") return child;
  if (typeof child === "number") return child;
  if (Array.isArray(child)) return flightChildren(child, ctx);
  return flightVNode(child as VNode, ctx);
}

async function flightVNode(node: VNode, ctx: FlightCtx): Promise<FlightNode> {
  const { type } = node;
  // Null `props` (some npm libs) is treated as {} — parity with render-to-string.
  const props = node.props ?? {};
  // Fragment (and context providers, which are transparent in Flight — server context does
  // not cross into client islands, mirroring React).
  if (type === FRAGMENT) return flightFragment(props, ctx);
  // Suspense: its own id scope (one slot in its parent; content rooted at its position),
  // resolved inline here, retrying on suspension.
  if ((type as unknown) === SUSPENSE) {
    return resolveInBoundaryScope(ctx.ids, () => flightChildren(props.children, ctx));
  }
  if ((type as unknown) === ERROR_BOUNDARY) return flightErrorBoundary(props, ctx);
  if (isComponentType(type)) return flightComponent(type, props, ctx);
  // Intrinsic host element.
  const p = await serializeProps(props, ctx);
  return flightHost(type as string, p, await flightChildren(props.children, ctx));
}

/** A fragment, or a context provider whose scope wraps its children. */
async function flightFragment(
  props: Record<string, unknown>,
  ctx: FlightCtx,
): Promise<FlightNode> {
  const scope = providerScopeOf(props);
  if (!scope) return flightChildren(props.children as VNodeChildren, ctx);
  ctx.scopes.push(scope);
  try {
    return await flightChildren(props.children as VNodeChildren, ctx);
  } finally {
    ctx.scopes.pop();
  }
}

/** Error boundary (see {@link renderErrorBoundaryWith}). */
function flightErrorBoundary(props: Record<string, unknown>, ctx: FlightCtx): Promise<FlightNode> {
  return renderErrorBoundaryWith(props, ctx.ids, {
    render: (children) => flightChildren(children, ctx),
    renderFallback: (child) => flightChild(child, ctx),
    activate: () => setDispatcher(ctx.dispatcher),
  });
}

/**
 * Function component (or a memo/forwardRef object wrapper). Each opens a fresh id scope,
 * consuming a slot in its parent's scope, so ids derive from tree position. A `"use client"`
 * component is NOT invoked: it emits a reference tagged with its path prefix (so the island
 * seeds the same scope on the client), and its props/children render in the island's scope.
 * A server component is invoked and expanded.
 */
async function flightComponent(
  type: unknown,
  props: Record<string, unknown>,
  ctx: FlightCtx,
): Promise<FlightNode> {
  const { parent, scope } = pushScope(ctx.ids);
  try {
    const ref = clientRefOf(type);
    if (ref) {
      const p = await serializeProps(props, ctx);
      const children = await flightChildren(props.children as VNodeChildren, ctx);
      return flightClientRef(ref.id, p, scopePrefix(scope), children);
    }
    setDispatcher(ctx.dispatcher);
    return await flightChild(await invokeServerComponent(type, props, ctx.scopes), ctx);
  } finally {
    ctx.ids.scope = parent;
  }
}

function serializeProps(props: Record<string, unknown>, ctx: FlightCtx): Promise<FlightProps> {
  return serializeFlightProps(props, (v) => serializeValue(v, ctx));
}

/**
 * Leaf cases (primitives, action/qrl refs, dropped functions, Date, thenables) are shared
 * across every Flight serializer; a VNode-valued prop (`icon={<Icon/>}`) is a Flight node.
 */
function serializeValue(value: unknown, ctx: FlightCtx): Promise<Serialized> {
  return serializeFlightValue(value, {
    value: (v) => serializeValue(v, ctx),
    vnode: (n) => flightVNode(n, ctx) as Promise<FlightValue>,
  });
}
