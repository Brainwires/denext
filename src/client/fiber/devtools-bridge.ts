// DevTools bridge: the first-party inspector's commit observer, per-fiber ids, the
// render profiler, prop overrides, and the fiber → DevNode export for the React
// DevTools extension.

import { activeRoots } from "./state.ts";
import type { RootHandle } from "./state.ts";
import { scheduleUpdate } from "./scheduler.ts";
import { commitToDevTools, type DevNode, injectDevTools } from "../devtools.ts";
import { componentDisplayName } from "../../runtime/react-brands.ts";
import type { Fiber, FiberTag } from "./fiber.ts";

let devToolsActive: boolean | undefined;

// A single observer the first-party denext inspector (src/client/devtools-inspect.ts)
// registers to learn a commit happened; it then lazily re-reads the tree on its own.
// Distinct from the React-extension bridge below and fired UNCONDITIONALLY — even when
// that extension is absent — so the native panel updates regardless. Never installed in
// production: the inspector module is imported only by dev route/Flight entries.
let commitObserver: (() => void) | null = null;

/** Register (or clear, with `null`) the dev inspector's per-commit observer. */
export function setCommitObserver(fn: (() => void) | null): void {
  commitObserver = fn;
}

// Dev-only: the first-party inspector supplies its stable fiber-id function so the React
// DevTools bridge's synthetic nodes can carry the SAME id the native inspector uses —
// letting the stock extension's prop/state edits route back to the right denext fiber.
// Null in production (and until installInspector runs), where DevNode.id is just -1.
let devIdForFiber: ((fiber: Fiber) => number) | null = null;

/** Register (or clear, with `null`) the inspector's fiber-id function for the RD bridge. */
export function setDevIdForFiber(fn: ((fiber: Fiber) => number) | null): void {
  devIdForFiber = fn;
}

// Dev-only DevTools profiler sink: when set, every component render is timed and
// reported (component type + duration ms + the fiber, for per-commit flamegraph
// capture). Null in production and when the panel's profiler is off, so the render hot
// path pays only a single null check.
export let renderProfiler: ((type: unknown, ms: number, fiber: Fiber) => void) | null = null;

/** Register (or clear, with `null`) the dev DevTools render profiler. */
export function setRenderProfiler(
  fn: ((type: unknown, ms: number, fiber: Fiber) => void) | null,
): void {
  renderProfiler = fn;
}

// Dev-only DevTools prop overrides: the panel can pin a component's prop to a value
// (the live companion to editing useState). Overrides are merged over the fiber's
// real props at render time. `overridesActive` gates the per-render lookup to zero
// cost in production and whenever nothing is overridden.
const fiberOverrides = new WeakMap<Fiber, Record<string, unknown>>();

// `overridesActive` gates the per-render override lookup — it tracks a live count of
// overridden fibers so it flips back to false once the last override is cleared
// (not stuck true for the rest of the session after any override).
let overrideCount = 0;
export let overridesActive = false;

/** Pin `fiber`'s prop `key` to `value` and re-render it (dev DevTools). Overrides are
 * shared across both buffers (a fiber and its `alternate`), which the reconciler swaps
 * between renders. */
export function overrideFiberProp(fiber: Fiber, key: string, value: unknown): void {
  const existing = fiberPropOverrides(fiber);
  const ov = existing ?? {};
  ov[key] = value;
  fiberOverrides.set(fiber, ov);
  if (fiber.alternate) fiberOverrides.set(fiber.alternate, ov);
  if (!existing) overrideCount++;
  overridesActive = overrideCount > 0;
  scheduleUpdate(fiber);
}

/** Drop all prop overrides on `fiber` and re-render it (dev DevTools). */
export function clearFiberProps(fiber: Fiber): void {
  const had = fiberPropOverrides(fiber) !== undefined;
  fiberOverrides.delete(fiber);
  if (fiber.alternate) fiberOverrides.delete(fiber.alternate);
  if (had) {
    overrideCount = Math.max(0, overrideCount - 1);
    overridesActive = overrideCount > 0;
    scheduleUpdate(fiber);
  }
}

/** The prop overrides pinned on `fiber` or its alternate (dev DevTools), or undefined. */
export function fiberPropOverrides(fiber: Fiber): Record<string, unknown> | undefined {
  return fiberOverrides.get(fiber) ??
    (fiber.alternate ? fiberOverrides.get(fiber.alternate) : undefined);
}

/** A snapshot of the committed root fibers, for the dev inspector's tree walk. */
export function devRootFibers(): Fiber[] {
  const out: Fiber[] = [];
  for (const h of activeRoots) out.push(h.current);
  return out;
}

export function reportCommit(handle: RootHandle): void {
  const obs = commitObserver;
  if (obs !== null) {
    try {
      obs();
    } catch {
      // The inspector observer must never affect rendering.
    }
  }
  try {
    if (devToolsActive === undefined) devToolsActive = injectDevTools();
    if (!devToolsActive) return;
    const child = handle.current.child;
    commitToDevTools(child ? fiberToDevNode(child) : null);
  } catch {
    // The DevTools bridge must never affect rendering.
  }
}

function fiberChildrenDevNodes(fiber: Fiber): DevNode[] {
  const out: DevNode[] = [];
  for (let c = fiber.child; c !== null; c = c.sibling) out.push(fiberToDevNode(c));
  return out;
}

/**
 * Per-tag overrides on the default (host) DevNode shape. Text carries its content and
 * no children; a component's single rendered child is its subtree; boundaries,
 * fragments and portals are synthetic named nodes without DOM of their own.
 */
const DEV_NODE_BY_TAG: Partial<Record<FiberTag, (fiber: Fiber) => Partial<DevNode>>> = {
  text: (f) => ({
    kind: "text",
    name: "text",
    key: null,
    props: {},
    text: String((f.vnode.props as { nodeValue?: unknown })?.nodeValue ?? ""),
    children: [],
  }),
  component: (f) => ({
    kind: "component",
    name: componentDisplayName(f.vnode.type),
    dom: null,
    children: f.child ? [fiberToDevNode(f.child)] : [],
  }),
  suspense: () => ({ kind: "component", name: "Suspense", dom: null }),
  errorboundary: () => ({ kind: "component", name: "ErrorBoundary", dom: null }),
  fragment: () => ({ kind: "fragment", name: "Fragment", dom: null }),
  portal: () => ({ kind: "fragment", name: "Portal", props: {}, dom: null }),
};

function fiberToDevNode(fiber: Fiber): DevNode {
  const vtype = fiber.vnode.type;
  const override = DEV_NODE_BY_TAG[fiber.tag]?.(fiber) ?? {};
  const node: DevNode = {
    // The inspector's stable id (dev-only), so the RD bridge can route edits back.
    id: devIdForFiber ? devIdForFiber(fiber) : -1,
    kind: "host",
    name: typeof vtype === "string" ? vtype : "host",
    key: fiber.vnode.key == null ? null : String(fiber.vnode.key),
    props: fiber.vnode.props,
    dom: fiber.stateNode,
    children: [],
    ...override,
  };
  if (override.children === undefined) node.children = fiberChildrenDevNodes(fiber);
  return node;
}
