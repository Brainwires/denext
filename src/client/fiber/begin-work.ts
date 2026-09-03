// Render phase, part 1: beginWork dispatches on the fiber tag to a per-tag handler
// that renders / reconciles the fiber's children.

import {
  devHydrationActive,
  isClassBoundary,
  isPlainUnkeyedFragment,
  suspenseListDisplay,
} from "./fiber-utils.ts";
import { claimHost, isHydrating } from "./hydration.ts";
import { resetBoundary } from "./boundaries.ts";
import { renderComponent } from "./render-component.ts";
import { cloneChildFibers, reconcileChildren } from "./reconcile-children.ts";
import { propagateContextChange } from "./context-propagation.ts";

import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { enterScope, rootScope } from "../../jsx/tree-id.ts";
import { SUSPENSE_LIST_PROP } from "../../runtime/suspense.ts";
import { PROVIDER } from "../../runtime/context.ts";
import { createFormStatusSignal, FormStatusContext } from "../../runtime/form-status.ts";
import { STRICT_MODE_PROP } from "../../runtime/strict-mode.ts";
import { PROFILER_PROP, type ProfilerOnRender } from "../../runtime/profiler.ts";
import { toError } from "../../runtime/error-boundary.ts";
import { normalizeChildren } from "../vnode-utils.ts";
import { propsAndContextEqual, providerContexts } from "../context-map.ts";
import { isClassComponent } from "../../compat/class-detect.ts";
import { type Fiber, NoLane, type SuspenseListState } from "./fiber.ts";
import { noteOffscreen, noteProfiler } from "./state.ts";
import { renderLanes } from "./scheduler.ts";

/** Perform one unit of work; return the next unit (first child) or null. */
// A "component" fiber: bail out when nothing changed, else render it and reconcile
// its output. Split out of {@linkcode beginWork}; `hasOwnUpdate` is the fiber's own
// pending-lane flag, computed in beginWork's preamble.
// May a "component" fiber skip re-rendering this pass? True only when it has a prior
// render, no own pending work, isn't a class (those decide via sCU/PureComponent
// inside renderComponent), keeps the SAME function ref (a Fast Refresh swap must run),
// and its props + read contexts are unchanged. Split out of {@linkcode beginComponent}.
function canSkipComponentRender(
  wip: Fiber,
  current: Fiber | null,
  hasOwnUpdate: boolean,
  isClass: boolean,
): boolean {
  return current !== null && !hasOwnUpdate && !isClass &&
    // A Fast Refresh swap keeps the fiber but changes the function ref (same
    // family, different type). Never bail then — the new implementation must
    // run. In production the type ref is always identical here, so this is a
    // no-op guard (zero behavior change).
    wip.vnode.type === current.vnode.type &&
    propsAndContextEqual(
      wip.vnode.type,
      current.vnode.props,
      wip.vnode.props,
      current.inherited,
      wip.inherited,
      current.readContexts,
    );
}

function beginComponent(wip: Fiber, hasOwnUpdate: boolean): Fiber | null {
  const current = wip.alternate;
  const isClass = __DENEXT_CLASS_COMPONENTS__ && isClassComponent(wip.vnode.type);
  if (canSkipComponentRender(wip, current, hasOwnUpdate, isClass)) {
    if ((wip.childLanes & renderLanes) === NoLane) return null; // bail whole subtree
    cloneChildFibers(wip);
    return wip.child;
  }
  // The class runtime resolves legacy `contextType` from `.contexts`; a
  // component's visible context is its inherited map. (Fragments override
  // `.contexts` with their derived map; components never expose via it.)
  wip.contexts = wip.inherited;
  const rendered = renderComponent(wip);
  if (__DENEXT_CLASS_COMPONENTS__ && wip.bailed) {
    // shouldComponentUpdate/PureComponent bailed. Like the function bailout,
    // still descend into children that have their own pending work, so a
    // descendant's update isn't dropped just because this class didn't change.
    if ((wip.childLanes & renderLanes) === NoLane) return null;
    cloneChildFibers(wip);
    return wip.child;
  }
  const childBoundary = isClassBoundary(wip) ? wip : wip.boundary;
  // React parity (`isUnkeyedTopLevelFragment`): a component that returns an UNKEYED
  // top-level Fragment is transparent — reconcile the Fragment's own children against
  // this component's children rather than nesting a Fragment fiber. A KEYED fragment is
  // NOT unwrapped (its key is meaningful). This lets a keyed element INSIDE the returned
  // fragment be matched by key even when the surrounding structure changes between
  // renders. Base UI's MenuTrigger depends on exactly this: it wraps its <button> in
  // `<Fragment key={triggerId}>` and, when open, returns that keyed wrapper alongside
  // focus-guard siblings inside an outer UNKEYED fragment. Without unwrapping, denext
  // compares the new outer unkeyed fragment against the old keyed one, fails to match,
  // and remounts the whole subtree — recreating the trigger's DOM node and detaching
  // floating-ui's positioning anchor, so the popup renders unpositioned at opacity:0.
  //
  // Only a PLAIN fragment (no props other than `children`) is unwrapped: denext overloads
  // Fragment to carry marker props for context Providers, SuspenseList, StrictMode and
  // Profiler (symbol-keyed), and unwrapping those would drop their behavior (e.g. a
  // Provider's value would stop reaching descendants). React never puts props on a
  // Fragment, so restricting to plain fragments costs no React parity.
  const childrenToReconcile: VNodeChildren = isPlainUnkeyedFragment(rendered)
    ? ((rendered as VNode).props?.children ?? null) as VNodeChildren
    : [rendered];
  reconcileChildren(wip, childrenToReconcile, wip.host, childBoundary, wip.inherited);
  return wip.child;
}

interface FragmentMarkers {
  strict: boolean;
  profiler: { id: string; onRender?: ProfilerOnRender } | undefined;
  provInfo: { id: symbol; value: unknown } | undefined;
  listPolicy:
    | { revealOrder?: SuspenseListState["revealOrder"]; tail?: SuspenseListState["tail"] }
    | undefined;
}

// A Fragment is denext's overloaded carrier for four symbol-keyed marker props:
// StrictMode, <Profiler>, a context Provider, and SuspenseList. Read them all off the
// vnode's props in one place. Split out of {@linkcode beginFragment}.
function readFragmentMarkers(wip: Fiber): FragmentMarkers {
  const props = wip.vnode.props as Record<string, unknown> | null;
  return {
    strict: props?.[STRICT_MODE_PROP] === true,
    profiler: props?.[PROFILER_PROP] as FragmentMarkers["profiler"],
    provInfo: props?.[PROVIDER as unknown as string] as FragmentMarkers["provInfo"],
    listPolicy: props?.[SUSPENSE_LIST_PROP] as FragmentMarkers["listPolicy"],
  };
}

// A "fragment" fiber: the overloaded carrier for context Providers, StrictMode,
// Profiler, and SuspenseList (all symbol-keyed marker props). Applies any active
// marker, reconciles children under the derived context, then wires SuspenseList
// membership. Split out of {@linkcode beginWork}.
function beginFragment(wip: Fiber): Fiber | null {
  const { strict, profiler, provInfo, listPolicy } = readFragmentMarkers(wip);
  // A StrictMode boundary makes its whole subtree strict in development — enabling
  // render/effect double-invoke.
  if (wip.strict !== true && devHydrationActive() && strict) {
    wip.strict = true;
  }
  // A <Profiler> boundary times its subtree's component renders.
  if (profiler) {
    wip.profiler = profiler;
    wip.underProfiler = true;
    noteProfiler();
  }
  const prevProvValue = wip.provValue;
  const exposed = providerContexts(wip, wip.vnode, wip.inherited);
  wip.contexts = exposed;
  // A provider whose value CHANGED must force every descendant that reads this
  // context to re-render, even if an intermediate parent bails (denext's memo
  // bailout now skips non-consumers). Mark those consumers' lanes so beginWork
  // renders them and bailing ancestors still descend. Skipped on mount (no prior
  // consumers) and when the value is unchanged (providerContexts reused the map).
  if (
    provInfo !== undefined && wip.alternate !== null &&
    !Object.is(prevProvValue, provInfo.value)
  ) {
    propagateContextChange(wip, provInfo.id, renderLanes);
  }
  reconcileChildren(
    wip,
    (wip.vnode.props?.children ?? null) as VNodeChildren,
    wip.host,
    wip.boundary,
    exposed,
  );
  // A SuspenseList (a Fragment carrying the reveal-policy marker) coordinates its
  // direct <Suspense> children's reveal order.
  if (listPolicy) applySuspenseListPolicy(wip, listPolicy);
  return wip.child;
}

// Wire a SuspenseList's shared reveal state onto a Fragment carrying the reveal-policy
// marker, and tag its direct children with their membership + index (propagated one
// level to the <Suspense> each renders). Split out of {@linkcode beginFragment}.
function applySuspenseListPolicy(
  wip: Fiber,
  listPolicy: {
    revealOrder?: SuspenseListState["revealOrder"];
    tail?: SuspenseListState["tail"];
  },
): void {
  // One shared state object across all buffers (created once, carried by
  // reference) so a bailed/cloned member always reads fresh reveal state.
  const st: SuspenseListState = wip.listState ?? { members: [], ready: [], snapshot: [] };
  wip.listState = st;
  st.revealOrder = listPolicy.revealOrder;
  st.tail = listPolicy.tail;
  // Freeze the persistent readiness so every member this render decides against
  // one consistent state, then start a fresh roster of scheduling targets.
  st.snapshot = [...st.ready];
  st.members = [];
  // Tag the list's direct children; membership propagates one level to the
  // <Suspense> each renders (see reconcileChildren).
  let i = 0;
  for (let c = wip.child; c !== null; c = c.sibling) {
    c.listOwnerState = st;
    c.listIndex = i++;
  }
  // Record the child count so the collapsed/hidden tail can locate the leading
  // boundary on the first render (when `snapshot` is still empty).
  st.count = i;
}

// Offscreen re-suspend of an already-revealed boundary: reconcile [primary…, fallback…]
// as one child list — the primary vnodes match the committed primary fibers (reused →
// state kept), the fallback mounts fresh — then hide the primary portion so it isn't
// re-rendered. Split out of {@linkcode beginSuspense}.
function beginSuspenseOffscreen(wip: Fiber): Fiber | null {
  const primary = normalizeChildren(wip.vnode.props.children as VNodeChildren);
  const combined = primary.concat(
    normalizeChildren(wip.vnode.props.fallback as VNodeChildren),
  );
  reconcileChildren(wip, combined, wip.host, wip.boundary, wip.inherited);
  wip.primaryCount = primary.length;
  let i = 0;
  for (let c = wip.child; c !== null; c = c.sibling, i++) {
    c.hidden = i < wip.primaryCount;
  }
  noteOffscreen();
  return wip.child;
}

// Decide what a <Suspense> boundary shows this pass — content, its fallback, or
// nothing (hidden, under a SuspenseList tail policy) — and the child list for that
// choice. Under a list the reveal order decides; otherwise its own showingFallback
// flag does. Split out of {@linkcode beginSuspense}.
function resolveSuspenseDisplay(
  wip: Fiber,
  inList: boolean,
): { display: "content" | "fallback" | "hidden"; children: VNodeChildren } {
  const display = inList ? suspenseListDisplay(wip) : wip.showingFallback ? "fallback" : "content";
  const children = display === "content"
    ? (wip.vnode.props.children as VNodeChildren)
    : display === "fallback"
    ? (wip.vnode.props.fallback as VNodeChildren)
    : null; // hidden
  return { display, children };
}

// A "suspense" fiber: own id-scope fork point; picks content/fallback/hidden per
// SuspenseList reveal order (or its own showingFallback), and handles the Offscreen
// keep-mounted-but-hidden reveal dance. Split out of {@linkcode beginWork}.
function beginSuspense(wip: Fiber): Fiber | null {
  // A Suspense boundary is its own id scope (a fork point, like React): it takes
  // one slot in its parent, and its content's ids are rooted at that position —
  // so a streamed/isolated hole reproduces exactly the ids the client computes.
  if (wip.idScope === undefined) {
    wip.idScope = enterScope(wip.idParentScope ?? rootScope());
  }
  // Under a SuspenseList, reveal order decides whether this boundary may show
  // content yet, show its fallback, or stay hidden (tail policy).
  const st = wip.listState;
  const inList = st != null && st.revealOrder != null;
  if (inList) st!.members[wip.listIndex!] = wip;

  // Offscreen: an URGENT re-suspend of an already-revealed boundary. Keep the
  // primary subtree mounted-but-hidden and show the fallback alongside, so a
  // later reveal restores the SAME instances (state preserved) instead of
  // remounting.
  if (!inList && wip.offscreen === true && wip.showingFallback === true) {
    return beginSuspenseOffscreen(wip);
  }

  const { display, children } = resolveSuspenseDisplay(wip, inList);
  // A list member rendering content is (tentatively) ready; if its children then
  // suspend, handleThrow resets its slot to false for the ordering above.
  if (inList && display === "content") st!.ready[wip.listIndex!] = true;
  reconcileChildren(wip, children, wip.host, wip.boundary, wip.inherited);
  // Leaving Offscreen (revealing content): un-hide the reused primary fibers so
  // they render, and mark the boundary for the commit pass to restore their DOM.
  if (!inList && display === "content" && wip.primaryCount != null) {
    for (let c = wip.child; c !== null; c = c.sibling) c.hidden = false;
    wip.offscreen = false;
    wip.primaryCount = undefined;
    noteOffscreen(); // so the commit pass restores hiddenEls visibility
  }
  return wip.child;
}

// A "host" fiber (a DOM element): claim its server node during hydration, and — for a
// `<form action={fn}>` — establish a form-scoped pending signal seeded into descendant
// context so useFormStatus reads the nearest form. Split out of {@linkcode beginWork}.
function beginHost(wip: Fiber): Fiber | null {
  if (isHydrating) claimHost(wip);
  let childInherited = wip.inherited;
  if (wip.vnode.type === "form") {
    const props = wip.vnode.props ?? {};
    const act = props.action ?? props.formAction;
    if (typeof act === "function") {
      wip.formStatus ??= createFormStatusSignal();
      childInherited = new Map(wip.inherited);
      childInherited.set(FormStatusContext._id, wip.formStatus);
    }
  }
  reconcileChildren(
    wip,
    (wip.vnode.props?.children ?? null) as VNodeChildren,
    wip,
    wip.boundary,
    childInherited,
  );
  return wip.child;
}

// An "errorboundary" fiber: when it has caught an error, render the fallback (reporting
// to the PARENT boundary so an error in the fallback doesn't loop back here); otherwise
// render its children with itself as their boundary. Split out of {@linkcode beginWork}.
function beginErrorBoundary(wip: Fiber): Fiber | null {
  if (wip.__error != null) {
    const Fallback = wip.vnode.props.fallback as (p: {
      error: Error;
      reset: () => void;
    }) => VNode;
    const fallbackVNode: VNode = {
      type: Fallback as unknown as VNode["type"],
      props: { error: toError(wip.__error), reset: () => resetBoundary(wip) },
      key: null,
    };
    reconcileChildren(wip, [fallbackVNode], wip.host, wip.boundary, wip.inherited);
  } else {
    reconcileChildren(
      wip,
      (wip.vnode.props?.children ?? null) as VNodeChildren,
      wip.host,
      wip,
      wip.inherited,
    );
  }
  return wip.child;
}

export function beginWork(wip: Fiber): Fiber | null {
  // Offscreen-hidden (a re-suspended boundary's preserved primary): do NOT render or
  // descend — keep the committed subtree mounted-as-is (a suspended child inside must
  // not re-throw) and DO NOT consume its lanes, so revealing it later re-renders with
  // the resolved data. Its DOM is hidden by the commit visibility pass.
  if (wip.hidden === true) return null;
  const hasOwnUpdate = (wip.lanes & renderLanes) !== 0;
  wip.lanes &= ~renderLanes; // consume only the lanes this render is processing

  switch (wip.tag) {
    case "root": {
      reconcileChildren(
        wip,
        wip.pendingElement != null ? [wip.pendingElement] : [],
        wip,
        null,
        wip.inherited,
      );
      return wip.child;
    }

    case "component":
      return beginComponent(wip, hasOwnUpdate);

    case "host":
      return beginHost(wip);

    case "fragment":
      return beginFragment(wip);

    case "portal": {
      wip.stateNode = wip.vnode.props.target as Element;
      reconcileChildren(
        wip,
        (wip.vnode.props?.children ?? null) as VNodeChildren,
        wip,
        wip.boundary,
        wip.inherited,
      );
      return wip.child;
    }

    case "suspense":
      return beginSuspense(wip);

    case "errorboundary":
      return beginErrorBoundary(wip);

    case "text":
      return null;
  }
}
