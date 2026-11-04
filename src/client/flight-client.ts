// Flight client — reconstruct a VNode tree from a Flight payload.
//
// The browser receives the server-produced Flight tree (host/text nodes with
// client-component references as holes) plus a registry mapping client-reference
// ids to the actual client component functions (from the route's client bundle).
// `parseFlight` stitches them into an ordinary VNode tree that the reconciler
// hydrates exactly as it would a re-imported tree.

import { h } from "../jsx/jsx-runtime.ts";
import type { Component, VNodeChild } from "../jsx/types.ts";
import type {
  FlightClient,
  FlightHost,
  FlightNode,
  FlightProps,
  FlightValue,
} from "../jsx/render-to-flight.ts";
import { actionReference, actionRefreshHandler } from "../runtime/server-action.ts";
import { qrlStub } from "../runtime/qrl.ts";
import { decodeTagged, decodeWire, NOT_TAGGED } from "../runtime/wire-codec.ts";
import { reviveSignal } from "../runtime/signal-brand.ts";
import { ErrorBoundary } from "../runtime/error-boundary.ts";

/** The `denext/action-call` module: a Server Action call with the dispatch and wire encoder. */
export interface ActionCallModule {
  /**
   * Call the Server Action `id` with `args`.
   *
   * @param id The action id.
   * @param args The call's arguments.
   * @param refresh Re-renders the current route after an action that revalidated or refreshed.
   * @param decode The wire decoder, for a codec-encoded result.
   * @returns The action's result.
   */
  callAction(
    id: string,
    args: unknown[],
    refresh: (() => void) | null,
    decode: (value: unknown) => unknown,
  ): Promise<unknown>;
}

/**
 * Loads `denext/action-call`, registered by the generated Flight entry
 * ({@linkcode setActionCallLoader}). The `import()` lives in the entry, not here: client-runtime
 * re-exports this module, so every app's graph reaches it, and an `import()` here would make the
 * call chunk an entry of every app — where its wire encoder, a file the `denext` barrel reaches,
 * would be hoisted into the startup chunks.
 */
let actionCallLoader: (() => Promise<ActionCallModule>) | null = null;

/**
 * Register how a Flight page loads its Server Action calls (the generated Flight entry passes
 * `() => import("denext/action-call")`).
 *
 * @param load Imports the action-call module.
 */
export function setActionCallLoader(load: () => Promise<ActionCallModule>): void {
  actionCallLoader = load;
}

/** The action-call module, loading it on first use. */
function loadActionCall(): Promise<ActionCallModule> {
  if (actionCallLoader === null) {
    return Promise.reject(new Error("denext: no Server Action loader is installed"));
  }
  return actionCallLoader();
}

/** One Server Action call from a Flight-revived reference. */
function callFlightAction(id: string, args: unknown[]): Promise<unknown> {
  return loadActionCall().then((m) => m.callAction(id, args, actionRefreshHandler(), decodeWire));
}

/**
 * A Server Action reference revived from a Flight payload (`{$:"a"}`). The first one a page
 * creates starts loading the action-call chunk, so the call itself does not wait on it; a page
 * with no action never loads it.
 */
function flightActionReference(id: string): unknown {
  void loadActionCall().catch(() => {}); // warm; a call reports a missing loader itself
  return actionReference(id, callFlightAction);
}

/** Maps client-reference ids (`clientId#export`) to client component functions. */
export type ClientRegistry = Map<string, Component> & {
  /**
   * Load (and register) the island modules a Flight payload references — the generated Flight
   * entry installs this. Islands are code-split and imported on demand, so a page ships only
   * its own islands' chunks; every consumer of a payload awaits this before `parseFlight`.
   */
  ensure?: (flight: unknown) => Promise<void>;
};

/**
 * The client ids (`c_<hash>`, the part before `#`) every client reference in a Flight payload
 * names — walked generically, so references nested in props (serialized vnodes) count too.
 */
export function flightClientIds(flight: unknown, out: Set<string> = new Set()): Set<string> {
  if (flight === null || typeof flight !== "object") return out;
  if (Array.isArray(flight)) {
    for (const item of flight) flightClientIds(item, out);
    return out;
  }
  const node = flight as Record<string, unknown>;
  const id = node.$ === "c" ? node.i : node.$ === "b" ? node.f : undefined;
  if (typeof id === "string") out.add(id.split("#")[0]);
  for (const key of Object.keys(node)) flightClientIds(node[key], out);
  return out;
}

/** Await the registry's island loader for `flight` (a no-op registry without one). */
export function ensureFlightModules(registry: ClientRegistry, flight: unknown): Promise<void> {
  return registry.ensure ? registry.ensure(flight) : Promise.resolve();
}

/**
 * Reconstruct a VNode tree from a {@linkcode FlightNode} payload, resolving
 * client-component references through `registry`.
 *
 * @param node The Flight payload (typically the parsed `#__denext_flight` island).
 * @param registry Client-reference id → component function.
 * @returns A renderable VNode child.
 */
export function parseFlight(node: FlightNode, registry: ClientRegistry): VNodeChild {
  if (node === null || typeof node === "string" || typeof node === "number") {
    return node;
  }
  if (typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    // A fragment: wrap the parsed children in a keyless fragment via h + Fragment
    // is unnecessary — the reconciler accepts an array child, so return it.
    return node.map((c) => parseFlight(c, registry)) as unknown as VNodeChild;
  }

  switch (node.$) {
    case "h":
      return h(node.t, keyedProps(node, registry), ...parseChildren(node.c, registry));
    case "c": {
      const component = registry.get(node.i);
      if (!component) {
        // Unknown client reference (bundle/registry mismatch): render nothing
        // rather than crash the whole tree.
        console.warn(`denext: no client component registered for "${node.i}"`);
        return null;
      }
      return h(component, keyedProps(node, registry), ...parseChildren(node.c, registry));
    }
    case "b": {
      // A segment's client `error.tsx` around its children: a real boundary on the client,
      // so a render throw after hydration swaps in the fallback (Next.js semantics). With
      // no registered fallback (bundle/registry mismatch) the boundary is transparent.
      const fallback = registry.get(node.f);
      const children = parseChildren(node.c, registry);
      if (!fallback) return children as unknown as VNodeChild;
      return h(ErrorBoundary, { fallback: fallback as never }, ...children);
    }
    case "a":
      // A bare action reference as a node has no visual output.
      return null;
  }
}

/** A host / client node's props, with its `key` (`k`) so a patched list reconciles by key. */
function keyedProps(node: FlightHost | FlightClient, registry: ClientRegistry) {
  const props = parseProps(node.p, registry);
  if (node.k !== undefined) props.key = node.k;
  return props;
}

/** Parse a Flight children array into VNode children (drops nulls implicitly). */
function parseChildren(children: FlightNode[], registry: ClientRegistry): VNodeChild[] {
  return children.map((c) => parseFlight(c, registry));
}

// Keys that would corrupt an object's prototype if assigned via `out[k] = …`
// (JSON.parse produces real own "__proto__" props whose assignment hits the
// inherited setter). Skipped when rebuilding objects from a Flight payload.
function isUnsafeKey(k: string): boolean {
  return k === "__proto__" || k === "constructor" || k === "prototype";
}

/** Parse a serialized props object back into a live props object. */
function parseProps(props: FlightProps, registry: ClientRegistry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Defensive: a malformed node may carry a non-object `p` (e.g. null); treat it
  // as empty props rather than throwing on Object.entries.
  if (props === null || typeof props !== "object") return out;
  for (const [name, value] of Object.entries(props)) {
    if (isUnsafeKey(name)) continue;
    out[name] = parseValue(value, registry);
  }
  return out;
}

/** Parse a single serialized prop value. */
function parseValue(value: FlightValue, registry: ClientRegistry): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => parseValue(v, registry));
  const revived = parseTagged(value as Record<string, unknown>, registry);
  if (revived !== NOT_TAGGED) return revived;

  // A plain object. Reverse the serializer's `$`-key escaping (a leading `$` was
  // doubled) so a user object with a `$`-prefixed key round-trips as DATA and can never
  // be re-interpreted as a control tag. An un-escaped `$`-object (i.e. one this branch
  // reached at all) is therefore always untrusted data, never a forged VNode.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, FlightValue>)) {
    const key = k.startsWith("$") ? k.slice(1) : k;
    if (isUnsafeKey(k) || isUnsafeKey(key)) continue;
    out[key] = parseValue(v, registry);
  }
  return out;
}

/** A tagged value revived (an action, qrl, channel, element, the wire codec's tags), else NOT_TAGGED. */
function parseTagged(value: Record<string, unknown>, registry: ClientRegistry): unknown {
  // A streamed navigation's deferred value: its promise (flight-nav-stream.ts), kept as is.
  if (typeof value.then === "function") return value;
  const tag = value.$;
  if (tag === "a") return flightActionReference(value.i as string);
  if (tag === "e") return qrlStub(value.i as string);
  if (tag === "ch") return { denextChannelId: value.i as string };
  // A signal prop (Flight only — never on the HTTP / Live wires, whose payloads a client sends).
  if (tag === "sg") return reviveSignal(parseValue(value.v as FlightValue, registry), value.i);
  // A VNode-valued prop.
  if (tag === "h" || tag === "c") return parseFlight(value as unknown as FlightNode, registry);
  // Date / bigint / URL / non-finite / Map / Set: the wire codec's tags, decoded by the same
  // switch the HTTP + Live wires use so the two decoders can't drift. Nested Map/Set entries
  // come back through `parseValue` (they may hold VNodes or action refs).
  return decodeTagged(value, (v) => parseValue(v as FlightValue, registry));
}

/** Structural guard exported for callers stitching a payload into the DOM. */
export type { FlightNode };
