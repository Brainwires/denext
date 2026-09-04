// Pure helpers over fibers: tag classification, ancestor searches, tree walks, effect
// collection, host namespaces and SuspenseList display policy. No module state.

import { FRAGMENT, PORTAL, type VNode } from "../../jsx/types.ts";
import { SUSPENSE } from "../../runtime/suspense.ts";
import { PROVIDER } from "../../runtime/context.ts";
import { ERROR_BOUNDARY } from "../../runtime/error-boundary.ts";
import { TEXT_TYPE } from "../vnode-utils.ts";
import { componentDisplayName, isComponentType } from "../../runtime/react-brands.ts";
import { hasErrorLifecycle } from "../../compat/class-component.ts";
import {
  ChildDeletion,
  ChildrenChanged,
  createFiber,
  type Fiber,
  type FiberTag,
  NoLane,
  Placement,
} from "./fiber.ts";

export function devHydrationActive(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

function tagOf(vnode: VNode): FiberTag {
  const t = vnode.type as unknown;
  if (t === TEXT_TYPE) return "text";
  if (t === SUSPENSE) return "suspense";
  if (t === ERROR_BOUNDARY) return "errorboundary";
  if (t === FRAGMENT) return "fragment";
  if (t === PORTAL) return "portal";
  if (typeof t === "function") return "component";
  // A non-callable memo/forwardRef object wrapper is also a component.
  if (typeof t === "object" && t !== null && isComponentType(t)) return "component";
  return "host";
}

export function createFiberFromVNode(vnode: VNode): Fiber {
  const tag = tagOf(vnode);
  const fiber = createFiber(tag, vnode);
  if (tag === "component") fiber.hooks = [];
  return fiber;
}

/**
 * Reconcile `returnFiber`'s existing child fibers against `childrenRaw`, linking
 * the resulting child/sibling chain and collecting unused fibers into
 * `returnFiber.deletions`. Sets each child's routing pointers (return/host/
 * boundary) and inherited context map. Flags the parent as ChildrenChanged when
 * membership or order changes so the commit re-syncs the nearest host.
 */
/**
 * Whether `v` is a plain, unkeyed Fragment element — an unkeyed `<>…</>` whose props are
 * nothing but `children`. Such a fragment is transparent and can be unwrapped (React's
 * `isUnkeyedTopLevelFragment`). A fragment carrying any marker prop (PROVIDER / STRICT_MODE
 * / SUSPENSE_LIST / PROFILER — all symbol-keyed) is NOT plain and must keep its own fiber,
 * or the behavior that prop encodes is lost. Symbol keys are checked via Reflect.ownKeys.
 */
export function isPlainUnkeyedFragment(v: unknown): v is VNode {
  if (v == null || typeof v !== "object") return false;
  const vn = v as VNode;
  if (vn.type !== FRAGMENT || vn.key != null) return false;
  const props = vn.props as Record<string | symbol, unknown> | null;
  if (props == null) return true;
  for (const k of Reflect.ownKeys(props)) {
    if (k !== "children") return false;
  }
  return true;
}

export function isClassBoundary(fiber: Fiber): boolean {
  return __DENEXT_CLASS_COMPONENTS__ && fiber.tag === "component" &&
    fiber.classInstance != null && hasErrorLifecycle(fiber.vnode.type);
}

/** Whether `fiber` (a provider fragment) re-provides `contextId`, shadowing it below. */
export function reprovidesContext(fiber: Fiber, contextId: symbol): boolean {
  const info = (fiber.vnode.props as Record<string, unknown> | null)
    ?.[PROVIDER as unknown as string] as { id: symbol } | undefined;
  return info !== undefined && info.id === contextId;
}

/**
 * A provider's value changed: force every descendant that READS `contextId` to render,
 * so a consumer isn't left stale when the memo bailout skips a non-consumer ancestor
 * between it and the provider. Walks the provider's committed subtree (its child links
 * before this render's reconcile), marks each consumer's lane, and threads `childLanes`
 * up to the provider so bailing ancestors still descend to reach it. Stops at a nested
 * provider that re-provides the same context (it shadows the value below). Mirrors
 * React's `propagateContextChange`; runs only on an actual value change of a mounted
 * provider, so a stable-value provider costs nothing.
 */
/** Whether `node` is a component that read `contextId` during its last render. */
export function readsContext(node: Fiber, contextId: symbol): boolean {
  return node.tag === "component" && node.readContexts !== undefined &&
    node.readContexts.has(contextId);
}

/** XML namespaces for non-HTML host elements. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/**
 * The namespace a host element must be created in, or `null` for plain HTML.
 * `<svg>`/`<math>` open a namespace that their descendants inherit; a `<foreignObject>`
 * inside SVG switches its own children back to HTML. Walks host ancestors to inherit the
 * enclosing namespace (a nested `<svg>` re-enters SVG regardless of context).
 */
export function hostNamespace(wip: Fiber, type: string): string | null {
  if (type === "svg") return SVG_NAMESPACE;
  if (type === "math") return MATHML_NAMESPACE;
  for (let p = wip.return; p !== null; p = p.return) {
    if (p.tag !== "host") continue;
    const t = p.vnode.type as string;
    if (t === "foreignObject") return null; // HTML content embedded in SVG
    if (t === "svg") return SVG_NAMESPACE;
    if (t === "math") return MATHML_NAMESPACE;
  }
  return null;
}

export function bubbleLanes(fiber: Fiber): void {
  let lanes = NoLane;
  for (let child = fiber.child; child !== null; child = child.sibling) {
    lanes |= child.lanes | child.childLanes;
  }
  fiber.childLanes = lanes;
}

export function findSuspense(fiber: Fiber): Fiber | null {
  for (let n = fiber.return; n !== null; n = n.return) {
    if (n.tag === "suspense") return n;
  }
  return null;
}

export function findErrorBoundary(fiber: Fiber): Fiber | null {
  for (let n = fiber.return; n !== null; n = n.return) {
    if (n.tag === "errorboundary" || isClassBoundary(n)) return n;
  }
  return null;
}

export function componentErrorInfo(fiber: Fiber): { componentStack: string } {
  return { componentStack: `\n    in ${componentDisplayName(fiber.vnode.type)}` };
}

/**
 * Decide what a `<Suspense>` inside a `<SuspenseList>` shows this render: its
 * content, its fallback, or nothing (`tail`). A boundary is "revealed" only when
 * its own content is ready AND the boundaries before it (per `revealOrder`) are
 * too. Not-yet-ready boundaries render their content to drive their promise (and
 * suspend to a fallback); a resolved-but-order-gated boundary shows its fallback.
 * With `tail` collapsed/hidden only the leading edge renders (a serial tail).
 */
export function suspenseListDisplay(member: Fiber): "content" | "fallback" | "hidden" {
  const st = member.listState!;
  const order = st.revealOrder!;
  // The frozen readiness snapshot for this render, so every member decides against
  // one consistent state.
  const ready = st.snapshot;
  const idx = member.listIndex!;
  const revealed = (i: number): boolean => {
    if (!ready[i]) return false;
    if (order === "together") return ready.length > 0 && ready.every(Boolean);
    if (order === "backwards") return ready.slice(i + 1).every(Boolean);
    return ready.slice(0, i).every(Boolean); // forwards
  };
  if (revealed(idx)) return "content";
  // A boundary not yet revealed shows its fallback. If it hasn't started/finished
  // its promise (not ready and not already suspended) it renders content once to
  // drive the promise — which then suspends back to its fallback.
  const gated = (): "content" | "fallback" =>
    !ready[idx] && member.showingFallback !== true ? "content" : "fallback";
  if (st.tail === "collapsed" || st.tail === "hidden") {
    // Only the leading not-yet-revealed boundary renders; the rest wait, hidden.
    // Length comes from the child count (not `ready.length`, which is empty on the
    // first render before any member reports readiness).
    const n = st.count ?? ready.length;
    const order2 = Array.from({ length: n }, (_, i) => i);
    const seq = order === "backwards" ? order2.reverse() : order2;
    const leading = seq.find((i) => !revealed(i));
    if (idx !== leading) return "hidden";
    // Drive the leading boundary's promise. `"collapsed"` shows its fallback while
    // pending; `"hidden"` shows NO fallback (React parity) — it hides instead, so the
    // fetch still starts (the initial content-drive throws synchronously) but nothing
    // is painted for the pending tail.
    const g = gated();
    return g === "fallback" && st.tail === "hidden" ? "hidden" : g;
  }
  // Default tail: boundaries fetch in parallel.
  return gated();
}

/** Collect component fibers with queued insertion effects, children before parents. */
export function collectInsertionEffects(fiber: Fiber, out: Fiber[]): void {
  if (fiber.hidden === true) return; // Offscreen-hidden subtree: effects are gated.
  for (let c = fiber.child; c !== null; c = c.sibling) collectInsertionEffects(c, out);
  if (fiber.tag !== "component") return;
  if (fiber.insertionEffects && fiber.insertionEffects.length > 0) out.push(fiber);
}

/** Collect component fibers with pending effects, children before parents. */
export function collectEffects(fiber: Fiber, out: Fiber[]): void {
  if (fiber.hidden === true) return; // Offscreen-hidden subtree: effects are gated.
  for (let c = fiber.child; c !== null; c = c.sibling) collectEffects(c, out);
  if (fiber.tag !== "component") return;
  if (
    (fiber.pendingEffects && fiber.pendingEffects.length > 0) ||
    (fiber.passiveEffects && fiber.passiveEffects.length > 0)
  ) {
    out.push(fiber);
  }
}

export function needsSync(fiber: Fiber): boolean {
  return ((fiber.flags | fiber.subtreeFlags) & (Placement | ChildDeletion | ChildrenChanged)) !== 0;
}

/** Pre-order DFS over the work-in-progress tree. */
export function walk(fiber: Fiber, visit: (f: Fiber) => void): void {
  visit(fiber);
  for (let c = fiber.child; c !== null; c = c.sibling) walk(c, visit);
}
