/**
 * `desktop.webViews`: the embedded web views a window may host (`createWebView` from
 * `denext/desktop/window`, `win.createWebView` in `desktop.ts`) — the per-window cap and the
 * optional allowlist of origins they may load. Checked by the config validator, resolved once at
 * launch by `resolveDesktopCapabilities` (failing fast, since the desktop entry imports the config
 * without the loader's validation) and enforced by the `window` capability.
 *
 * Runtime-only (imported by the caps resolver, the config validator and the `window` capability,
 * never a client bundle).
 *
 * @module
 */

import { normalizeDesktopNavigationOrigin } from "./app-origin.ts";

/** How many web views one window hosts at once unless `desktop.webViews.limit` says. */
const DEFAULT_WEBVIEW_LIMIT = 8;
/** The most `desktop.webViews.limit` takes (the runtime's own per-window cap). */
const MAX_WEBVIEW_LIMIT = 32;

/** `desktop.webViews` as resolved. */
export interface DesktopWebViewSettings {
  /** The most web views one window hosts at once (1..32). */
  readonly limit: number;
  /** The exact origins a web view may load (`null`: any `http:` / `https:` origin). */
  readonly allowedOrigins: readonly string[] | null;
}

/** The settings with nothing configured. */
export const DEFAULT_WEBVIEW_SETTINGS: DesktopWebViewSettings = {
  limit: DEFAULT_WEBVIEW_LIMIT,
  allowedOrigins: null,
};

/**
 * One `desktop.webViews.allowedOrigins` entry as an origin (`"https://docs.example"`), or `null`
 * when it is not an exact `http:` / `https:` origin (a path, a wildcard, credentials, another
 * scheme).
 *
 * @param entry The configured entry.
 * @returns The normalized origin, or `null`.
 */
function webViewOriginOf(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const origin = normalizeDesktopNavigationOrigin(entry);
  if (origin === null) return null;
  return origin.startsWith("http://") || origin.startsWith("https://") ? origin : null;
}

/**
 * What is wrong with `desktop.webViews`, as `[field under desktop., message]`, or `null`.
 *
 * @param value The configured value.
 * @returns The problem, or `null`.
 */
export function webViewsConfigProblem(value: unknown): [string, string] | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["webViews", "must be an object: { limit?, allowedOrigins? }"];
  }
  const v = value as { limit?: unknown; allowedOrigins?: unknown };
  if (
    v.limit !== undefined &&
    (typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 ||
      v.limit > MAX_WEBVIEW_LIMIT)
  ) {
    return ["webViews.limit", `must be an integer from 1 to ${MAX_WEBVIEW_LIMIT}`];
  }
  if (v.allowedOrigins === undefined) return null;
  if (!Array.isArray(v.allowedOrigins)) {
    return ["webViews.allowedOrigins", 'must be an array of origins ("https://docs.example")'];
  }
  for (const [i, entry] of v.allowedOrigins.entries()) {
    if (webViewOriginOf(entry) === null) {
      return [
        `webViews.allowedOrigins[${i}]`,
        'must be an exact http(s) origin ("https://docs.example"): no path, wildcard, ' +
        "credentials or other scheme",
      ];
    }
  }
  return null;
}

/**
 * Resolve `desktop.webViews` (throwing on a bad value: the desktop entry reads the config without
 * the loader's validation).
 *
 * @param desktop The config's `desktop` section.
 * @returns The settings (the defaults when unset).
 */
export function resolveDesktopWebViewSettings(desktop: unknown): DesktopWebViewSettings {
  const value = (desktop as { webViews?: unknown } | null | undefined)?.webViews;
  const problem = webViewsConfigProblem(value);
  if (problem) throw new Error(`desktop: desktop.${problem[0]} ${problem[1]}`);
  if (value === undefined) return DEFAULT_WEBVIEW_SETTINGS;
  const v = value as { limit?: number; allowedOrigins?: unknown[] };
  return {
    limit: v.limit ?? DEFAULT_WEBVIEW_LIMIT,
    allowedOrigins: v.allowedOrigins
      ? [...new Set(v.allowedOrigins.map((o) => webViewOriginOf(o)!))]
      : null,
  };
}
