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
  useMemoCache,
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
export { useActionState, useFormStatus } from "../runtime/actions.ts";
export type { FormStatus } from "../runtime/actions.ts";
export { createResource, Suspense, SuspenseList, use } from "../runtime/suspense.ts";
export type { SuspenseListProps, SuspenseProps } from "../runtime/suspense.ts";
export { dynamic } from "../runtime/dynamic.ts";
export type { DynamicLoader, DynamicOptions } from "../runtime/dynamic.ts";
export { ErrorBoundary, forbidden, notFound, unauthorized } from "../runtime/error-boundary.ts";
export type { ErrorBoundaryProps, ErrorFallbackProps } from "../runtime/error-boundary.ts";
// `jsx`/`jsxs` are compiler-runtime functions (imported via `denext/jsx-runtime`),
// not hand-written API — this entrypoint exposes only `h` and `Fragment`.
export { Fragment, h } from "../jsx/jsx-runtime.ts";

// Dev Fast Refresh runtime: family registration + state-preserving reconcile.
// Emitted only into dev route entries; never referenced by a production bundle.
export { enableFastRefresh, registerFamily } from "./refresh-runtime.ts";

// Flight hydration: reconstruct a VNode tree from the server's Flight payload.
export { type ClientRegistry, parseFlight } from "./flight-client.ts";
export type { FlightNode } from "../jsx/render-to-flight.ts";
// The browser dispatch stub for a server reference (used by generated stubs).
export { clientActionStub } from "../runtime/server-action.ts";
// qrl: a lazily-loaded, code-split event handler with a stable identity.
// `capturedScope` reads a handler's captured scope inside an extracted segment
// (normally the qrl build transform emits the call; also usable by hand).
export { capturedScope, type Qrl, qrl } from "../runtime/qrl.ts";

// Islands inspector (dev): the hydration timeline — which islands hydrated, when, and
// under which client:* strategy (also on window.__denextIslands). Empty in production.
export { getIslandTimeline, type IslandHydration } from "./lazy-hydrate.ts";
// First-party DevTools (dev): the native inspector API + the in-page glass-box panel.
// `installDevtools` is emitted only into dev route/Flight entries; a production bundle
// never references it. The public `denext/devtools` module re-exports the same surface.
export {
  type DenextDevtoolsApi,
  getInspectorTree,
  getPageRenderMode,
  getRenderModes,
  type InspectContext,
  type InspectHook,
  type InspectNode,
  installInspector,
  type PageRenderMode,
  type RenderModeEntry,
  type SerializedValue,
  setHookState,
  subscribe,
} from "./devtools-inspect.ts";
export { installDevtools } from "./devtools-panel.ts";
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
  setFlightParser,
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
