/**
 * The eager half of the React class-component runtime: the `Component` / `PureComponent`
 * base classes and the per-instance internals they share with the reconciler-side half in
 * {@link "./class-component.ts"}.
 *
 * Why two modules: a user module `extends React.Component` at module-evaluation time, so
 * the base class must be present in every bundle that aliases `react` — but the
 * reconciler-side runtime (mount/update/unmount lifecycle, `shouldComponentUpdate`, error
 * boundaries; the bulk of the bytes) is only needed when a class actually renders on the
 * client. Keeping the base here lets that half live in the on-demand `denext/class-runtime`
 * chunk while `react.ts` keeps a tiny static import. `setState`/`forceUpdate` reach the
 * reconciler through the class-support seam, so this module never imports the fiber graph.
 *
 * @module
 */

import type { VNode } from "../jsx/types.ts";
import { getClassScheduleUpdate } from "../client/fiber/class-support.ts";

/** Object marker on `Component.prototype` (React parity; Jest-automock safe). */
const IS_REACT_COMPONENT: Record<never, never> = {};

/** denext-internal per-instance state, stashed non-enumerably on a class instance. */
export interface ClassInternals {
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

/**
 * The subset of the reconciler `Instance` the class runtime touches. Exported so the
 * class helpers have a public parameter type; callers pass their real `Instance` (a
 * superset).
 */
export interface ReconcilerInstance {
  /** The element being rendered (its `type` is the class constructor). */
  vnode: VNode;
  /** Context values visible to this instance, keyed by context id. */
  contexts: Map<symbol, unknown>;
  /** Post-commit effects the reconciler drains (mount/update lifecycle is queued here). */
  pendingEffects?: Array<() => void>;
  /** The user's class instance, created on mount. */
  classInstance?: unknown;
  /** The `getSnapshotBeforeUpdate` return value, captured before DOM mutation. */
  __snapshot?: unknown;
  /** Props from before the current render (for `componentDidUpdate`). */
  __prevProps?: unknown;
  /** State from before the current render (for `componentDidUpdate`). */
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
   * Create the component. React passes props and (legacy) context.
   *
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
    getClassScheduleUpdate()(i.inst as Any);
  }

  /** Force a re-render, bypassing `shouldComponentUpdate`. */
  forceUpdate(callback?: () => void): void {
    const i = internals(this);
    i.forced = true;
    if (callback) i.pendingCallbacks.push(callback);
    getClassScheduleUpdate()(i.inst as Any);
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
export function internals(c: unknown): ClassInternals {
  return (c as { __denext: ClassInternals }).__denext;
}
