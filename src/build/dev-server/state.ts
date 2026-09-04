// Dev server state: the one record every dev-server module reads and mutates, plus the
// dev-only endpoint paths. `startDevServer` creates it and the modules in this directory
// are plain functions over it — no closure-captured locals — so each concern (assets,
// compat build, manifest, bundles, reload channel, dev endpoints, watcher, request
// handler) is a separately readable unit.

import type { ProjectPaths } from "../paths.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import type { ModuleLoader } from "../../server/types.ts";
import type { UnbundledDev } from "../dev-unbundled.ts";
import type { BoundaryManifest } from "../module-graph.ts";
import type { AppCss } from "../css.ts";
import type { MiddlewareRunner } from "../../server/middleware.ts";
import type { Instrumentation } from "../../server/instrumentation.ts";
import { DevEventLog } from "../dev-events.ts";

/** Live-reload / Fast Refresh SSE stream. */
export const RELOAD_PATH = "/_denext/reload";
/** On-demand client route bundle (`?p=<routePath>`). */
export const ROUTE_BUNDLE_PATH = "/_denext/route.js";
/** App-wide Flight bundle (client islands + registry). */
export const FLIGHT_BUNDLE_PATH = "/_denext/flight.js";
/** Per-route extracted stylesheet (`?p=<routePath>`). */
export const ROUTE_CSS_PATH = "/_denext/route.css";
/**
 * The live-reload/Fast-Refresh runtime, served as an external same-origin module so the
 * strict dev CSP (`script-src 'self'`) allows it — no inline script.
 */
export const DEV_RELOAD_JS_PATH = "/_denext/dev-reload.js";
/** Browser → server dev log sink (console/errors, POST). */
export const DEV_LOG_PATH = "/_denext/dev-log";
/** The dev black box: recent server + browser events (GET, read by the MCP live tools). */
export const DEV_STATE_PATH = "/_denext/dev-state";
/** Dev overlay "open in editor" (same cross-origin gate as the reload stream). */
export const OPEN_IN_EDITOR_PATH = "/_denext/open-in-editor";

export interface DevServerOptions {
  paths: ProjectPaths;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  /** Fail instead of falling back if the port is taken (explicit --port). */
  strictPort?: boolean;
  /**
   * Extra origins (or bare hostnames) permitted to open the dev live-reload
   * stream, beyond the dev server's own origin. Mirrors Next.js's
   * `allowedDevOrigins` — needed when reaching the dev server from another host
   * (a LAN device, a proxy). A cross-origin page not listed here is refused, so a
   * malicious site a developer visits cannot subscribe to the reload channel.
   */
  allowedDevOrigins?: string[];
  /**
   * Force the unbundled per-module dev loop on (`true`) or off (`false`), overriding the
   * `DENEXT_DEV_UNBUNDLED` env default. An explicit option keeps mode selection per-server
   * — a process-global env var can't distinguish two servers running concurrently (e.g. in
   * a parallel test run).
   */
  unbundled?: boolean;
  /**
   * Capture the dev process's own `console.*` into the dev black box (readable via the MCP
   * live tools). This wraps `globalThis.console`, which is process-global — so only the real
   * `denext dev` CLI (one dev server per process) sets it. An embedded/in-process server (a
   * test, a parallel run) must leave it off, or concurrent servers would fight over console.
   */
  captureServerConsole?: boolean;
}

/** Everything the dev server's stages share. Mutable fields are per-generation caches. */
export interface DevState {
  readonly paths: ProjectPaths;
  readonly options: DevServerOptions;
  readonly allowedDevOrigins: string[];

  /** Generation counter: bumped on any file change to bust module + bundle caches. */
  generation: number;
  manifest: RouteManifest | null;
  /**
   * The manifest the typed-module emit was last kicked off for (so a rescan re-emits once,
   * fire-and-forget, rather than blocking every request with a fresh `deno doc` pass).
   */
  lastEmittedManifest: RouteManifest | null;

  /**
   * Unbundled dev loop (Vite-class per-module HMR): serves each source module
   * transformed-but-unbundled at its own URL and hot-swaps a single edited module in
   * place (~5ms) instead of re-bundling the whole route (~hundreds of ms) through
   * `deno bundle`. DEFAULT-ON for the native App Router; opt out with
   * DENEXT_DEV_UNBUNDLED=0 to force the bundled whole-route refresh. Within a native
   * app, per-route eligibility (`getUnbundled().supportsRoute`) keeps MDX routes bundled
   * and flight routes route through the flight entry, with an in-place fallback to the
   * bundled Fast Refresh for any edit the unbundled graph does not own.
   * `unbundledActive` is resolved once compat detection settles (in `getManifest`),
   * before any render reads `clientEntryFor`.
   */
  readonly unbundledOptIn: boolean;
  unbundled: UnbundledDev | null;
  unbundledActive: boolean;
  /** Native App Router vs the react→denext compat runtime; `createUnbundledDev` captures it once. */
  unbundledCompat: boolean;

  /**
   * Flight boundary state, refreshed per generation. Mutable references shared with
   * createApp so gating/tagging stay live across edits.
   */
  readonly flightRoutes: Set<string>;
  readonly flightClients: Map<string, { url: string }>;
  readonly flightServers: Map<string, { url: string }>;
  boundaryGen: number;
  flightBundle: string | null;

  /**
   * next-compat (drop-in) mode: rewrite react→denext so npm React libraries render on
   * denext's single React. Detected once. The Flight boundary is preserved in compat too
   * (Stage 4b): boundary routes render server components server-side and hydrate only
   * their islands via the compat flight bundle. Per generation we rebuild the server
   * bundles (incl. islands/actions) + client entries.
   */
  compatP: Promise<boolean> | undefined;
  compatLoad: ModuleLoader | null;
  compatBuiltGen: number;
  compatBuilding: Promise<void> | null;
  /**
   * Source module path → react→denext compat server bundle path (this generation), used
   * to redirect boundary refs so the SSR renderer tags the shared-chunk island/action
   * instances the page bundle references.
   */
  compatModuleMap: Map<string, string>;
  /** The boundary islands to bundle as compat entries this generation (set by refreshBoundary). */
  compatBoundary: BoundaryManifest | null;

  /** CSS assets, rebuilt per generation (client import map + per-route extracted stylesheet). */
  cssAssets: AppCss | null;
  cssGen: number;
  cssHadEntries: boolean;

  /**
   * Auto-memo compiler (experimental, opt-in) + qrl handler extraction: maps of original →
   * transformed module URLs, merged into the client bundle's import-map redirects.
   */
  compilerMap: Record<string, string>;
  qrlMap: Record<string, string>;
  compilerGen: number;

  /** Cache Components (experimental): the `"use cache"` loader wrapper, rebuilt per generation. */
  readonly useCacheEnabled: boolean;
  ucLoad: ModuleLoader | null;
  ucLoadGen: number;

  /**
   * Client bundle cache keyed by route path (cleared on change). Entry code only; split
   * chunks (from dynamic imports) live in `chunkCache`, served next to the entry so its
   * relative `./chunk-*.js` imports resolve.
   */
  readonly bundleCache: Map<string, string>;
  readonly chunkCache: Map<string, string>;
  /** In-flight route bundles, so a burst of first hits spawns one `deno bundle`. */
  readonly routeInFlight: Map<string, Promise<string>>;

  middlewareRunner: MiddlewareRunner;
  middlewareGen: number;
  /** Loaded at boot (async); `onRequestError` forwards through it once loaded. */
  instrumentation: Instrumentation;

  /** Live-reload subscribers. */
  readonly reloadClients: Set<ReadableStreamDefaultController<Uint8Array>>;
  /**
   * Dev black-box recorder: server errors + browser console/errors (POSTed to
   * DEV_LOG_PATH) land here and are read back via DEV_STATE_PATH (the MCP live tools).
   */
  readonly devEvents: DevEventLog;
  /** Monotonic token so a stale `deno check` run is dropped when a newer edit lands. */
  typeCheckToken: number;

  /** The dev module loader (wired by `startDevServer` once the manifest getter exists). */
  load: ModuleLoader;
}

/** Fresh per-server state. */
export function createDevState(options: DevServerOptions): DevState {
  const { paths } = options;
  return {
    paths,
    options,
    allowedDevOrigins: options.allowedDevOrigins ?? [],
    generation: 0,
    manifest: null,
    lastEmittedManifest: null,
    unbundledOptIn: options.unbundled ?? (Deno.env.get("DENEXT_DEV_UNBUNDLED") !== "0"),
    unbundled: null,
    unbundledActive: false,
    unbundledCompat: false,
    flightRoutes: new Set(),
    flightClients: new Map(),
    flightServers: new Map(),
    boundaryGen: -1,
    flightBundle: null,
    compatP: undefined,
    compatLoad: null,
    compatBuiltGen: -1,
    compatBuilding: null,
    compatModuleMap: new Map(),
    compatBoundary: null,
    cssAssets: null,
    cssGen: -1,
    cssHadEntries: false,
    compilerMap: {},
    qrlMap: {},
    compilerGen: -1,
    useCacheEnabled: paths.config?.experimental?.cacheComponents ?? false,
    ucLoad: null,
    ucLoadGen: -1,
    bundleCache: new Map(),
    chunkCache: new Map(),
    routeInFlight: new Map(),
    middlewareRunner: null,
    middlewareGen: -1,
    instrumentation: {},
    reloadClients: new Set(),
    devEvents: new DevEventLog(),
    typeCheckToken: 0,
    load: () => Promise.reject(new Error("denext: dev loader used before startDevServer wired it")),
  };
}
