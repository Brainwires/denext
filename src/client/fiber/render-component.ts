// Rendering one component fiber: the dev Fast Refresh seam, class components,
// memo/forwardRef unwrapping, prop preparation, the render-phase-update loop and
// the StrictMode double render.

import { devHydrationActive } from "./fiber-utils.ts";
import { devtoolsHooks } from "./devtools-seam.ts";
import {
  clientDispatcher,
  currentFiber,
  enterComponentRender,
  hookIndex,
  renderPhaseUpdateScheduled,
  resetHookCursor,
  setRefreshSwapRender,
  setSuppressEffectQueue,
} from "./hooks-dispatcher.ts";
import { HK_MEMO } from "./hook-kinds.ts";

import type { VNode } from "../../jsx/types.ts";
import { enterScope, ID_PATH_PROP, rootScope } from "../../jsx/tree-id.ts";
import { setDispatcher } from "../../runtime/hooks.ts";
import type { RefreshResolution, RefreshSwapHooks } from "./refresh-swap.ts";
import { isClassComponent } from "../../compat/class-detect.ts";
import {
  componentDisplayName,
  REACT_ELEMENT_TYPE,
  resolveComponentType,
} from "../../runtime/react-brands.ts";
import { getClassSupport } from "./class-support.ts";
import { loadClassRuntime } from "../class-loader.ts";
import { findSuspense, updateDepthError } from "./fiber-utils.ts";
import { isHydrating } from "./hydration.ts";
import { ERR_ASYNC_COMPONENT, ERR_CLASS_DISABLED, reconcilerError } from "./errors.ts";
import { scheduleUpdate } from "./scheduler.ts";
import {
  BailedBit,
  type Fiber,
  fiberExt,
  hasBit,
  HasEffect,
  StrictBit,
  UnderProfilerBit,
} from "./fiber.ts";

/** Bound on render-phase re-invocations of one component (React's RE_RENDER_LIMIT). */
const MAX_RENDER_PHASE_PASSES = 25;

/** The error a client render throws when a component resolves to a Promise. */
function asyncClientComponentError(inst: Fiber): Error {
  return reconcilerError(ERR_ASYNC_COMPONENT, componentDisplayName(inst.vnode.type));
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
  if (result instanceof Promise) throw asyncClientComponentError(inst);
  let passes = 0;
  while (renderPhaseUpdateScheduled) {
    if (++passes > MAX_RENDER_PHASE_PASSES) {
      resetHookCursor();
      throw updateDepthError(componentDisplayName(inst.vnode.type), inst);
    }
    restoreForReRender(inst, baselineLength);
    resetHookCursor();
    result = forwardsRef ? type(props, ref) : type(props);
    if (result instanceof Promise) throw asyncClientComponentError(inst);
  }
  return result;
}

/** `props` minus `ref` (a new object only when a ref is present). */
function withoutRef(props: unknown): unknown {
  if (!props || typeof props !== "object" || !("ref" in props)) return props;
  const { ref: _ref, ...rest } = props as Record<string, unknown>;
  return rest;
}

/**
 * The isomorphic island runtime's render hook (iso-island.ts): the wrapper render of a component
 * fiber whose element carries a `client:*` directive, else null. Null until a page loads it.
 */
let islandRender:
  | ((fiber: Fiber, type: unknown, props: Record<string, unknown>) => unknown)
  | null = null;

/** Install (or clear) the isomorphic island render hook. */
export function setIslandRender(fn: typeof islandRender): void {
  islandRender = fn;
}

/**
 * Dev Fast Refresh's per-render hooks ({@link RefreshSwapHooks}), installed by the refresh
 * runtime (refresh-swap.ts) and null in production, where a reused fiber never changes its
 * implementation: a component then renders its `vnode.type` with no resolution step.
 */
let refreshSwap: RefreshSwapHooks | null = null;

/** Install (or clear, with `null`) dev Fast Refresh's per-render hooks. */
export function setRefreshSwapHooks(hooks: RefreshSwapHooks | null): void {
  refreshSwap = hooks;
}

/** Set once the on-demand class runtime failed to load: surface the guided error, don't retry forever. */
let classRuntimeUnavailable = false;

/**
 * A class component reached the reconciler before the on-demand class runtime was installed:
 * it was not server-rendered on this page, so the entry had no `#__denext_classes` marker to
 * preload on — a soft navigation onto a class page, a `client:only` island. Start the load
 * (coalesced in class-loader.ts) and re-render this fiber when it lands. Inside a Suspense
 * boundary — or while hydrating — the load suspends like any thenable (fallback, or the whole
 * root keeping its server DOM, then retry); otherwise, with no boundary above, the fiber keeps
 * its committed child for this pass — nothing, on a first mount — and is
 * scheduled again, so the cost is at most one round trip of blank subtree. Only a load
 * failure surfaces the guided "class components are disabled" error.
 */
function awaitClassRuntime(inst: Fiber): VNode | null {
  const load = loadClassRuntime();
  const failed = (err: unknown) => {
    classRuntimeUnavailable = true;
    console.error("denext: the class-component runtime failed to load:", err);
  };
  // While hydrating, suspend (the whole root, with no boundary above): its server DOM stays and
  // the retry hydrates it, as React's selective hydration keeps a pending subtree dehydrated.
  if (isHydrating || findSuspense(inst)) {
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
    throw reconcilerError(ERR_CLASS_DISABLED, componentDisplayName(inst.vnode.type));
  }
  if (cs === null) return awaitClassRuntime(inst);
  const { vnode, bailed } = cs.renderClassInstance(inst as never);
  // Class lifecycle callbacks (componentDidMount / componentDidUpdate) and the class ref are
  // queued onto the fiber's effect arrays by the class-support bridge, NOT through
  // scheduleEffect — so set the HasEffect bit here too, or the flags-guided commit collectors
  // would prune the class fiber and its lifecycle would never fire. Set at render time so
  // bubbleFlags carries it; a bail can still queue a changed ref.
  if (
    (inst.pendingEffects && inst.pendingEffects.length > 0) ||
    (inst.passiveEffects && inst.passiveEffects.length > 0) ||
    (inst.ext?.insertionEffects && inst.ext.insertionEffects.length > 0)
  ) {
    inst.flags |= HasEffect;
  }
  if (bailed) {
    inst.bits |= BailedBit;
    return (inst.child?.vnode as VNode) ?? null;
  }
  return (vnode as VNode) ?? null;
}

type RenderFn = (props: unknown, ref?: unknown) => VNode;

/**
 * Resolve memo/forwardRef object wrappers to the render function. The fast path (a plain
 * function type) returns it unchanged with a single typeof check. A wrapper hiding a
 * class (`memo(Class)`) renders the class as its one child element, as React's
 * MemoComponent does: the memo fiber compares props (shallow, or the given `compare`) and
 * the class fiber below it runs the class runtime with the raw constructor. The check
 * runs only in the wrapped case, so the plain-function hot path pays nothing.
 */
function resolveRenderTarget(rawType: unknown): { fn: unknown; forwardsRef: boolean } {
  const resolved = resolveComponentType(rawType);
  // The flag first: with class components compiled out, this branch folds away, as before.
  if (__DENEXT_CLASS_COMPONENTS__ && resolved.fn !== rawType && isClassComponent(resolved.fn)) {
    // The element react-brands.ts' `memoClassElement` builds, inlined (the shared chunk's
    // budget); `resolved` is this call's own object.
    const type = resolved.fn as VNode["type"];
    resolved.fn = (props: VNode["props"]): VNode => ({
      $$typeof: REACT_ELEMENT_TYPE,
      type,
      props,
      key: null,
    });
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
  inst.idScope ??= enterScope(inst.idParentScope ?? rootScope());
  return props;
}

/**
 * Run the render phase, twice under StrictMode (dev) to surface impure render logic: the second
 * pass is {@linkcode strictSecondPass}, which only the dev path installs
 * ({@linkcode installStrictRender}), so a production bundle carries none of it.
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
  return strictPass !== null && hasBit(inst, StrictBit)
    ? strictPass(result, inst, baselineLength, type, props, ref, forwardsRef)
    : result ?? null;
}

/** The StrictMode second render pass; null until the dev path installs it. */
let strictPass: typeof strictSecondPass | null = null;

/**
 * StrictMode's second render pass (dev; `first` is used as is without `__denextDev`). The first
 * pass initialized hook cells and queued
 * effects; the second reads the same cells (no new effects, ids cached) and its result is the
 * one used. The scope's local id index is restored so an impure second pass that calls an
 * extra useId can't shift this component's ids. (Class components are not double-rendered —
 * they are gated and comparatively rare.)
 */
function strictSecondPass(
  first: VNode | null | undefined,
  inst: Fiber,
  baselineLength: number,
  type: RenderFn,
  props: unknown,
  ref: unknown,
  forwardsRef: boolean,
): VNode | null {
  if (!devHydrationActive()) return first ?? null;
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

/**
 * Install (`true`) or remove (`false`) StrictMode's dev double render. Called from the dev path
 * only (`installDevtools`, via {@linkcode installStrictMode}), so a production bundle never
 * contains it.
 */
export function installStrictRender(on = true): void {
  strictPass = on ? strictSecondPass : null;
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
  if (swap !== null) refreshSwap!.finish(inst, swap, hookIndex);
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
  const swap = refreshSwap === null ? null : refreshSwap.resolve(inst);
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
    // Before the class branch: a class is a `useId` level of its own too (its id scope), as
    // every server renderer counts it.
    const props = prepareRenderProps(inst);
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
    // An isomorphic island (iso-island.ts) renders its wrapper in place of the component.
    const island = islandRender?.(inst, rawType, props as Record<string, unknown>);
    if (island) {
      type = island as RenderFn;
      forwardsRef = false;
    }
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
