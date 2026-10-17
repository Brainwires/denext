// The two bundles a Start app runs as, both compiled onto denext's React with
// `@denext/denext/build/next-compat` and TanStack's own compiler as an extra esbuild plugin: the
// server bundle (Start's handler and the app) and the client bundle. `denext build` builds both
// and records where the server bundle is (`server.json`), so `denext start` loads it without
// building; dev builds each on first use and again after an edit; `denext export` builds both
// and prerenders the app's pages through the server bundle (./prerender.ts).

import type { PluginBuildContext, PluginContext } from "@denext/denext/server";
import {
  buildNextCompatClientEntries,
  buildNextCompatModules,
  createNextCompatServerLoader,
} from "@denext/denext/build/next-compat";
import { join, relative } from "@std/path";
import { type ClientGraph, type StartBuild, startBuild } from "./compile.ts";
import { clientEntrySource } from "./entries.ts";
import { CLIENT_ENTRY, CLIENT_PREFIX, routerManifest, SERVER_FN_SEGMENT } from "./handler.ts";
import {
  formatRefusals,
  PAGES_DIR,
  pageWriter,
  type PrerenderOptions,
  prerenderPages,
  type RouteInfo,
  type StartPage,
} from "./prerender.ts";
import type { ImportProtection } from "./protect.ts";
import { coversServerFns, scanServerFns } from "./server-fns.ts";
import { loadStartToolchain, type ServerFnInfo, type StartEnv } from "./toolchain.ts";

/** Where a Start app's modules are, and where the plugin writes. */
export interface StartApp {
  /** The project root, as given. */
  projectRoot: string;
  /** Its real path: server-function ids hash module paths relative to it. */
  root: string;
  /** The source directory. */
  src: string;
  /** The router module (real path). */
  routerFile: string;
  /** `src/start.ts` (real path), when the app has one. */
  startFile: string | null;
  /** The generated server entry and client boot module. */
  serverEntry: string;
  boot: string;
  /** `.denext/tanstack-start/` and its `client/`. */
  outDir: string;
  clientDir: string;
  /** The app's `deno.json`. */
  configPath: string;
  /** The app's `basePath` (`""` when none). */
  basePath: string;
}

/** The bundles' lifecycle, as the request handler and the build step use it. */
export interface StartBundles {
  /** Import the server entry (building the server bundle on first use). */
  loadServerEntry(): Promise<{ fetch(request: Request): Promise<Response> }>;
  /** The client bundle's directory, once built. */
  client(): Promise<string>;
  /** Build the client bundle. */
  bundle(): Promise<void>;
  /** The last client build's import graph (`null` before one). */
  clientGraph(): ClientGraph | null;
  /** Build the server bundle and record it for `denext start` (`server.json`). */
  prebuildServer(): Promise<void>;
  /** Drop the record of a previous build's server bundle (a failed build leaves none). */
  forgetServerBuild(): Promise<void>;
  /** Forget both bundles: the next request builds them again (an edit in dev). */
  reset(): void;
}

/**
 * Start's build-time `process.env` constants (its Vite plugin defines the same).
 *
 * @param basePath The app's `basePath` (`""` when none).
 * @param prerendering The bundle is the export's server bundle (Start's `TSS_PRERENDERING`).
 */
export function startDefines(basePath: string, prerendering = false): Record<string, string> {
  const values: Record<string, string> = {
    TSS_SERVER_FN_BASE: `${basePath}${SERVER_FN_SEGMENT}`,
    TSS_ROUTER_BASEPATH: basePath || "/",
    TSS_DEV_SERVER: "false",
    TSS_PRERENDERING: String(prerendering),
    TSS_SHELL: "false",
    TSS_INLINE_CSS_ENABLED: "false",
    TSS_DEV_SSR_STYLES_ENABLED: "false",
    // denext's own same-origin check guards server functions (see the handler).
    TSS_DISABLE_CSRF_MIDDLEWARE_WARNING: "true",
  };
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)]),
  );
}

/**
 * The bundles of the Start app `app`.
 *
 * @param ctx The plugin context (mode, config, module loader).
 * @param app The app's modules and output paths.
 * @param protection Start's import protection, as the app configures it.
 */
export function createBundles(
  ctx: PluginContext,
  app: StartApp,
  protection?: ImportProtection,
): StartBundles {
  let tc: ReturnType<typeof loadStartToolchain> | undefined;
  const toolchain = () => (tc ??= loadStartToolchain(app.projectRoot));
  const compat = {
    projectDir: app.projectRoot,
    configPath: app.configPath,
    outDir: app.outDir,
    minify: ctx.mode !== "dev",
    // TanStack Router's error boundaries are class components.
    classComponents: ctx.config.classComponents !== false,
    resolveAllNodeModules: ctx.config.nodeResolve !== false,
    define: startDefines(app.basePath, ctx.mode === "export"),
  };
  const startOf = async (
    env: StartEnv,
    knownServerFns: Record<string, ServerFnInfo>,
    onServerFns?: (fns: Record<string, ServerFnInfo>) => void,
  ) =>
    startBuild({
      env,
      toolchain: await toolchain(),
      projectRoot: app.root,
      routerFile: app.routerFile,
      startFile: app.startFile,
      manifest: routerManifest(`${app.basePath}${CLIENT_PREFIX}${CLIENT_ENTRY}`),
      knownServerFns,
      onServerFns,
      protection,
    });

  // The resolver maps every server function the compiler meets. The functions are found by a
  // scan of the sources first; one the scan missed (reached only through a module outside
  // them) rebuilds the bundle once with it.
  const buildServer = async () => {
    let known = await scanServerFns(await toolchain(), app.root, app.src);
    for (let attempt = 0;; attempt++) {
      const seen: Record<string, ServerFnInfo> = {};
      const start = await startOf("server", known, (fns) => Object.assign(seen, fns));
      const moduleMap = await buildNextCompatModules({
        ...compat,
        modules: [app.serverEntry],
        extraPlugins: [start.plugin],
        // `"use cache"` in the app's server code, Start-compiled modules included.
        useCache: cacheComponents(ctx),
      });
      if (coversServerFns(known, seen) || attempt > 0) return moduleMap;
      known = { ...known, ...seen };
    }
  };
  let lastClient: StartBuild | undefined;
  const bundle = async () => {
    const start = await startOf("client", {});
    lastClient = start;
    await buildNextCompatClientEntries({
      ...compat,
      clientDir: app.clientDir,
      entries: [{ id: "client", source: clientEntrySource(app.boot) }],
      momentumSafeScroll: ctx.config.momentumSafeScroll !== false,
      extraPlugins: [start.plugin],
      // A `"use server"` module that declares server functions: Start's RPC stubs, no source.
      serverModuleSource: (path) => start.serverModuleSource(path),
    });
  };

  const serverRecord = join(app.outDir, SERVER_RECORD);
  // `denext start` loads what `denext build` built; anything else (and a build with no record)
  // builds it.
  const serverModules = async () =>
    (ctx.mode === "prod" ? await readServerRecord(serverRecord, app) : null) ??
      await buildServer();

  let server: Promise<(path: string) => Promise<unknown>> | undefined;
  let built: Promise<string> | undefined;
  return {
    async loadServerEntry() {
      server ??= serverModules().then((moduleMap) =>
        createNextCompatServerLoader(ctx.load, { moduleMap })
      ).catch((err) => {
        server = undefined; // a failed build is retried by the next request
        throw err;
      });
      return (await server)(app.serverEntry) as never;
    },
    client: () =>
      built ??= (ctx.mode === "prod" ? Promise.resolve() : bundle()).then(() => app.clientDir),
    bundle,
    clientGraph: () => lastClient?.clientGraph() ?? null,
    forgetServerBuild: () => Deno.remove(serverRecord).catch(() => {}),
    async prebuildServer() {
      const moduleMap = await buildServer();
      await writeServerRecord(serverRecord, app, moduleMap.get(app.serverEntry));
    },
    reset() {
      server = undefined;
      built = undefined;
    },
  };
}

/** The record of the built server bundle, in the plugin's output directory. */
export const SERVER_RECORD = "server.json";

/** `cacheComponents` (or Next's `experimental.cacheComponents` spelling) is on. */
function cacheComponents(ctx: PluginContext): boolean {
  const config = ctx.config as {
    cacheComponents?: boolean;
    experimental?: Record<string, unknown>;
  };
  return (config.cacheComponents ?? config.experimental?.cacheComponents) === true;
}

/**
 * Record where the server entry's bundle is (`<bundle>#<key>`), relative to the output
 * directory, so a build moved to another directory (a container image) still finds it.
 */
async function writeServerRecord(path: string, app: StartApp, ref: string | undefined) {
  if (!ref) throw new Error("@denext/tanstack-start: the server bundle has no entry");
  const at = ref.lastIndexOf("#");
  const bundle = relative(app.outDir, ref.slice(0, at)).replace(/\\/g, "/");
  await Deno.writeTextFile(path, JSON.stringify({ bundle, key: ref.slice(at + 1) }) + "\n");
}

/** The server bundle `denext build` recorded, or `null` when there is none. */
async function readServerRecord(path: string, app: StartApp): Promise<Map<string, string> | null> {
  let record: { bundle?: unknown; key?: unknown };
  try {
    record = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
  if (typeof record.bundle !== "string" || typeof record.key !== "string") return null;
  return new Map([[app.serverEntry, `${join(app.outDir, record.bundle)}#${record.key}`]]);
}

/** What `denext export` prerenders: Start's `prerender` and `pages` options, and the routes. */
export interface ExportPlan {
  options: PrerenderOptions;
  pages: StartPage[];
  /** The route tree the prepare step generated (`null` when the plugin does not generate it). */
  routes(): RouteInfo[] | null;
  /** The project root and the app's `basePath`. */
  projectRoot: string;
  basePath: string;
}

/**
 * The build step: `denext build` builds the client bundle, then the server bundle, so a build
 * error in either fails the build and `denext start`'s first request builds nothing. `denext
 * export` prerenders the app's pages ({@link exportStep}), unless `prerender.enabled` is
 * `false`.
 *
 * @param mode The plugin context's mode.
 * @param bundles The app's bundles.
 * @param build The build step's context (the export's emit seam).
 * @param plan What the export prerenders.
 */
export async function buildStep(
  mode: PluginContext["mode"],
  bundles: StartBundles,
  build?: PluginBuildContext,
  plan?: ExportPlan,
): Promise<void> {
  if (mode === "export") {
    if (build && plan && plan.options.enabled !== false) {
      return await exportStep(build, bundles, plan);
    }
    console.warn(
      "[@denext/tanstack-start] prerender is off (`prerender.enabled: false`): the export has " +
        "no TanStack routes; `denext start` serves them.",
    );
    return;
  }
  await bundles.forgetServerBuild();
  await bundles.bundle();
  await bundles.prebuildServer();
}

/**
 * `denext export`: the client bundle into the export (`/_tss/`), then Start's prerender of the
 * app's pages through the server bundle into `<outDir>/pages-static/` (which the export copies to
 * its root), the routes that need a server left out and listed.
 *
 * @param build The build step's context.
 * @param bundles The app's bundles (built for the export).
 * @param plan What the export prerenders.
 */
async function exportStep(
  build: PluginBuildContext,
  bundles: StartBundles,
  plan: ExportPlan,
): Promise<void> {
  await Deno.remove(join(build.outDir, PAGES_DIR), { recursive: true }).catch(() => {});
  const clientDir = await bundles.client();
  for await (const entry of Deno.readDir(clientDir)) {
    if (!entry.isFile) continue;
    const source = await Deno.readFile(join(clientDir, entry.name));
    await build.emitFile({ fileName: `${CLIENT_PREFIX.slice(1)}${entry.name}`, source });
  }
  const server = await bundles.loadServerEntry();
  const { written, refused } = await prerenderPages({
    options: plan.options,
    pages: plan.pages,
    routes: plan.routes(),
    client: bundles.clientGraph(),
    projectRoot: plan.projectRoot,
    basePath: plan.basePath,
    fetch: (request) => server.fetch(request),
    write: pageWriter(build.outDir),
  });
  console.log(`[@denext/tanstack-start] prerendered ${written.length} page(s)`);
  const report = formatRefusals(refused, plan.projectRoot);
  if (report) console.warn(report);
}
