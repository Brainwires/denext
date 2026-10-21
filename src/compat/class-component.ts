/**
 * React class-component runtime for denext — the reconciler-side half. The `Component` /
 * `PureComponent` base classes live in {@link "./class-base.ts"} (eager: a module `extends`
 * them at evaluation time); everything a class needs only when it RENDERS on the client —
 * mount/update/unmount lifecycle, `setState` batching, `getDerivedStateFromProps`,
 * `shouldComponentUpdate`/`PureComponent` bailout, `getSnapshotBeforeUpdate`,
 * `getDerivedStateFromError`/`componentDidCatch`, legacy `contextType` — lives here, so the
 * generated browser entry can load it on demand as the `denext/class-runtime` chunk (see
 * {@link "../class-runtime.ts"}) and a function-only app never ships it. `renderClassToVNode` (SSR) lives with
 * the base in class-base.ts, so this module is referenced ONLY by that chunk.
 *
 * @module
 */

import "../runtime/class-flag.ts";
import type { Context } from "../runtime/hooks.ts";
import { getClassScheduleUpdate, setClassSupport } from "../client/fiber/class-support.ts";
import { type Fiber, fiberExt } from "../client/fiber/fiber.ts";
// Type only: a value import of dom-props.ts from this on-demand chunk re-splits the shared graph.
import type { HostState } from "../client/dom-props.ts";
import {
  type ClassInstanceFields,
  type ClassInternals,
  type ClassRenderResult,
  instantiateClass,
  internals,
  type ReconcilerInstance,
} from "./class-base.ts";

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
  const x = classFields(inst);
  let c = x.classInstance as Any;
  const isMount = c == null;
  // React 19 hands a class its props WITHOUT `ref` (the ref reaches the instance, not `props`).
  const nextProps = withoutRef(inst.vnode.props);

  if (isMount) {
    c = instantiateClass(Ctor, nextProps, contextForCtor(Ctor, inst), inst);
    x.classInstance = c;
  } else {
    c.context = contextForCtor(Ctor, inst); // refresh legacy context on update
  }

  const i = internals(c);
  const prevProps = c.props;
  const prevState = c.state;

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
    // A bailed class still swaps a changed ref, as React's finishClassComponent marks it first.
    queueRef(inst, c);
    return { vnode: null, bailed: true };
  }

  c.props = nextProps;
  c.state = nextState;
  i.forced = false;
  x.__prevProps = prevProps;
  x.__prevState = prevState;

  const vnode = c.render();
  (inst.pendingEffects ??= []).push(
    isMount ? mountEffect(c, i) : updateEffect(inst, c, i),
  );
  queueRef(inst, c);
  return { vnode, bailed: false };
}

/** `props` minus `ref` (a new object only when a ref is present). */
function withoutRef(props: Any): Any {
  if (props == null || !("ref" in props)) return props;
  const { ref: _ref, ...rest } = props;
  return rest;
}

/** The fiber's ref bookkeeping (the same fields a host's ref uses). */
function refState(inst: ReconcilerInstance): HostState {
  return inst as unknown as HostState;
}

/**
 * Queue the class's ref as a layout effect after its `componentDidMount` / `componentDidUpdate`,
 * as React's commit attaches a class ref (`safelyAttachRef`) — never during render. A changed ref
 * detaches the old one first; an unchanged one (or none at all) queues nothing.
 */
function queueRef(inst: ReconcilerInstance, c: Any): void {
  const ref = (inst.vnode.props as Any)?.ref;
  const s = refState(inst);
  if (!Object.is(ref ?? undefined, s.attachedRef)) {
    (inst.pendingEffects ??= []).push(() => setRef(s, ref, c));
  }
}

/**
 * Point the fiber's ref at `c` (`ref == null`: just detach), React 19 style: the old ref is
 * detached first (its returned cleanup, else a `null` call / `.current = null`), and a callback
 * ref may return a cleanup. dom-props.ts' `updateRef` does the same for a host; it is not
 * imported, so this chunk adds no edge into the shared graph.
 */
function setRef(s: HostState, ref: Any, c: unknown): void {
  if (Object.is(s.attachedRef, ref ?? undefined)) return;
  detachClassRef(s);
  if (ref == null) return;
  s.attachedRef = ref;
  if (typeof ref !== "function") ref.current = c;
  else {
    const cleanup = ref(c);
    if (typeof cleanup === "function") s.refCleanup = cleanup;
  }
}

/** Detach the attached ref: its returned cleanup, else a `null` call / `.current = null`. */
function detachClassRef(s: HostState): void {
  const old = s.attachedRef as Any;
  if (typeof s.refCleanup === "function") s.refCleanup();
  else if (typeof old === "function") old(null);
  else if (old != null) old.current = null;
  s.refCleanup = s.attachedRef = undefined;
}

/** The instance's class fields, allocating the fiber's extension on first use. */
function classFields(inst: ReconcilerInstance): ClassInstanceFields {
  return fiberExt(inst as unknown as Fiber);
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
      const x = inst.ext;
      c.componentDidUpdate(x?.__prevProps, x?.__prevState, x?.__snapshot);
    }
    flushCallbacks(i);
  };
}

/** Capture `getSnapshotBeforeUpdate` (after render, before DOM mutation). */
function captureSnapshot(inst: ReconcilerInstance): void {
  const x = classFields(inst);
  const c = x.classInstance as Any;
  x.__snapshot = c && typeof c.getSnapshotBeforeUpdate === "function"
    ? c.getSnapshotBeforeUpdate(x.__prevProps, x.__prevState)
    : undefined;
}

/**
 * Run `componentWillUnmount` for a class instance (on unmount, or when a hidden `<Activity>` /
 * re-suspended Suspense boundary hides it — React's `disappearLayoutEffects`). Only a mounted
 * instance runs it: one already hidden (or mounted hidden) has none to undo.
 */
function unmountClassInstance(inst: ReconcilerInstance): void {
  // The ref detaches BEFORE `componentWillUnmount`, as React's deletion / disappear does.
  detachClassRef(refState(inst));
  const c = inst.ext?.classInstance as Any;
  if (!c || !internals(c).mounted) return;
  internals(c).mounted = false;
  if (typeof c.componentWillUnmount === "function") c.componentWillUnmount();
}

/**
 * A hidden boundary hides (`visible: false`, `componentWillUnmount`) or shows again
 * (`componentDidMount`, plus the setState callbacks held while hidden) a class instance — React's
 * disappear / reappear layout effects. The reveal re-rendered it, but React runs
 * `componentDidMount` alone then, never the `componentDidUpdate` that render queued.
 */
function setClassVisible(inst: ReconcilerInstance, visible: boolean): void {
  const c = inst.ext?.classInstance as Any;
  if (!visible) return unmountClassInstance(inst);
  inst.pendingEffects = undefined;
  if (!internals(c).mounted) mountEffect(c, internals(c))();
  setRef(refState(inst), (inst.vnode.props as Any)?.ref, c);
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
  const c = inst.ext?.classInstance as Any;
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
 * Install the class runtime into the client-reconciler seam (class-support.ts). Reached
 * through the `denext/class-runtime` entrypoint: the generated route/Flight entry imports it
 * statically when the build scan saw a class in the app's own sources (or `classComponents:
 * true`), and otherwise loads it on demand — before hydrating — when the server-rendered
 * document carries the `#__denext_classes` marker. A function-only page never references
 * this, so the whole class runtime stays out of its bundle. Idempotent.
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
    setClassVisible,
  });
}
