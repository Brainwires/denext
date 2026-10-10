// SPA mode: the pieces every SPA path (build, export, prod, dev) shares — URL/file
// constants, the generated entry, the HTML shell, and the config/entry resolution.

import { join, normalize, resolve, SEPARATOR, toFileUrl } from "@std/path";
import type { SpaConfig } from "../../server/config.ts";
import { normalizeSpaAssetsDir } from "../../server/config-validate.ts";
import { computeCsp, sha256Base64 } from "../../server/csp.ts";
import type { ProjectPaths } from "../paths.ts";
import { resolveExportPath } from "../export-paths.ts";
import { SHELL_CAPTURE_SCRIPT, type SpaShellParts } from "./shell-capture.ts";

/** The client-asset URL prefix (matches the App Router prod server). */
export const CLIENT_PREFIX = "/_denext/client/";

/**
 * The URL prefix the SPA's client output is served under, and the export-relative directory it
 * is written to: `/<spa.assetsDir>/` when set (Vite's `build.assetsDir`), else
 * {@linkcode CLIENT_PREFIX}.
 *
 * @param spa The SPA config.
 * @returns A prefix with a leading and a trailing slash.
 */
export function spaClientPrefix(spa: SpaConfig | undefined): string {
  if (spa?.assetsDir === undefined) return CLIENT_PREFIX;
  const dir = normalizeSpaAssetsDir(spa.assetsDir);
  if (dir === null) {
    throw new Error(
      `denext: \`spa.assetsDir\` must be a relative directory of letters, digits, "_", "." and ` +
        `"-" segments (e.g. "assets"), not ${JSON.stringify(spa.assetsDir)}`,
    );
  }
  return `/${dir}/`;
}

/** Live-reload SSE endpoint (dev). */
export const RELOAD_PATH = "/_denext/reload";
/** The external dev-reload module URL (kept out of the CSP inline-script path). */
export const DEV_RELOAD_JS_PATH = "/_denext/dev-reload.js";
/** The SPA entry bundle basename. */
export const ENTRY_FILE = "index.js";
/** The SPA extracted-stylesheet basename. */
export const STYLE_FILE = "index.css";
/** The generated shell basename. */
export const SHELL_FILE = "index.html";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The bundle entry source: import the user's entry module for its side effects
 * (it mounts the app itself). Kept as a generated wrapper — rather than bundling
 * the entry file directly — so this seam can inject the dev Fast Refresh hooks.
 *
 * In `dev`, it installs Fast Refresh **before** the app mounts: `enableFastRefresh()`
 * runs as inline code (after the static `denext/client` import's body), then the
 * user entry is pulled in with a **dynamic** `import()` so its `createRoot(...)` runs
 * with the family seam already active — a plain static `import` of the entry would be
 * hoisted and execute before the inline enable call. The refresh runtime is dev-only,
 * so a production entry keeps the bare static import (nothing extra ships).
 *
 * The dev entry also sets `globalThis.__denextDev` and installs the DevTools panel: SPA
 * dev has no other place that sets the flag, and both are dev-only, so neither reaches a
 * production entry.
 */
export function generateSpaEntry(
  entryUrl: string,
  dev = false,
  instrumentationClient: string | null = null,
  support: SpaEntrySupport = {},
): string {
  // `instrumentation-client` runs FIRST, before the app's entry (Next's semantics) — the
  // same prelude the App Router entries get.
  const prelude = instrumentationClient
    ? `import ${JSON.stringify(toFileUrl(instrumentationClient).href)};\n`
    : "";
  // Wire the reconciler-seam runtimes (class components, Activity offscreen scheduler,
  // ViewTransition marking) into place BEFORE the app mounts — the App Router entries emit the
  // same installs (see `classSupportBlock`/`activitySupportBlock`/`viewTransitionSupportBlock`
  // in bundle.ts). Each is gated so an app that doesn't use the feature emits no reference and
  // `deno bundle`/esbuild tree-shakes that runtime out. Without the class install, a SPA that
  // renders any class component (an error boundary, a `Schema.TaggedError` subclass) throws
  // "class components are disabled" at render; likewise `<Activity>`/`<ViewTransition>` would
  // silently no-op.
  const install = supportInstall(support);
  const links = (support.reactNative ? REACT_NATIVE_SPLASH : "") +
    (support.expoRouterLinks ? EXPO_ROUTER_LINKS : "");
  if (!dev) {
    // The installs ride a `data:` module imported AHEAD of the app entry: ES imports are
    // hoisted, so install STATEMENTS here would run only after the app module had evaluated —
    // and an app entry mounts synchronously (`createRoot(el).render(<App/>)`, React Native's
    // `AppRegistry` / `registerRootComponent`). Its first render would then meet class
    // components with no runtime installed and commit them blank for a round trip (a
    // gesture-handler `GestureDetector` finds its child missing and throws).
    return `// denext generated SPA entry — do not edit.\n${prelude}${seamImport(install)}import ${
      JSON.stringify(entryUrl)
    };\n${links}`;
  }
  // `__denextDev` is the FIRST statement (after the hoisted instrumentation import): the
  // DevTools panel and the whole inspector no-op unless the flag is set, and nothing else
  // in SPA dev sets it — the shell's dev script runs AFTER this module, so waiting for it
  // would leave the panel unmounted. Installing it here, before the app's dynamic import,
  // also lets the inspector see the very first commit.
  return `// denext generated SPA entry (dev) — do not edit.\n${prelude}` +
    `globalThis.__denextDev = true;\n${install}` +
    `import { enableFastRefresh } from "denext/client-runtime";\n` +
    `import { installDevtools } from "denext/devtools";\n` +
    `enableFastRefresh();\ninstallDevtools();\n` +
    `await import(${JSON.stringify(entryUrl)});\n${links}`;
}

/** Which reconciler-seam runtimes the SPA entry should install (class defaults on for SPA). */
export interface SpaEntrySupport {
  /**
   * The `spa.shell` client runtime's install lines (`spaShellInstall`), run ahead of the app so
   * its `createRoot` mounts off-screen while the prerendered shell stays painted. `""` / unset
   * without a shell.
   */
  shell?: string;
  /** Install the class-component runtime (default true for SPA — error boundaries are common). */
  classComponents?: boolean;
  /** Install the `<Activity>` offscreen scheduler (set when the app uses it). */
  activity?: boolean;
  /** Install the per-element `<ViewTransition>` runtime (set when the app uses it). */
  viewTransition?: boolean;
  /** Install the host-singleton runtime (default true; a scan clears it when no document tag). */
  singletons?: boolean;
  /** Route the shell's deep links through expo-router (React Native mode with `app/`). */
  expoRouterLinks?: boolean;
  /** React Native mode: hide the shell's splash screen once the app has drawn. */
  reactNative?: boolean;
}

/**
 * React Native mode: hide the Capacitor shell's splash screen once the app has drawn its first
 * frame (a frame after the root element first has content, at most ~10 s after boot), as
 * expo-router hides Expo's native splash when its first screen is ready. An Expo app's web code never hides it (Expo's web
 * build has no splash; the template's `hideAsync` call lives in its native-only variant), so
 * the splash otherwise stayed until the plugin's own timeout. Outside the shell `hideSplash`
 * does nothing; an app that calls `SplashScreen.hideAsync()` itself hides it the same way.
 */
export const REACT_NATIVE_SPLASH =
  `import { hideSplash as __denextHideSplash } from "denext/mobile";
(function __denextHideWhenDrawn(frames) {
  var root = typeof document === "undefined" ? null : document.getElementById("root");
  if (root && root.firstChild || frames > 600) {
    requestAnimationFrame(function () { __denextHideSplash().catch(function () {}); });
  } else {
    requestAnimationFrame(function () { __denextHideWhenDrawn(frames + 1); });
  }
})(0);
`;

/**
 * React Native mode with expo-router: the links that open the app in the Capacitor shell (its
 * custom scheme, `myapp://settings`, at launch and while it runs) navigate expo-router to their
 * path, as expo-router does on iOS and Android through expo-linking. Its web build reads the
 * route from the page URL only, so without this a deep link brought the app forward and
 * changed nothing. `router.navigate` is retried until the root layout has mounted; outside the
 * shell `onDeepLink` does nothing.
 *
 * A namespace import: `router` is a CommonJS export behind React Mode's `expo-router` overlay
 * (`export *` of the real package, which a dynamic `import()` chunk does not carry), and the
 * dev loop's dependency bundle exposes the whole CommonJS module as `__denextCjs`.
 */
export const EXPO_ROUTER_LINKS = `import * as __denextExpoRouter from "expo-router";
import { onDeepLink as __denextOnDeepLink } from "denext/mobile";
function __denextRouteLink(path, tries) {
  var m = __denextExpoRouter;
  var router = m.router || (m.__denextCjs && m.__denextCjs.router) || (m.default && m.default.router);
  try {
    router.navigate(path);
  } catch (err) {
    if (tries < 100) setTimeout(function () { __denextRouteLink(path, tries + 1); }, 100);
    else console.error(err);
  }
}
__denextOnDeepLink(function () {}, { route: function (path) { __denextRouteLink(path, 0); } });
`;

/**
 * The seam installs as one side-effect `import` of a `data:` module, evaluated before every
 * later import of the entry (esbuild and `deno bundle` both inline it and resolve its bare
 * `denext/*` imports as the entry's own). `""` when there is nothing to install.
 */
function seamImport(install: string): string {
  if (!install) return "";
  return `import 'data:text/javascript,${install.trim().split("\n").join("")}';\n`;
}

/** The `import`+`install()` lines for each seam runtime the entry needs. */
export function supportInstall(support: SpaEntrySupport): string {
  const lines: string[] = [];
  if (support.classComponents ?? true) {
    lines.push(
      `import { installClassSupport } from "denext/class-runtime";`,
      `installClassSupport();`,
    );
  }
  if (support.activity) {
    lines.push(
      `import { installActivitySupport } from "denext/client-runtime";`,
      `installActivitySupport();`,
    );
  }
  if (support.viewTransition) {
    lines.push(
      `import { installViewTransitionSupport } from "denext/client-runtime";`,
      `installViewTransitionSupport();`,
    );
  }
  if (support.singletons ?? true) {
    lines.push(
      `import { installSingletonSupport } from "denext/client-runtime";`,
      `installSingletonSupport();`,
    );
  }
  if (support.shell) lines.push(support.shell.trim());
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Classify a batch of changed source paths into the dev live-reload action:
 * `"refresh"` (Fast Refresh — re-import the rebuilt bundle, reconcile in place,
 * preserve state) for ordinary component/source edits, or `"reload"` (full page
 * reload) when the change is one Fast Refresh can't safely reconcile — the SPA
 * **entry module itself** (its top-level `createRoot(...).render(...)` mount may
 * have changed) or a `public/` asset (served files, not part of the module graph).
 *
 * Conservative on purpose: any entry/public change in the batch forces a reload, so
 * a mixed edit is never silently half-applied. Exported for testing.
 */
export function classifySpaChange(
  changed: string[],
  entryPath: string,
  publicDir: string,
): "reload" | "refresh" {
  // Normalized first: on Windows a watcher path, a config path and a joined one may disagree
  // on separators (`C:\app\public` vs `C:/app/public`) while naming the same file.
  const entry = normalize(entryPath);
  const pub = normalize(publicDir);
  for (const p of changed.map((c) => normalize(c))) {
    if (p === entry) return "reload";
    if (p === pub || p.startsWith(pub + SEPARATOR)) return "reload";
  }
  return "refresh";
}

let warnedSpaHead = false;
/**
 * Dev-only, once-per-process warning that `spa.head` is injected into `<head>` as raw
 * HTML (mirrors `metadata.head`'s warning) — a reminder to sanitize any untrusted
 * input the app splices into it, since the SPA shell is the config most likely to be
 * fed dynamic values.
 */
function warnRawSpaHeadOnce(): void {
  if (warnedSpaHead) return;
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  warnedSpaHead = true;
  console.warn(
    "denext: spa.head is injected into <head> as raw HTML — sanitize any untrusted " +
      "input to avoid injection. (dev-only warning)",
  );
}

/**
 * Opt-in CSP for the shell (client-only React ships none by default; this is parity
 * with Vite/CRA, not a limitation). Emitted as a <meta> so it applies for `export`
 * (any static host), `start`, and `dev`. `frame-ancestors` is header-only — ignored
 * in <meta> — so it is dropped here; the always-on `X-Frame-Options: SAMEORIGIN`
 * (applyDefaultSecurityHeaders) covers clickjacking. The shell ships no inline
 * script, so `script-src 'self'` needs no hashes; inline <style> in `spa.head` is
 * hashed by computeCsp so it stays allowed.
 */
async function cspMetaTag(
  spa: SpaConfig,
  head: string,
  inlineScripts: readonly string[] = [],
): Promise<string> {
  if (!spa.csp || spa.csp === "off") return "";
  const route = spa.csp === "strict" ? undefined : spa.csp;
  const hashes = await Promise.all(
    inlineScripts.map(async (s) => `'sha256-${await sha256Base64(s)}'`),
  );
  const policy = (await computeCsp(head, {
    ...route,
    scriptSrc: [...(route?.scriptSrc ?? []), ...hashes],
  }))
    .split("; ")
    .filter((d) => !/^frame-ancestors\b/.test(d))
    .join("; ");
  return `\n    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}" />`;
}

/**
 * The mount element (`<div id="root">`) and its inline scripts. Plain, it holds `spa.loading`
 * (the boot placeholder the app's first render replaces). With a rendered `spa.shell` it is
 * marked `data-denext-shell` and holds the shell's markup, preceded by the boot script and
 * followed by the field-capture script ({@linkcode SHELL_CAPTURE_SCRIPT}); `scripts` lists the
 * inline sources the CSP must hash.
 */
function mountElement(
  rootId: string,
  loading: string | undefined,
  shell: SpaShellParts | null | undefined,
): { html: string; scripts: string[] } {
  const id = escapeHtml(rootId);
  if (!shell) return { html: `<div id="${id}">${loading ?? ""}</div>`, scripts: [] };
  const scripts = shell.bootScript
    ? [shell.bootScript, SHELL_CAPTURE_SCRIPT]
    : [SHELL_CAPTURE_SCRIPT];
  const boot = shell.bootScript ? `<script>${shell.bootScript}</script>\n    ` : "";
  return {
    html: `${boot}<div id="${id}" data-denext-shell="">${shell.markup}</div>\n    ` +
      `<script>${SHELL_CAPTURE_SCRIPT}</script>`,
    scripts,
  };
}

/** Generate the HTML shell that boots the SPA bundle. */
/**
 * The client chunk URLs the entry STATICALLY imports (transitively) — for `modulepreload`.
 * Reading `index.js` and following only static `import ... "…"` / `export ... from "…"`
 * specifiers (never dynamic `import(…)`) mirrors Vite's entry-graph preload: the browser
 * fetches the runtime chunks in parallel with the entry instead of discovering them after
 * it downloads and parses. Dynamic imports (route/feature chunks, the app's own big lazy
 * `main`) are intentionally left out — preloading those would waste bandwidth on code a
 * given load may never reach.
 */
export async function collectSpaPreloads(
  clientDir: string,
  entryFile: string,
  prefix: string = CLIENT_PREFIX,
): Promise<string[]> {
  const seen = new Set<string>();
  const queued = new Set<string>();
  const queue = [entryFile];
  const out: string[] = [];
  // Static ESM imports/re-exports; the negative lookahead drops dynamic `import(`.
  const importRe = /\b(?:import|export)\b(?!\s*\()(?:[^"'();]*?\bfrom\b\s*)?["']([^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = await Deno.readTextFile(join(clientDir, file));
    } catch {
      continue; // a specifier that isn't an emitted local file (bare/npm) — skip
    }
    for (const m of src.matchAll(importRe)) {
      const spec = m[1];
      if (!spec.startsWith(prefix)) continue; // only our emitted client chunks
      const name = spec.slice(prefix.length);
      if (name === entryFile || seen.has(name) || queued.has(name)) continue;
      queued.add(name);
      out.push(name);
      queue.push(name);
    }
  }
  return out;
}

/**
 * Expo web's root style (`reactNative` mode): React Native's root view is `flex: 1`, so the
 * page and the mount node must be a full-height flex parent. Keyed on `rootId`; an id that is
 * not a plain CSS identifier is matched with an attribute selector instead.
 */
function reactNativeRootStyleTag(rootId: string): string {
  const root = /^[A-Za-z][\w-]*$/.test(rootId)
    ? `#${rootId}`
    : `[id="${rootId.replace(/["\\<>]/g, "")}"]`;
  return `\n    <style>html,body,${root}{height:100%;margin:0}${root}{display:flex}</style>`;
}

export async function spaShellHtml(opts: {
  spa: SpaConfig;
  /** URL of the client entry bundle (e.g. `/_denext/client/index.js`). */
  scriptSrc: string;
  /** URL of the extracted stylesheet, when the app has CSS. */
  styleHref?: string;
  /** URL of the dev-reload module (dev only). */
  devScriptSrc?: string;
  /** Client chunk URLs to `<link rel="modulepreload">` (the entry's static graph). */
  preload?: string[];
  /**
   * Inject Expo web's root style ahead of `spa.head`, and default the viewport to
   * `viewport-fit=cover` (`reactNative` mode).
   */
  reactNativeRootStyle?: boolean;
  /** Head markup that goes ahead of `spa.head` (React Native mode's `@font-face` rules). */
  headPrefix?: string;
  /** The rendered `spa.shell` for this target (`renderSpaShell`); replaces `spa.loading`. */
  shell?: SpaShellParts | null;
}): Promise<string> {
  const { spa } = opts;
  const lang = spa.lang ?? "en";
  const title = spa.title ?? "denext app";
  const rootId = spa.rootId ?? "root";
  const style = opts.styleHref
    ? `\n    <link rel="stylesheet" href="${escapeHtml(opts.styleHref)}" />`
    : "";
  const preload = (opts.preload ?? [])
    .map((href) => `\n    <link rel="modulepreload" href="${escapeHtml(href)}" />`)
    .join("");
  if (spa.head) warnRawSpaHeadOnce();
  const rnStyle = opts.reactNativeRootStyle ? reactNativeRootStyleTag(rootId) : "";
  const head = rnStyle + (opts.headPrefix ?? "") + (spa.head ? `\n    ${spa.head}` : "");
  // An app-supplied viewport (`viewport-fit=cover` for iOS safe areas, `interactive-widget`)
  // replaces the default instead of competing with it. React Native mode's default covers the
  // whole screen, as a React Native app does: without `viewport-fit=cover` every safe-area
  // inset (SafeAreaView, react-native-safe-area-context) reads 0 in the iOS shell.
  const viewportContent = opts.reactNativeRootStyle
    ? "width=device-width, initial-scale=1, viewport-fit=cover"
    : "width=device-width, initial-scale=1";
  const viewport = /<meta\b[^>]*\bname=["']viewport["']/i.test(spa.head ?? "")
    ? ""
    : `\n    <meta name="viewport" content="${viewportContent}" />`;
  const devScript = opts.devScriptSrc
    ? `\n    <script src="${escapeHtml(opts.devScriptSrc)}"></script>`
    : "";
  const mount = mountElement(rootId, spa.loading, opts.shell);
  const cspMeta = await cspMetaTag(spa, head + mount.html, mount.scripts);
  // The app's stylesheet follows `spa.head`, where Vite injects it (before `</head>`, after the
  // page's own head content). A migrated index.html's inline boot `<style>` (`body { font-family:
  // ... }`) then yields to the app's rules of the same specificity instead of overriding them.
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="utf-8" />${cspMeta}${viewport}
    <title>${escapeHtml(title)}</title>${head}${preload}${style}
  </head>
  <body>
    ${mount.html}
    <script type="module" src="${escapeHtml(opts.scriptSrc)}"></script>${devScript}
  </body>
</html>
`;
}

/** Resolve the SPA config + absolute entry path, throwing a clear error if absent. */
export function spaEntryPath(paths: ProjectPaths): { spa: SpaConfig; entryPath: string } {
  const spa = paths.config?.spa;
  if (!spa) {
    throw new Error(
      'denext: mode "spa" requires a `spa` config (e.g. `spa: { entry: "./src/main.tsx" }`)',
    );
  }
  return { spa, entryPath: resolve(paths.projectDir, spa.entry) };
}

/** Assert the entry module exists on disk (a clear error beats a cryptic bundle failure). */
export async function assertEntryExists(entryPath: string): Promise<void> {
  try {
    const info = await Deno.stat(entryPath);
    if (!info.isFile) throw new Error();
  } catch {
    throw new Error(`denext: SPA entry not found at ${entryPath} (check \`spa.entry\`).`);
  }
}

/** True for a request that should receive the SPA shell (a navigation), not a 404. */
export function wantsShell(request: Request, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) return true;
  // Extensionless paths are navigations (client-router routes); a path with a file
  // extension that wasn't served as an asset above is a genuine 404.
  return resolveExportPath(pathname).navigation;
}
