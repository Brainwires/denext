// SPA mode dev server: the shared state — the per-generation bundle, the live-reload
// subscribers, and the optional unbundled (per-module HMR) loop.

import {
  type Platform,
  platformResolution,
  projectPlatformRedirects,
  sharedBuildTarget,
} from "../platform-extensions.ts";
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
import { spaTailwind } from "../react-native-uniwind.ts";
import { bundleSpaInto, spaCssGraph, spaCssRoots, spaDefines, usesExpoRouter } from "./bundle.ts";
import { renderSpaShell, spaShellFor, spaShellInstall } from "./shell.ts";
import type { SpaShellParts } from "./shell-capture.ts";
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

/** One target's bundled-loop build. */
export interface SpaTargetBuild {
  /**
   * The current generation's build dir, or null when invalidated. The client assets live
   * in a per-generation dir served via serveStatic — so the compat (esbuild, multi-file)
   * and plain (deno bundle) paths are served identically.
   */
  dir: string | null;
  /** Whether the build emitted a stylesheet. */
  hasStyles: boolean;
  /** The build in flight, if any. */
  building: Promise<string> | null;
}

/** Everything the SPA dev server's stages share. */
export interface SpaDevState {
  readonly options: SpaDevServerOptions;
  readonly paths: ProjectPaths;
  readonly spa: SpaConfig;
  readonly entryPath: string;
  /** Bumped on every source change; the bundle + extracted CSS are per generation. */
  generation: number;
  /**
   * The bundled loop's build per target (`web`, and each shell target whose platform files
   * resolve unlike web's; see {@linkcode spaBuildTarget}). Cleared by {@linkcode invalidateBuilds}.
   */
  readonly builds: Map<Platform, SpaTargetBuild>;
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
  /**
   * The rendered `spa.shell` per `generation:platform` (only the current generation's are
   * kept): the shell is re-rendered after an edit, once, on the next navigation.
   */
  readonly shells: Map<string, Promise<SpaShellParts | null>>;
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
    builds: new Map(),
    reloadClients: new Set(),
    devEvents: new DevEventLog(),
    unbundledOptIn: unbundledOptIn(options),
    unbundled: null,
    unbundledReady: null,
    unbundledCss: new Map(),
    unbundledCssGen: -1,
    pluginsReady: Promise.resolve(),
    shells: new Map(),
  };
}

/** A target's build dir name for a generation: `<gen>` for web, `<gen>-<target>` for another. */
function genDirName(gen: number, platform: Platform): string {
  return platform === "web" ? String(gen) : `${gen}-${platform}`;
}

/**
 * Prune `platform`'s prior generations — a long dev session (many edits) would otherwise
 * accumulate a full bundle copy per change. Builds are serialized per target and only the
 * current generation is served, so removing that target's others is safe; another target's
 * builds are its own, and stay.
 */
async function pruneGenerations(root: string, keep: string, platform: Platform): Promise<void> {
  const own = platform === "web" ? /^\d+$/ : new RegExp(`^\\d+-${platform}$`);
  try {
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory && e.name !== keep && own.test(e.name)) {
        await Deno.remove(join(root, e.name), { recursive: true }).catch(() => {});
      }
    }
  } catch { /* root vanished — nothing to prune */ }
}

async function buildGeneration(
  st: SpaDevState,
  build: SpaTargetBuild,
  gen: number,
  platform: Platform,
): Promise<string> {
  const root = join(st.paths.outDir, "spa-dev");
  const name = genDirName(gen, platform);
  const dir = join(root, name);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await ensureDir(dir);
  const res = await bundleSpaInto(st.paths, st.entryPath, dir, false, true, platform);
  build.hasStyles = res.hasStyles;
  build.dir = dir;
  await pruneGenerations(root, name, platform);
  return dir;
}

/**
 * The target whose bundled-loop build `platform` shares: `web` when its platform files resolve
 * as web's do and it renders the same `spa.shell`, else `platform` itself — as the App Router dev
 * server decides (`devBuildTarget` in ../dev-server/platform.ts).
 */
function spaBuildTarget(st: SpaDevState, platform: Platform): Promise<Platform> {
  const { paths, spa } = st;
  if (spaShellFor(spa, platform) !== spaShellFor(spa, "web")) return Promise.resolve(platform);
  return sharedBuildTarget(
    platform,
    (p) => projectPlatformRedirects(paths.projectDir, paths.config, p),
  );
}

/** `platform`'s build record (created empty on first use). */
function buildOf(st: SpaDevState, platform: Platform): SpaTargetBuild {
  let build = st.builds.get(platform);
  if (!build) {
    build = { dir: null, hasStyles: false, building: null };
    st.builds.set(platform, build);
  }
  return build;
}

/**
 * The current generation's build for the session's `platform` (building it on first use): its
 * dir and whether it has a stylesheet. Callers MUST capture the returned dir and pass it to
 * `serveStatic` rather than reading the build record again after the await — a concurrent watch
 * event can invalidate it (and bump the generation) between the await resolving and the read.
 *
 * @param st The dev state.
 * @param platform The session's target (shares web's build when its files resolve alike).
 */
export async function ensureBuilt(
  st: SpaDevState,
  platform: Platform = "web",
): Promise<{ dir: string; hasStyles: boolean }> {
  const target = await spaBuildTarget(st, platform);
  const build = buildOf(st, target);
  if (build.dir) return { dir: build.dir, hasStyles: build.hasStyles };
  if (!build.building) {
    const gen = st.generation;
    build.building = st.pluginsReady.then(() => buildGeneration(st, build, gen, target))
      .finally(() => {
        build.building = null;
      });
  }
  const dir = await build.building;
  return { dir, hasStyles: build.hasStyles };
}

/** Drop every target's build: the next request for each rebuilds it (a source edit). */
export function invalidateBuilds(st: SpaDevState): void {
  for (const build of st.builds.values()) build.dir = null;
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
        // One install for every target: on a page without the shell it does nothing.
        shell: spaShellInstall(st.spa.shell ?? null),
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
      tailwind: spaTailwind(paths),
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

/**
 * The rendered `spa.shell` for `platform` at the current generation (rendered once per
 * generation and target), or null when no shell applies to it.
 */
export function devShell(st: SpaDevState, platform: Platform): Promise<SpaShellParts | null> {
  if (!st.spa.shell) return Promise.resolve(null);
  const key = `${st.generation}:${platform}`;
  let hit = st.shells.get(key);
  if (!hit) {
    for (const k of st.shells.keys()) if (!k.startsWith(`${st.generation}:`)) st.shells.delete(k);
    hit = renderSpaShell(st.paths, platform, false);
    // A failed render is retried on the next navigation (after the fix's edit, or as is).
    hit.catch(() => st.shells.delete(key));
    st.shells.set(key, hit);
  }
  return hit;
}
