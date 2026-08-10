/**
 * React class-component runtime for denext, gated behind `classComponents` (see
 * {@link "../runtime/class-flag.ts"}). Everything class-specific lives here so the
 * build gate has a single import to include/exclude — a function-only project
 * never pulls this module.
 *
 * Full semantics: `setState`/`forceUpdate` (batched via the reconciler's existing
 * scheduler), `getDerivedStateFromProps`, `shouldComponentUpdate`,
 * `PureComponent`, mount/update/unmount lifecycle, `getSnapshotBeforeUpdate`,
 * `getDerivedStateFromError`/`componentDidCatch`, and legacy `contextType`.
 *
 * @module
 */

import { scheduleUpdate } from "../client/reconciler.ts";
import type { Context } from "../runtime/hooks.ts";
import type { VNode } from "../jsx/types.ts";

/** Object marker on `Component.prototype` (React parity; Jest-automock safe). */
export const IS_REACT_COMPONENT: Record<never, never> = {};

/** denext-internal per-instance state, stashed non-enumerably on a class instance. */
interface ClassInternals {
  /** The reconciler Instance that owns this class instance. */
  inst: ReconcilerInstance;
  /** Queued `setState` partials (objects or updater fns), applied in order. */
  pendingState: Array<unknown>;
  /** Queued `setState`/`forceUpdate` callbacks, run after commit. */
  pendingCallbacks: Array<() => void>;
  /** `forceUpdate` bypasses `shouldComponentUpdate` for the next render. */
  forced: boolean;
  /** Whether `componentDidMount` has run. */
  mounted: boolean;
}

/** The subset of the reconciler `Instance` the class runtime touches. */
interface ReconcilerInstance {
  vnode: VNode;
  contexts: Map<symbol, unknown>;
  pendingEffects?: Array<() => void>;
  classInstance?: unknown;
  __snapshot?: unknown;
  __prevProps?: unknown;
  __prevState?: unknown;
}

// deno-lint-ignore no-explicit-any -- user components have heterogeneous prop/state shapes.
type Any = any;

/** React `Component` base class. */
export class Component<P = Record<string, unknown>, S = Record<string, unknown>> {
  /** The component's props. */
  props: P;
  /** The component's state. */
  state: S;
  /** Legacy `contextType` value. */
  context: unknown;
  /** Legacy string refs. */
  refs: Record<string, unknown> = {};

  /**
   * @param props Initial props.
   * @param context Legacy context value (from `contextType`).
   */
  constructor(props: P, context?: unknown) {
    this.props = props;
    this.context = context;
    this.state = undefined as unknown as S;
  }

  /** Schedule a state update (merged/queued, batched into one re-render). */
  setState(partial: Partial<S> | ((s: S, p: P) => Partial<S>), callback?: () => void): void {
    const i = internals(this);
    i.pendingState.push(partial);
    if (callback) i.pendingCallbacks.push(callback);
    scheduleUpdate(i.inst as Any);
  }

  /** Force a re-render, bypassing `shouldComponentUpdate`. */
  forceUpdate(callback?: () => void): void {
    const i = internals(this);
    i.forced = true;
    if (callback) i.pendingCallbacks.push(callback);
    scheduleUpdate(i.inst as Any);
  }

  /** Render the component. Subclasses must override. */
  render(): unknown {
    throw new Error("denext: class component is missing a render() method");
  }
}
(Component.prototype as Any).isReactComponent = IS_REACT_COMPONENT;

/** React `PureComponent` — default `shouldComponentUpdate` is a shallow compare. */
export class PureComponent<P = Record<string, unknown>, S = Record<string, unknown>>
  extends Component<P, S> {}
(PureComponent.prototype as Any).isPureReactComponent = true;

/** Read the denext internals off a class instance. */
function internals(c: unknown): ClassInternals {
  return (c as { __denext: ClassInternals }).__denext;
}

/** Whether `type` is a React class component (has `prototype.isReactComponent`). */
export function isClassComponent(type: unknown): boolean {
  return typeof type === "function" &&
    !!(type as Any).prototype &&
    (type as Any).prototype.isReactComponent != null;
}

/** Whether a class defines error-boundary lifecycle. */
export function hasErrorLifecycle(type: unknown): boolean {
  if (typeof type !== "function") return false;
  return typeof (type as Any).getDerivedStateFromError === "function" ||
    typeof (type as Any).prototype?.componentDidCatch === "function";
}

/** Construct a class instance and attach denext internals. */
export function instantiateClass(
  Ctor: Any,
  props: Any,
  context: unknown,
  inst: unknown,
): Any {
  const c = new Ctor(props, context);
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

/** Shallow-equal two objects (PureComponent default SCU). */
export function shallowEqual(a: Any, b: Any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
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
export function renderClassInstance(inst: ReconcilerInstance): ClassRenderResult {
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

  if (!isMount && !i.forced && typeof c.shouldComponentUpdate === "function") {
    if (!c.shouldComponentUpdate(nextProps, nextState, c.context)) {
      c.props = nextProps;
      c.state = nextState;
      flushCallbacks(i);
      return { vnode: null, bailed: true };
    }
  }
  if (
    !isMount && !i.forced && (c as Any).isPureReactComponent &&
    shallowEqual(prevProps, nextProps) && shallowEqual(prevState, nextState)
  ) {
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

  inst.pendingEffects ??= [];
  if (isMount) {
    inst.pendingEffects.push(() => {
      i.mounted = true;
      if (typeof c.componentDidMount === "function") c.componentDidMount();
      flushCallbacks(i);
    });
  } else {
    inst.pendingEffects.push(() => {
      if (typeof c.componentDidUpdate === "function") {
        c.componentDidUpdate(inst.__prevProps, inst.__prevState, inst.__snapshot);
      }
      flushCallbacks(i);
    });
  }

  return { vnode, bailed: false };
}

/** Capture `getSnapshotBeforeUpdate` (after render, before DOM mutation). */
export function captureSnapshot(inst: ReconcilerInstance): void {
  const c = inst.classInstance as Any;
  if (c && typeof c.getSnapshotBeforeUpdate === "function") {
    inst.__snapshot = c.getSnapshotBeforeUpdate(inst.__prevProps, inst.__prevState);
  } else {
    inst.__snapshot = undefined;
  }
}

/** Run `componentWillUnmount` for a class instance (on unmount). */
export function unmountClassInstance(inst: ReconcilerInstance): void {
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
export function handleClassError(
  inst: ReconcilerInstance,
  error: unknown,
  info: { componentStack?: string },
): boolean {
  const c = inst.classInstance as Any;
  if (!c) return false;
  const Ctor = inst.vnode.type as Any;
  let handled = false;
  if (typeof Ctor.getDerivedStateFromError === "function") {
    const derived = Ctor.getDerivedStateFromError(error);
    if (derived != null) {
      const i = internals(c);
      i.pendingState.push(derived);
      scheduleUpdate(i.inst as Any);
      handled = true;
    }
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
export function renderClassToVNode(type: Any, props: Any, context: unknown): unknown {
  const c = instantiateClass(type, props, context, null);
  let state = c.state;
  const g = type.getDerivedStateFromProps;
  if (typeof g === "function") {
    const d = g(props, state);
    if (d != null) state = { ...state, ...d };
  }
  c.state = state;
  return c.render();
}
