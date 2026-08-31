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
import { createSSRDispatcher, type ProviderScope, resolveContextType } from "./render-to-string.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import {
  ERROR_BOUNDARY,
  isControlSignal,
  reportBoundaryError,
  toClientError,
} from "../runtime/error-boundary.ts";
import { deferErrorMarker, serializeScalar } from "./flight-scalar.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import { enterScope, ID_PATH_PROP, rootScope, scopePrefix } from "./tree-id.ts";
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

/** Sentinel marking a prop/array entry that must be dropped (non-serializable). */
const SKIP = Symbol("skip");

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
  const { scopes, dispatcher } = ctx;

  // Fragment (and context providers, which are transparent in Flight — server
  // context does not cross into client islands, mirroring React).
  if (type === FRAGMENT) {
    const providerInfo = props[PROVIDER as unknown as string] as
      | { id: symbol; value: unknown }
      | undefined;
    if (providerInfo) {
      const scope: ProviderScope = new Map();
      scope.set(providerInfo.id, providerInfo.value);
      scopes.push(scope);
      try {
        return await flightChildren(props.children, ctx);
      } finally {
        scopes.pop();
      }
    }
    return flightChildren(props.children, ctx);
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
          return await flightChildren(props.children, ctx);
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

  // Error boundary: render children; on a non-control throw, render the fallback
  // (from the pre-children scope state, so its ids line up with the client's).
  if ((type as unknown) === ERROR_BOUNDARY) {
    const idScope = ctx.ids.scope;
    const savedCount = idScope.count;
    const savedLocal = idScope.local;
    try {
      return await flightChildren(props.children, ctx);
    } catch (err) {
      if (isThenable(err) || isControlSignal(err)) throw err;
      ctx.ids.scope = idScope;
      idScope.count = savedCount;
      idScope.local = savedLocal;
      const Fallback = props.fallback as (p: { error: Error; reset: () => void }) => VNode;
      setDispatcher(dispatcher);
      reportBoundaryError(props, err);
      const fb = await Fallback({ error: toClientError(err), reset: () => {} });
      return flightChild(fb as VNodeChild, ctx);
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
        // A `"use client"` component: emit a reference, do NOT invoke it. It still
        // occupies a slot; tag it with its path prefix so the island seeds the same
        // scope on the client. Its props/children render in the island's scope.
        const p = await serializeProps(props, ctx);
        p[ID_PATH_PROP] = scopePrefix(scope);
        return { $: "c", i: ref.id, p, c: await flightChildren(props.children, ctx) };
      }
      // A server component: invoke and expand.
      setDispatcher(dispatcher);
      if (isClassComponent(type)) {
        if (__DENEXT_CLASS_COMPONENTS__) {
          return await flightChild(
            renderClassToVNode(type, props, resolveContextType(type, scopes)) as VNodeChild,
            ctx,
          );
        }
        throw classComponentsDisabledError();
      }
      const result = await invokeComponent(resolveComponentType(type), props);
      return await flightChild(result as VNodeChild, ctx);
    } finally {
      ctx.ids.scope = parentScope;
    }
  }

  // Intrinsic host element.
  return {
    $: "h",
    t: type as string,
    p: await serializeProps(props, ctx),
    c: await flightChildren(props.children, ctx),
  };
}

async function serializeProps(
  props: Record<string, unknown>,
  ctx: FlightCtx,
): Promise<FlightProps> {
  const out: FlightProps = {};
  for (const [name, value] of Object.entries(props)) {
    if (
      name === "children" || name === "key" || name === "ref" ||
      name === PROVIDER.toString()
    ) continue;
    const sv = await serializeValue(value, ctx);
    if (sv !== SKIP) out[name] = sv as FlightValue;
  }
  return out;
}

async function serializeValue(
  value: unknown,
  ctx: FlightCtx,
): Promise<FlightValue | typeof SKIP> {
  // Leaf cases (primitives, action/qrl refs, dropped functions, Date, thenables)
  // are shared across every Flight serializer; only array/VNode/object differ here.
  const scalar = serializeScalar(value);
  if (scalar.kind === "value") return scalar.value;
  if (scalar.kind === "skip") return SKIP;
  // A Remix `defer()` field / promise prop: resolve it and serialize the result so
  // deferred data crosses the boundary (awaited, not streamed as a placeholder). A
  // rejection serializes to the error marker so `<Await>` renders its `errorElement`.
  if (scalar.kind === "thenable") {
    try {
      return await serializeValue(await scalar.promise, ctx);
    } catch (err) {
      return await serializeValue(deferErrorMarker(err), ctx);
    }
  }

  if (Array.isArray(value)) {
    const items: FlightValue[] = [];
    for (const el of value) {
      const sv = await serializeValue(el, ctx);
      if (sv !== SKIP) items.push(sv as FlightValue);
    }
    return items;
  }

  // A VNode-valued prop (e.g. `icon={<Icon/>}`) is serialized as a Flight node.
  if (isVNode(value)) return flightVNode(value, ctx) as Promise<FlightValue>;

  if (typeof value === "object") {
    const obj: Record<string, FlightValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = await serializeValue(v, ctx);
      if (sv !== SKIP) obj[k] = sv as FlightValue;
    }
    return obj;
  }

  // Symbols, bigints, etc. — not serializable.
  return SKIP;
}

/** Structural check for a VNode (has a `type` and `props`). */
function isVNode(value: unknown): value is VNode {
  return (
    typeof value === "object" && value !== null &&
    "type" in value && "props" in value
  );
}
