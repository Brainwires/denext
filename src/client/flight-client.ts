// Flight client — reconstruct a VNode tree from a Flight payload.
//
// The browser receives the server-produced Flight tree (host/text nodes with
// client-component references as holes) plus a registry mapping client-reference
// ids to the actual client component functions (from the route's client bundle).
// `parseFlight` stitches them into an ordinary VNode tree that the reconciler
// hydrates exactly as it would a re-imported tree.

import { h } from "../jsx/jsx-runtime.ts";
import type { Component, VNode, VNodeChild } from "../jsx/types.ts";
import type { FlightNode, FlightProps, FlightValue } from "../jsx/render-to-flight.ts";
import { clientActionStub } from "../runtime/server-action.ts";

/** Maps client-reference ids (`clientId#export`) to client component functions. */
export type ClientRegistry = Map<string, Component>;

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
    case "a":
      // A bare action reference as a node has no visual output.
      return null;
  }
}

/** Parse a Flight children array into VNode children (drops nulls implicitly). */
function parseChildren(children: FlightNode[], registry: ClientRegistry): VNodeChild[] {
  return children.map((c) => parseFlight(c, registry));
}

/** Parse a serialized props object back into a live props object. */
function parseProps(props: FlightProps, registry: ClientRegistry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
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
  if (tagged.$ === "D") return new Date((value as { v: string }).v);
  if (tagged.$ === "h" || tagged.$ === "c") {
    // A VNode-valued prop.
    return parseFlight(value as FlightNode, registry);
  }

  // A plain object.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, FlightValue>)) {
    out[k] = parseValue(v, registry);
  }
  return out;
}

/** Structural guard exported for callers stitching a payload into the DOM. */
export type { FlightNode, VNode };
