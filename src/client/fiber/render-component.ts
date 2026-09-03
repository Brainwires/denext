// Rendering one component fiber: dev Fast Refresh resolution, class components,
// memo/forwardRef unwrapping, prop preparation, the render-phase-update loop and
// the StrictMode double render.

import { devHydrationActive } from "./fiber-utils.ts";
import { fiberPropOverrides, overridesActive, renderProfiler } from "./devtools-bridge.ts";
import {
  clientDispatcher,
  currentFiber,
  enterComponentRender,
  hookIndex,
  renderPhaseUpdateScheduled,
  resetHookCursor,
} from "./hooks-dispatcher.ts";

import type { VNode } from "../../jsx/types.ts";
import { enterScope, ID_PATH_PROP, rootScope } from "../../jsx/tree-id.ts";
import type { DependencyList } from "../../compat/react-types.ts";
import { setDispatcher } from "../../runtime/hooks.ts";
import {
  familyResolveActive,
  reportSignatureChange,
  resolveFamilyCurrent,
  textVNode,
} from "../vnode-utils.ts";
import { classComponentsDisabledError, isClassComponent } from "../../compat/class-detect.ts";
import { resolveComponentType } from "../../runtime/react-brands.ts";
import { renderClassInstance } from "../../compat/class-component.ts";
import type { Fiber, HookCell } from "./fiber.ts";

/** Bound on render-phase re-invocations of one component (React's RE_RENDER_LIMIT). */
const MAX_RENDER_PHASE_PASSES = 25;

/** The error a client render throws when a component resolves to a Promise. */
function asyncClientComponentError(): Error {
  return new Error("denext: async components are server-only; cannot render on the client.");
}

/**
 * Reset a component's hooks to their render-start state before a render-phase
 * re-invocation (React's render-phase update — a component that calls its own
 * `setState`/`dispatch` while rendering itself). denext mutates `cell.deps` in place as
 * it queues effects and store subscriptions, so a naive re-render would compare a hook's
 * new deps against the deps the PREVIOUS (now discarded) sub-render just wrote —
 * suppressing effects that must still queue and dropping them when the effect queues are
 * cleared. Restoring the committed deps (captured in `depsBaseline`) makes each effect /
 * `useSyncExternalStore` subscription re-queue exactly when it changed vs the last
 * COMMITTED render, matching React. Cells created during a discarded sub-render (index
 * past the baseline) are reset to a fresh-mount state so their mount effect re-queues on
 * the final pass. The three effect queues are cleared so only the final sub-render's
 * effects reach the commit.
 */
function restoreForReRender(inst: Fiber, depsBaseline: Array<DependencyList | undefined>): void {
  const hooks = inst.hooks!;
  for (let i = 0; i < hooks.length; i++) {
    const c = hooks[i];
    if (i < depsBaseline.length) {
      c.deps = depsBaseline[i]; // committed deps: re-queue iff changed vs the last commit
    } else {
      c.deps = undefined; // created during a discarded sub-render — treat as a fresh mount
      c.mounted = false;
    }
  }
  inst.insertionEffects = [];
  inst.pendingEffects = [];
  inst.passiveEffects = [];
}

/**
 * Invoke a function component and converge any render-phase updates it makes to its OWN
 * state (Base UI's dialog/transition status, a `usePrevious`-style prop adjustment, and
 * other "adjust state while rendering" idioms). React re-renders just that component in
 * place — reading the updated state — until it stabilizes, with no commit in between;
 * denext does the same here rather than scheduling a whole-tree re-render + commit, which
 * never converges for this idiom (each pass commits, feeding the transition state back on
 * itself) and trips the render-pass guard, aborting the commit. `depsBaseline` is the
 * render-start deps snapshot used to restore hook state between sub-renders.
 */
function runRenderPhase(
  inst: Fiber,
  depsBaseline: Array<DependencyList | undefined>,
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
      throw new Error(
        "denext: Maximum update depth exceeded. A component repeatedly schedules an " +
          "update during its own render (e.g. calling setState unconditionally while rendering).",
      );
    }
    restoreForReRender(inst, depsBaseline);
    resetHookCursor();
    result = forwardsRef ? type(props, ref) : type(props);
    if (result instanceof Promise) throw asyncClientComponentError();
  }
  return result;
}

/** Run a component fiber's render, returning the single rendered vnode. */
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
 */
function resolveRefreshSwap(inst: Fiber): RefreshResolution {
  const resolveFR = familyResolveActive();
  const rawType = resolveFR ? resolveFamilyCurrent(inst.vnode.type) : inst.vnode.type;
  const refreshSwap = resolveFR
    ? (inst.alternate !== null && inst.alternate.lastImpl != null &&
      inst.alternate.lastImpl !== rawType)
    : (inst.alternate !== null && inst.vnode.type !== inst.alternate.vnode.type);
  if (resolveFR) inst.lastImpl = rawType;
  const oldKinds = refreshSwap && inst.hooks ? inst.hooks.map((c) => c.kind) : null;
  return { rawType, refreshSwap, oldKinds };
}

/**
 * Render a bare class component (raw type is a class) through the class runtime, which
 * reads `inst.vnode.type` as the constructor. (Per-module HMR does not substitute class
 * impls — an edited class module is reload-only — so the family-current impl equals
 * `inst.vnode.type` whenever this path is taken.) A shouldComponentUpdate/PureComponent
 * bail keeps the committed child.
 */
function renderClassFiber(inst: Fiber): VNode {
  if (!__DENEXT_CLASS_COMPONENTS__) throw classComponentsDisabledError();
  const { vnode, bailed } = renderClassInstance(inst as never);
  if (bailed) {
    inst.bailed = true;
    return (inst.child?.vnode as VNode) ?? textVNode("");
  }
  return (vnode as VNode) ?? textVNode("");
}

type RenderFn = (props: unknown, ref?: unknown) => VNode;

/**
 * Resolve memo/forwardRef object wrappers to the render function. The fast path (a plain
 * function type) returns it unchanged with a single typeof check. A wrapper hiding a
 * class (e.g. memo(Class)) can't go through the object path — the class runtime needs
 * the raw constructor — so it is rejected; the guard runs only in the wrapped case so
 * the plain-function hot path pays nothing.
 */
function resolveRenderTarget(rawType: unknown): { type: RenderFn; forwardsRef: boolean } {
  const resolved = resolveComponentType(rawType);
  const type = resolved.fn as RenderFn;
  if (type !== rawType && __DENEXT_CLASS_COMPONENTS__ && isClassComponent(type)) {
    throw new Error(
      "denext: memo() of a class component is unsupported; wrap the class in a " +
        "function component (or memo the function) instead.",
    );
  }
  return { type, forwardsRef: resolved.forwardsRef };
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
  if (overridesActive) {
    const ov = fiberPropOverrides(inst);
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
 * Each hook's render-start deps are snapshotted so a render-phase update (a component
 * that sets its own state while rendering) can re-invoke and converge locally — denext
 * mutates cell.deps in place, so the baseline is needed to re-queue effects correctly.
 * Cheap ref-copies; on the no-render-phase-update common path the snapshot is unused.
 */
function renderWithStrictMode(
  inst: Fiber,
  type: RenderFn,
  props: unknown,
  ref: unknown,
  forwardsRef: boolean,
): VNode {
  const depsBaseline = inst.hooks!.map((c) => c.deps);
  const result = runRenderPhase(inst, depsBaseline, type, props, ref, forwardsRef);
  if (inst.strict === true && devHydrationActive()) {
    const localAfterFirst = inst.idScope!.local;
    const second = runRenderPhase(
      inst,
      inst.hooks!.map((c) => c.deps),
      type,
      props,
      ref,
      forwardsRef,
    );
    inst.idScope!.local = localAfterFirst;
    return second ?? textVNode("");
  }
  return result ?? textVNode("");
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
  swap: RefreshResolution,
): void {
  if (swap.refreshSwap && hookSignatureChanged(swap.oldKinds, inst.hooks, hookIndex)) {
    reportSignatureChange();
  }
  if (inst.underProfiler === true) {
    const d = performance.now() - t0;
    inst.actualDuration = d;
    inst.selfBaseDuration = d;
  }
  if (renderProfiler !== null) renderProfiler(inst.vnode.type, performance.now() - profT0, inst);
}

export function renderComponent(inst: Fiber): VNode {
  const prevInst = currentFiber;
  const prevIdx = hookIndex;
  const swap = resolveRefreshSwap(inst);
  enterComponentRender(inst, 0);
  inst.insertionEffects = [];
  inst.pendingEffects = [];
  inst.passiveEffects = [];
  // Rebuild the read-context set from this render's useContext calls (accumulated
  // across any render-phase / StrictMode re-invocations, which read the same set).
  inst.readContexts = undefined;
  if (__DENEXT_CLASS_COMPONENTS__) inst.bailed = false;
  // Time the render for an enclosing <Profiler> (a bailed component never reaches
  // here, so its actualDuration stays 0 while selfBaseDuration carries over).
  const t0 = inst.underProfiler === true ? performance.now() : 0;
  // Dev-only DevTools profiler: time every component render while recording (null
  // otherwise, so the hot path is one null check).
  const profT0 = renderProfiler !== null ? performance.now() : 0;
  const prevDispatcher = setDispatcher(clientDispatcher);
  try {
    if (isClassComponent(inst.vnode.type)) return renderClassFiber(inst);
    const { type, forwardsRef } = resolveRenderTarget(swap.rawType);
    const props = prepareRenderProps(inst);
    // forwardRef threads `ref` via props (denext convention); a plain component
    // ignores the second argument.
    const ref = forwardsRef ? ((props as { ref?: unknown }).ref ?? null) : undefined;
    return renderWithStrictMode(inst, type, props, ref, forwardsRef);
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
