// createContext — provider/consumer pairs resolved through the hook dispatcher.
// The actual value lookup lives in each dispatcher's `useContext`, which walks
// the provider stack maintained during rendering.

import { type Context, useContext } from "./hooks.ts";
import { FRAGMENT, type VNode, type VNodeChild } from "../jsx/types.ts";

/** Marks a VNode as a context provider so the renderer can push/pop its value. */
export const PROVIDER: symbol = Symbol.for("denext.provider");

/**
 * Create a context with the given default value. The returned {@link Context} is
 * usable directly as a provider element (`<MyContext value={v}>`, React 19
 * style) and also exposes `.Provider`; `useContext(MyContext)` reads the nearest
 * provided value, falling back to `defaultValue`.
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol("denext.context");
  // The provider function: a fragment carrying the provider marker the renderer
  // pushes onto the context scope stack.
  const provider = (props: { value: T; children?: unknown }): VNode => ({
    type: FRAGMENT,
    key: null,
    props: {
      children: props.children as never,
      [PROVIDER as unknown as string]: { id, value: props.value },
    },
  });
  // The context object IS the provider, with metadata attached, so both
  // `<MyContext value>` and `<MyContext.Provider value>` work.
  const context = provider as unknown as Context<T>;
  context._id = id;
  context._defaultValue = defaultValue;
  context.Provider = provider as unknown as Context<T>["Provider"];
  // Legacy render-prop consumer: `<MyContext.Consumer>{value => …}</MyContext.Consumer>`.
  // Some libraries (react-spring, older UI kits) also just reference `.Consumer` and
  // assign to it (e.g. `Consumer._context = ctx`), so it must exist as an object.
  const Consumer = (props: { children: (value: T) => VNodeChild }): VNodeChild =>
    props.children(useContext(context));
  context.Consumer = Consumer as unknown as Context<T>["Consumer"];
  return context;
}
