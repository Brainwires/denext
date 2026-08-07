// createContext — provider/consumer pairs resolved through the hook dispatcher.
// The actual value lookup lives in each dispatcher's `useContext`, which walks
// the provider stack maintained during rendering.

import type { Context } from "./hooks.ts";
import { FRAGMENT, type VNode } from "../jsx/types.ts";

/** Marks a VNode as a context provider so the renderer can push/pop its value. */
export const PROVIDER = Symbol.for("denext.provider");

export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol("denext.context");
  const context: Context<T> = {
    _id: id,
    _defaultValue: defaultValue,
    Provider: (props): VNode => ({
      type: FRAGMENT,
      key: null,
      props: {
        children: props.children,
        [PROVIDER as unknown as string]: { id, value: props.value },
      },
    }),
  };
  return context;
}
