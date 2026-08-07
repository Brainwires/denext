// Client runtime public surface.

export {
  createRoot,
  flushSync,
  hydrateRoot,
  type Root,
  setDocument,
} from "./reconciler.ts";

// Re-export hooks and context so client components import from one place.
export {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../runtime/hooks.ts";
export { createContext } from "../runtime/context.ts";
export { h, jsx, jsxs, Fragment } from "../jsx/jsx-runtime.ts";
