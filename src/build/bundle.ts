// Browser bundling via Deno's own `deno bundle` — no third-party bundler.
//
// For each page route we generate a single entry module that imports the page,
// its layouts, and the client runtime, then hydrates. Bundling the whole thing
// as one module graph keeps shared module identity (e.g. context symbols)
// intact, which separate dynamic imports would break.

import { denoVersionOk, MIN_DENO_VERSION } from "./deno-version.ts";
import { MOMENTUM_SCROLL_OPT_OUT } from "../client/momentum-boot.ts";
import { basename, dirname, fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import type { PageRoute } from "../router/manifest.ts";
import type { BoundaryManifest } from "./module-graph.ts";
import {
  findServerOnlyLeaks,
  formatServerOnlyLeaks,
  type ServerOnlyLeak,
} from "./server-only-scan.ts";
import { hiddenSourceMapsEnabled } from "./hidden-sourcemaps.ts";
import { clientImportMap, type ClientImports, type ServerModules } from "./client-imports.ts";
import {
  findShippedServerModules,
  formatServerModuleLeaks,
  importerChains,
  type ServerModuleLeak,
} from "./server-module-guard.ts";
import { carryLinks } from "./config-links.ts";
import { appDenextRootFor, foldAppDenext, JSR_DENEXT_ROOT } from "./app-framework-root.ts";

/**
 * The framework root as a URL, in whatever scheme the framework itself runs under:
 * `file://…` from a local checkout, `https://jsr.io/@denext/denext/<ver>/` when a consumer
 * runs the CLI straight from JSR (`deno run -A jsr:@denext/denext/cli …`). Always ends with a
 * slash. This is the scheme-agnostic base — prefer it (+ {@link frameworkFileUrl} /
 * {@link readFrameworkText}) over {@link frameworkRoot}, whose filesystem path only exists for
 * a local checkout.
 */
export function frameworkRootUrl(): string {
  return new URL("../../", import.meta.url).href;
}

/** The URL of a file/module under the framework root, in the framework's own scheme. */
export function frameworkFileUrl(relative: string): string {
  return new URL(relative, frameworkRootUrl()).href;
}

/**
 * Read a text file under the framework root: `Deno.readTextFile` for a local checkout,
 * `fetch()` when the framework is served remotely (JSR). Lets the build read its own
 * `deno.json`/assets whether denext runs from disk or straight from JSR.
 */
async function readFrameworkText(relative: string): Promise<string> {
  const url = frameworkFileUrl(relative);
  if (url.startsWith("file://")) return await Deno.readTextFile(fromFileUrl(url));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `could not fetch framework file "${relative}" (${res.status} ${res.statusText})`,
    );
  }
  return await res.text();
}

/** Parse a JSON file under the framework root (scheme-agnostic). `{}` if unreadable. */
export async function readFrameworkJson(
  relative: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFrameworkText(relative)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The framework's own import map, with its relative entries (`denext` → `./mod.ts`) absolutized
 * to the framework's scheme (file:// or the remote JSR URL) so a build re-exec'd from a temp dir
 * can still resolve them. jsr:/npm:/absolute values pass through unchanged.
 */
export async function frameworkImports(): Promise<Record<string, string>> {
  const cfg = await readFrameworkJson("deno.json");
  return absolutizeAgainstUrl(
    (cfg.imports ?? {}) as Record<string, string>,
    frameworkFileUrl("deno.json"),
  );
}

/**
 * `imports` with its relative entries (`./mod.ts`, `../src/`) resolved against `baseUrl` (any
 * scheme — file:// or a remote framework root); a trailing-slash prefix mapping keeps its slash.
 * jsr:/npm:/absolute values pass through unchanged.
 */
function absolutizeAgainstUrl(
  imports: Record<string, string>,
  baseUrl: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(imports)) {
    if (value.startsWith("./") || value.startsWith("../")) {
      const abs = new URL(value, baseUrl).href;
      out[key] = value.endsWith("/") && !abs.endsWith("/") ? abs + "/" : abs;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Absolute filesystem path to the denext framework root (contains deno.json, mod.ts) for a
 * local checkout. When the framework runs remotely (from JSR) there is no filesystem path, so
 * this returns the remote root URL instead — callers that only use it as a `startsWith` prefix
 * for classifying framework-internal modules still work, because remote module paths carry that
 * same URL prefix. Callers that build sub-paths must use {@link frameworkFileUrl} (which handles
 * both schemes) rather than `join(frameworkRoot(), …)` (which corrupts a URL's `//`).
 */
export function frameworkRoot(): string {
  const url = frameworkRootUrl();
  return url.startsWith("file://") ? fromFileUrl(url) : url;
}

/**
 * Resolve the `deno` executable to shell out to for bundling.
 *
 * Under `deno run`, `Deno.execPath()` is the deno binary. But in a `deno
 * compile`d denext binary it is `denext` itself — running `denext bundle` would
 * just print help. Resolution order:
 *   1. `DENO_BIN` env var (explicit override)
 *   2. `Deno.execPath()` when it is actually `deno`
 *   3. the standard install location `~/.deno/bin/deno`
 *   4. `deno` on PATH (last resort)
 */
export function denoExecutable(): string {
  const fromEnv = Deno.env.get("DENO_BIN");
  if (fromEnv) return fromEnv;

  const exec = Deno.execPath();
  const base = basename(exec).toLowerCase().replace(/\.exe$/, "");
  if (base === "deno") return exec;

  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (home) {
    const bin = Deno.build.os === "windows" ? "deno.exe" : "deno";
    const candidate = join(home, ".deno", "bin", bin);
    try {
      Deno.statSync(candidate);
      return candidate;
    } catch {
      // not there; fall through
    }
  }
  return "deno";
}

let bundleSupport: Promise<void> | undefined;

/**
 * Verify the resolved `deno` exists and is new enough for the (experimental)
 * `deno bundle` subcommand, with a clear, actionable error otherwise. Runs the
 * check once per process (memoized). `deno bundle` is an evolving subcommand;
 * this fails fast on a missing/old binary instead of a cryptic bundle error, and
 * the build-smoke test guards against output-shape drift.
 */
export function ensureBundleSupport(): Promise<void> {
  // Memoize only a SUCCESSFUL probe. Caching a rejection would permanently brick
  // a long-lived dev server after one transient spawn failure (or after the user
  // fixes their Deno install / sets DENO_BIN) — reset so the next call re-probes.
  if (!bundleSupport) {
    bundleSupport = probeBundleSupport().catch((err) => {
      bundleSupport = undefined;
      throw err;
    });
  }
  return bundleSupport;
}

async function probeBundleSupport(): Promise<void> {
  const deno = denoExecutable();
  let versionText: string;
  try {
    const out = await new Deno.Command(deno, {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    versionText = new TextDecoder().decode(out.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `denext: could not run \`${deno} --version\` to bundle client code (${msg}). ` +
        `Install Deno ${MIN_DENO_VERSION}+, or set DENO_BIN to a compatible deno binary.`,
    );
  }
  const match = versionText.match(/deno\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    throw new Error(
      `denext: unexpected \`deno --version\` output while checking bundle support:\n${versionText}\n` +
        `denext needs Deno ${MIN_DENO_VERSION}+ (the \`deno bundle\` subcommand). Set DENO_BIN if needed.`,
    );
  }
  if (!denoVersionOk(`${match[1]}.${match[2]}.${match[3]}`)) {
    throw new Error(
      `denext: bundling requires Deno ${MIN_DENO_VERSION}+ (the \`deno bundle\` subcommand); ` +
        `found ${match[0]}. Upgrade Deno, or set DENO_BIN to a newer deno binary.`,
    );
  }
}

/**
 * The route's own top-level source files (page, layouts, templates, loading,
 * error, and slot pages) — the crawl roots for discovering a route's CSS.
 */
export function routeSourceFiles(route: PageRoute): string[] {
  const files = [route.filePath, ...route.layoutChain, ...route.templateChain];
  if (route.loading) files.push(route.loading);
  if (route.error) files.push(route.error);
  for (const slot of Object.values(route.slots ?? {})) {
    if (slot.default) files.push(slot.default);
    for (const p of slot.pages) files.push(p.filePath);
  }
  return files;
}

/**
 * Every default-export component module the SERVER loads for a route: page,
 * layout/template chains, loading/error/not-found/forbidden/unauthorized
 * boundaries, and slot pages/defaults. These are the modules the SSR loader must
 * be able to redirect to a react→denext-rewritten bundle (superset of
 * {@link routeSourceFiles}, which omits the extra boundaries — that one is for CSS
 * crawl roots only).
 */
export function routeServerModules(route: PageRoute): string[] {
  const files = routeSourceFiles(route);
  if (route.notFound) files.push(route.notFound);
  if (route.forbidden) files.push(route.forbidden);
  if (route.unauthorized) files.push(route.unauthorized);
  return [...new Set(files)];
}

type SlotEntry = readonly [name: string, file: string];

/**
 * Parallel-route slots: for the isomorphic client bundle, render each slot's `default`
 * (or its most-specific page). Per-URL slot matching + intercepts are resolved on the
 * server (SSR/Flight); interactive slots use the Flight path.
 */
function routeSlotEntries(route: PageRoute): SlotEntry[] {
  return Object.entries(route.slots ?? {})
    .map(([name, slot]) => [name, slot.default ?? slot.pages[0]?.filePath] as const)
    .filter((e): e is SlotEntry => !!e[1]);
}

function importLine(ident: string, file: string): string {
  return `import ${ident} from ${JSON.stringify(toFileUrl(file).href)};`;
}

/** The route entry's static imports: page, layouts, templates, slots, loading/error. */
function routeEntryImports(route: PageRoute, slots: SlotEntry[]): string {
  const lines = [importLine("Page", route.filePath)];
  route.layoutChain.forEach((p, i) => lines.push(importLine(`Layout${i}`, p)));
  route.templateChain.forEach((p, i) => lines.push(importLine(`Template${i}`, p)));
  slots.forEach(([, file], i) => lines.push(importLine(`Slot${i}`, file)));
  if (route.loading) lines.push(importLine("Loading", route.loading));
  if (route.error) lines.push(importLine("ErrorComp", route.error));
  return lines.join("\n");
}

/** Wrap the page innermost → outermost, mirroring the server's composition. */
function routeEntryTree(route: PageRoute, slots: SlotEntry[]): string {
  const slotProps = slots
    .map(([name], i) => `${JSON.stringify(name)}: h(Slot${i}, { params: data.params })`)
    .join(", ");
  let wrap = "let tree = h(Page, { params: data.params, searchParams: sp });\n";
  if (route.loading) {
    wrap += "  tree = h(Suspense, { fallback: h(Loading, {}), children: tree });\n";
  }
  if (route.error) {
    wrap += "  tree = h(ErrorBoundary, { fallback: ErrorComp, children: tree });\n";
  }
  for (let i = route.templateChain.length - 1; i >= 0; i--) {
    wrap += `  tree = h(Template${i}, { children: tree, params: data.params });\n`;
  }
  const innermostLayout = route.layoutChain.length - 1;
  for (let i = innermostLayout; i >= 0; i--) {
    // The innermost layout also receives the parallel-route slot props.
    const extra = i === innermostLayout && slotProps ? `, ${slotProps}` : "";
    const depth = route.layoutDepths?.[i] ?? 0;
    wrap += `  tree = h(Layout${i}, { children: tree, params: data.params${extra} });\n`;
    // Provide the layout's segment depth so useSelectedLayoutSegment(s) resolves
    // relative to its level (mirrors the server's wrapLayouts).
    wrap +=
      `  tree = provideLayoutSegments({ pathname: location.pathname, depth: ${depth} }, tree);\n`;
  }
  return wrap;
}

/**
 * Fast Refresh imports + setup (dev only). Bundled mode registers each route-structural
 * component under a stable family id (module URL + export) so a re-imported edit
 * reconciles onto the existing fiber and preserves hook state, then enables the seam.
 * Unbundled (per-module) mode: each source module is served (and re-imported) on its own,
 * so the PER-MODULE footer (spaRefreshPlugin/refreshFooter) registers each component under
 * its export-named family id. The entry must NOT also register them under `#default` —
 * that second registration would win on `familiesByType` and shadow the footer's, so an
 * edit's re-registration (keyed by export name) would never reach the ref the tree
 * actually rendered. Just enable the seam. Both also install the first-party DevTools
 * (inspector + in-page panel), imported only here in dev so it never ships in production.
 * Bundled mode appends `opts.devMetaFooter` (the route files' `__dnxMeta` calls) after the
 * registrations; unbundled mode ignores it (its per-module footers carry the metadata).
 */
function routeRefreshBlock(
  route: PageRoute,
  slots: SlotEntry[],
  opts: GenerateRouteEntryOptions,
): { refreshImport: string; refreshReg: string } {
  const { dev = false, perModule = false } = opts;
  if (!dev) return { refreshImport: "", refreshReg: "" };
  if (perModule) {
    return {
      refreshImport:
        `import { enablePerModuleRefresh } from "denext/client-runtime";\nimport { installDevtools } from "denext/devtools";\n`,
      refreshReg: `enablePerModuleRefresh();\ninstallDevtools();\n`,
    };
  }
  const fam = (ident: string, file: string) =>
    `registerFamily(${ident}, ${JSON.stringify(toFileUrl(file).href + "#default")});`;
  const lines = [fam("Page", route.filePath)];
  route.layoutChain.forEach((p, i) => lines.push(fam(`Layout${i}`, p)));
  route.templateChain.forEach((p, i) => lines.push(fam(`Template${i}`, p)));
  if (route.loading) lines.push(fam("Loading", route.loading));
  if (route.error) lines.push(fam("ErrorComp", route.error));
  slots.forEach(([, file], i) => lines.push(fam(`Slot${i}`, file)));
  return {
    refreshImport:
      `import { enableFastRefresh, registerFamily } from "denext/client-runtime";\nimport { installDevtools } from "denext/devtools";\n`,
    // The DevTools metadata sidecar rides AFTER the registrations, keyed by the same
    // `<url>#default` family ids (bundled dev only — see `GenerateRouteEntryOptions`).
    refreshReg: `enableFastRefresh();\ninstallDevtools();\n${lines.join("\n")}\n` +
      (opts.devMetaFooter ?? ""),
  };
}

/**
 * The hydration `catch` body. On a Fast Refresh re-import (marked by the dev client), a
 * hydration/render error is unrecoverable in place — fall back to a full reload; on first
 * load keep the warning (async-server-component skip / flight failure).
 */
function hydrationCatch(dev: boolean, message: string): string {
  const warn = `console.warn(${JSON.stringify(message)}, err && err.message);`;
  return dev ? `if (window.__denextRefreshing) location.reload();\n    else ${warn}` : warn;
}

/**
 * The `instrumentation-client` prelude of a generated browser entry: a side-effect import
 * of the project's `instrumentation-client.{ts,tsx,js}` FIRST, so it runs before the app's
 * client code starts (Next's semantics). Empty when the project has none.
 */
function clientInstrumentationImport(path: string | null | undefined): string {
  return path ? `import ${JSON.stringify(toFileUrl(path).href)};\n` : "";
}

/** How {@linkcode generateRouteEntry} shapes a route's browser entry. Every field is optional. */
export interface GenerateRouteEntryOptions {
  /** Emit Fast Refresh registration + the DevTools install (dev only). Default `false`. */
  dev?: boolean;
  /**
   * The unbundled dev server: install PER-MODULE Fast Refresh (`enablePerModuleRefresh`,
   * which adds the reconciler's family-current substitution) instead of the whole-entry
   * `enableFastRefresh`. Only meaningful with `dev`. Default `false`.
   */
  perModule?: boolean;
  /** The project's `instrumentation-client` module, imported first. Default none. */
  instrumentationClient?: string | null;
  /** How the entry gets the class-component runtime. Default `"lazy"`. */
  classRuntime?: ClassRuntimeMode;
  /** Install `<Activity>` support. Default `false`. */
  usesActivity?: boolean;
  /** Install `<ViewTransition>` support. Default `false`. */
  usesViewTransition?: boolean;
  /** Install host-singleton support (a client root layout's document tags). Default `true`. */
  usesSingletons?: boolean;
  /**
   * The route files' DevTools metadata (`__dnxMeta(…)` calls plus their import, from
   * `routeDevMeta`), appended after the `registerFamily` calls. Honoured ONLY for a bundled
   * dev entry (`dev && !perModule`); a production or per-module entry ignores it.
   */
  devMetaFooter?: string;
}

/**
 * Generate the browser entry source that hydrates a single page route.
 *
 * @param route The page route.
 * @param opts Dev/refresh mode, runtime installs and the dev metadata footer.
 * @returns The generated entry module source.
 */
export function generateRouteEntry(
  route: PageRoute,
  opts: GenerateRouteEntryOptions = {},
): string {
  const slots = routeSlotEntries(route);
  const { refreshImport, refreshReg } = routeRefreshBlock(route, slots, opts);
  const { classImport, classInstall, classBoot } = classSupportBlock(opts.classRuntime ?? "lazy");
  const { activityImport, activityInstall } = activitySupportBlock(opts.usesActivity ?? false);
  const { vtImport, vtInstall } = viewTransitionSupportBlock(opts.usesViewTransition ?? false);
  const { singletonImport, singletonInstall } = singletonSupportBlock(opts.usesSingletons ?? true);
  return `// denext generated route entry — do not edit.
${
    clientInstrumentationImport(opts.instrumentationClient)
  }import { startClient, provideLayoutSegments } from "denext/client-runtime";
import { Suspense, ErrorBoundary } from "denext/client";
import { h } from "denext/jsx-runtime";
${classImport}${activityImport}${vtImport}${singletonImport}${refreshImport}${
    routeEntryImports(route, slots)
  }
${refreshReg}${classInstall}${activityInstall}${vtInstall}${singletonInstall}
async function main() {
  const el = document.getElementById("__denext");
  const dataEl = document.getElementById("__denext_data");
  if (!el) return;
  const data = dataEl
    ? JSON.parse(dataEl.textContent || "{}")
    : { params: {}, searchParams: "" };
  const sp = new URLSearchParams(data.searchParams || "");
  ${routeEntryTree(route, slots)}
${classBoot}  try {
    startClient(el, tree);
  } catch (err) {
    ${hydrationCatch(opts.dev ?? false, "denext: skipping hydration for this route:")}
  }
}

main();
`;
}

/**
 * The browser entry for `global-error.tsx`. It replaces the root layout and renders its own
 * `<html>`/`<body>`, so — unlike a route entry — it hydrates the whole document (not the
 * `#__denext` container) via `startGlobalErrorClient`, which rebuilds the error from the
 * server's `#__denext_ge_data` island and supplies a real `reset`. Tiny by design: this page
 * only ships when an uncaught error escaped rendering.
 */
export function generateGlobalErrorEntry(
  globalErrorFile: string,
  instrumentationClient: string | null = null,
): string {
  return `// denext generated global-error entry — do not edit.
${
    clientInstrumentationImport(instrumentationClient)
  }import { startGlobalErrorClient } from "denext/client-runtime";
import GlobalError from ${JSON.stringify(toFileUrl(globalErrorFile).href)};
startGlobalErrorClient(GlobalError);
`;
}

/**
 * Generate the browser entry for a Flight route. Unlike {@link generateRouteEntry}
 * (which statically imports the whole page tree), this imports ONLY the app's
 * `"use client"` modules, builds a registry keyed by client-reference id, reads
 * the `#__denext_flight` island, and hydrates the reconstructed island tree.
 * Server-component code never enters this bundle.
 *
 * @param boundary The app's boundary manifest (its `client` modules are imported).
 * @param dev When true, emit Fast Refresh registration for client islands (dev only).
 * @returns The generated entry module source.
 */
/**
 * Whether any source file under `rootDir` (or in `extraFiles` — sibling-package modules
 * the routes import) satisfies `test` when its text is read. The shared machinery behind
 * the build-time feature scans ({@linkcode appImportsLive}, {@linkcode appUsesClassComponents},
 * {@linkcode appUsesActivity}): each is a deliberate over-approximation that keeps a runtime
 * whenever its token appears and only drops it when the app never mentions it — so a scan can
 * never false-DROP a feature. Early-returns on the first match. Reads only the app's own
 * sources ({@linkcode appScanFiles}): never a previous build's output, which would keep a feature
 * the app has since dropped. A file that can't be read counts as no match.
 */
async function scanAppSources(
  rootDir: string,
  test: (content: string) => boolean,
  extraFiles: string[] = [],
): Promise<boolean> {
  for (const file of extraFiles) {
    if (test(await Deno.readTextFile(file).catch(() => ""))) return true;
  }
  for await (const file of appScanFiles(rootDir)) {
    if (test(await Deno.readTextFile(file).catch(() => ""))) return true;
  }
  return false;
}

/** Folders a feature scan never reads: tooling state and dependencies. */
const SCAN_SKIP = new Set([".denext", ".git", "node_modules"]);
/** Project-root folders that hold build output (`denext export`'s default, desktop/mobile builds). */
const SCAN_SKIP_ROOT = new Set(["out", "dist"]);
/** The source extensions a feature scan reads. */
const SCAN_SOURCE = /\.(?:tsx?|jsx?|mjs)$/;

/**
 * The app's source files under `dir`, for the feature scans. Build output is left out: the
 * root's `out/` and `dist/`, and any folder holding an export (`_denext/`, so a custom
 * `denext export --out`, its `.staging`/`.prev` siblings and the copies Capacitor keeps under
 * `ios/` / `android/` are all skipped). A stale export's bundles name every feature its
 * last build had, so reading them would keep a runtime the app no longer uses.
 */
async function* appScanFiles(dir: string, root = dir): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isFile) {
      if (SCAN_SOURCE.test(entry.name)) yield path;
    } else if (
      entry.isDirectory && !SCAN_SKIP.has(entry.name) &&
      !(dir === root && SCAN_SKIP_ROOT.has(entry.name)) && !(await isExportDir(path))
    ) {
      yield* appScanFiles(path, root);
    }
  }
}

/** Whether `dir` is a static export (it holds the `_denext/` asset folder every export writes). */
function isExportDir(dir: string): Promise<boolean> {
  return Deno.stat(join(dir, "_denext")).then((s) => s.isDirectory, () => false);
}

/**
 * Whether any source file under `rootDir` imports `denext/live` — the build-time signal
 * that decides if the Flight entry bundles the Live WebSocket transport (see
 * {@linkcode generateFlightEntry}'s `usesLive`). The substring also matches the full
 * `@denext/denext/live` JSR form. `extraFiles` are sibling-package modules the routes import.
 */
export function appImportsLive(rootDir: string, extraFiles: string[] = []): Promise<boolean> {
  return scanAppSources(rootDir, (c) => c.includes("denext/live"), extraFiles);
}

/**
 * Whether any source file under `rootDir` (or in `extraFiles`, e.g. sibling workspace
 * modules) uses class components — the build-time PRELOAD HINT that makes the generated
 * entry install the class runtime eagerly instead of on demand (see
 * {@linkcode classSupportBlock}: a miss is not a crash, the runtime still loads lazily when
 * a page's server render produced a class). A class component in these sources MUST name
 * `Component`/`PureComponent` (in its import or its `extends`); whole-word (`\b`) so
 * `MyComponent` / `componentDidMount` don't trip it. npm packages are not scanned — the word
 * appears in nearly every React package, so the hint would be always-on for no gain.
 */
export function appUsesClassComponents(
  rootDir: string,
  extraFiles: string[] = [],
): Promise<boolean> {
  return scanAppSources(rootDir, (c) => /\b(?:Pure)?Component\b/.test(c), extraFiles);
}

/**
 * Whether any source file under `rootDir` uses `<Activity>` — the build-time signal that
 * decides if the generated entry installs the offscreen scheduler (see
 * {@linkcode activitySupportBlock}). An app can't render one without naming `Activity` (its
 * import, `React.Activity`, or `<Activity>`); whole-word (`\b`) so `ActivityIndicator` /
 * `myActivity` don't trip it. `denext/navigation`'s `StackLayout` / `TabsLayout` / `StackView` /
 * `TabsView` keep their hidden screens with `<Activity>`, so naming one of them counts too.
 */
export function appUsesActivity(rootDir: string, extraFiles: string[] = []): Promise<boolean> {
  return scanAppSources(
    rootDir,
    (c) => /\b(?:Activity|StackLayout|TabsLayout|StackView|TabsView)\b/.test(c),
    extraFiles,
  );
}

/**
 * Whether any source file under `rootDir` uses `<ViewTransition>` — the build-time signal that
 * decides if the generated entry installs the per-element marking runtime (see
 * {@linkcode viewTransitionSupportBlock}). An app can't render one without naming
 * `ViewTransition`; whole-word (`\b`) so a longer identifier doesn't trip it.
 */
export function appUsesViewTransition(
  rootDir: string,
  extraFiles: string[] = [],
): Promise<boolean> {
  return scanAppSources(rootDir, (c) => /\bViewTransition\b/.test(c), extraFiles);
}

/**
 * Whether any source file under `rootDir` renders a document tag (`<html>`, `<head>`, `<body>`)
 * — the build-time signal that decides if the generated entry installs the host-singleton
 * runtime (see {@linkcode singletonSupportBlock}): only a root layout rendered by client code puts
 * one under the page container, and an app can't render one without writing it (JSX, or an
 * `h("html", …)` / `createElement("body", …)` call). Comment-only lines are skipped, so a note
 * like "denext supplies <html>/<body>" doesn't count. A server root layout trips it too (the scan
 * can't tell); that only keeps a runtime the app may not need, never drops one it does.
 */
export function appRendersDocumentTags(
  rootDir: string,
  extraFiles: string[] = [],
): Promise<boolean> {
  const tag = /<(?:html|head|body)[\s>]|\(\s*["'](?:html|head|body)["']/;
  return scanAppSources(
    rootDir,
    (c) => tag.test(c.split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n")),
    extraFiles,
  );
}

/**
 * Fast Refresh (dev only) for the Flight entry: register each client island's exports as
 * a family so an edited island preserves state. Two modes:
 *  - bundled: the whole flight entry is re-imported on refresh, so it registers each
 *    export under its client-reference id (`clientId#k`) via `regFamily`.
 *  - perModule (unbundled): each island module is served on its OWN @fs URL with the
 *    per-module footer that registers `moduleUrl#k`, and only that module is re-imported
 *    on edit. The entry must NOT also register under `clientId#k` — a second family would
 *    shadow the footer's on `familiesByType`, so the edit's re-registration would never
 *    reach the ref the tree rendered. Just enable the seam; the flight `registry`
 *    (clientId#k -> fn, for Flight parsing) is separate from the fiber family and is
 *    still built in both modes.
 */
function flightRefreshBlock(
  dev: boolean,
  perModule: boolean,
): { refreshImport: string; regFamily: string; enableRefresh: string } {
  if (!dev) return { refreshImport: "", regFamily: "", enableRefresh: "" };
  const devtools = `import { installDevtools } from "denext/devtools";\n`;
  if (perModule) {
    return {
      refreshImport: `import { enablePerModuleRefresh } from "denext/client-runtime";\n` + devtools,
      regFamily: "",
      enableRefresh: "enablePerModuleRefresh();\ninstallDevtools();\n",
    };
  }
  return {
    refreshImport: `import { enableFastRefresh, registerFamily } from "denext/client-runtime";\n` +
      devtools,
    regFamily: '    registerFamily(v, clientId + "#" + k);\n',
    enableRefresh: "enableFastRefresh();\ninstallDevtools();\n",
  };
}

/**
 * Live Server Components ship the WebSocket transport (live-client + presence + data
 * subscriptions). It is pulled in ONLY when the app actually uses a live feature
 * (`usesLive`, a build-time scan for the `denext/live` specifier) — a Flight app that
 * never renders `<Live>`/`useLiveData` bundles none of it. The decision is build-time,
 * not runtime, because the Flight entry is app-wide: a soft navigation into a live route
 * reconstructs its tree through this same registry, so `Live` must already be registered
 * whenever any route uses it. `navigate` is imported only when `configureLive` (its sole
 * user here) is emitted.
 */
function flightLiveBlock(usesLive: boolean) {
  const clientImport =
    `import { flightClientIds, startClient, parseFlight, readStreamedFlight, setFlightParser, setResumabilityReboot } from "denext/client-runtime";${
      usesLive ? `\nimport { navigate } from "denext/client";` : ""
    }`;
  if (!usesLive) return { clientImport, liveImport: "", liveRegister: "", liveConfigure: "" };
  return {
    clientImport,
    liveImport: `import { Live, configureLive } from "denext/live";\n`,
    liveRegister:
      `\n// The framework <Live> island resolves through the same registry.\nregistry.set("denext#Live", Live);\n`,
    liveConfigure:
      `// Live Server Components: parse pushed boundary payloads through the app registry,
// and refresh the current route for coarse updates. No socket opens until a <Live>
// boundary mounts.
configureLive({
  parse: (flight) => registry.ensure(flight).then(() => parseFlight(flight, registry)),
  refresh: () => navigate(location.href, { history: false }),
});
`,
  };
}

/**
 * How a generated browser entry gets the class-component runtime (the on-demand
 * `denext/class-runtime` chunk: mount/update/unmount lifecycle, setState batching, class
 * error boundaries), installed into the reconciler seam (class-support.ts):
 *
 * - `"lazy"` (the default): the entry loads the chunk before hydrating ONLY when the
 *   document carries the `#__denext_classes` marker — the server stamps it when a render
 *   produced a class component — so a class that lives only in a dependency the build scan
 *   never read still hydrates in production, and a function-only page never fetches it.
 * - `"eager"`: a static import + install — the build scan saw a class in the app's own
 *   sources (or `classComponents: true`), so skip the extra round trip; also dev, which
 *   installs unconditionally (unbundled, so free).
 * - `"off"`: nothing (`classComponents: false`); a class throws the guided error and the
 *   runtime costs zero bytes.
 */
export type ClassRuntimeMode = "eager" | "lazy" | "off";

/**
 * The entry-level pieces for a {@linkcode ClassRuntimeMode}: a static import + install
 * (eager), or an awaited marker-gated dynamic import placed before the first render (lazy —
 * the runtime must be in place before hydration starts, because whether a class fiber is an
 * error boundary is decided on the way down). The reconciler itself never statically imports
 * the runtime; the emitted install here is the sole link, so `deno bundle`/esbuild keep it
 * out of the entry (and, for `"lazy"`, in its own chunk).
 */
function classSupportBlock(
  mode: ClassRuntimeMode,
): { classImport: string; classInstall: string; classBoot: string } {
  if (mode === "eager") {
    return {
      classImport: `import { installClassSupport } from "denext/class-runtime";\n`,
      classInstall: "installClassSupport();\n",
      classBoot: "",
    };
  }
  if (mode === "lazy") {
    // The dynamic import lives in the runtime (class-loader.ts), not in the entry: one
    // importer means one chunk named after the module (`class-runtime-<hash>.js`), not an
    // anonymous `chunk-*` shared by every route entry.
    return {
      classImport: `import { loadClassRuntime } from "denext/client-runtime";\n`,
      classInstall: "",
      classBoot:
        `  // The server rendered a class component: load the class runtime BEFORE hydrating.
  if (document.getElementById("__denext_classes")) await loadClassRuntime();
`,
    };
  }
  return { classImport: "", classInstall: "", classBoot: "" };
}

/**
 * The `Activity` offscreen scheduler (hide/reveal a subtree, preserving its state, tearing
 * down its effects) is installed into the reconciler seam (activity-support.ts) ONLY when
 * the app uses `<Activity>` — so an app that never renders one never references
 * `installActivitySupport` and `deno bundle` tree-shakes the whole offscreen runtime out.
 * The reconciler itself never statically imports it; the emitted `installActivitySupport()`
 * here is the sole link. Native prod scans the app ({@linkcode appUsesActivity}); dev
 * installs unconditionally (unbundled, so free). `false` mirrors the default.
 */
function activitySupportBlock(
  usesActivity: boolean,
): { activityImport: string; activityInstall: string } {
  if (!usesActivity) return { activityImport: "", activityInstall: "" };
  return {
    activityImport: `import { installActivitySupport } from "denext/client-runtime";\n`,
    activityInstall: "installActivitySupport();\n",
  };
}

/**
 * The host-singleton runtime (a client root layout's `<html>`/`<head>`/`<body>` adopt the page's
 * own elements; singleton-support.ts) is installed into the reconciler seam unless a build scan
 * ({@linkcode appRendersDocumentTags}) found no document tag in the app — so an app whose
 * document denext or a server layout supplies tree-shakes it out. On by default: only a caller
 * that scanned the app drops it.
 */
function singletonSupportBlock(
  usesSingletons: boolean,
): { singletonImport: string; singletonInstall: string } {
  if (!usesSingletons) return { singletonImport: "", singletonInstall: "" };
  return {
    singletonImport: `import { installSingletonSupport } from "denext/client-runtime";\n`,
    singletonInstall: "installSingletonSupport();\n",
  };
}

/**
 * The `<ViewTransition>` per-element marking runtime is installed into the reconciler seam
 * (view-transition-support.ts) ONLY when the app uses `<ViewTransition>` — so an app that
 * never renders one never references `installViewTransitionSupport` and `deno bundle`
 * tree-shakes the marking runtime out. The navigation runtime never statically imports it;
 * the emitted `installViewTransitionSupport()` here is the sole link. Native prod scans the
 * app ({@linkcode appUsesViewTransition}); dev installs unconditionally (unbundled, free).
 */
function viewTransitionSupportBlock(
  usesViewTransition: boolean,
): { vtImport: string; vtInstall: string } {
  if (!usesViewTransition) return { vtImport: "", vtInstall: "" };
  return {
    vtImport: `import { installViewTransitionSupport } from "denext/client-runtime";\n`,
    vtInstall: "installViewTransitionSupport();\n",
  };
}

/**
 * Seed the `denext/feature` flag map on the CLIENT for the native App Router path. The
 * compat/SPA esbuild paths inline `__DENEXT_FEATURES__` via `define`, but `deno bundle` has
 * no `define`, and the fold only reaches component (`.tsx`/`.jsx`) modules — so a `feature()`
 * call in a plain `.ts` util (or via a namespace import) would otherwise read the empty
 * `globalThis` default and disagree with the (seeded) server render. Seeding here makes the
 * fold a pure DCE optimization: any un-folded call still returns the configured value. Emitted
 * at the top of the entry, before any island module executes. Empty map → nothing emitted (the
 * runtime default `{}` already reads every flag as `false`).
 */
function featureSeedBlock(features: Record<string, boolean>): string {
  if (Object.keys(features).length === 0) return "";
  return `globalThis.__DENEXT_FEATURES__ = ${JSON.stringify(features)};\n`;
}

/**
 * The client-entry prelude for `momentumSafeScroll: false`: it sets the global the runtime's
 * root boot reads (src/client/momentum-boot.ts) so the iOS momentum-safe scroll shim is never
 * installed. Empty when the shim stays on (the default). Every client entry generator path
 * prepends it — native `deno bundle` ({@linkcode bundleSourceFiles} / {@linkcode bundleRoutes}),
 * the compat/SPA esbuild entries and the unbundled dev entries — since the runtime is shared
 * and prebuilt, a per-app `define` could not reach it.
 *
 * @param enabled The resolved `momentumSafeScroll` value (`undefined` means on).
 * @returns The statement to prepend, or `""`.
 */
export function momentumScrollSeed(enabled: boolean | undefined): string {
  return enabled === false ? `globalThis.${MOMENTUM_SCROLL_OPT_OUT} = false;\n` : "";
}

/**
 * {@linkcode momentumScrollSeed} as a side-effect `import` of a `data:` module, for an entry
 * that statically imports app code which may create a root while it evaluates (a SPA's
 * `main.tsx` calls `createRoot` at top level). ES imports are hoisted and evaluated before the
 * entry's own statements, so a prepended assignment would run after that root booted the shim;
 * an import prepended FIRST is evaluated first. `deno bundle` and esbuild inline the `data:`
 * module, so the output is the same one statement, now ahead of the app. Bundled entries only:
 * an unbundled dev entry would hand the `data:` URL to the browser (and its CSP).
 *
 * @param enabled The resolved `momentumSafeScroll` value (`undefined` means on).
 * @returns The import to prepend, or `""`.
 */
export function momentumScrollSeedImport(enabled: boolean | undefined): string {
  if (enabled !== false) return "";
  return `import "data:text/javascript,globalThis.${MOMENTUM_SCROLL_OPT_OUT}=false;";\n`;
}

/** The Flight entry's `main()`: read the island, adopt signal state, hydrate, boot resumability. */
function flightMain(catchBody: string, classBoot: string): string {
  return `async function main() {
  const el = document.getElementById("__denext");
  const flightEl = document.getElementById("__denext_flight");
  if (!el || !flightEl) return;
  let flight;
  try {
    // A streamed document sent each Suspense hole and deferred value as its own chunk.
    flight = await readStreamedFlight(document, JSON.parse(flightEl.textContent || "null"));
  } catch {
    return;
  }
  // Adopt server-transported signal state BEFORE hydration, so useSignal/useStore
  // resume from it instead of recomputing their initializers. Parked on a global
  // (no framework import) so the signal runtime stays off the shared chunk unless
  // the app actually uses signals; useSignal reads the same global.
  const stateEl = document.getElementById("__denext_state");
  if (stateEl) {
    try {
      const raw = JSON.parse(stateEl.textContent || "null");
      let clean;
      if (raw && typeof raw === "object") {
        clean = {};
        for (const k of Object.keys(raw)) {
          if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
          clean[k] = raw[k];
        }
      }
      globalThis.__denextSignalState = clean || undefined;
    } catch { /* ignore malformed state */ }
  }
${classBoot}  await registry.ensure(flight); // this page's islands (code-split chunks)
  // A null tree is a root-less islands page (every client part a carved island): nothing to
  // hydrate at the root — startClient only installs navigation, and the islands boot below.
  const tree = flight == null ? null : parseFlight(flight, registry);
  try {
    startClient(el, tree);
  } catch (err) {
    ${catchBody}
  }
  // Resumability runtime — deferred (client:*) island hydration AND delegated qrl
  // dispatch (data-dnx-h handlers that run without hydration). Lives in a separate
  // chunk, loaded ONLY when a page actually uses one of them, so non-resumable apps
  // bundle none of it.
  // Resolves to the delegated dispatcher's resumeEvent: the deferred boot (flight-boot.ts) that
  // imported this entry on an island's trigger hands it the events it buffered meanwhile.
  if (document.getElementById("__denext_islands") || document.querySelector("[data-dnx-h]")) {
    try {
      const lazy = await import("denext/lazy");
      lazy.bootResumability(registry);
      return lazy.resumeEvent;
    } catch (err) {
      console.warn("denext: resumability boot failed:", err && err.message);
    }
  }
}
`;
}

export function generateFlightEntry(
  boundary: BoundaryManifest,
  dev = false,
  perModule = false,
  usesLive = true,
  instrumentationClient: string | null = null,
  classRuntime: ClassRuntimeMode = "lazy",
  usesActivity = false,
  usesViewTransition = false,
  features: Record<string, boolean> = {},
  usesSingletons = true,
): string {
  const entries = [...boundary.client.entries()];
  // Islands are code-split: one dynamic `import()` per island module, run on demand for the
  // islands a payload actually references (see `registry.ensure`). A page ships the entry +
  // its own islands' chunks — not the whole app's (shadcn/ui: 2,700 islands, 10 MB up front).
  const loaders = entries
    .map(([clientId, ref]) =>
      `  [${JSON.stringify(clientId)}, () => import(${JSON.stringify(ref.url)})],`
    )
    .join("\n");
  const { refreshImport, regFamily, enableRefresh } = flightRefreshBlock(dev, perModule);
  const { clientImport, liveImport, liveRegister, liveConfigure } = flightLiveBlock(usesLive);
  const { classImport, classInstall, classBoot } = classSupportBlock(classRuntime);
  const { activityImport, activityInstall } = activitySupportBlock(usesActivity);
  const { vtImport, vtInstall } = viewTransitionSupportBlock(usesViewTransition);
  const { singletonImport, singletonInstall } = singletonSupportBlock(usesSingletons);
  return `// denext generated Flight entry — do not edit.
${clientInstrumentationImport(instrumentationClient)}${clientImport}
${liveImport}${classImport}${activityImport}${vtImport}${singletonImport}${refreshImport}
${
    featureSeedBlock(features)
  }${classInstall}${activityInstall}${vtInstall}${singletonInstall}const registry = new Map();
// Functions AND React's non-callable memo()/forwardRef() element objects — the server tags
// both as client references (radix exports the latter), so both must resolve here. An island
// from an npm package's CommonJS build (what the server bundle resolves) arrives as
// { default: module.exports }: its exports are module.exports' own properties.
function reg(mod, clientId) {
  const cjs = mod.default && typeof mod.default === "object" && mod.default.__esModule
    ? mod.default
    : null;
  for (const [k, v] of [...Object.entries(cjs ?? {}), ...Object.entries(mod)]) {
    if (typeof v === "function") {
      registry.set(clientId + "#" + k, v);
${regFamily}    } else if (v && typeof v === "object" && v.$$typeof) {
      registry.set(clientId + "#" + k, v);
    }
  }
}
const loaders = new Map([
${loaders}
]);
const loaded = new Map();
// Load + register every island a Flight payload references (each module once).
registry.ensure = (flight) => {
  const jobs = [];
  for (const id of flightClientIds(flight)) {
    const load = loaders.get(id);
    if (!load) continue;
    let job = loaded.get(id);
    if (!job) {
      job = load().then((mod) => reg(mod, id));
      loaded.set(id, job);
    }
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => undefined);
};
${enableRefresh}${liveRegister}
// Register the soft-nav Flight parser so a client navigation to another Flight
// route reconstructs its tree through this app-wide registry (no bundle re-run) —
// loading that route's island chunks first.
setFlightParser((flight) => registry.ensure(flight).then(() => parseFlight(flight, registry)));
// A soft nav into a route with islands (or resumable handlers) from a page that never loaded
// the resumability runtime loads it now; once loaded, bootResumability owns this hook.
setResumabilityReboot((islands, state) => {
  if (islands?.length || document.querySelector("[data-dnx-h]")) {
    import("denext/lazy")
      .then((m) => m.bootResumability(registry, true, islands?.length ? islands : undefined, state))
      .catch((err) => console.warn("denext: resumability boot failed:", err && err.message));
  }
});

${liveConfigure}
${flightMain(hydrationCatch(dev, "denext: flight hydration failed:"), classBoot)}
// Read by the deferred boot (flight-boot.ts), which imports this entry on an island's trigger.
export const ready = main();
`;
}

/** Options controlling a {@linkcode bundleSource}/{@linkcode bundleRoutes} pass. */
export interface BundleOptions {
  /** deno config path (`deno.json`) used to resolve the entry's imports. */
  configPath: string;
  /**
   * The app's `momentumSafeScroll` setting; `false` prepends {@linkcode momentumScrollSeed}
   * to every entry so the runtime skips the iOS scroll shim. Unset keeps it on.
   */
  momentumSafeScroll?: boolean;
  /** Minify the output (production builds); omit for readable dev output. */
  minify?: boolean;
  /**
   * Extra import-map entries merged into the bundle's config `imports` (keyed by full module
   * URL): the CSS shims. The app's own modules resolve through {@linkcode redirects},
   * {@linkcode rewritten} and {@linkcode server} instead, which reach aliased imports too.
   */
  importMap?: Record<string, string>;
  /**
   * The project root whose import-map aliases the client resolution follows (see
   * ./client-imports.ts). Defaults to the config's directory; unset with a `file:` URL config
   * (an app with no `deno.json`, which has no aliases).
   */
  projectDir?: string;
  /** The target's platform-file redirects (`projectPlatformRedirects`), keyed by file URL. */
  redirects?: Record<string, string>;
  /** The client transforms: a module's file URL → its transformed file's URL. */
  rewritten?: Record<string, string>;
  /**
   * The `"use server"` modules (the boundary's `server`): every import of one, however it is
   * spelled, resolves to a generated action stub, so server code never enters the bundle. A
   * bundle that still ships a `"use server"` module fails.
   */
  server?: ServerModules;
  /**
   * Dev build: emit Fast Refresh registration into the generated entry (family
   * registration + `enableFastRefresh()` + a full-reload fallback). Off for
   * production `denext build`, so its entries carry none of the refresh runtime.
   */
  dev?: boolean;
  /**
   * Whether the app uses any Live Server Components feature (from an
   * {@linkcode appImportsLive} scan). When false, the generated Flight entry omits
   * the `denext/live` import and its WebSocket transport — so a Flight app that
   * never renders `<Live>`/`useLiveData` bundles none of it. Defaults to `true`
   * (safe: keep Live) when unset — dev and callers that don't scan.
   */
  usesLive?: boolean;
  /**
   * How the generated entry gets the class-component runtime — see
   * {@linkcode ClassRuntimeMode}. Defaults to `"lazy"` (load on demand when the document
   * says a class rendered). Dev callers pass `"eager"` (unbundled, installs unconditionally).
   */
  classRuntime?: ClassRuntimeMode;
  /**
   * Whether the app uses `<Activity>` (from an {@linkcode appUsesActivity} scan). When false,
   * the generated entry omits `installActivitySupport()` so `deno bundle` tree-shakes the
   * offscreen scheduler out. Defaults to `false` when unset; dev callers pass `true`.
   */
  usesActivity?: boolean;
  /**
   * Whether the app uses `<ViewTransition>` (from an {@linkcode appUsesViewTransition} scan).
   * When false, the generated entry omits `installViewTransitionSupport()` so `deno bundle`
   * tree-shakes the per-element marking runtime out. Defaults to `false`; dev passes `true`.
   */
  usesViewTransition?: boolean;
  /**
   * Whether the app renders a document tag (from an {@linkcode appRendersDocumentTags} scan).
   * When false, the generated entry omits `installSingletonSupport()` so `deno bundle`
   * tree-shakes the host-singleton runtime out. Defaults to `true`: only a scanned build drops it.
   */
  usesSingletons?: boolean;
  /**
   * Compile-time feature flags (`features`) to seed on the CLIENT for the native
   * `deno bundle` path (which has no esbuild `define`). Baked into the flight entry so an
   * un-folded `feature()` call reads the configured value instead of the empty default. Only
   * the native flight bundler passes this; compat/SPA seed via `define` instead. Defaults `{}`.
   */
  features?: Record<string, boolean>;
  /**
   * The project's `instrumentation-client.{ts,tsx,js}` (absolute path), imported first by
   * every generated browser entry so it runs before the app's client code. Null/unset: none.
   */
  instrumentationClient?: string | null;
}

export { generateServerStub } from "./client-imports.ts";

/**
 * Bundle the app-wide Flight entry, redirecting every `"use server"` module to a
 * generated client stub so server-only code is stripped from the browser bundle.
 *
 * @param boundary The app's boundary manifest (client modules + server modules
 *   with their `exports`).
 * @param opts Bundle config + minify flag.
 * @returns The bundled Flight entry (entry file + any dynamic-import chunks).
 */
export function bundleFlightEntry(
  boundary: BoundaryManifest,
  opts: BundleOptions,
): Promise<BundleOutput> {
  return bundleSourceFiles(
    generateFlightEntry(
      boundary,
      opts.dev,
      false,
      opts.usesLive ?? true,
      opts.instrumentationClient ?? null,
      opts.classRuntime ?? "lazy",
      opts.usesActivity ?? false,
      opts.usesViewTransition ?? false,
      opts.features ?? {},
      opts.usesSingletons ?? true,
    ),
    {
      configPath: opts.configPath,
      minify: opts.minify,
      importMap: opts.importMap,
      projectDir: opts.projectDir,
      redirects: opts.redirects,
      rewritten: opts.rewritten,
      server: opts.server ?? boundary.server,
    },
  );
}

/**
 * The result of bundling one entry: its entry file plus any split chunks.
 *
 * With code splitting enabled, a `dynamic()` import (or any dynamic `import()`)
 * becomes a separate chunk file; shared modules are hoisted into a common chunk
 * that both the entry and the lazy chunks import, so module identity (context
 * symbols, registries) is preserved. All files must be served from the same
 * directory so the entry's relative chunk imports resolve.
 */
export interface BundleOutput {
  /** Basename of the entry file within {@linkcode files} (e.g. `"entry.js"`). */
  entry: string;
  /** Every emitted JS file (entry + split chunks) keyed by basename. */
  files: Map<string, string>;
  /**
   * External source maps keyed by `<file>.map`: present only for hidden source maps
   * (`DENEXT_SOURCEMAPS=hidden`, see hidden-sourcemaps.ts).
   */
  maps?: Map<string, string>;
}

/** Convenience: the entry file's JavaScript source from a {@linkcode BundleOutput}. */
export function entryCode(output: BundleOutput): string {
  const code = output.files.get(output.entry);
  if (code === undefined) {
    throw new Error(`bundle output is missing its entry file "${output.entry}"`);
  }
  return code;
}

/**
 * Resolve an import map's relative specifiers (`./x`, `../x`) to absolute file
 * URLs against `baseDir`, so the map keeps working when copied into a merged
 * config elsewhere. Bare specifiers (jsr:, npm:, https:, and already-absolute
 * file URLs) pass through unchanged.
 */
/**
 * A deno config's import-map entries that point at local files, for resolving alias imports
 * the way `denext migrate` emits them and the web stubs of native-only packages:
 *
 * - `prefixes`: the PREFIX aliases (`"~/": "./src/"` → `["~/", absDir]`); a value may be an
 *   absolute `file://` URL or a `./` / `../` path (resolved against the config's directory);
 * - `exact`: the EXACT entries whose value is a `./` / `../` path (`"some-pkg":
 *   "./web/some-pkg.ts"` → `"some-pkg"` → absPath).
 *
 * Anything else (jsr:/npm:/https:) is not a local alias. Empty when the config is absent or
 * unparseable — only relative imports resolve then.
 */
export async function readLocalAliases(configPath: string): Promise<LocalAliases> {
  const out: LocalAliases = { prefixes: [], exact: new Map() };
  const baseDir = dirname(configPath);
  for (const [k, v] of Object.entries(await importMapOf(configPath))) {
    if (typeof v !== "string") continue;
    if (k.endsWith("/")) addPrefixAlias(out, k, v, baseDir);
    else if (isRelativePath(v)) out.exact.set(k, resolve(baseDir, v));
  }
  return out;
}

/** The local aliases of a deno config ({@linkcode readLocalAliases}). */
export interface LocalAliases {
  /** Prefix aliases: `[key ending in "/", absolute directory]`. */
  readonly prefixes: Array<[string, string]>;
  /** Exact aliases: key → absolute file. */
  readonly exact: Map<string, string>;
}

/** A deno config's `imports` (empty when it is absent or unparseable). */
async function importMapOf(configPath: string): Promise<Record<string, unknown>> {
  try {
    return (JSON.parse(await Deno.readTextFile(configPath)) as {
      imports?: Record<string, unknown>;
    }).imports ?? {};
  } catch {
    return {};
  }
}

/** Whether an import-map value is a `./` / `../` path. */
function isRelativePath(v: string): boolean {
  return v.startsWith("./") || v.startsWith("../");
}

/** Record the prefix alias `key` → `value` when the value is a local directory. */
function addPrefixAlias(out: LocalAliases, key: string, value: string, baseDir: string): void {
  if (value.startsWith("file://")) {
    out.prefixes.push([key, fromFileUrl(value.endsWith("/") ? value : value + "/")]);
  } else if (isRelativePath(value)) out.prefixes.push([key, resolve(baseDir, value)]);
}

export function absolutizeImports(
  imports: Record<string, string> | undefined,
  baseDir: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(imports ?? {})) {
    // Resolve relative (`./`, `../`) and root-relative (`/`) path values to
    // absolute file URLs; bare specifiers (jsr:, npm:, https:, data:, file://)
    // and already-absolute URLs pass through unchanged.
    const isPath = value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
    if (!isPath) {
      out[key] = value;
      continue;
    }
    const abs = toFileUrl(resolve(baseDir, value)).href;
    // Preserve a trailing slash: an import-map PREFIX mapping (`"~/": "./src/"`)
    // needs its value to keep the trailing slash so subpath resolution (`~/x` →
    // `…/src/x`) works — but `resolve` normalizes the trailing slash away.
    out[key] = value.endsWith("/") && !abs.endsWith("/") ? abs + "/" : abs;
  }
  return out;
}

/**
 * Resolve the config path to pass to `deno bundle`: the caller's config, or —
 * when import-map redirects are supplied — a merged config in `tmpDir` that
 * extends the base `imports` with them (deno bundle takes a single config).
 */
export async function prepareConfig(
  tmpDir: string,
  opts: Pick<BundleOptions, "configPath" | "importMap">,
): Promise<string> {
  // `configPath` may be a plain filesystem path OR a `file://` URL — the latter when the
  // app has no `deno.json` of its own and `resolveProject` falls back to
  // `frameworkFileUrl("deno.json")`. `Deno.readTextFile` (and `dirname`) need a path, so
  // normalize first (mirrors `readFrameworkText`); passing a `file://` string straight to
  // `readTextFile` treats it as a literal filename → NotFound.
  const configFsPath = opts.configPath.startsWith("file://")
    ? fromFileUrl(opts.configPath)
    : opts.configPath;
  const base = JSON.parse(await Deno.readTextFile(configFsPath));
  // The merged config lives in a temp dir, so any relative import-map paths in
  // the base config (e.g. `denext` -> `../../mod.ts`) must be resolved to
  // absolute against the ORIGINAL config's directory or they break.
  const appImports = absolutizeImports(base.imports, dirname(configFsPath));
  // The generated entries and the client transforms import the RUNNING framework by URL; when
  // the app's own `denext` reaches another copy, fold that copy into this one so the bundle
  // carries one runtime (./app-framework-root.ts). The same root in the usual case: no entry.
  const appRoot = await appFrameworkRoot(configFsPath, base, appImports["denext"]);
  base.imports = {
    // Always resolve `denext/live` against the framework: the generated Flight
    // entry imports `<Live>` from it, and it is kept off the main barrels (so
    // non-live apps bundle none of it). A config/import-map entry still overrides.
    "denext/live": frameworkFileUrl("src/live.ts"),
    // Same discipline for `denext/lazy`: the generated entry dynamically imports it
    // only when a page has client:* islands, so non-lazy apps bundle none of it.
    "denext/lazy": frameworkFileUrl("src/lazy.ts"),
    // And for `denext/class-runtime`: the generated entry loads the class-component
    // runtime on demand (a page that renders a class), so function-only apps bundle none.
    "denext/class-runtime": frameworkFileUrl("src/class-runtime.ts"),
    // SPA mode's `client:*` deferred mounts: the build's island rewrite imports `SpaIsland`
    // from it (spa-islands.ts), so only an app with a directive bundles it.
    "denext/spa-island": frameworkFileUrl("src/spa-island.ts"),
    // The GENERATED entries import their boot/HMR plumbing from `denext/client-runtime`
    // and the dev inspector from `denext/devtools`; an app's own import map need not
    // (and usually does not) list those subpaths, so resolve them against the framework.
    "denext/client-runtime": frameworkFileUrl("src/client/client-runtime.ts"),
    "denext/devtools": frameworkFileUrl("src/devtools.ts"),
    ...foldAppDenext(frameworkRootUrl(), appRoot),
    ...appImports,
    ...opts.importMap,
  };
  // `links` name directories relative to the config, which now lives in `tmpDir`.
  carryLinks(base, base, dirname(configFsPath), tmpDir);
  const configPath = join(tmpDir, "deno.merged.json");
  await Deno.writeTextFile(configPath, JSON.stringify(base));
  return configPath;
}

/** The running framework's version (its `deno.json`), read once. */
let frameworkVersion: Promise<string> | undefined;

let warnedSkew = false;

/**
 * The root of the denext copy the app at `configFsPath` imports (./app-framework-root.ts), with a
 * one-time warning when it is a different published version than the one running the build.
 */
async function appFrameworkRoot(
  configFsPath: string,
  config: { lock?: unknown },
  denext: string | undefined,
): Promise<string> {
  frameworkVersion ??= readFrameworkJson("deno.json").then((c) => String(c.version ?? ""));
  const running = { root: frameworkRootUrl(), version: await frameworkVersion };
  const root = await appDenextRootFor(configFsPath, config, denext, running);
  const version = root.startsWith(JSR_DENEXT_ROOT) ? root.slice(JSR_DENEXT_ROOT.length, -1) : "";
  if (version && version !== running.version && !warnedSkew) {
    warnedSkew = true;
    console.warn(
      `denext: this app's denext is ${version} (${denext}), but denext ${running.version} is ` +
        `building it, so its client bundles run ${running.version}'s runtime. Run the CLI the ` +
        `app pins (\`deno task build\`) to build with ${version}.`,
    );
  }
  return root;
}

/**
 * Shell out to `deno bundle` over one or more entry files (code splitting on),
 * returning every emitted `.js` file keyed by basename. `--code-splitting`
 * requires `--outdir` (it cannot stream to stdout); with multiple entries, any
 * module imported by more than one is hoisted into a shared chunk.
 */
/**
 * Deno's minimum-dependency-age policy (default 24 h) applies to the `deno bundle` child too,
 * and Deno gives the parent no way to read the value it was started with. `DENEXT_MIN_DEP_AGE`
 * (e.g. `0`, `1h`) is forwarded as the child's `--min-dep-age`; the app's own `deno.json`
 * `minimumDependencyAge` is honored by the child through `--config` as usual.
 */
export function minDepAgeArgs(env: string | undefined = safeEnv("DENEXT_MIN_DEP_AGE")): string[] {
  return env ? [`--min-dep-age=${env}`] : [];
}

/**
 * The minimum-dependency-age policy a GENERATED config (the merged CSS/module configs, the
 * runtime-prebuild temp config, a deno-loader config) must carry so every resolver in the
 * build — the re-exec'd child, `deno info` crawls, esbuild's portable deno-loader — applies
 * the same rule: `DENEXT_MIN_DEP_AGE` when set (the operator's override), else whatever the
 * app's own config declares (`appValue`), else nothing (Deno's default). Without this a
 * `@denext/*` codec published within Deno's default 2-day window was refused by the loader
 * while the CLI process itself had resolved it fine.
 */
export function minDepAgeConfig(
  appValue: unknown,
  env: string | undefined = safeEnv("DENEXT_MIN_DEP_AGE"),
): { minimumDependencyAge?: unknown } {
  if (env) return { minimumDependencyAge: env };
  return appValue === undefined ? {} : { minimumDependencyAge: appValue };
}

/**
 * The config path to hand a deno-loader: `configPath` itself, or — when the policy needs
 * injecting ({@link minDepAgeConfig} yields a value the file does not already carry) — a temp
 * copy of it with `minimumDependencyAge` added and relative import-map entries absolutized
 * against the original file's location (a remote `https://` framework config included).
 */
export async function loaderConfigPath(configPath: string, tmpDir: string): Promise<string> {
  const policy = minDepAgeConfig(undefined);
  if (policy.minimumDependencyAge === undefined) return configPath;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(configPath) ? configPath : toFileUrl(configPath).href;
  let cfg: Record<string, unknown>;
  try {
    const text = url.startsWith("file://")
      ? await Deno.readTextFile(fromFileUrl(url))
      : await (await fetch(url)).text();
    cfg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return configPath; // unreadable/JSONC: leave the original alone
  }
  if (cfg.minimumDependencyAge !== undefined) return configPath;
  const imports = absolutizeAgainstUrl((cfg.imports ?? {}) as Record<string, string>, url);
  const out = join(tmpDir, `deno.min-dep-age.${Math.random().toString(36).slice(2, 8)}.json`);
  await Deno.writeTextFile(out, JSON.stringify({ ...cfg, imports, ...policy }));
  return out;
}

function safeEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Explain a `deno bundle` failure. Deno's "Do not know how to load path: deno:jsr:@denext/…"
 * means the resolver found no version satisfying the range — on a brand-new release that is
 * the minimum-dependency-age policy (nothing older than 24 h matches), not a broken app.
 */
export function bundleFailureMessage(code: number, stderr: string): string {
  const hint = /Do not know how to load path: deno:jsr:@denext\//.test(stderr)
    ? `\nHint: no published version of denext satisfied the import map's range. If the version ` +
      `you want was published in the last 24 h, Deno's minimum-dependency-age policy hides it — ` +
      `re-run with DENEXT_MIN_DEP_AGE=0 (or set "minimumDependencyAge" in your deno.json).`
    : "";
  return `deno bundle failed (${code}):\n${stderr}${hint}\n` +
    `(\`deno bundle\` is an evolving subcommand; if this looks like a CLI/flag ` +
    `error rather than a code error, check your Deno version or set DENO_BIN.)`;
}

/** What one `deno bundle` run emitted. */
interface DenoBundleRun {
  /** Every emitted JS file keyed by basename. */
  files: Map<string, string>;
  /**
   * Per emitted file, the modules it was built from (its source map's `sources`, as
   * realpath'd absolute paths) — what actually shipped, after tree-shaking. Feeds the
   * server-only leak check.
   */
  sources: Map<string, Set<string>>;
  /** Each emitted file's external source map by `<file>.map`, kept only for hidden source maps. */
  maps: Map<string, string>;
}

async function runDenoBundle(
  entryPaths: string[],
  configPath: string,
  outDir: string,
  minify: boolean | undefined,
  sourcemap: boolean | undefined,
): Promise<DenoBundleRun> {
  const args = [
    "bundle",
    // Next.js app code uses extensionless imports (`./button`, `@/lib/x`)
    // everywhere. Enable sloppy-imports so those resolve; it is a permissive
    // fallback (explicit specifiers still resolve first), so it never changes
    // resolution for denext's own extension-qualified code.
    "--unstable-sloppy-imports",
    "--platform=browser",
    "--code-splitting",
    "--outdir",
    outDir,
    "--config",
    configPath,
    ...minDepAgeArgs(),
  ];
  if (minify) args.push("--minify");
  // Dev builds (unminified) get inline source maps so browser stack traces and
  // breakpoints map back to the original `.tsx` sources. Inline keeps the map
  // inside the emitted `.js` (no sidecar to collect/serve). Production ships none —
  // but an EXTERNAL map (a sidecar in the temp dir, no `sourceMappingURL` comment in
  // the JS) is still produced and read for its `sources`: the exact module list that
  // survived tree-shaking, which the server-only leak check needs.
  args.push(sourcemap ? "--sourcemap=inline" : "--sourcemap=external");
  args.push(...entryPaths);

  const { code, stderr } = await new Deno.Command(denoExecutable(), {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(bundleFailureMessage(code, new TextDecoder().decode(stderr)));
  }
  const files = new Map<string, string>();
  const maps = new Map<string, string>();
  // `denext export --sourcemaps hidden`: keep the external maps (nothing references them).
  const keepMaps = !sourcemap && hiddenSourceMapsEnabled();
  for await (const dirEntry of Deno.readDir(outDir)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".js")) {
      files.set(dirEntry.name, await Deno.readTextFile(join(outDir, dirEntry.name)));
    } else if (keepMaps && dirEntry.isFile && dirEntry.name.endsWith(".js.map")) {
      maps.set(dirEntry.name, await Deno.readTextFile(join(outDir, dirEntry.name)));
    }
  }
  return { files, sources: await bundledSources(outDir, files), maps };
}

/**
 * What each emitted file was built from: its source map's `sources`, resolved against
 * `outDir` and realpath'd (so they compare equal to the paths the project's own files are
 * read by). An external map is the `<name>.map` sidecar; an inline one (dev) is decoded from
 * the file's trailing `sourceMappingURL` data URL. A file with no readable map contributes
 * nothing — the leak check then simply has less to attribute.
 */
async function bundledSources(
  outDir: string,
  files: Map<string, string>,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const [name, code] of files) {
    const json = await sourceMapJson(outDir, name, code);
    out.set(name, json ? await mapSources(outDir, json) : new Set());
  }
  return out;
}

/** The source-map JSON of one emitted file: its `.map` sidecar, else its inline map, else null. */
async function sourceMapJson(outDir: string, name: string, code: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(outDir, `${name}.map`));
  } catch {
    return inlineSourceMap(code);
  }
}

/** The JSON of an inline (`data:` base64) source map at the end of a bundled file, or null. */
function inlineSourceMap(code: string): string | null {
  const marker = "//# sourceMappingURL=data:application/json";
  const at = code.lastIndexOf(marker);
  if (at === -1) return null;
  const comma = code.indexOf(",", at);
  if (comma === -1) return null;
  try {
    const bytes = Uint8Array.from(atob(code.slice(comma + 1).trim()), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** A source map's `sources`, resolved against `outDir` and realpath'd where they exist on disk. */
async function mapSources(outDir: string, json: string): Promise<Set<string>> {
  const out = new Set<string>();
  let sources: unknown;
  try {
    sources = (JSON.parse(json) as { sources?: unknown }).sources;
  } catch {
    return out;
  }
  if (!Array.isArray(sources)) return out;
  for (const s of sources) {
    if (typeof s !== "string") continue;
    const abs = resolve(outDir, s);
    try {
      out.add(await Deno.realPath(abs));
    } catch {
      out.add(abs); // not on disk (a virtual/data: module) — keep as resolved
    }
  }
  return out;
}

/**
 * What a generated browser entry is, for a leak report: the route of its page file (the
 * file IS the route in the App Router), the islands bundle, or the global-error entry.
 * Null for an entry denext did not generate (a SPA or plugin entry, bundled as given and
 * never leak-checked here). Paths are shown relative to `projectDir`.
 */
async function generatedEntryLabel(source: string, projectDir: string): Promise<string | null> {
  if (source.startsWith("// denext generated route entry")) {
    const page = /^import Page from "(file:\/\/[^"]+)";$/m.exec(source);
    if (!page) return "a route entry";
    return `the route of ${await projectRelative(fromFileUrl(page[1]), projectDir)}`;
  }
  if (source.startsWith("// denext generated Flight entry")) {
    return `the "use client" islands bundle`;
  }
  if (source.startsWith("// denext generated global-error entry")) return "the global-error entry";
  return null;
}

/** `path` relative to the (realpath'd) project dir — by its realpath when the logical path is outside it. */
async function projectRelative(path: string, projectDir: string): Promise<string> {
  const rel = relative(projectDir, path);
  if (!rel.startsWith("..")) return rel;
  try {
    return relative(projectDir, await Deno.realPath(path));
  } catch {
    return rel;
  }
}

/**
 * The emitted files an entry loads: itself plus, transitively, every sibling chunk it
 * imports (`"./chunk-….js"`, static or dynamic). A leak in a shared chunk is attributed to
 * every entry that reaches the chunk.
 */
function entryChunkClosure(entryFile: string, files: Map<string, string>): string[] {
  const seen = new Set<string>([entryFile]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const code = files.get(queue.shift()!) ?? "";
    for (const m of code.matchAll(/["']\.\/([^"']+\.js)["']/g)) {
      if (files.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        queue.push(m[1]);
      }
    }
  }
  return [...seen];
}

/**
 * The project directory (the config's), realpath'd so it compares and displays against the
 * realpath'd source-map paths (macOS `/var` vs `/private/var`, a symlinked checkout).
 */
async function realProjectDir(configPath: string): Promise<string> {
  const dir = dirname(configPath);
  try {
    return await Deno.realPath(dir);
  } catch {
    return dir;
  }
}

/**
 * A bundled entry as {@link assertNoServerOnlyLeaks} sees it: its source, emitted basename and
 * the path it was bundled from.
 */
interface BundledEntry {
  source: string;
  file: string;
  path: string;
}

/** What a bundle resolved through, for its checks: the client resolution and the merged config. */
interface BundleResolution {
  client: ClientImports;
  configPath: string;
}

/** Each shipped path of a rewritten copy → the app module it stands in for (real paths). */
function copyOriginals(client: ClientImports): Map<string, string> {
  const out = new Map<string, string>();
  for (const [copy, original] of Object.entries(client.originals)) {
    out.set(fromFileUrl(copy), fromFileUrl(original));
  }
  return out;
}

/**
 * Fail a bundle that shipped a `"use server"` module (see ./server-module-guard.ts): any entry,
 * any module, wherever it came from. `shipped` maps each entry's label to the source paths it
 * emitted; the error names each module (a copy as its app original), the chain that imported it
 * and the entries that shipped it.
 */
async function assertNoServerModules(
  shipped: Array<{ label: string; entry: string; sources: Set<string> }>,
  resolution: BundleResolution,
  projectDir: string,
): Promise<void> {
  const originals = copyOriginals(resolution.client);
  const found = new Map<string, ServerModuleLeak & { raw: string }>();
  for (const { label, sources } of shipped) {
    for (const raw of await findShippedServerModules(sources)) {
      const module = originals.get(raw) ?? raw;
      const leak = found.get(module) ?? { module, raw, entries: [], chain: [] };
      leak.entries.push(label);
      found.set(module, leak);
    }
  }
  if (found.size === 0) return;
  const leaks = [...found.values()];
  const chains = await importerChains(
    shipped.map((s) => s.entry),
    resolution.configPath,
    leaks.map((l) => l.raw),
    { deno: denoExecutable(), args: minDepAgeArgs() },
  );
  for (const leak of leaks) {
    // The chain starts at the generated entry (a temp file the label already names).
    leak.chain = (chains.get(leak.raw) ?? []).slice(1).map((p) => originals.get(p) ?? p);
  }
  throw new Error(formatServerModuleLeaks(leaks, projectDir));
}

/**
 * Fail a browser bundle that shipped server-only code — a `node:` import, a
 * `server-only` marker, or a `Deno.` access reached from a route's isomorphic tree or a
 * `"use client"` island (see {@linkcode findServerOnlyLeaks}). `deno bundle
 * --platform=browser` emits those verbatim, so without this the page would fail only in
 * the browser. Only denext-generated entries are checked (each is named by its header),
 * and only what the bundle actually emitted counts (the source maps' `sources`), so a
 * `"use server"` module the import map redirected to a stub never appears. Every entry is
 * first checked for a shipped `"use server"` module ({@linkcode assertNoServerModules}). A
 * dev caller surfaces the thrown error in the overlay + console; `denext build` exits
 * non-zero with it.
 */
async function assertNoServerOnlyLeaks(
  entries: BundledEntry[],
  run: DenoBundleRun,
  opts: BundleOptions,
  resolution: BundleResolution,
): Promise<void> {
  const projectDir = await realProjectDir(opts.configPath);
  const originals = copyOriginals(resolution.client);
  const shippedBy: Array<{ label: string; entry: string; sources: Set<string> }> = [];
  for (const { source, file, path } of entries) {
    const sources = new Set<string>();
    for (const chunk of entryChunkClosure(file, run.files)) {
      for (const s of run.sources.get(chunk) ?? []) sources.add(s);
    }
    const label = await generatedEntryLabel(source, projectDir);
    shippedBy.push({ label: label ?? "the app's client entry", entry: path, sources });
  }
  await assertNoServerModules(shippedBy, resolution, projectDir);
  const found = new Map<string, { leak: ServerOnlyLeak; entries: string[] }>();
  for (const [i, { source }] of entries.entries()) {
    const label = await generatedEntryLabel(source, projectDir);
    if (!label) continue;
    // A rewritten copy is checked (and named) as the app module it stands in for.
    const shipped = [...shippedBy[i].sources].map((s) => originals.get(s) ?? s);
    for (const leak of await findServerOnlyLeaks(shipped, projectDir)) {
      const entry = found.get(leak.module) ?? { leak, entries: [] };
      entry.entries.push(label);
      found.set(leak.module, entry);
    }
  }
  if (found.size > 0) throw new Error(formatServerOnlyLeaks(found, projectDir));
}

/**
 * Resolve a bundle's app modules (./client-imports.ts: the platform redirects, the client
 * transforms, an action stub per `"use server"` module, and the rewritten copies that make an
 * aliased import reach them), written under `tmpDir`, and the merged config `deno bundle` runs
 * with.
 */
async function bundleResolution(tmpDir: string, opts: BundleOptions): Promise<BundleResolution> {
  const client = await clientImportMap({
    projectDir: opts.projectDir ??
      (opts.configPath.startsWith("file:") ? null : dirname(opts.configPath)),
    redirects: opts.redirects,
    rewritten: opts.rewritten,
    server: opts.server,
    dir: join(tmpDir, "client-imports"),
  });
  const configPath = await prepareConfig(tmpDir, {
    configPath: opts.configPath,
    importMap: { ...opts.importMap, ...client.importMap },
  });
  return { client, configPath };
}

/**
 * A fresh `deno bundle` workspace (after checking the toolchain supports it): a temp dir with
 * an empty `src/` for the entry sources and the `out/` path the bundle writes to. The caller
 * removes `tmpDir` when done.
 */
async function bundleWorkspace(): Promise<{ tmpDir: string; srcDir: string; outDir: string }> {
  await ensureBundleSupport();
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_bundle_" });
  const srcDir = join(tmpDir, "src");
  await Deno.mkdir(srcDir);
  return { tmpDir, srcDir, outDir: join(tmpDir, "out") };
}

/**
 * Bundle an entry source string into browser JavaScript by shelling out to
 * `deno bundle` with code splitting. Returns the entry file plus any chunk files
 * emitted for dynamic imports.
 */
export async function bundleSourceFiles(
  entrySource: string,
  opts: BundleOptions,
): Promise<BundleOutput> {
  const { tmpDir, srcDir, outDir } = await bundleWorkspace();
  const entryPath = join(srcDir, "entry.tsx");
  try {
    await Deno.writeTextFile(entryPath, momentumScrollSeed(opts.momentumSafeScroll) + entrySource);
    const resolution = await bundleResolution(tmpDir, opts);
    const run = await runDenoBundle(
      [entryPath],
      resolution.configPath,
      outDir,
      opts.minify,
      opts.dev,
    );
    const { files } = run;
    const entry = "entry.js";
    if (!files.has(entry)) {
      throw new Error(
        `deno bundle produced no entry file (got: ${[...files.keys()].join(", ") || "nothing"})`,
      );
    }
    await assertNoServerOnlyLeaks(
      [{ source: entrySource, file: entry, path: entryPath }],
      run,
      opts,
      resolution,
    );
    return run.maps.size > 0 ? { entry, files, maps: run.maps } : { entry, files };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/**
 * The result of bundling several entries together: each caller `key` mapped to
 * its emitted entry basename, plus every emitted file (entries + shared/split
 * chunks) keyed by basename.
 */
export interface MultiBundleOutput {
  /** Caller key (e.g. a route id) → that entry's emitted basename in {@linkcode files}. */
  entries: Map<string, string>;
  /** Every emitted JS file (entries + shared/split chunks) keyed by basename. */
  files: Map<string, string>;
}

/**
 * Bundle several browser entries in a **single** code-split pass, so any module
 * imported by more than one entry — chiefly the denext client runtime, which
 * every route entry imports — is hoisted into one shared chunk they all reference
 * (downloaded once, cached across client navigations) instead of being inlined
 * into each entry. Contrast {@linkcode bundleRoute}, which bundles one route in
 * isolation and therefore cannot share a chunk with its siblings.
 *
 * @param routeEntries The entries to bundle, each with a stable caller `key`.
 * @param opts Bundle config + minify flag (import-map redirects apply to all).
 * @returns The per-key entry basenames and every emitted file.
 */
export async function bundleRoutes(
  routeEntries: Array<{ key: string; source: string }>,
  opts: BundleOptions,
): Promise<MultiBundleOutput> {
  const { tmpDir, srcDir, outDir } = await bundleWorkspace();
  try {
    // Distinct per-entry basenames so esbuild's outputs map back unambiguously.
    const bases = routeEntries.map((_, i) => `entry_${i}`);
    const entryPaths = bases.map((b) => join(srcDir, `${b}.tsx`));
    await Promise.all(
      routeEntries.map((re, i) =>
        Deno.writeTextFile(entryPaths[i], momentumScrollSeed(opts.momentumSafeScroll) + re.source)
      ),
    );
    const resolution = await bundleResolution(tmpDir, opts);
    const run = await runDenoBundle(
      entryPaths,
      resolution.configPath,
      outDir,
      opts.minify,
      opts.dev,
    );
    const { files } = run;

    const entries = new Map<string, string>();
    routeEntries.forEach((re, i) => {
      const out = `${bases[i]}.js`;
      if (!files.has(out)) {
        throw new Error(
          `deno bundle produced no output for entry "${re.key}" ` +
            `(expected ${out}; got: ${[...files.keys()].join(", ") || "nothing"})`,
        );
      }
      entries.set(re.key, out);
    });
    await assertNoServerOnlyLeaks(
      routeEntries.map((re, i) => ({
        source: re.source,
        file: entries.get(re.key)!,
        path: entryPaths[i],
      })),
      run,
      opts,
      resolution,
    );
    return { entries, files };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/**
 * Bundle a page route's browser entry (entry + any dynamic-import chunks).
 *
 * @param route The page route.
 * @param opts Bundle options; `devMetaFooter` (dev server only) is the route files'
 *   DevTools metadata, appended to a `dev` entry (see {@linkcode GenerateRouteEntryOptions}).
 * @returns The bundled entry and its chunks.
 */
export function bundleRoute(
  route: PageRoute,
  opts: BundleOptions & { devMetaFooter?: string },
): Promise<BundleOutput> {
  return bundleSourceFiles(
    generateRouteEntry(route, {
      dev: opts.dev,
      instrumentationClient: opts.instrumentationClient,
      classRuntime: opts.classRuntime,
      usesActivity: opts.usesActivity,
      usesViewTransition: opts.usesViewTransition,
      usesSingletons: opts.usesSingletons,
      devMetaFooter: opts.devMetaFooter,
    }),
    opts,
  );
}

/** Bundle the `global-error.tsx` browser entry on its own (the dev server's on-demand path). */
export function bundleGlobalError(
  globalErrorFile: string,
  opts: BundleOptions,
): Promise<BundleOutput> {
  return bundleSourceFiles(
    generateGlobalErrorEntry(globalErrorFile, opts.instrumentationClient ?? null),
    opts,
  );
}

/**
 * Write a {@linkcode BundleOutput} to `dir`: the entry file as `entryName` and
 * every split chunk under its own (content-hashed) basename. Chunks are shared
 * by name, so identical chunks across routes overwrite with identical content.
 *
 * @param dir Target directory (all files must land together so relative chunk
 *   imports resolve).
 * @param output The bundle to write.
 * @param entryName The filename to give the entry (e.g. `"index.js"`).
 */
export async function writeBundleOutput(
  dir: string,
  output: BundleOutput,
  entryName: string,
): Promise<void> {
  for (const [name, code] of output.files) {
    const target = name === output.entry ? entryName : name;
    await Deno.writeTextFile(join(dir, target), code);
  }
  for (const [name, map] of output.maps ?? []) {
    const renamed = name === `${output.entry}.map`;
    await Deno.writeTextFile(
      join(dir, renamed ? `${entryName}.map` : name),
      renamed ? withMapFile(map, entryName) : map,
    );
  }
}

/** A source map's JSON with its `file` field naming `file` (after the entry is renamed). */
function withMapFile(map: string, file: string): string {
  try {
    return JSON.stringify({ ...JSON.parse(map), file });
  } catch {
    return map;
  }
}
