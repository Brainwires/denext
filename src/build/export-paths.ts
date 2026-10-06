// Which exported file serves a URL path: the ONE mapping every surface that serves a static export
// uses. The desktop request handler (desktop.ts) reads the pages it names and falls back to the root
// shell for a navigation; the SPA servers (spa/prod-server.ts, spa/dev-handler.ts) give the shell to
// a navigation through `wantsShell` (spa/shared.ts). The Capacitor shells' routers are native code
// generated from templates (bridge-export-router-native-template.ts for iOS, `DenextExportRoutes`
// in mobile-native-install.ts for Android); they mirror EXPORT_PAGE_SUFFIXES, and
// tests/export-routes-conformance.test.ts runs all of them (the native ones compiled with stubs
// where swiftc / javac exist) against the shared vectors in tests/fixtures/export-routes.json,
// the spec of this mapping.
//
// Pure: no file access. Path-traversal and symlink protection stay with `serveStatic`
// (server/static.ts), which every TS surface reads a candidate through.

/**
 * The suffixes an extensionless route is tried with, in order: `/route` (or `/route/`) is
 * `route/index.html` (what a multi-page App Router export writes), then `route.html`.
 */
export const EXPORT_PAGE_SUFFIXES: readonly string[] = ["/index.html", ".html"];

/** The root page: what `/` serves, and the shell a single-page app's client routes get. */
export const EXPORT_SHELL_PAGE = "/index.html";

/** What {@linkcode resolveExportPath} decides for one URL path. */
export interface ExportPathResolution {
  /**
   * The export files that serve the path as a page, in order, each a `/`-rooted path relative to
   * the export directory: a `.html` path is itself; `/route` (or `/route/`) is
   * `/route/index.html` then `/route.html`; `/` is `/index.html`. Empty for any other extension
   * (an asset, which the surface serves as the file itself).
   */
  pages: string[];
  /**
   * The path has no extension in its last segment, so it is a navigation: where the surface does
   * single-page client routing, a navigation no page serves gets the root shell
   * ({@linkcode EXPORT_SHELL_PAGE}) instead of a 404.
   */
  navigation: boolean;
}

/**
 * The export pages that serve `pathname` and whether it is a navigation.
 *
 * @param pathname A URL pathname (`URL.pathname`: no query or fragment, still percent-encoded).
 * @returns The candidate pages in order, and the navigation flag.
 */
export function resolveExportPath(pathname: string): ExportPathResolution {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (last.endsWith(".html")) return { pages: [pathname], navigation: false };
  if (last.includes(".")) return { pages: [], navigation: false };
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const pages = trimmed === ""
    ? [EXPORT_SHELL_PAGE]
    : EXPORT_PAGE_SUFFIXES.map((suffix) => trimmed + suffix);
  return { pages, navigation: true };
}
