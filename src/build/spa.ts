// SPA mode ("React but not Next"): build/dev/export/serve a single client entry
// as a pure client-side-rendered app — no `app/` directory, no SSR, no Flight.
//
// denext bundles the configured `spa.entry` module (which mounts the app itself,
// e.g. a Vite-style `main.tsx` calling `createRoot(...).render(...)`), wraps it in
// a generated HTML shell, and serves that shell for every navigation (history-API
// fallback). This lets an existing client-only React SPA run on denext's toolchain
// (`deno bundle`, Tailwind, the CSS pipeline) and packaging (`deno desktop`),
// without restructuring it into the App Router. The whole path reuses the existing
// bundle/CSS primitives — it only differs in that it has one hand-written entry and
// no route manifest.
//
// The implementation lives under `./spa/`: `shared` (constants, the generated entry,
// the HTML shell), `bundle` (native / next-compat bundling + stylesheet extraction),
// `build` (production build + static export), `prod-server`, and the dev server
// (`dev-state`, `dev-watch`, `dev-handler`, `dev-reload-script`, `dev-server`).

export { buildSpa, exportSpa } from "./spa/build.ts";
export { pnpmCatalogPackages } from "./spa/bundle.ts";
export { startSpaDevServer } from "./spa/dev-server.ts";
export { startSpaProdServer } from "./spa/prod-server.ts";
export { classifySpaChange, generateSpaEntry, spaShellHtml } from "./spa/shared.ts";
