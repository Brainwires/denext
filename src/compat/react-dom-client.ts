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

import { createRoot, hydrateRoot } from "../client/mod.ts";

export { createRoot, hydrateRoot, type Root } from "../client/mod.ts";

/**
 * Default export mirroring the named API. Real `react-dom/client` has no ESM default
 * export, but code bundled with `esModuleInterop`/CJS interop (Vite, webpack, tsc)
 * commonly writes `import ReactDOM from "react-dom/client"; ReactDOM.createRoot(…)`
 * and relies on the bundler synthesizing a default from the CJS namespace. denext is
 * pure ESM, so it provides that namespace default explicitly for drop-in parity.
 */
export default { createRoot, hydrateRoot };
