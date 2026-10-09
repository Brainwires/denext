/**
 * Class-component instantiation and the server render (`renderClassToVNode`), split from
 * {@link "./class-base.ts"} so the SSR renderer can import them without reaching the
 * `Component` / `PureComponent` base classes. The root `denext` entry re-exports the server
 * renderer, so its static imports are reachable from every app's client graph: importing the
 * base classes from there hoisted them into every app's shared runtime chunk, even an app with
 * no class component (they belong to the on-demand `denext/class-runtime` chunk).
 *
 * @module
 */

import type { ClassInternals } from "./class-base.ts";

// deno-lint-ignore no-explicit-any -- user components have heterogeneous prop/state shapes.
type Any = any;

/**
 * Construct a class instance and attach denext internals.
 *
 * @param Ctor The class-component constructor.
 * @param props Initial props.
 * @param context Legacy `contextType` value, if any.
 * @param inst The owning reconciler Instance (or null for SSR).
 * @returns The constructed class instance (with `__denext` internals).
 */
export function instantiateClass(
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
