// Flight client — reconstruct a VNode tree from a Flight payload.
//
// The browser receives the server-produced Flight tree (host/text nodes with
// client-component references as holes) plus a registry mapping client-reference
// ids to the actual client component functions (from the route's client bundle).
// `parseFlight` stitches them into an ordinary VNode tree that the reconciler
// hydrates exactly as it would a re-imported tree.

import { h } from "../jsx/jsx-runtime.ts";
import type { Component, VNodeChild } from "../jsx/types.ts";
import type { FlightNode, FlightProps, FlightValue } from "../jsx/render-to-flight.ts";
import { clientActionStub } from "../runtime/server-action.ts";
import { qrlStub } from "../runtime/qrl.ts";
import { decodeTagged, NOT_TAGGED } from "../runtime/wire-codec.ts";
import { ErrorBoundary } from "../runtime/error-boundary.ts";

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
      return h(node.t, parseProps(node.p, registry), ...parseChildren(node.c, registry));
    case "c": {
      const component = registry.get(node.i);
      if (!component) {
        // Unknown client reference (bundle/registry mismatch): render nothing
        // rather than crash the whole tree.
        console.warn(`denext: no client component registered for "${node.i}"`);
        return null;
      }
      return h(component, parseProps(node.p, registry), ...parseChildren(node.c, registry));
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

  const tagged = value as { $?: string };
  if (tagged.$ === "a") return clientActionStub((value as { i: string }).i);
  if (tagged.$ === "e") return qrlStub((value as { i: string }).i);
  if (tagged.$ === "h" || tagged.$ === "c") {
    // A VNode-valued prop.
    return parseFlight(value as FlightNode, registry);
  }
  // Date / bigint / URL / non-finite / Map / Set: the wire codec's tags, decoded by the same
  // switch the HTTP + Live wires use so the two decoders can't drift. Nested Map/Set entries
  // come back through `parseValue` (they may hold VNodes or action refs).
  const revived = decodeTagged(
    value as Record<string, unknown>,
    (v) => parseValue(v as FlightValue, registry),
  );
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

/** Structural guard exported for callers stitching a payload into the DOM. */
export type { FlightNode };
