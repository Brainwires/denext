// Generate the browser **hydration entry** for a Pages Router route, and the
// stable id used for its bundle filename/URL.
//
// The entry mirrors the App Router's generated route entry (see denext core's
// `generateRouteEntry`): it statically imports the page's *default* export — so
// the bundler tree-shakes `getServerSideProps`/`getStaticProps` and any
// server-only imports used solely by them out of the browser bundle — registers
// it under its route path, and hands off to the shared client runtime, which
// reads `#__NEXT_DATA__` from the DOM and hydrates `#__next`.

import { toFileUrl } from "@std/path";

/**
 * A stable, URL/filesystem-safe id for a route path. `/` → `index`; segments are
 * joined with `__`; dynamic `[slug]` → `_slug_`, catch-all `[...rest]` →
 * `catchall_rest`, optional catch-all `[[...rest]]` → `optcatchall_rest`.
 *
 * @param routePath The display route path (e.g. `/blog/[slug]`).
 */
export function routeId(routePath: string): string {
  if (routePath === "/") return "index";
  const parts = routePath.replace(/^\//, "").replace(/\/$/, "").split("/");
  return parts
    .map((seg) => {
      const opt = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (opt) return `optcatchall_${opt[1]}`;
      const cat = seg.match(/^\[\.\.\.(.+)\]$/);
      if (cat) return `catchall_${cat[1]}`;
      const dyn = seg.match(/^\[(.+)\]$/);
      if (dyn) return `_${dyn[1]}_`;
      return seg.replace(/[^a-z0-9]/gi, "_");
    })
    .join("__");
}

/** Inputs for {@linkcode generateClientEntry}. */
export interface ClientEntryInput {
  /** The route's display path (e.g. `/blog/[slug]`), used as its registry key. */
  routePath: string;
  /** Absolute path to the page module (its default export is the component). */
  pageFile: string;
  /** Absolute path to the `_app` module, if the project has one. */
  appFile?: string | null;
  /** Import specifier for the shared client runtime (overridable for tests). */
  runtimeSpecifier?: string;
}

/** The specifier a bundled entry imports the shared runtime from. */
export const RUNTIME_SPECIFIER = "@denext/pages-router/client-runtime";

/**
 * Build the source of a route's browser hydration entry. Pass the result to
 * `bundleRoutes` (from `@denext/denext/bundle`) — every route's entry imports the
 * same runtime and `_app`, so those hoist into one shared chunk.
 */
export function generateClientEntry(input: ClientEntryInput): string {
  const runtime = input.runtimeSpecifier ?? RUNTIME_SPECIFIER;
  const pageUrl = toFileUrl(input.pageFile).href;
  const appImport = input.appFile
    ? `import App from ${JSON.stringify(toFileUrl(input.appFile).href)};`
    : `const App = null;`;
  return [
    `// @denext/pages-router generated client entry — do not edit.`,
    `import { bootstrapPages, registerPage } from ${JSON.stringify(runtime)};`,
    `import Page from ${JSON.stringify(pageUrl)};`,
    appImport,
    `registerPage(${JSON.stringify(input.routePath)}, Page);`,
    `bootstrapPages({ App });`,
    ``,
  ].join("\n");
}
