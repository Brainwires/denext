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
export { setFlightParser, startClient, startGlobalErrorClient } from "./navigation.ts";
export { type LayoutSegmentInfo, provideLayoutSegments } from "../runtime/layout-segments.ts";
// Flight hydration: reconstruct a VNode tree from the server's Flight payload.
export {
  type ClientRegistry,
  ensureFlightModules,
  flightClientIds,
  parseFlight,
} from "./flight-client.ts";
// Server Actions: the browser dispatch stub emitted for each `"use server"` export.
export { clientActionStub } from "../runtime/server-action.ts";
// Class components: the entry emits `installClassSupport()` to wire the class runtime into
// the reconciler seam ONLY when the app uses classes — so a function-only bundle drops this
// re-export (and the whole ~3.1 KB class runtime) via tree-shaking.
export { installClassSupport } from "../compat/class-component.ts";
// Resumability: the lazily-loaded event-handler reference the qrl transform emits.
export { capturedScope, type Qrl, qrl } from "../runtime/qrl.ts";
// Dev Fast Refresh: family registration + state-preserving reconcile (dev entries only).
export {
  enableFastRefresh,
  enablePerModuleRefresh,
  performModuleRefresh,
  registerFamily,
} from "./refresh-runtime.ts";
