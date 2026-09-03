// Render phase, part 2: completeWork creates or updates the host DOM for a finished
// fiber and bubbles its flags and lanes.

import { bubbleLanes, hostNamespace } from "./fiber-utils.ts";
import { claimText, isHydrating, popHydrationCursor } from "./hydration.ts";
import { onErrorFor } from "./boundaries.ts";

import { applyProps } from "../dom-props.ts";
import { stampFiber } from "../dom-fiber-map.ts";
import { FOREIGN_PROP } from "../../runtime/lazy-directive.ts";
import { doc } from "./state.ts";
import {
  bubbleFlags,
  childrenDom,
  type Fiber,
  Placement,
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
  return ns !== null ? doc.createElementNS(ns, hType) : doc.createElement(hType);
}

function completeHost(wip: Fiber): void {
  if (isHydrating) popHydrationCursor();
  if (!wip.listeners) wip.listeners = wip.alternate?.listeners ?? new Map();
  if (wip.alternate !== null) {
    // Update: applyProps + re-sync deferred to the commit (mutation) phase.
    stampFiber(wip.stateNode, wip); // keep the reverse map on the live buffer
    wip.flags |= Update;
    return;
  }
  // Fresh mount (or a hydration-adopted node): build off-DOM.
  if (wip.stateNode == null) wip.stateNode = createHostInstance(wip);
  applyProps(wip.stateNode as Element, wip, {}, wip.vnode.props ?? {}, onErrorFor(wip));
  // A foreign host (a lazy island's wrapper) is adopted but its subtree is left
  // untouched, so a separate per-island hydrateRoot can own that DOM.
  if (wip.vnode.props?.[FOREIGN_PROP] !== true) {
    syncChildren(wip.stateNode as Element, childrenDom(wip));
  }
  stampFiber(wip.stateNode, wip); // index node → fiber for delegated dispatch
  wip.flags |= Placement;
}

function completeText(wip: Fiber): void {
  if (wip.alternate !== null) {
    const value = String(wip.vnode.props.nodeValue ?? "");
    if ((wip.stateNode as Text).nodeValue !== value) wip.flags |= Update;
  } else if (isHydrating) {
    claimText(wip);
  } else {
    wip.stateNode = doc.createTextNode(String(wip.vnode.props.nodeValue ?? ""));
    wip.flags |= Placement;
  }
}

function completeComponent(wip: Fiber): void {
  // getSnapshotBeforeUpdate runs before a class update's DOM mutation — but
  // not when shouldComponentUpdate/PureComponent bailed this render.
  if (__DENEXT_CLASS_COMPONENTS__ && wip.classInstance && wip.alternate && !wip.bailed) {
    wip.flags |= Snapshot;
  }
}

export function completeWork(wip: Fiber): void {
  switch (wip.tag) {
    case "host":
      completeHost(wip);
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
