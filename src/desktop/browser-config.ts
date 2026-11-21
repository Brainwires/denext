/**
 * `desktop.app.browser`: what a Deno Desktop app that may be the system's default web browser
 * claims. Shared by the packager (Info.plist, `.desktop` entries), the launch router (which links
 * reach `onDeepLink`) and the `defaultBrowser` capability.
 *
 * Pure: no Deno APIs, no I/O.
 *
 * @module
 */

/** The URL schemes a browser handles (which `desktop.app.deepLinks` refuses). */
export const BROWSER_SCHEMES: readonly string[] = ["http", "https"];

/**
 * The Linux `MimeType` entries of a browser's `.desktop` file: the two schemes' handlers and the
 * HTML documents.
 */
export const BROWSER_MIME_TYPES: readonly string[] = [
  "x-scheme-handler/http",
  "x-scheme-handler/https",
  "text/html",
  "application/xhtml+xml",
];

/**
 * The macOS document types (uniform type identifiers) a browser opens, with the name Finder shows,
 * each declared with `LSHandlerRank` `Alternate` (the app may open them; it never takes them over
 * on install).
 */
export const BROWSER_DOCUMENT_TYPES: ReadonlyArray<readonly [uti: string, name: string]> = [
  ["public.html", "HTML document"],
  ["public.xhtml", "XHTML document"],
  ["public.url", "Web site location"],
];

/** The framework LaunchServices lives in (the `defaultBrowser` capability's `--allow-ffi` scope). */
export const CORE_SERVICES_PATH = "/System/Library/Frameworks/CoreServices.framework/CoreServices";
/** The framework with `CFString` (the `defaultBrowser` capability's `--allow-ffi` scope). */
export const CORE_FOUNDATION_PATH =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
/** The Linux programs the `defaultBrowser` capability runs (its `--allow-run` scope). */
export const DEFAULT_BROWSER_LINUX_PROGRAMS: readonly string[] = ["xdg-settings", "xdg-mime"];

/**
 * Whether the config makes the app a browser candidate (`desktop.app.browser: true`).
 *
 * @param config The project config (or its `.deno-desktop/config.json` slice).
 * @returns `true` only for a literal `true`.
 */
export function desktopBrowserEnabled(config: unknown): boolean {
  const desktop = (config as { desktop?: unknown } | null | undefined)?.desktop;
  const app = (desktop as { app?: unknown } | null | undefined)?.app;
  return (app as { browser?: unknown } | null | undefined)?.browser === true;
}
