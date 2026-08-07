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
  renderToReadableStream,
  streamToString,
} from "./src/jsx/render-to-stream.ts";
export type { StreamOptions } from "./src/jsx/render-to-stream.ts";

export {
  createResource,
  Suspense,
  use,
} from "./src/runtime/suspense.ts";
export type { SuspenseProps } from "./src/runtime/suspense.ts";

export {
  ErrorBoundary,
  notFound,
  NotFoundError,
} from "./src/runtime/error-boundary.ts";
export type {
  ErrorBoundaryProps,
  ErrorFallbackProps,
} from "./src/runtime/error-boundary.ts";

// Client navigation (safe to import on the server; DOM access is lazy).
export {
  Link,
  navigate,
  useRouter,
  usePathname,
  useSearchParams,
} from "./src/client/navigation.ts";
export type { LinkProps, Router } from "./src/client/navigation.ts";

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
