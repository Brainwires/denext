// Rendering one component fiber: dev Fast Refresh resolution, class components,
// memo/forwardRef unwrapping, prop preparation, the render-phase-update loop and
// the StrictMode double render.

import { devHydrationActive } from "./fiber-utils.ts";
import { devtoolsHooks } from "./devtools-seam.ts";
import {
  clientDispatcher,
  currentFiber,
  enterComponentRender,
  HK_MEMO,
  hookIndex,
  renderPhaseUpdateScheduled,
  resetHookCursor,
  setRefreshSwapRender,
  setSuppressEffectQueue,
} from "./hooks-dispatcher.ts";

import type { VNode } from "../../jsx/types.ts";
import { enterScope, ID_PATH_PROP, rootScope } from "../../jsx/tree-id.ts";
import { setDispatcher } from "../../runtime/hooks.ts";
import {
  familyResolveActive,
  reportSignatureChange,
  resolveFamilyCurrent,
} from "../vnode-utils.ts";
import { classComponentsDisabledError, isClassComponent } from "../../compat/class-detect.ts";
import { componentDisplayName, resolveComponentType } from "../../runtime/react-brands.ts";
import { getClassSupport } from "./class-support.ts";
import { loadClassRuntime } from "../class-loader.ts";
import { findSuspense, updateDepthError } from "./fiber-utils.ts";
import { scheduleUpdate } from "./scheduler.ts";
import {
  BailedBit,
  type Fiber,
  fiberExt,
  hasBit,
  HasEffect,
  type HookCell,
  StrictBit,
  UnderProfilerBit,
} from "./fiber.ts";

/** Bound on render-phase re-invocations of one component (React's RE_RENDER_LIMIT). */
const MAX_RENDER_PHASE_PASSES = 25;

/** The error a client render throws when a component resolves to a Promise. */
function asyncClientComponentError(): Error {
  return new Error("denext: async components are server-only; cannot render on the client.");
}

/**
 * Reset a component's hooks to their render-start state before a render-phase
 * re-invocation (React's render-phase update — a component that calls its own
 * `setState`/`dispatch` while rendering itself). A cell's deps change during a render only
 * for `useMemo` / `useCallback`: an effect's or a store subscription's deps are recorded when
 * it COMMITS (hooks-dispatcher.ts), so the cells that existed when the render started still
 * hold their committed deps, and each effect / `useSyncExternalStore` subscription re-queues
 * exactly when it changed vs the last COMMITTED render, matching React. Cells created during a
 * discarded sub-render (index at or past `baselineLength`, the cell count at render start) are
 * reset to a fresh-mount state so their mount effect re-queues on the final pass. The three
 * effect queues are cleared so only the final sub-render's effects reach the commit.
 *
 * `useMemo` / `useCallback` cells are left as the previous pass wrote them: React's
 * re-render reuses the work-in-progress hooks, so a memo whose deps did not change since
 * the previous PASS returns the same value. Restoring the committed deps instead would
 * recompute it every pass, and a component that stores that memo in state during render
 * (`if (last !== merged) setLast(merged)`, React's "store information from previous
 * renders") would see a new identity each pass and never converge.
 */
function restoreForReRender(inst: Fiber, baselineLength: number): void {
  setSuppressEffectQueue(false); // the discarded pass's queues are cleared below; re-queue
  const hooks = inst.hooks!;
  for (let i = baselineLength; i < hooks.length; i++) {
    const c = hooks[i];
    if (c.kind === HK_MEMO) continue; // keeps the previous pass's value and deps (see above)
    c.deps = undefined; // created during a discarded sub-render — treat as a fresh mount
    c.mounted = false;
  }
  // Effect queues are allocated on a component's first effect of the render (most
  // components schedule none): three empty arrays per render, and per fiber, otherwise.
  if (inst.ext) inst.ext.insertionEffects = undefined;
  inst.pendingEffects = undefined;
  inst.passiveEffects = undefined;
}

/**
 * Invoke a function component and converge any render-phase updates it makes to its OWN
 * state (Base UI's dialog/transition status, a `usePrevious`-style prop adjustment, and
 * other "adjust state while rendering" idioms). React re-renders just that component in
 * place — reading the updated state — until it stabilizes, with no commit in between;
 * denext does the same here rather than scheduling a whole-tree re-render + commit, which
 * never converges for this idiom (each pass commits, feeding the transition state back on
 * itself) and trips the render-pass guard, aborting the commit. `baselineLength` is the
 * render-start cell count used to restore hook state between sub-renders.
 */
function runRenderPhase(
  inst: Fiber,
  baselineLength: number,
  type: (props: unknown, ref?: unknown) => VNode,
  props: unknown,
  ref: unknown,
  forwardsRef: boolean,
): VNode {
  resetHookCursor();
  let result = forwardsRef ? type(props, ref) : type(props);
  if (result instanceof Promise) throw asyncClientComponentError();
  let passes = 0;
  while (renderPhaseUpdateScheduled) {
    if (++passes > MAX_RENDER_PHASE_PASSES) {
      resetHookCursor();
      throw updateDepthError(componentDisplayName(inst.vnode.type), inst);
    }
    restoreForReRender(inst, baselineLength);
    resetHookCursor();
    result = forwardsRef ? type(props, ref) : type(props);
    if (result instanceof Promise) throw asyncClientComponentError();
  }
  return result;
}

/** `props` minus `ref` (a new object only when a ref is present). */
function withoutRef(props: unknown): unknown {
  if (!props || typeof props !== "object" || !("ref" in props)) return props;
  const { ref: _ref, ...rest } = props as Record<string, unknown>;
  return rest;
}

/** How a component fiber's implementation resolved under dev Fast Refresh / per-module HMR. */
interface RefreshResolution {
  /** The impl to render: the family-current one under per-module HMR, else `vnode.type`. */
  rawType: unknown;
  /** A reused fiber whose implementation changed — dev-only, impossible in production. */
  refreshSwap: boolean;
  /** The pre-swap hook-kind sequence for the signature guard; null outside a swap. */
  oldKinds: Array<number | undefined> | null;
}

/**
 * Resolve what `inst` renders as, and whether this render is a Fast Refresh swap.
 *
 * Dev per-module HMR (unbundled dev server): the parent may still hold the pre-edit ref
 * in its vnode, so resolve the component to its family's CURRENT impl and render that
 * on the live fiber. Null resolver in production and on the whole-entry refresh path →
 * `rawType` is just `inst.vnode.type` (one function-pointer check).
 *
 * A reused fiber whose implementation changed (same family, different ref) is a refresh
 * swap. Whole-entry refresh sees the change on `vnode.type` (the tree is rebuilt from
 * fresh refs); per-module HMR sees it only via the impl the previous render recorded
 * (`alternate.lastImpl`), since the vnode ref is stale. The impl about to render is
 * recorded so the NEXT render can detect a per-module swap across the double-buffered
 * alternate (dev-only; skipped in prod). The pre-swap hook-kind sequence is snapshotted
 * so the signature guard can compare the WHOLE signature (count + order), not just the
 * count — a same-count reorder is unsafe too. Null outside a swap, so prod pays nothing.
 *
 * Returns `null` for the production case — no family resolver and no swap: render
 * `inst.vnode.type` — so a component render allocates no resolution object.
 */
function resolveRefreshSwap(inst: Fiber): RefreshResolution | null {
  const resolveFR = familyResolveActive();
  const rawType = resolveFR ? resolveFamilyCurrent(inst.vnode.type) : inst.vnode.type;
  const refreshSwap = resolveFR
    ? (inst.alternate?.ext?.lastImpl != null && inst.alternate.ext.lastImpl !== rawType)
    : (inst.alternate !== null && inst.vnode.type !== inst.alternate.vnode.type);
  if (resolveFR) fiberExt(inst).lastImpl = rawType;
  else if (!refreshSwap) return null;
  const oldKinds = refreshSwap && inst.hooks ? inst.hooks.map((c) => c.kind) : null;
  return { rawType, refreshSwap, oldKinds };
}

/** Set once the on-demand class runtime failed to load: surface the guided error, don't retry forever. */
let classRuntimeUnavailable = false;

/**
 * A class component reached the reconciler before the on-demand class runtime was installed:
 * it was not server-rendered on this page, so the entry had no `#__denext_classes` marker to
 * preload on — a soft navigation onto a class page, a `client:only` island. Start the load
 * (coalesced in class-loader.ts) and re-render this fiber when it lands. Inside a Suspense
 * boundary the load suspends like any thenable (fallback, then retry); with no boundary above,
 * the fiber keeps its committed child for this pass — nothing, on a first mount — and is
 * scheduled again, so the cost is at most one round trip of blank subtree. Only a load
 * failure surfaces the guided "class components are disabled" error.
 */
function awaitClassRuntime(inst: Fiber): VNode | null {
  const load = loadClassRuntime();
  const failed = (err: unknown) => {
    classRuntimeUnavailable = true;
    console.error("denext: the class-component runtime failed to load:", err);
  };
  if (findSuspense(inst)) {
    load.catch(failed);
    throw load;
  }
  load.then(() => scheduleUpdate(inst), (err) => {
    failed(err);
    scheduleUpdate(inst); // re-render into the guided error (an error boundary can catch it)
  });
  inst.bits |= BailedBit;
  return (inst.child?.vnode as VNode) ?? null;
}

/**
 * Render a bare class component (raw type is a class) through the class runtime, which
 * reads `inst.vnode.type` as the constructor. (Per-module HMR does not substitute class
 * impls — an edited class module is reload-only — so the family-current impl equals
 * `inst.vnode.type` whenever this path is taken.) A shouldComponentUpdate/PureComponent
 * bail keeps the committed child.
 */
function renderClassFiber(inst: Fiber): VNode | null {
  const cs = getClassSupport();
  if (!__DENEXT_CLASS_COMPONENTS__ || classRuntimeUnavailable) {
    throw classComponentsDisabledError();
  }
  if (cs === null) return awaitClassRuntime(inst);
  const { vnode, bailed } = cs.renderClassInstance(inst as never);
  if (bailed) {
    inst.bits |= BailedBit;
    return (inst.child?.vnode as VNode) ?? null;
  }
  // Class lifecycle callbacks (componentDidMount / componentDidUpdate) are queued onto the
  // fiber's effect arrays by the class-support bridge, NOT through scheduleEffect — so set
  // the HasEffect bit here too, or the flags-guided commit collectors would prune the class
  // fiber and its lifecycle would never fire. Set at render time so bubbleFlags carries it.
  if (
    (inst.pendingEffects && inst.pendingEffects.length > 0) ||
    (inst.passiveEffects && inst.passiveEffects.length > 0) ||
    (inst.ext?.insertionEffects && inst.ext.insertionEffects.length > 0)
  ) {
    inst.flags |= HasEffect;
  }
  return (vnode as VNode) ?? null;
}

type RenderFn = (props: unknown, ref?: unknown) => VNode;

/**
 * Resolve memo/forwardRef object wrappers to the render function. The fast path (a plain
 * function type) returns it unchanged with a single typeof check. A wrapper hiding a
 * class (e.g. memo(Class)) can't go through the object path — the class runtime needs
 * the raw constructor — so it is rejected; the guard runs only in the wrapped case so
 * the plain-function hot path pays nothing.
 */
function resolveRenderTarget(rawType: unknown): { fn: unknown; forwardsRef: boolean } {
  const resolved = resolveComponentType(rawType);
  if (resolved.fn !== rawType && __DENEXT_CLASS_COMPONENTS__ && isClassComponent(resolved.fn)) {
    throw new Error(
      "denext: memo() of a class component is unsupported; wrap the class in a " +
        "function component (or memo the function) instead.",
    );
  }
  return resolved;
}

/**
 * The props this render sees, plus the fiber's id scope.
 *
 * A Flight island hydrates on its own, so it can't derive its position from an
 * enclosing tree — the server tags it with its tree-path prefix. Root the island's id
 * scope at that prefix so its ids match the server render. Dev DevTools prop overrides
 * are merged over the real props (gated to zero cost when nothing is overridden / in
 * production). On first render the component takes its slot in its enclosing scope (in
 * the same depth-first order the server assigns), so useId derives from its position;
 * reused fibers keep their mount-time scope (useId is cached per hook cell).
 */
function prepareRenderProps(inst: Fiber): unknown {
  let props: unknown = inst.vnode.props;
  const idPath = (props as Record<string, unknown>)[ID_PATH_PROP];
  if (typeof idPath === "string") {
    if (inst.idScope === undefined) inst.idScope = rootScope(idPath);
    const { [ID_PATH_PROP]: _drop, ...rest } = props as Record<string, unknown>;
    props = rest;
  }
  const dh = devtoolsHooks;
  if (dh) {
    const ov = dh.propOverrides(inst);
    if (ov) props = { ...(props as Record<string, unknown>), ...ov };
  }
  if (inst.idScope === undefined) {
    inst.idScope = enterScope(inst.idParentScope ?? rootScope());
  }
  return props;
}

/**
 * Run the render phase, twice under StrictMode (dev) to surface impure render logic.
 * The first pass initialized hook cells and queued effects; the second reads the same
 * cells (no new effects, ids cached) and its result is the one used. The scope's local
 * id index is restored so an impure second pass that calls an extra useId can't shift
 * this component's ids. (Class components are not double-rendered — they are gated and
 * comparatively rare.)
 *
 * The render-start cell count is kept so a render-phase update (a component that sets its
 * own state while rendering) can re-invoke and converge locally, resetting the cells the
 * discarded pass created (see {@linkcode restoreForReRender}).
 */
function renderWithStrictMode(
  inst: Fiber,
  type: RenderFn,
  props: unknown,
  ref: unknown,
  forwardsRef: boolean,
): VNode | null {
  const baselineLength = inst.hooks!.length;
  const result = runRenderPhase(inst, baselineLength, type, props, ref, forwardsRef);
  if (hasBit(inst, StrictBit) && devHydrationActive()) {
    const localAfterFirst = inst.idScope!.local;
    // Effect deps are recorded at COMMIT, so the second pass would see them "changed" again
    // and queue duplicates: suppress queueing for it (the first pass's entries commit).
    setSuppressEffectQueue(true);
    let second: VNode | null;
    try {
      second = runRenderPhase(inst, baselineLength, type, props, ref, forwardsRef);
    } finally {
      setSuppressEffectQueue(false);
    }
    inst.idScope!.local = localAfterFirst;
    return second ?? null;
  }
  return result ?? null;
}

/**
 * Post-render bookkeeping (runs whether the render returned or threw). The Fast Refresh
 * hook-signature guard: the edited component's hook sequence changed — a different
 * count OR a same-count reorder/kind change — so reusing its hook cells is unsafe;
 * signal a full reload (no-op unless the dev refresh runtime installed a handler).
 * Then the `<Profiler>` timing and the dev DevTools profiler callback.
 */
function finishComponentRender(
  inst: Fiber,
  t0: number,
  profT0: number,
  swap: RefreshResolution | null,
): void {
  if (swap?.refreshSwap && hookSignatureChanged(swap.oldKinds, inst.hooks, hookIndex)) {
    reportSignatureChange();
  }
  if (hasBit(inst, UnderProfilerBit)) {
    const d = performance.now() - t0;
    const x = fiberExt(inst);
    x.actualDuration = d;
    x.selfBaseDuration = d;
  }
  const prof = devtoolsHooks?.profiler;
  if (prof) prof(inst.vnode.type, performance.now() - profT0, inst);
}

/**
 * Run a component fiber's render, returning what it rendered. `null` (a component that
 * rendered `null`/`undefined`) reconciles to no children — no host node, as in React.
 */
export function renderComponent(inst: Fiber): VNode | null {
  const prevInst = currentFiber;
  const prevIdx = hookIndex;
  const swap = resolveRefreshSwap(inst);
  setRefreshSwapRender(swap?.refreshSwap ?? false);
  enterComponentRender(inst, 0);
  // Effect queues are allocated on a component's first effect of the render (most
  // components schedule none): three empty arrays per render, and per fiber, otherwise.
  if (inst.ext) inst.ext.insertionEffects = undefined;
  inst.pendingEffects = undefined;
  inst.passiveEffects = undefined;
  // Rebuild the read-context set from this render's useContext calls (accumulated
  // across any render-phase / StrictMode re-invocations, which read the same set).
  inst.readContexts = undefined;
  if (__DENEXT_CLASS_COMPONENTS__) inst.bits &= ~BailedBit;
  // Time the render for an enclosing <Profiler> (a bailed component never reaches
  // here, so its actualDuration stays 0 while selfBaseDuration carries over).
  const t0 = hasBit(inst, UnderProfilerBit) ? performance.now() : 0;
  // Dev-only DevTools profiler: time every component render while recording (null
  // otherwise, so the hot path is one null check).
  const profT0 = devtoolsHooks?.profiler ? performance.now() : 0;
  const prevDispatcher = setDispatcher(clientDispatcher);
  try {
    // The flag is the FIRST operand on purpose: with class components compiled out, the
    // whole branch folds away and `renderClassFiber` (hence the class runtime) is dropped
    // from the bundle — a plain `isClassComponent(...)` test would keep it referenced.
    if (__DENEXT_CLASS_COMPONENTS__ && isClassComponent(inst.vnode.type)) {
      return renderClassFiber(inst);
    }
    const rawType = swap === null ? inst.vnode.type : swap.rawType;
    // A plain function component (the common case) is its own render function.
    let type = rawType as RenderFn;
    let forwardsRef = false;
    if (typeof rawType !== "function") {
      const target = resolveRenderTarget(rawType);
      type = target.fn as RenderFn;
      forwardsRef = target.forwardsRef;
    }
    const props = prepareRenderProps(inst);
    // forwardRef receives `(props, ref)` with `ref` REMOVED from props, as in React (a
    // render fn that spreads `props` onto a host element must not forward the ref twice).
    const ref = forwardsRef ? ((props as { ref?: unknown }).ref ?? null) : undefined;
    const renderProps = forwardsRef ? withoutRef(props) : props;
    return renderWithStrictMode(inst, type, renderProps, ref, forwardsRef);
  } finally {
    finishComponentRender(inst, t0, profT0, swap);
    setDispatcher(prevDispatcher);
    enterComponentRender(prevInst, prevIdx);
  }
}

/**
 * Whether a Fast Refresh swap changed the component's hook signature: a different
 * number of hooks, or the same number in a different order/kind (both make reusing
 * the carried cells unsafe). `oldKinds` is the pre-swap kind sequence; `hooks` now
 * holds the post-render cells and `newCount` (the render's `hookIndex`) how many it
 * used. Returns false when not a swap (`oldKinds` null).
 */
function hookSignatureChanged(
  oldKinds: Array<number | undefined> | null,
  hooks: HookCell[] | undefined,
  newCount: number,
): boolean {
  if (oldKinds === null) return false;
  if (oldKinds.length !== newCount) return true; // count changed
  for (let i = 0; i < newCount; i++) {
    if (oldKinds[i] !== hooks![i].kind) return true; // reorder / kind change
  }
  return false;
}
