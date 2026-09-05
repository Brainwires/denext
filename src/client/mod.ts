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
  act,
  createPortal,
  createRoot,
  flushSync,
  hydrateRoot,
  type Root,
  type RootOptions,
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
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useErrorBoundary,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "../runtime/hooks.ts";
export { Profiler } from "../runtime/profiler.ts";
export type { ProfilerOnRender, ProfilerPhase, ProfilerProps } from "../runtime/profiler.ts";
export type {
  Context,
  EffectCleanup,
  ErrorBoundaryController,
  StateUpdater,
} from "../runtime/hooks.ts";
export { memo } from "../runtime/memo.ts";
export type { PropsComparator } from "../runtime/memo.ts";
export { createContext } from "../runtime/context.ts";
// denext's first-party AsyncContext (Variable + Snapshot). Cross-`await` propagation
// requires the build transform (`experimental.asyncContext`).
export { AsyncContext } from "../runtime/async-context.ts";
export { useActionState, useFormStatus } from "../runtime/actions.ts";
export type { FormStatus } from "../runtime/actions.ts";
// Typed Server Actions — client-safe result type + idle-state helper.
export { idleActionState } from "../runtime/define-action.ts";
export type { ActionResult, TypedAction } from "../runtime/define-action.ts";
export { createResource, Suspense, SuspenseList, use } from "../runtime/suspense.ts";
export type { SuspenseListProps, SuspenseProps } from "../runtime/suspense.ts";
export { dynamic } from "../runtime/dynamic.ts";
export type { DynamicLoader, DynamicOptions } from "../runtime/dynamic.ts";
export { ErrorBoundary, forbidden, notFound, unauthorized } from "../runtime/error-boundary.ts";
export type { ErrorBoundaryProps, ErrorFallbackProps } from "../runtime/error-boundary.ts";
// `jsx`/`jsxs` are compiler-runtime functions (imported via `denext/jsx-runtime`),
// not hand-written API — this entrypoint exposes only `h` and `Fragment`.
export { Fragment, h } from "../jsx/jsx-runtime.ts";

// qrl: a lazily-loaded, code-split event handler with a stable identity — normally
// emitted by the qrl build transform, also usable by hand (see docs/resumability);
// `capturedScope` reads a handler's captured scope inside an extracted segment.
export { capturedScope, type Qrl, qrl } from "../runtime/qrl.ts";

export type { FlightNode } from "../jsx/render-to-flight.ts";

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
// Typed API client (pair with the generated `./.denext/api.ts` ApiSchema).
export { apiRequest, buildPath, createApiClient } from "../runtime/api-client.ts";
export type {
  ApiClient,
  ApiEndpoint,
  ApiRequestOptions,
  ApiSchema,
  HttpMethod,
  RequestArgs,
  RequestOf,
  RequiredKeys,
  ResponseOf,
} from "../runtime/api-client.ts";

export {
  Link,
  navigate,
  prefetch,
  useLocale,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
  useTranslations,
} from "./navigation.ts";
export type {
  AnchorProps,
  HrefInput,
  LinkProps,
  Router,
  RouterNavigateOptions,
  UrlObject,
} from "./navigation.ts";
