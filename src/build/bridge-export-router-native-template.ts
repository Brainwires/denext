// The export-aware router every generated `DenextBridgeViewController.swift` carries (the OTA
// one, the auth-session registering-only one and the app-extension registering-only one, and
// every composition), embedded as text so it ships inside the JSR package.
//
// Capacitor iOS serves the app's files through `WebViewAssetHandler`, which asks its `Router`
// for the file behind each request path. Capacitor's own `CapacitorRouter` answers every path
// without an extension with the root `index.html` (it assumes a single-page app), so in an
// exported multi-page App Router site a plain `<a href="/protected">` loads the home page. The
// bridge view controller's `router()` (an `open` hook `CAPBridgeViewController.loadView()` calls
// once, before the first page) returns `DenextExportRouter` instead: a path with an extension
// passes through, `/route` is `/route/index.html` or `/route.html` when the export has that
// page, and anything else is still the root `index.html` (a single-page app's client routes
// keep working).
//
// `basePath` is the directory the UI is served from: Capacitor sets it through
// `WebViewAssetHandler.setAssetPath` from the instance's `appLocation` (the bundled `public/`,
// or the over-the-air UI directory the OTA bridge picks in `instanceDescriptor()`) and again on
// `setServerBasePath` (an OTA UI applied while running), so the file checks follow the UI
// actually served.
//
// Android's counterpart is part of the composed MainActivity (`DenextExportRoutes` in
// mobile-native-install.ts). Edit this as source: it is compiled only in an app (verified on a
// device against Capacitor 8). Every `\`` below is an escaped template-literal character.
//
// The candidate order mirrors `EXPORT_PAGE_SUFFIXES` (export-paths.ts), the mapping every TS
// surface uses; tests/export-routes-conformance.test.ts holds both routers to the shared vectors
// (tests/fixtures/export-routes.json), compiling this one with swiftc where it exists.

/** The `router()` override, first thing in the bridge view controller's class body. */
export const EXPORT_ROUTER_OVERRIDE =
  `    /// Serves an exported multi-page app's routes: Capacitor's router answers every path
    /// without an extension with the root \`index.html\` (a single-page-app assumption), so
    /// \`/protected\` would load the home page.
    override open func router() -> Router {
        DenextExportRouter()
    }

`;

/** The router, appended to the bridge view controller's file. */
export const EXPORT_ROUTER_SWIFT = `
/// \`/route\` → \`/route/index.html\` or \`/route.html\` when the export has that page, else the root
/// \`index.html\` (a single-page app's client routes keep working). \`basePath\` is the directory
/// the UI is served from (the bundled \`public/\` or an over-the-air UI), set by Capacitor.
struct DenextExportRouter: Router {
    var basePath: String = ""
    func route(for path: String) -> String {
        let url = URL(fileURLWithPath: path)
        guard url.pathExtension.isEmpty else { return basePath + path }
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        if !trimmed.isEmpty {
            let fm = FileManager.default
            for candidate in [trimmed + "/index.html", trimmed + ".html"] {
                if fm.fileExists(atPath: basePath + candidate) { return basePath + candidate }
            }
        }
        return basePath + "/index.html"
    }
}
`;

/** The class declaration every bridge view controller template opens its body with. */
const CLASS_ANCHOR = "class DenextBridgeViewController: CAPBridgeViewController {\n";

/**
 * `source` (a bridge view controller template) with the export-aware router: the `router()`
 * override first in the class body and `DenextExportRouter` at the end of the file.
 *
 * @param source The Swift template.
 * @returns The template with the router.
 * @throws When `source` has no `DenextBridgeViewController` class to override `router()` in.
 */
export function withExportRouter(source: string): string {
  if (!source.includes(CLASS_ANCHOR)) {
    throw new Error("the bridge view controller template has no place for the export router");
  }
  return source.replace(CLASS_ANCHOR, CLASS_ANCHOR + EXPORT_ROUTER_OVERRIDE) +
    EXPORT_ROUTER_SWIFT;
}
