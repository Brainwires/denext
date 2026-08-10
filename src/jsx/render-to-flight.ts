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
import { CLASS_COMPONENTS_ENABLED } from "../runtime/class-flag.ts";
import { isClassComponent, renderClassToVNode } from "../compat/class-component.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY, isControlSignal, toError } from "../runtime/error-boundary.ts";
import { isServerAction } from "../runtime/server-action.ts";
import { clientRefOf } from "../runtime/client-reference.ts";

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
  | FlightDate;

/** A serialized props object (VNode-valued props are themselves Flight nodes). */
export type FlightProps = Record<string, FlightValue>;

/** Sentinel marking a prop/array entry that must be dropped (non-serializable). */
const SKIP = Symbol("skip");

interface FlightCtx {
  scopes: ProviderScope[];
  dispatcher: Dispatcher;
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
  const dispatcher = createSSRDispatcher(scopes);
  const ctx: FlightCtx = { scopes, dispatcher };
  const prev = setDispatcher(dispatcher);
  try {
    return await flightChild(node as VNodeChild, ctx);
  } finally {
    setDispatcher(prev);
  }
}

async function flightChildren(children: VNodeChildren, ctx: FlightCtx): Promise<FlightNode[]> {
  const arr = Array.isArray(children) ? children : children == null ? [] : [children];
  const out = await Promise.all(arr.map((c) => flightChild(c, ctx)));
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
  const { type, props } = node;
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

  // Suspense: resolve inline (no streaming in this pass), retrying on suspension.
  if ((type as unknown) === SUSPENSE) {
    for (;;) {
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
  }

  // Error boundary: render children; on a non-control throw, render the fallback.
  if ((type as unknown) === ERROR_BOUNDARY) {
    try {
      return await flightChildren(props.children, ctx);
    } catch (err) {
      if (isThenable(err) || isControlSignal(err)) throw err;
      const Fallback = props.fallback as (p: { error: Error; reset: () => void }) => VNode;
      setDispatcher(dispatcher);
      const fb = await Fallback({ error: toError(err), reset: () => {} });
      return flightChild(fb as VNodeChild, ctx);
    }
  }

  // Function component.
  if (typeof type === "function") {
    const ref = clientRefOf(type);
    if (ref) {
      // A `"use client"` component: emit a reference, do NOT invoke it.
      return {
        $: "c",
        i: ref.id,
        p: await serializeProps(props, ctx),
        c: await flightChildren(props.children, ctx),
      };
    }
    // A server component: invoke and expand.
    setDispatcher(dispatcher);
    if (CLASS_COMPONENTS_ENABLED && isClassComponent(type)) {
      return flightChild(renderClassToVNode(type, props, undefined) as VNodeChild, ctx);
    }
    const result = await type(props as never);
    return flightChild(result as VNodeChild, ctx);
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
  if (value === undefined) return SKIP;
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value as FlightPrimitive;

  // A server-action reference passed as a prop (e.g. to a client component or a
  // `<form action>`): carry only its id.
  if (isServerAction(value)) return { $: "a", i: value.denextActionId };

  // Functions (event handlers etc.) cannot cross the boundary — drop them. The
  // client component supplies its own handlers from its own module.
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

  // A VNode-valued prop (e.g. `icon={<Icon/>}`) is serialized as a Flight node.
  if (isVNode(value)) return flightVNode(value, ctx) as Promise<FlightValue>;

  if (t === "object") {
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
