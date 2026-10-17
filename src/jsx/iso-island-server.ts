// The server half of per-island hydration on the isomorphic (non-Flight) path (the client half is
// src/client/iso-island.ts). A component element with a `client:*` directive renders through
// `IsoIslandServer`: one component level around the island wrapper
// (`<div data-dnx-island data-dnx-strategy style="display:contents">`) holding the component, the
// directive stripped. The client renders the same shape, so the page hydrates around the island
// (adopting the wrapper, leaving its children) and `useId` agrees on both sides. `client:only`
// renders the wrapper empty. Only the HTML renderers of non-Flight routes use it: a Flight route
// carves its islands at the client boundary (island-wrapper.ts).

import { h } from "./jsx-runtime.ts";
import type { VNode } from "./types.ts";
import { isoIslandProps, parseStrategy } from "../runtime/lazy-directive.ts";
import { brandOf, REACT_LAZY_TYPE } from "../runtime/react-brands.ts";
import { isClassComponent } from "../compat/class-detect.ts";

/** What {@link IsoIslandServer} renders: the component and its props (directive included). */
interface IsoIslandServerProps {
  c: unknown;
  p: Record<string, unknown>;
}

/** The island wrapper around the component, the directive stripped (see the module comment). */
export function IsoIslandServer({ c, p }: IsoIslandServerProps): VNode {
  const { strategy, param, rest } = parseStrategy(p);
  return h(
    "div",
    isoIslandProps(strategy!, param),
    strategy === "only" ? null : h(c as never, rest),
  );
}

/**
 * The {@link IsoIslandServer} props for a component element whose props carry a `client:*`
 * directive, else null (the element renders as itself).
 */
export function isoIsland(
  type: unknown,
  props: Record<string, unknown>,
): IsoIslandServerProps | null {
  for (const k in props) {
    if (k.startsWith("client:")) {
      return parseStrategy(props).strategy === null || !islandType(type)
        ? null
        : { c: type, p: props };
    }
  }
  return null;
}

/**
 * A component the client renders as an island: a function, `memo` or `forwardRef` (a class or
 * a lazy component renders eagerly, the directive a plain prop, on both sides).
 */
export function islandType(type: unknown): boolean {
  return !isClassComponent(type) && brandOf(type) !== REACT_LAZY_TYPE;
}
