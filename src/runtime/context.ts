// createContext — provider/consumer pairs resolved through the hook dispatcher.
// The actual value lookup lives in each dispatcher's `useContext`, which walks
// the provider stack maintained during rendering.

import { activeDispatcher, type Context, rendering } from "./hooks.ts";
import { FRAGMENT, type VNode, type VNodeChild } from "../jsx/types.ts";

/** Marks a VNode as a context provider so the renderer can push/pop its value. */
export const PROVIDER: symbol = Symbol.for("denext.provider");

/**
 * Where the `react` entry (src/compat/react-internals.ts) installs what a `react-reconciler`
 * renderer gets from a context's provider or `.Consumer`: called outside denext's own render, each
 * returns an element of the context's React twin (or of the twin's consumer), which that renderer
 * provides and reads as it does a React context.
 */
export const FOREIGN_PROVIDER: unique symbol = Symbol.for("denext.foreignProvider");

/** Builds the element a foreign renderer gets (see {@linkcode FOREIGN_PROVIDER}). */
type ForeignElement = (context: unknown, props: unknown, consumer: boolean) => VNode;

/**
 * The foreign renderer's element builder while one calls a context component, else undefined:
 * denext renders every component with its dispatcher installed, so a call without one is a
 * `react-reconciler` renderer's.
 */
function foreignElement(): ForeignElement | undefined {
  return rendering()
    ? undefined
    : (globalThis as { [FOREIGN_PROVIDER]?: ForeignElement })[FOREIGN_PROVIDER];
}

/** Non-enumerable brand stamped on a context `.Consumer` (for `react-is`). */
export const CONSUMER_BRAND: symbol = Symbol.for("denext.context.consumer");

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
  const provider = (props: { value: T; children?: unknown }): VNode => {
    const foreign = foreignElement();
    if (foreign) return foreign(context, props, false);
    return {
      type: FRAGMENT,
      key: null,
      props: {
        children: props.children as never,
        [PROVIDER as unknown as string]: { id, value: props.value },
      },
    };
  };
  // The context object IS the provider, with metadata attached, so both
  // `<MyContext value>` and `<MyContext.Provider value>` work.
  const context = provider as unknown as Context<T>;
  context._id = id;
  context._defaultValue = defaultValue;
  // React's own fields: a `react-reconciler` renderer (React Native Skia's <Canvas>) reads the
  // value of a context it has no provider for from these, and writes them for its host contexts.
  // Across renderers a context reads its default, as in React.
  const fields = context as unknown as { _currentValue: T; _currentValue2: T };
  fields._currentValue = fields._currentValue2 = defaultValue;
  context.Provider = provider as unknown as Context<T>["Provider"];
  // Legacy render-prop consumer: `<MyContext.Consumer>{value => …}</MyContext.Consumer>`.
  // Some libraries (react-spring, older UI kits) also just reference `.Consumer` and
  // assign to it (e.g. `Consumer._context = ctx`), so it must exist as an object.
  // Wrap the render-prop result in a Fragment: render props idiomatically return a
  // bare string/number/array, and on the client a component's raw return goes
  // straight to mount() — a fragment routes it through child normalization instead.
  // A foreign renderer reads the context itself; denext reads it from its dispatcher (what
  // `useContext` does).
  const Consumer = (props: { children: (value: T) => VNodeChild }): VNode =>
    foreignElement()?.(context, props, true) ?? {
      type: FRAGMENT,
      key: null,
      props: { children: props.children(activeDispatcher().useContext(context)) as never },
    };
  // Brand it (non-enumerably, so it never leaks into props/serialization) and
  // back-reference its context, matching React's `Consumer._context` so
  // `react-is.isContextConsumer` and libraries reading `_context` both work.
  Object.defineProperty(Consumer, CONSUMER_BRAND, { value: true, enumerable: false });
  (Consumer as unknown as { _context: Context<T> })._context = context;
  context.Consumer = Consumer as unknown as Context<T>["Consumer"];
  return context;
}
