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

export {
  createPortal,
  createRoot,
  flushSync,
  hydrateRoot,
  type Root,
  setDocument,
} from "./reconciler.ts";
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
  useEffectEvent,
  useErrorBoundary,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useMemoCache,
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
export { memo } from "../runtime/memo.ts";
export type { PropsComparator } from "../runtime/memo.ts";
export { createContext } from "../runtime/context.ts";
export { useActionState, useFormStatus } from "../runtime/actions.ts";
export type { FormStatus } from "../runtime/actions.ts";
export { createResource, Suspense, use } from "../runtime/suspense.ts";
export type { SuspenseProps } from "../runtime/suspense.ts";
export { dynamic } from "../runtime/dynamic.ts";
export type { DynamicLoader, DynamicOptions } from "../runtime/dynamic.ts";
export { ErrorBoundary, forbidden, notFound, unauthorized } from "../runtime/error-boundary.ts";
export type { ErrorBoundaryProps, ErrorFallbackProps } from "../runtime/error-boundary.ts";
// `jsx`/`jsxs` are compiler-runtime functions (imported via `denext/jsx-runtime`),
// not hand-written API — this entrypoint exposes only `h` and `Fragment`.
export { Fragment, h } from "../jsx/jsx-runtime.ts";

// Flight hydration: reconstruct a VNode tree from the server's Flight payload.
export { type ClientRegistry, parseFlight } from "./flight-client.ts";
export type { FlightNode } from "../jsx/render-to-flight.ts";
// The browser dispatch stub for a server reference (used by generated stubs).
export { clientActionStub } from "../runtime/server-action.ts";
// Layout-relative segment provider (used by the generated route entry).
export { type LayoutSegmentInfo, provideLayoutSegments } from "../runtime/layout-segments.ts";
// i18n message catalog: provider + interpolation backing useTranslations().
export {
  interpolate,
  makeTranslate,
  type Messages,
  provideMessages,
  type TranslateFn,
  type TranslationVars,
} from "../runtime/i18n-messages.ts";
// Public environment variables (client reads only the public-prefixed subset).
export { isPublicEnvKey, PUBLIC_ENV_PREFIXES, publicEnv } from "../runtime/public-env.ts";

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
  useTranslations,
} from "./navigation.ts";
export type { LinkProps, Router } from "./navigation.ts";
