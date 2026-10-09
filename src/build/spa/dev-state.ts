// SPA mode dev server: the shared state — the per-generation bundle, the live-reload
// subscribers, and the optional unbundled (per-module HMR) loop.

import { type Platform, platformResolution } from "../platform-extensions.ts";
import { ensureDir } from "@std/fs";
import { join, resolve } from "@std/path";
import {
  domListsEnabled,
  featureFlags,
  momentumSafeScrollEnabled,
  nodeResolveEnabled,
  type SpaConfig,
} from "../../server/config.ts";
import { domListAliases } from "../dom-lists.ts";
import { appRendersDocumentTags, appUsesActivity, appUsesViewTransition } from "../bundle.ts";
import { reactNativeBundleOptions } from "../react-native.ts";
import { buildAppCss, extractRouteCss } from "../css.ts";
import { createUnbundledDev, type UnbundledDev } from "../dev-unbundled.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import type { ProjectPaths } from "../paths.ts";
import { DevEventLog } from "../dev-events.ts";
import { type SseClients, sseSend } from "../sse.ts";
import { tailwindPaths } from "../tailwind.ts";
import { bundleSpaInto, spaCssGraph, spaCssRoots, spaDefines, usesExpoRouter } from "./bundle.ts";
import {
  CLIENT_PREFIX,
  EXPO_ROUTER_LINKS,
  REACT_NATIVE_SPLASH,
  spaEntryPath,
  supportInstall,
} from "./shared.ts";

export interface SpaDevServerOptions {
  paths: ProjectPaths;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  strictPort?: boolean;
  /**
   * Force the unbundled per-module dev loop on (`true`) or off (`false`), overriding the
   * `DENEXT_DEV_UNBUNDLED` env default — see {@link DevServerOptions.unbundled}. Keeps mode
   * per-server so concurrent (e.g. parallel-test) servers don't fight over a global env var.
   */
  unbundled?: boolean;
  /** Extra dev origins (hosts) allowed to reach the `/_denext/*` dev endpoints. */
  allowedDevOrigins?: string[];
  /** The session token a non-loopback bind requires (see `DevServerOptions.devToken`). */
  devToken?: string;
}

/** The unbundled SPA's separately-extracted stylesheet URL. */
export const UNBUNDLED_STYLE_PATH = CLIENT_PREFIX + "unbundled.css";

/** Everything the SPA dev server's stages share. */
export interface SpaDevState {
  readonly options: SpaDevServerOptions;
  readonly paths: ProjectPaths;
  readonly spa: SpaConfig;
  readonly entryPath: string;
  /** Bumped on every source change; the bundle + extracted CSS are per generation. */
  generation: number;
  /**
   * The current generation's build dir, or null when invalidated. The client assets live
   * in a per-generation dir served via serveStatic — so the compat (esbuild, multi-file)
   * and plain (deno bundle) paths are served identically.
   */
  devDir: string | null;
  hasStyles: boolean;
  building: Promise<string> | null;
  /** Live-reload (SSE) subscribers. */
  readonly reloadClients: SseClients;
  /**
   * The dev black box: the page's console (POSTed to `/_denext/dev-log` by the dev-reload
   * script's capture), read back via `/_denext/dev-state` (`denext_dev_logs`).
   */
  readonly devEvents: DevEventLog;
  /** Unbundled dev loop opt-in (default-on; DENEXT_DEV_UNBUNDLED=0 or `unbundled: false`). */
  readonly unbundledOptIn: boolean;
  unbundled: UnbundledDev | null;
  unbundledReady: Promise<boolean> | null;
  /** The unbundled loop's stylesheet per target, for generation {@linkcode unbundledCssGen}. */
  readonly unbundledCss: Map<Platform, string>;
  unbundledCssGen: number;
  /**
   * Settles once the config's plugins are set up and their prepare steps ran (see
   * dev-plugins.ts): a bundle waits on it, since it may import what a step generates.
   */
  pluginsReady: Promise<void>;
}

/**
 * The unbundled opt-in: the explicit option, else on unless `DENEXT_DEV_UNBUNDLED=0` — React
 * Native mode included: its resolvers run inside the loop's dependency bundle (see
 * `dev-unbundled/react-native.ts`).
 */
function unbundledOptIn(options: SpaDevServerOptions): boolean {
  return options.unbundled ?? Deno.env.get("DENEXT_DEV_UNBUNDLED") !== "0";
}

/** Create the dev state for `options.paths` (resolves + validates the SPA entry). */
export function createSpaDevState(options: SpaDevServerOptions): SpaDevState {
  const { paths } = options;
  const { spa, entryPath } = spaEntryPath(paths);
  return {
    options,
    paths,
    spa,
    entryPath,
    generation: 0,
    devDir: null,
    hasStyles: false,
    building: null,
    reloadClients: new Set(),
    devEvents: new DevEventLog(),
    unbundledOptIn: unbundledOptIn(options),
    unbundled: null,
    unbundledReady: null,
    unbundledCss: new Map(),
    unbundledCssGen: -1,
    pluginsReady: Promise.resolve(),
  };
}

/**
 * Prune prior generations — a long dev session (many edits) would otherwise accumulate a
 * full bundle copy per change. Builds are serialized and only the current generation is
 * served, so removing the others is safe.
 */
async function pruneGenerations(root: string, keep: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory && e.name !== keep) {
        await Deno.remove(join(root, e.name), { recursive: true }).catch(() => {});
      }
    }
  } catch { /* root vanished — nothing to prune */ }
}

async function buildGeneration(st: SpaDevState, gen: number): Promise<string> {
  const root = join(st.paths.outDir, "spa-dev");
  const dir = join(root, String(gen));
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await ensureDir(dir);
  const res = await bundleSpaInto(st.paths, st.entryPath, dir, false, true);
  st.hasStyles = res.hasStyles;
  st.devDir = dir;
  await pruneGenerations(root, String(gen));
  return dir;
}

/**
 * The current generation's build dir (building it on first use). Callers MUST capture the
 * return value and pass it to `serveStatic` rather than reading `devDir` again after the
 * await — a concurrent watch event can null `devDir` (and bump the generation) between
 * the await resolving and the read, which would otherwise deref null.
 */
export function ensureBuilt(st: SpaDevState): Promise<string> {
  if (st.devDir) return Promise.resolve(st.devDir);
  if (st.building) return st.building;
  const gen = st.generation;
  st.building = st.pluginsReady.then(() => buildGeneration(st, gen)).finally(() => {
    st.building = null;
  });
  return st.building;
}

/** Push one SSE data frame to every live-reload subscriber (dropping dead ones). */
export function broadcastFrame(st: SpaDevState, data: string): void {
  sseSend(st.reloadClients, data);
}

/** Per-module HMR frame: the changed accept-boundary module URLs to re-import (unbundled). */
export function broadcastUpdate(st: SpaDevState, urls: string[]): void {
  broadcastFrame(st, `update:${JSON.stringify(urls)}`);
}

/**
 * Unbundled dev loop (Vite-class per-module HMR) for SPA: default-on (opt out with
 * DENEXT_DEV_UNBUNDLED=0). Serves the SPA entry + its module graph unbundled so a
 * component edit hot-swaps one module in place (native denext or the react→denext
 * compat runtime, decided by `detectNextCompat`). The app's `.css` imports become empty
 * shims, so the extracted stylesheet is built + linked separately
 * ({@linkcode getUnbundledCss}), mirroring the App Router unbundled loop.
 */
export function ensureUnbundled(st: SpaDevState): Promise<boolean> {
  return st.unbundledReady ??= (async () => {
    if (!st.unbundledOptIn) return false;
    await st.pluginsReady; // the module graph may import what a prepare step generates
    const { paths, entryPath } = st;
    // React Native mode: react-native → react-native-web and the rest of its resolvers run in
    // the loop's dependency bundle; it needs the compat (react→denext) runtime.
    const rn = reactNativeBundleOptions(paths.config, paths.projectDir, true);
    const compat = rn !== null || await detectNextCompat(paths);
    const [activity, viewTransition, singletons] = await Promise.all([
      appUsesActivity(paths.projectDir, [entryPath]),
      appUsesViewTransition(paths.projectDir, [entryPath]),
      appRendersDocumentTags(paths.projectDir, [entryPath]),
    ]);
    st.unbundled = createUnbundledDev({
      projectDir: paths.projectDir,
      appDir: resolve(entryPath, ".."),
      configPath: paths.configPath,
      outDir: paths.outDir,
      compat,
      classComponents: paths.config?.classComponents ?? true,
      features: featureFlags(paths.config),
      momentumSafeScroll: momentumSafeScrollEnabled(paths.config),
      instrumentationClient: paths.instrumentationClientPath,
      spaEntry: entryPath,
      // `lists: "denext"`: `@legendapp/list/react` → denext's VirtualList-backed module.
      specAliases: domListsEnabled(paths.config) ? domListAliases() : undefined,
      // `client:*` component elements become deferred mounts (spa-islands.ts), as in a build.
      spaIslands: true,
      // Each target's platform files for the app's own modules (`web` unless the page names one).
      resolvePlatform: (platform) => platformResolution(paths.config, platform),
      // The seam installs the bundled SPA entry runs (Expo Router's navigators need Activity).
      spaInstall: supportInstall({
        classComponents: paths.config?.classComponents ?? true,
        activity: activity || rn !== null,
        viewTransition,
        singletons,
      }) + (rn ? REACT_NATIVE_SPLASH : "") + (await usesExpoRouter(paths) ? EXPO_ROUTER_LINKS : ""),
      // The compat bundle's defines: `import.meta.env` (`spa.env`), React Native's globals,
      // and `process.env.NODE_ENV` (the bundle injects a `process` shim; a module does not).
      define: compat
        ? {
          ...spaDefines(st.spa, true),
          ...rn?.define,
          "process.env.NODE_ENV": JSON.stringify("development"),
        }
        : undefined,
      reactNative: rn
        ? {
          plugins: rn.plugins,
          platformExtensions: rn.platformExtensions,
          define: rn.define,
          resolveAllNodeModules: nodeResolveEnabled(paths.config),
        }
        : undefined,
      onDepsRebuilt: () => broadcastFrame(st, "reload"),
    });
    return true;
  })();
}

/**
 * The unbundled SPA's extracted stylesheet for `platform` (the session's target) and the current
 * generation (cached): the stylesheets its graph reaches through that target's platform files,
 * as a build of it extracts them.
 */
export async function getUnbundledCss(
  st: SpaDevState,
  platform: Platform = "web",
): Promise<string> {
  if (st.unbundledCssGen !== st.generation) {
    st.unbundledCss.clear();
    st.unbundledCssGen = st.generation;
  }
  const hit = st.unbundledCss.get(platform);
  if (hit !== undefined) return hit;
  const { paths } = st;
  const gen = st.generation;
  let text = "";
  try {
    const roots = await spaCssRoots(paths, st.entryPath, platform);
    const appCss = await buildAppCss({
      projectDir: paths.projectDir,
      configPath: paths.configPath,
      outDir: paths.outDir,
      minify: false,
      entryFiles: roots,
      tailwind: tailwindPaths(paths.projectDir, paths.config?.tailwind),
      graph: await spaCssGraph(paths, platform, "dev"),
    });
    text = appCss ? await extractRouteCss(roots, appCss) : "";
  } catch {
    text = "";
  }
  // An edit meanwhile started another generation: its request extracts afresh.
  if (st.unbundledCssGen === gen) st.unbundledCss.set(platform, text);
  return text;
}
