// denext — a Next.js-style web framework for Deno, built on the standard library.
//
// Public entry point. Re-exports the JSX runtime, hooks, context, and SSR so
// user code can `import { useState, renderToString } from "denext"`.

export { Fragment, h, jsx, jsxDEV, jsxs } from "./src/jsx/jsx-runtime.ts";
export type {
  Component,
  JSX,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VProps,
} from "./src/jsx/types.ts";

export {
  escapeHtml,
  renderToString,
  serializeStyle,
} from "./src/jsx/render-to-string.ts";

export {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "./src/runtime/hooks.ts";
export type { Context, Dispatcher, StateUpdater } from "./src/runtime/hooks.ts";

export { createContext } from "./src/runtime/context.ts";

export const VERSION = "0.1.0";
