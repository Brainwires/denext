/**
 * React class-component runtime for denext — the reconciler-side half. The `Component` /
 * `PureComponent` base classes live in {@link "./class-base.ts"} (eager: a module `extends`
 * them at evaluation time); everything a class needs only when it RENDERS on the client —
 * mount/update/unmount lifecycle, `setState` batching, `getDerivedStateFromProps`,
 * `shouldComponentUpdate`/`PureComponent` bailout, `getSnapshotBeforeUpdate`,
 * `getDerivedStateFromError`/`componentDidCatch`, legacy `contextType` — lives here, so the
 * generated browser entry can load it on demand as the `denext/class-runtime` chunk (see
 * {@link "../class-runtime.ts"}) and a function-only app never ships it. The SSR renderers
 * import `renderClassToVNode` from here directly (the server has no bundle-size gate).
 *
 * @module
 */

import "../runtime/class-flag.ts";
import type { Context } from "../runtime/hooks.ts";
import { getClassScheduleUpdate, setClassSupport } from "../client/fiber/class-support.ts";
import { type ClassInternals, internals, type ReconcilerInstance } from "./class-base.ts";

// The instance type is re-exported so the reconciler seam (class-support.ts) keeps resolving
// it from here; the base classes themselves are imported from class-base.ts directly.
export { type ReconcilerInstance } from "./class-base.ts";

// `scheduleUpdate` (class `setState`/`forceUpdate` re-render) is a client-only concern
// read through the reconciler seam (class-support.ts) rather than statically imported, so
// the SSR render path — which imports this module for `renderClassToVNode` — never drags
// the client reconciler graph and its browser-only scheduler handles into a server/CLI
// process. On the server the seam's no-op default is safe (the class runtime only renders).

// deno-lint-ignore no-explicit-any -- user components have heterogeneous prop/state shapes.
type Any = any;

/** Whether a class defines error-boundary lifecycle. */
function hasErrorLifecycle(type: unknown): boolean {
  if (typeof type !== "function") return false;
  return typeof (type as Any).getDerivedStateFromError === "function" ||
    typeof (type as Any).prototype?.componentDidCatch === "function";
}

/**
 * Construct a class instance and attach denext internals.
 *
 * @param Ctor The class-component constructor.
 * @param props Initial props.
 * @param context Legacy `contextType` value, if any.
 * @param inst The owning reconciler Instance (or null for SSR).
 * @returns The constructed class instance (with `__denext` internals).
 */
function instantiateClass(
  Ctor: unknown,
  props: unknown,
  context: unknown,
  inst: unknown,
): object {
  const c = new (Ctor as Any)(props, context);
  Object.defineProperty(c, "__denext", {
    value: {
      inst,
      pendingState: [],
      pendingCallbacks: [],
      forced: false,
      mounted: false,
    } as ClassInternals,
    enumerable: false,
    writable: true,
  });
  if (c.state === undefined || c.state === null) c.state = {};
  return c;
}

/**
 * Shallow-equal two objects (PureComponent default `shouldComponentUpdate`).
 *
 * @param a First value.
 * @param b Second value.
 * @returns Whether they are the same reference or shallow-equal objects.
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !Object.is(ao[k], bo[k])) return false;
  }
  return true;
}

/** Apply queued setState partials onto the current state, returning the next state. */
function applyPendingState(c: Any, i: ClassInternals, props: Any): Any {
  let next = c.state;
  for (const partial of i.pendingState) {
    const delta = typeof partial === "function" ? partial(next, props) : partial;
    if (delta != null) next = { ...next, ...delta };
  }
  i.pendingState.length = 0;
  return next;
}

/** Run and clear queued setState/forceUpdate callbacks. */
function flushCallbacks(i: ClassInternals): void {
  const cbs = i.pendingCallbacks;
  i.pendingCallbacks = [];
  for (const cb of cbs) cb();
}

/** Resolve the constructor's legacy `contextType` value from the instance's contexts. */
function contextForCtor(Ctor: Any, inst: ReconcilerInstance): unknown {
  const ctxType = Ctor.contextType as Context<unknown> | undefined;
  if (!ctxType || ctxType._id == null) return undefined;
  // Record the context read so the context-aware memo bailout treats a legacy
  // `static contextType` class exactly like a `useContext` consumer. Without this the
  // class is invisible to propagateContextChange/propsAndContextEqual (which key on
  // `readContexts`), so a provider value change is dropped whenever a memoized
  // non-consumer ancestor between the provider and this class bails the subtree.
  ((inst as { readContexts?: Set<symbol> }).readContexts ??= new Set()).add(ctxType._id);
  return inst.contexts.has(ctxType._id) ? inst.contexts.get(ctxType._id) : ctxType._defaultValue;
}

/** The result of {@link renderClassInstance}: the vnode to reconcile + a bail flag. */
export interface ClassRenderResult {
  /** The rendered vnode, or null when bailed. */
  vnode: unknown;
  /** True when `shouldComponentUpdate`/Pure bailed — reuse the prior subtree. */
  bailed: boolean;
}

/**
 * Render a class component on the client: instantiate on mount, apply
 * `getDerivedStateFromProps` + queued `setState`, honor `shouldComponentUpdate`/
 * Pure bailout, run `render()`, and queue mount/update lifecycle into the
 * instance's `pendingEffects` (drained post-commit by the reconciler).
 *
 * @param inst The reconciler Instance for this component.
 * @returns The vnode to reconcile and whether it bailed.
 */
function renderClassInstance(inst: ReconcilerInstance): ClassRenderResult {
  const Ctor = inst.vnode.type as Any;
  let c = inst.classInstance as Any;
  const isMount = c == null;

  if (isMount) {
    c = instantiateClass(Ctor, inst.vnode.props, contextForCtor(Ctor, inst), inst);
    inst.classInstance = c;
  } else {
    c.context = contextForCtor(Ctor, inst); // refresh legacy context on update
  }

  const i = internals(c);
  const prevProps = c.props;
  const prevState = c.state;
  const nextProps = inst.vnode.props;

  let nextState = applyPendingState(c, i, nextProps);
  const gdsfp = Ctor.getDerivedStateFromProps;
  if (typeof gdsfp === "function") {
    const derived = gdsfp(nextProps, nextState);
    if (derived != null) nextState = { ...nextState, ...derived };
  }

  if (!isMount && !i.forced && bailsOut(c, nextProps, nextState, prevProps, prevState)) {
    c.props = nextProps;
    c.state = nextState;
    flushCallbacks(i);
    return { vnode: null, bailed: true };
  }

  c.props = nextProps;
  c.state = nextState;
  i.forced = false;
  inst.__prevProps = prevProps;
  inst.__prevState = prevState;

  const vnode = c.render();
  (inst.pendingEffects ??= []).push(
    isMount ? mountEffect(c, i) : updateEffect(inst, c, i),
  );
  return { vnode, bailed: false };
}

/** `shouldComponentUpdate` says no, or a PureComponent sees shallow-equal props + state. */
function bailsOut(c: Any, nextProps: Any, nextState: Any, prevProps: Any, prevState: Any): boolean {
  if (typeof c.shouldComponentUpdate === "function") {
    return !c.shouldComponentUpdate(nextProps, nextState, c.context);
  }
  return c.isPureReactComponent === true &&
    shallowEqual(prevProps, nextProps) && shallowEqual(prevState, nextState);
}

function mountEffect(c: Any, i: ClassInternals): () => void {
  return () => {
    i.mounted = true;
    if (typeof c.componentDidMount === "function") c.componentDidMount();
    flushCallbacks(i);
  };
}

function updateEffect(inst: ReconcilerInstance, c: Any, i: ClassInternals): () => void {
  return () => {
    if (typeof c.componentDidUpdate === "function") {
      c.componentDidUpdate(inst.__prevProps, inst.__prevState, inst.__snapshot);
    }
    flushCallbacks(i);
  };
}

/** Capture `getSnapshotBeforeUpdate` (after render, before DOM mutation). */
function captureSnapshot(inst: ReconcilerInstance): void {
  const c = inst.classInstance as Any;
  if (c && typeof c.getSnapshotBeforeUpdate === "function") {
    inst.__snapshot = c.getSnapshotBeforeUpdate(inst.__prevProps, inst.__prevState);
  } else {
    inst.__snapshot = undefined;
  }
}

/** Run `componentWillUnmount` for a class instance (on unmount). */
function unmountClassInstance(inst: ReconcilerInstance): void {
  const c = inst.classInstance as Any;
  if (c && typeof c.componentWillUnmount === "function") c.componentWillUnmount();
}

/**
 * Route a caught descendant error to a class error boundary: apply
 * `getDerivedStateFromError` (schedules a re-render to the fallback) and call
 * `componentDidCatch`. Returns whether this instance handled it.
 *
 * @param inst The boundary's reconciler Instance.
 * @param error The caught error.
 * @param info The React error info (`{ componentStack }`).
 * @returns Whether the boundary handled the error.
 */
function handleClassError(
  inst: ReconcilerInstance,
  error: unknown,
  info: { componentStack?: string },
): boolean {
  const c = inst.classInstance as Any;
  if (!c) return false;
  const Ctor = inst.vnode.type as Any;
  let handled = false;
  if (typeof Ctor.getDerivedStateFromError === "function") {
    // Declaring getDerivedStateFromError makes the class a boundary — a `null` return
    // (no state change) still handles the error, as in React.
    const derived = Ctor.getDerivedStateFromError(error);
    const i = internals(c);
    if (derived != null) i.pendingState.push(derived);
    getClassScheduleUpdate()(i.inst as Any);
    handled = true;
  }
  if (typeof c.componentDidCatch === "function") {
    c.componentDidCatch(error, info);
    handled = true;
  }
  return handled;
}

/**
 * Server-render a class component to a vnode: instantiate, apply
 * `getDerivedStateFromProps`, call `render()`. No lifecycle effects (React server
 * behavior).
 *
 * @param type The class component.
 * @param props The props.
 * @param context Legacy context value, if resolvable.
 * @returns The rendered vnode.
 */
export function renderClassToVNode(type: unknown, props: unknown, context: unknown): unknown {
  const c = instantiateClass(type, props, context, null) as Any;
  let state = c.state;
  const g = (type as Any).getDerivedStateFromProps;
  if (typeof g === "function") {
    const d = g(props, state);
    if (d != null) state = { ...state, ...d };
  }
  c.state = state;
  return c.render();
}

/**
 * Install the class runtime into the client-reconciler seam (class-support.ts). Emitted
 * and called by the generated route/Flight entry ONLY when the app uses class components
 * (or `classComponents` is forced on), so a function-only bundle never references this —
 * and `deno bundle` then tree-shakes the whole class runtime out. Idempotent.
 */
export function installClassSupport(): void {
  // The flag guard lets the compat esbuild `define` fold this body to a no-op when
  // `classComponents` is off — the class runtime then becomes unreferenced and drops from
  // the prebuilt compat runtime chunk (whose entry-point exports don't otherwise
  // tree-shake). On the native path the flag is the runtime-global `true` and the whole
  // function tree-shakes anyway when the app doesn't use classes.
  if (!__DENEXT_CLASS_COMPONENTS__) return;
  setClassSupport({
    handleClassError,
    renderClassInstance,
    hasErrorLifecycle,
    captureSnapshot,
    unmountClassInstance,
  });
}
