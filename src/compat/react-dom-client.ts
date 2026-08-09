/**
 * React-compatible `react-dom/client` entrypoint for denext.
 *
 * Alias `react-dom/client` to this module so `createRoot`/`hydrateRoot` from the
 * React 18+ client API resolve to denext's reconciler:
 *
 * ```jsonc
 * "imports": { "react-dom/client": "jsr:@denext/denext/react-dom/client" }
 * ```
 *
 * denext's `createRoot(container).render(element)` and
 * `hydrateRoot(container, element)` are already React-shaped.
 *
 * @module
 */

export { createRoot, hydrateRoot, type Root } from "../client/mod.ts";
