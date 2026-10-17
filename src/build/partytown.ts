/**
 * `<Script strategy="worker">` off the main thread, as Next does it: through Partytown, which
 * the APP installs (`@qwik.dev/partytown`, or Next's `@builder.io/partytown`), never denext —
 * the framework ships no runtime npm. With `nextScriptWorkers` (Next's
 * `experimental.nextScriptWorkers`) on, the servers and `denext export` publish the package's
 * `lib/` files plus a generated `boot.js` under {@linkcode PARTYTOWN_PREFIX} on the app's own
 * origin, and tell `<Script>` where they are ({@linkcode setScriptWorkers}).
 *
 * Why it holds under the strict default CSP (`script-src 'self'`, no inline script): the page
 * runs only `boot.js`, a same-origin external script (the Partytown config + snippet, which
 * Next inlines). The service worker (`partytown-sw.js`) is same-origin and registered under
 * the prefix, which `script-src 'self'` covers when `worker-src` is unset. The sandbox iframe
 * and the web worker are documents the service worker synthesizes, which carry no policy of
 * their own; the scripts then run in that worker, and what they do to the page goes through
 * Partytown's proxy into the page, where the page's CSP still applies.
 *
 * @module
 */

import { join } from "@std/path";
import { setScriptWorkers } from "../runtime/script.ts";
import type { DenextConfig } from "../server/config.ts";
import type { HstsConfig } from "../server/config.ts";
import { serveImmutableAsset } from "../server/serve-utils.ts";
import { findInstalledPackage } from "./installed-package.ts";

/** Where Partytown is served (below the app's `basePath`); Next's is `/_next/static/~partytown/`. */
const PARTYTOWN_PREFIX = "/_denext/~partytown/";

/** The packages searched, in order: Partytown's current name, then the one Next checks for. */
const PARTYTOWN_PACKAGES = ["@qwik.dev/partytown", "@builder.io/partytown"] as const;

/** The build output's Partytown directory, inside the client dir (swapped in with it). */
export const PARTYTOWN_BUILD_DIR = "_partytown";

/**
 * Whether the app turned on `nextScriptWorkers`: the top-level field, else Next's
 * `experimental.nextScriptWorkers` spelling (top-level wins).
 */
export function scriptWorkersEnabled(config: DenextConfig | null | undefined): boolean {
  return (config?.nextScriptWorkers ?? config?.experimental?.nextScriptWorkers) === true;
}

/** The public path Partytown is served under for `basePath` (always ends with `/`). */
export function partytownPublicLib(config: DenextConfig | null | undefined): string {
  return (config?.basePath?.replace(/\/$/, "") ?? "") + PARTYTOWN_PREFIX;
}

/**
 * The installed Partytown's `lib/` directory, seen from `projectDir` the way Node resolves a
 * package (walking up `node_modules`), or null when neither package is installed.
 *
 * @param projectDir The app's directory.
 */
export async function findPartytownLib(projectDir: string): Promise<string | null> {
  for (const name of PARTYTOWN_PACKAGES) {
    const dir = await findInstalledPackage(projectDir, name);
    if (!dir) continue;
    try {
      if ((await Deno.stat(join(dir, "lib", "partytown.js"))).isFile) return join(dir, "lib");
    } catch { /* an install without lib/ — try the next name */ }
  }
  return null;
}

/**
 * `boot.js`: the Partytown config Next inlines (`partytown = { lib }`, an app's own
 * `window.partytown` keys kept) and the snippet, as ONE same-origin external script. It is
 * idempotent (every worker `<Script>` carries it), scopes the snippet's top-level bindings in
 * a function, and sets the slot `<Script>` reads in the browser, so a hydrating client
 * component renders the markup the server did. A worker script a client render adds later (a
 * client component, a soft navigation) is handed to Partytown with its `ptupdate` event, which
 * Next leaves to the app.
 *
 * @param lib The public lib path (ends with `/`).
 * @param snippet The package's `lib/partytown.js`.
 */
export function partytownBootSource(lib: string, snippet: string): string {
  const libJson = JSON.stringify(lib);
  return `/* denext: Partytown boot (nextScriptWorkers) */
(function () {
if (window.__denextPartytown) return;
window.__denextPartytown = 1;
window.__denextScriptWorkers = { lib: ${libJson} };
window.partytown = Object.assign({ lib: ${libJson} }, window.partytown);
${snippet}
var queued = 0;
new MutationObserver(function (records) {
  for (var i = 0; i < records.length && !queued; i++) {
    var added = records[i].addedNodes;
    for (var j = 0; j < added.length; j++) {
      if (added[j].nodeName === "SCRIPT" && added[j].type === "text/partytown") {
        queued = 1;
        setTimeout(function () {
          queued = 0;
          window.dispatchEvent(new CustomEvent("ptupdate"));
        });
        break;
      }
    }
  }
}).observe(document, { childList: true, subtree: true });
})();
`;
}

/** Copy `from` into `to` recursively (Partytown's lib is a few flat files plus `debug/`). */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    if (e.isDirectory) await copyTree(join(from, e.name), join(to, e.name));
    else if (e.isFile) await Deno.copyFile(join(from, e.name), join(to, e.name));
  }
}

/**
 * Write Partytown's files and `boot.js` into `dest` (replacing what a previous run left).
 *
 * @param libDir The package's `lib/` ({@linkcode findPartytownLib}).
 * @param dest The directory {@linkcode PARTYTOWN_PREFIX} is served from.
 * @param lib The public lib path `boot.js` points Partytown at.
 */
async function writePartytownFiles(
  libDir: string,
  dest: string,
  lib: string,
): Promise<void> {
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await copyTree(libDir, dest);
  const snippet = await Deno.readTextFile(join(libDir, "partytown.js"));
  await Deno.writeTextFile(join(dest, "boot.js"), partytownBootSource(lib, snippet));
}

/** The warning when `nextScriptWorkers` is on but no Partytown is installed. */
export const PARTYTOWN_MISSING_WARNING =
  "denext: `nextScriptWorkers` is on but Partytown is not installed, so " +
  '<Script strategy="worker"> runs on the main thread. Install `@qwik.dev/partytown` into ' +
  'node_modules (`deno add npm:@qwik.dev/partytown` with `"nodeModulesDir": "auto"`, or ' +
  "your package manager).";

/**
 * Publish Partytown for a server or an export when the app turned it on: write its files into
 * `dest` and point `<Script>` at them, or warn and keep the main-thread fallback when the
 * package is missing. With the option off it clears the slot and writes nothing.
 *
 * @param config The app's config.
 * @param projectDir The app's directory (where `node_modules` is searched from).
 * @param dest The directory {@linkcode PARTYTOWN_PREFIX} is served from.
 * @returns Whether Partytown is on (its files are in `dest`).
 */
export async function preparePartytown(
  config: DenextConfig | null | undefined,
  projectDir: string,
  dest: string,
): Promise<boolean> {
  if (!scriptWorkersEnabled(config)) {
    setScriptWorkers(undefined);
    return false;
  }
  const libDir = await findPartytownLib(projectDir);
  if (!libDir) {
    console.warn(PARTYTOWN_MISSING_WARNING);
    setScriptWorkers({ missing: true });
    return false;
  }
  const lib = partytownPublicLib(config);
  await writePartytownFiles(libDir, dest, lib);
  setScriptWorkers({ lib });
  return true;
}

/**
 * `denext start`: point `<Script>` at the Partytown files the build wrote (no `node_modules`
 * at run time, so a compiled binary works too), or keep the fallback when the build found none.
 *
 * @param config The app's config.
 * @param dir The build's Partytown directory (`<client>/_partytown`).
 */
export async function loadPartytownBuild(
  config: DenextConfig | null | undefined,
  dir: string,
): Promise<void> {
  if (!scriptWorkersEnabled(config)) return setScriptWorkers(undefined);
  const built = await Deno.stat(join(dir, "boot.js")).then((s) => s.isFile, () => false);
  setScriptWorkers(built ? { lib: partytownPublicLib(config) } : { missing: true });
}

/**
 * Serve a Partytown file from `dir` when `pathname` (with `basePath` already stripped) is under
 * {@linkcode PARTYTOWN_PREFIX}; null otherwise. Not content-hashed, so revalidated rather than
 * cached as immutable; a browser checks the service worker script itself anyway.
 *
 * @param dir The directory the files were written to.
 * @param pathname The request path, below `basePath`.
 * @param request The request (for conditional and encoding headers).
 * @param secure Whether the connection is HTTPS (HSTS).
 * @param hsts The app's HSTS setting.
 */
export function servePartytown(
  dir: string,
  pathname: string,
  request: Request,
  secure: boolean,
  hsts: HstsConfig | false | undefined,
): Promise<Response> | null {
  if (!pathname.startsWith(PARTYTOWN_PREFIX)) return null;
  const rel = pathname.slice(PARTYTOWN_PREFIX.length - 1);
  return serveImmutableAsset(dir, rel, request, secure, hsts, "// not found");
}
