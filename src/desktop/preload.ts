/**
 * The runtime half of `desktop.preload` (see `src/build/desktop-preload.ts` for the bundler): where
 * the bundled preload lives in the served UI directory, and reading it back as text that is safe
 * to inline into a `<script>` element. Runtime-only (imported by `runDesktop`), with no build
 * dependencies, so a packaged app does not pull the bundler in.
 *
 * TRUST: the preload is the app's own code. It runs in the page's world (a webview has no isolated
 * world, unlike an Electron preload under contextIsolation) with exactly the page's privileges —
 * no sandbox. Its purpose is to run EARLY and expose bridges before the page's scripts read them.
 *
 * @module
 */

/** Where the bundled preload lives inside the static export (and the served UI directory). */
export const DESKTOP_PRELOAD_FILE = "_denext/desktop-preload.js";

/**
 * The env var `denext desktop dev` sets on the window process to the dev build of the preload
 * (the static export is not rebuilt in live-reload mode). `runDesktop` honors it ONLY in
 * live-reload proxy mode, which a packaged app never enters.
 */
export const DESKTOP_PRELOAD_ENV = "DENEXT_DESKTOP_PRELOAD_FILE";

/**
 * The preload source as it may sit inside an inline `<script>`: `</script` and `<!--` cannot
 * appear raw (the first ends the element, the second can switch the HTML tokenizer into the
 * double-escaped state), so both are escaped. Inside JavaScript strings, template literals,
 * regular expressions and comments — the only places they occur in valid code — `<\/script` and
 * `<\!--` mean the same text.
 *
 * @param source The bundled preload.
 * @returns The source, safe to inline.
 */
export function inlineSafeScript(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/**
 * Read the bundled preload, inline-safe, or `undefined` when there is none (no `desktop.preload`).
 *
 * @param file The bundle path.
 * @returns The script text, or `undefined`.
 */
export async function readDesktopPreload(file: string): Promise<string | undefined> {
  try {
    return inlineSafeScript(await Deno.readTextFile(file));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}
