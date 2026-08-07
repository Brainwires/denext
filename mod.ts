/**
 * # denext
 *
 * A Next.js-style web framework for Deno, built on the standard library with
 * zero runtime npm dependencies. This is the main entry point: it re-exports
 * the JSX runtime, hooks, context, Suspense, error boundaries, client
 * navigation, and server rendering.
 *
 * @example Render a component to HTML
 * ```tsx
 * import { renderToString, useState } from "@denext/denext";
 *
 * function Hello({ name }: { name: string }) {
 *   return <h1>Hello {name}</h1>;
 * }
 *
 * const html = await renderToString(<Hello name="world" />);
 * ```
 *
 * @module
 */

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
  isValidAttrName,
  renderToString,
  serializeStyle,
} from "./src/jsx/render-to-string.ts";
export type { RenderOptions } from "./src/jsx/render-to-string.ts";

export { renderToReadableStream, streamToString } from "./src/jsx/render-to-stream.ts";
export type { StreamOptions } from "./src/jsx/render-to-stream.ts";

export { createResource, Suspense, use } from "./src/runtime/suspense.ts";
export type { SuspenseProps } from "./src/runtime/suspense.ts";

export {
  ErrorBoundary,
  forbidden,
  ForbiddenError,
  notFound,
  NotFoundError,
  permanentRedirect,
  redirect,
  RedirectError,
  unauthorized,
  UnauthorizedError,
} from "./src/runtime/error-boundary.ts";
export type { ErrorBoundaryProps, ErrorFallbackProps } from "./src/runtime/error-boundary.ts";

// Client navigation (safe to import on the server; DOM access is lazy).
export {
  Link,
  navigate,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "./src/client/navigation.ts";
export type { LinkProps, NavigateOptions, Router } from "./src/client/navigation.ts";

export {
  startTransition,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "./src/runtime/hooks.ts";
export type { Context, Dispatcher, EffectCleanup, Ref, StateUpdater } from "./src/runtime/hooks.ts";

export { createContext } from "./src/runtime/context.ts";

export { useActionState, useFormStatus } from "./src/runtime/actions.ts";
export type { FormStatus } from "./src/runtime/actions.ts";

/** The denext framework version. */
export const VERSION = "0.2.0";
