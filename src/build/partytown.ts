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
import { currentCacheScope } from "../server/cache-scope.ts";
import { isPrerendering } from "../runtime/prerender.ts";

// `<Script>`'s bridge (it cannot import these server modules): a render whose output outlives
// the response — a `"use cache"` body, a PPR shell prerender — gets no per-response nonce.
(globalThis as { __denextScriptWorkersShared?: () => boolean }).__denextScriptWorkersShared = () =>
  isPrerendering() || currentCacheScope() !== undefined;

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
 * The snippet's last argument decides atomics mode (`window.crossOriginIsolated`), which loads
 * `partytown-atomics.js` as a page script. denext pins the service-worker mode instead and
 * never publishes the atomics files: a page script anyone could include is a sandbox an
 * injection could start on its own. Null when the snippet is not the shape this expects.
 */
function serviceWorkerModeSnippet(snippet: string): string | null {
  const tail = ",window.crossOriginIsolated)";
  const at = snippet.lastIndexOf(tail);
  if (at < 0 || snippet.indexOf(tail) !== at) return null;
  return snippet.slice(0, at) + ",!1)" + snippet.slice(at + tail.length);
}

/**
 * `boot.js`: the Partytown config Next inlines (`partytown = { lib }`) and the snippet, as ONE
 * same-origin external script, which only lets Partytown run the worker scripts denext
 * rendered for this response:
 *
 * - Every `text/partytown` script is held inert (retyped) the moment it enters the document,
 *   so no Partytown sandbox can pick one up before it is checked.
 * - At `DOMContentLoaded` the nonce every boot tag ran with (`document.currentScript.nonce`,
 *   hidden from markup and CSS once parsed) must be one and the same, and the page's own CSP
 *   must list it: a probe `<script nonce>` runs only if it does. A boot tag an injection added
 *   cannot carry that nonce, and makes the page refuse Partytown altogether.
 * - Only the held scripts with that nonce go back to `text/partytown`, with the ones code made
 *   with `document.createElement` — Partytown's own, for a script a worker script loads, or the
 *   app's: an injection writes markup, it cannot call it. The rest stay inert.
 *   Partytown then starts, and a script added later (a client render) is checked the same way
 *   before Partytown is told with its `ptupdate` event.
 * - The sandbox iframe is admitted by the service worker only for the tab this boot announces
 *   (see {@linkcode partytownServiceWorkerSource}), so an injected iframe gets no sandbox.
 *
 * It is idempotent (every worker `<Script>` carries it), keeps the snippet's top-level bindings
 * in a function, and sets the slot `<Script>` reads in the browser, so a client render stamps
 * the same nonce. `lib` and `debug` are denext's: only the files it publishes exist.
 *
 * @param lib The public lib path (ends with `/`).
 * @param snippet The package's `lib/partytown.js`, in service-worker mode.
 */
export function partytownBootSource(lib: string, snippet: string): string {
  const libJson = JSON.stringify(lib);
  return `/* denext: Partytown boot (nextScriptWorkers) */
(function (w, d) {
var me = d.currentScript;
(w.__denextPtBoots = w.__denextPtBoots || []).push(me && me.nonce || "");
if (w.__denextPartytown) return;
w.__denextPartytown = 1;
var LIB = ${libJson};
var RUN = "text/partytown";
var HELD = "text/denext-partytown-held";
var INERT = "text/denext-partytown-blocked";
var SEL = 'script[type="' + RUN + '"]:not([data-ptid]),script[type="' + HELD + '"]';
var slot = w.__denextScriptWorkers = { lib: LIB, nonce: me && me.nonce || "" };
var nonce = null;
w.partytown = Object.assign({}, w.partytown, { lib: LIB, debug: false });
var made = new WeakSet(), createElement = d.createElement;
d.createElement = function (tag) {
  var el = createElement.apply(this, arguments);
  if (String(tag).toLowerCase() === "script") made.add(el);
  return el;
};
function retype(s, type) { if (s.type !== type) s.type = type; }
function check(s) {
  if (nonce === null) return retype(s, HELD);
  if (nonce && (s.nonce === nonce || made.has(s))) { retype(s, RUN); return 1; }
  retype(s, INERT);
}
function sweep(root) {
  var found = 0;
  if (root.matches && root.matches(SEL)) found |= check(root);
  if (root.querySelectorAll) {
    var all = root.querySelectorAll(SEL);
    for (var i = 0; i < all.length; i++) found |= check(all[i]);
  }
  return found;
}
var queued = 0;
new MutationObserver(function (records) {
  var found = 0;
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (r.type === "attributes") found |= sweep(r.target);
    for (var j = 0; j < r.addedNodes.length; j++) found |= sweep(r.addedNodes[j]);
  }
  if (found && nonce && !queued) {
    queued = 1;
    setTimeout(function () {
      queued = 0;
      w.dispatchEvent(new CustomEvent("ptupdate"));
    });
  }
}).observe(d, { childList: true, subtree: true, attributes: true, attributeFilter: ["type"] });
sweep(d);
function listed(n) {
  if (!n) return false;
  var probe = d.createElement("script");
  probe.nonce = n;
  probe.textContent = "document.currentScript.setAttribute('data-ok', '')";
  (d.head || d.documentElement).appendChild(probe);
  var ok = probe.hasAttribute("data-ok");
  probe.remove();
  return ok;
}
var tab;
Object.defineProperty(w, "_pttab", {
  configurable: true,
  get: function () { return tab; },
  set: function (v) {
    tab = v;
    navigator.serviceWorker.getRegistration(LIB).then(function (reg) {
      var sw = reg && (reg.active || reg.waiting || reg.installing);
      if (sw) sw.postMessage({ denextPartytownTab: String(v) });
    });
  },
});
function start() {
  var boots = w.__denextPtBoots, n = boots[0];
  for (var i = 1; i < boots.length; i++) if (boots[i] !== n) n = "";
  nonce = slot.nonce = listed(n) ? n : "";
  sweep(d);
  if (!nonce) return;
  Object.defineProperty(d, "readyState", { configurable: true, value: "complete" });
  try {
${snippet}
  } finally {
    delete d.readyState;
  }
}
if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", start);
else start();
})(window, document);
`;
}

/**
 * `partytown-sw.js`: Partytown's service worker (`partytown-sw-impl.js`) behind a gate that
 * synthesizes the sandbox page only for a tab a boot script announced after it checked the
 * page's scripts. Without it, an injected `<iframe src=".../partytown-sandbox-sw.html">` on ANY
 * page of the origin — once a visit registered the worker — would start a sandbox that runs
 * that page's `text/partytown` scripts. An announcement is used once; an unannounced tab is
 * refused after a short wait (the message and the iframe's request race).
 */
export function partytownServiceWorkerSource(): string {
  return `/* denext: Partytown service worker gate (nextScriptWorkers) */
importScripts("./partytown-sw-impl.js");
(function () {
var partytownFetch = self.onfetch, partytownMessage = self.onmessage;
var announced = new Set(), waiting = new Map();
self.onmessage = function (ev) {
  var tab = ev.data && ev.data.denextPartytownTab;
  if (typeof tab !== "string") return partytownMessage && partytownMessage.call(self, ev);
  announced.add(tab);
  var wake = waiting.get(tab);
  if (wake) { waiting.delete(tab); wake(); }
};
function admitted(tab) {
  if (announced.has(tab)) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { waiting.delete(tab); resolve(false); }, 3000);
    waiting.set(tab, function () { clearTimeout(timer); resolve(true); });
  });
}
self.onfetch = function (ev) {
  if (!new URL(ev.request.url).pathname.endsWith("sw.html")) {
    return partytownFetch && partytownFetch.call(self, ev);
  }
  var tab = new URL(ev.request.url).search.slice(1);
  ev.respondWith(admitted(tab).then(function (ok) {
    var out = null;
    if (ok && tab && typeof partytownFetch === "function") {
      announced.delete(tab);
      partytownFetch.call(self, { request: ev.request, respondWith: function (r) { out = r; } });
    }
    return out || new Response("", { status: 403 });
  }));
};
})();
`;
}

/** The package's files denext publishes, under the names it serves them as. */
const PUBLISHED_LIB_FILES: Record<string, string> = {
  "partytown-sw.js": "partytown-sw-impl.js",
  "partytown-media.js": "partytown-media.js",
};

/**
 * Write the files Partytown needs in service-worker mode — `boot.js`, the gated
 * `partytown-sw.js` and the package's worker and media scripts — into `dest`, replacing what a
 * previous run left. Nothing else is published: not the raw snippet, the atomics mode or the
 * debug build, each a page script an injection could use to start Partytown without the
 * checks in `boot.js`.
 *
 * @param libDir The package's `lib/` ({@linkcode findPartytownLib}).
 * @param dest The directory {@linkcode PARTYTOWN_PREFIX} is served from.
 * @param lib The public lib path `boot.js` points Partytown at.
 * @returns False (and nothing written) when the snippet is not the shape denext supports.
 */
async function writePartytownFiles(libDir: string, dest: string, lib: string): Promise<boolean> {
  const snippet = serviceWorkerModeSnippet(await Deno.readTextFile(join(libDir, "partytown.js")));
  if (snippet === null) return false;
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await Deno.mkdir(dest, { recursive: true });
  for (const [from, to] of Object.entries(PUBLISHED_LIB_FILES)) {
    await Deno.copyFile(join(libDir, from), join(dest, to));
  }
  await Deno.writeTextFile(join(dest, "partytown-sw.js"), partytownServiceWorkerSource());
  await Deno.writeTextFile(join(dest, "boot.js"), partytownBootSource(lib, snippet));
  return true;
}

/** The warning when the installed Partytown's snippet is not a shape denext can pin. */
export const PARTYTOWN_UNSUPPORTED_WARNING =
  "denext: the installed Partytown's snippet is not a version denext supports, so " +
  '<Script strategy="worker"> runs on the main thread. Install `@qwik.dev/partytown` ' +
  "0.14 or `@builder.io/partytown` 0.10.";

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
  if (!(await writePartytownFiles(libDir, dest, lib))) {
    console.warn(PARTYTOWN_UNSUPPORTED_WARNING);
    setScriptWorkers({ missing: true });
    return false;
  }
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
