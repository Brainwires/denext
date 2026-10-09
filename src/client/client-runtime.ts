/**
 * The client-side runtime surface that denext's GENERATED browser entries import: the
 * route/Flight entry (`denext build`, `denext dev`), the SPA dev entry, the Pages Router
 * client entry and the Server Action client stubs. It is a stable specifier for emitted
 * code, like `denext/compiler-runtime` is for the build transforms — not API an
 * application author calls. Apps use `denext/client`.
 *
 * @module
 */

// Boot: mount/hydrate the page, install soft navigation, seed the layout-segment hooks.
export { setResumabilityReboot, startClient, startGlobalErrorClient } from "./navigation.ts";
// Flight soft navigation: only the generated Flight entry calls this, so an app with no Flight
// route tree-shakes the whole Flight soft-nav runtime (flight-nav.ts) out of its bundle.
export { setFlightParser } from "./flight-nav.ts";
export { type LayoutSegmentInfo, provideLayoutSegments } from "../runtime/layout-segments.ts";
// Flight hydration: reconstruct a VNode tree from the server's Flight payload.
export {
  type ClientRegistry,
  ensureFlightModules,
  flightClientIds,
  parseFlight,
} from "./flight-client.ts";
// A streamed Flight document's tree: the shell + each hole / deferred value as it streamed.
export { readStreamedFlight } from "./streamed-flight.ts";
// Server Actions: the browser dispatch stub emitted for each `"use server"` export.
export { clientActionStub } from "../runtime/server-action.ts";
// Class components: `installClassSupport` lives in its own entrypoint, `denext/class-runtime`
// (a code-split chunk). The entry imports it statically when the build scan saw a class, and
// otherwise calls `loadClassRuntime()` — the single dynamic-import site — when the document
// says the server rendered a class. The install itself is deliberately NOT re-exported here.
export { loadClassRuntime } from "./class-loader.ts";
// Activity: the entry emits `installActivitySupport()` to wire the offscreen scheduler into
// the reconciler seam ONLY when the app uses `<Activity>` — so an app that never renders one
// drops this re-export (and the whole offscreen begin logic) via tree-shaking.
export { installActivitySupport } from "./fiber/activity-runtime.ts";
// ViewTransition: the entry emits `installViewTransitionSupport()` to wire the per-element
// marking runtime into the reconciler seam ONLY when the app uses `<ViewTransition>` — so an
// app that never renders one drops this re-export (and the marking logic) via tree-shaking.
export { installViewTransitionSupport } from "./fiber/view-transition-runtime.ts";
// Host singletons: the entry emits `installSingletonSupport()` ONLY when the app's sources render
// a document tag (a client root layout's `<html>`/`<body>` adopt the page's own elements), so an
// app whose document denext or a server layout supplies drops it via tree-shaking.
export { installSingletonSupport } from "./fiber/singleton-runtime.ts";
// Resumability: the lazily-loaded event-handler reference the qrl transform emits.
export { capturedScope, type Qrl, qrl } from "../runtime/qrl.ts";
// Dev DevTools metadata: the per-component source position + hook names the dev
// transforms' Fast Refresh footer registers (dev only; unreferenced in production, so the
// registry tree-shakes away).
export { type ComponentDevMeta, type HookDevMeta, registerComponentMeta } from "./devtools-meta.ts";
// Dev Fast Refresh: family registration + state-preserving reconcile (dev entries only).
export {
  enableFastRefresh,
  enablePerModuleRefresh,
  performModuleRefresh,
  registerFamily,
} from "./refresh-runtime.ts";
