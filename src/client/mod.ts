/**
 * Client runtime public surface for the denext framework.
 *
 * Bundles the browser-side pieces a route bundle needs: the virtual-DOM
 * reconciler (mount, hydrate, flush), the hook and context primitives,
 * Suspense and error-boundary helpers, the JSX runtime, and soft client-side
 * navigation (the {@link Link} component and router hooks). Everything is
 * re-exported here so client components can import from a single entrypoint.
 *
 * @module
 */

// Client runtime public surface.

export { createRoot, flushSync, hydrateRoot, type Root, setDocument } from "./reconciler.ts";
export type {
  Component,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "../jsx/types.ts";
export type { NavigateOptions } from "./navigation.ts";

// Re-export hooks and context so client components import from one place.
export {
  startTransition,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useErrorBoundary,
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
} from "../runtime/hooks.ts";
export type {
  Context,
  EffectCleanup,
  ErrorBoundaryController,
  StateUpdater,
} from "../runtime/hooks.ts";
export { createContext } from "../runtime/context.ts";
export { useActionState, useFormStatus } from "../runtime/actions.ts";
export type { FormStatus } from "../runtime/actions.ts";
export { createResource, Suspense, use } from "../runtime/suspense.ts";
export type { SuspenseProps } from "../runtime/suspense.ts";
export { ErrorBoundary, forbidden, notFound, unauthorized } from "../runtime/error-boundary.ts";
export type { ErrorBoundaryProps, ErrorFallbackProps } from "../runtime/error-boundary.ts";
export { Fragment, h, jsx, jsxs } from "../jsx/jsx-runtime.ts";

export {
  Link,
  navigate,
  prefetch,
  startClient,
  useLocale,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "./navigation.ts";
export type { LinkProps, Router } from "./navigation.ts";
