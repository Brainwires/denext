// Render phase, part 2: completeWork creates or updates the host DOM for a finished
// fiber and bubbles its flags and lanes.

import { bubbleLanes, hostNamespace } from "./fiber-utils.ts";
import { claimText, isHydrating, popHydrationCursor } from "./hydration.ts";
import { onErrorFor } from "./boundaries.ts";

import { applyProps, initSelect } from "../dom-props.ts";
import { stampFiber } from "../dom-fiber-map.ts";
import { FOREIGN_PROP } from "../../runtime/lazy-directive.ts";
import { documentForFiber } from "./state.ts";
import { getSingletonSupport } from "./singleton-support.ts";
import {
  BailedBit,
  bubbleFlags,
  childrenDom,
  type Fiber,
  Placement,
  RefAttach,
  Snapshot,
  syncChildren,
  Update,
} from "./fiber.ts";

/**
 * Create the DOM node for a fresh host fiber. SVG/MathML elements must be created in
 * their own namespace (createElementNS) — a plain createElement puts `<svg>`/`<path>`/…
 * in the HTML namespace, where they occupy layout space but draw nothing (the classic
 * "icon takes up room but is invisible"). The namespace is inherited down the subtree
 * until a `<foreignObject>` switches back to HTML.
 */
function createHostInstance(wip: Fiber): Element {
  const hType = wip.vnode.type as string;
  const ns = hostNamespace(wip, hType);
  const doc = documentForFiber(wip);
  return ns !== null ? doc.createElementNS(ns, hType) : doc.createElement(hType);
}

/**
 * Whether a host's props differ in anything but `children` (reconciled separately). Shallow
 * identity, like applyProps' own per-prop `oldValue === value` guard — so a `false` here
 * means applyProps would change nothing (it would only re-register identical listeners).
 */
function hostPropsChanged(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  if (prev === next) return false;
  if (prev == null || next == null) return true;
  // `children` counts on both sides: only its presence changing (rare) reads as a change,
  // which costs one no-op applyProps.
  let count = 0;
  for (const k in next) {
    if (k !== "children" && (next[k] !== prev[k] || !(k in prev))) return true;
    count++;
  }
  for (const _ in prev) count--;
  return count !== 0;
}

/**
 * Complete a host update, shared with the singleton runtime: true when `wip` is one (it has
 * an alternate). The listener map is created by the first handler (dom-props) and shared by
 * both buffers. applyProps + re-sync are deferred to the commit (mutation) phase — only when
 * a prop other than `children` changed (React's prepareUpdate diff). applyProps over equal
 * props is a no-op, so a re-rendered list of unchanged rows commits no work.
 */
export function completeHostUpdate(wip: Fiber): boolean {
  if (!wip.listeners) wip.listeners = wip.alternate?.listeners;
  if (wip.alternate === null) return false;
  if (hostPropsChanged(wip.alternate.vnode.props, wip.vnode.props)) wip.flags |= Update;
  return true;
}

function completeHost(wip: Fiber): void {
  if (isHydrating) popHydrationCursor();
  if (completeHostUpdate(wip)) return;
  // Fresh mount (or a hydration-adopted node): build off-DOM. Apply every prop EXCEPT the ref
  // — a ref callback must fire at commit (after the node is placed), never during this render
  // phase — and flag the fiber so the commit attaches it (see `RefAttach`).
  const fresh = wip.stateNode == null;
  if (fresh) wip.stateNode = createHostInstance(wip);
  const props = wip.vnode.props ?? {};
  applyProps(wip.stateNode as Element, wip, {}, props, onErrorFor(wip), false);
  if (props.ref != null) wip.flags |= RefAttach;
  // A foreign host (a lazy island's wrapper) is adopted but its subtree is left
  // untouched, so a separate per-island hydrateRoot can own that DOM.
  if (wip.vnode.props?.[FOREIGN_PROP] !== true) {
    syncChildren(wip.stateNode as Element, childrenDom(wip));
  }
  // A new `<select>` picks its option once the options are in it (hydration keeps the
  // server's — or the user's — selection).
  if (fresh && wip.vnode.type === "select") initSelect(wip.stateNode as Element, props);
  // Index node → fiber for event dispatch (events.ts). A fresh node is only reachable once this
  // render commits; an update re-records at its commit (commitMutation), never at render, so an
  // abandoned render's handlers never run.
  stampFiber(wip.stateNode, wip);
  wip.flags |= Placement;
}

function completeText(wip: Fiber): void {
  if (wip.alternate !== null) {
    // Same text as last render: nothing to do, without reading the DOM (React compares
    // the old and new text the same way). Otherwise compare against the live node.
    if (wip.alternate.vnode.props.nodeValue === wip.vnode.props.nodeValue) return;
    const value = String(wip.vnode.props.nodeValue ?? "");
    if ((wip.stateNode as Text).nodeValue !== value) wip.flags |= Update;
  } else if (isHydrating) {
    claimText(wip);
  } else {
    wip.stateNode = documentForFiber(wip).createTextNode(String(wip.vnode.props.nodeValue ?? ""));
    wip.flags |= Placement;
  }
}

function completeComponent(wip: Fiber): void {
  // getSnapshotBeforeUpdate runs before a class update's DOM mutation — but
  // not when shouldComponentUpdate/PureComponent bailed this render.
  if (
    __DENEXT_CLASS_COMPONENTS__ && wip.ext?.classInstance && wip.alternate &&
    (wip.bits & BailedBit) === 0
  ) {
    wip.flags |= Snapshot;
  }
}

export function completeWork(wip: Fiber): void {
  switch (wip.tag) {
    case "host":
      completeHost(wip);
      break;
    case "singleton": // an adopted document tag (singleton-support.ts)
      getSingletonSupport()!.complete(wip);
      break;
    case "text":
      completeText(wip);
      break;
    case "component":
      completeComponent(wip);
      break;
      // root / fragment / portal / suspense / errorboundary: no own DOM.
  }
  bubbleFlags(wip);
  bubbleLanes(wip);
}
