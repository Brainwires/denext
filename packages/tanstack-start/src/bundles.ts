// The two bundles a Start app runs as, both compiled onto denext's React with
// `@denext/denext/build/next-compat` and TanStack's own compiler as an extra esbuild plugin: the
// server bundle (Start's handler and the app, built on first use) and the client bundle (built at
// `denext build`, or on first use in dev).

import type { PluginContext } from "@denext/denext/server";
import {
  buildNextCompatClientEntries,
  buildNextCompatModules,
  createNextCompatServerLoader,
} from "@denext/denext/build/next-compat";
import { startBuildPlugin } from "./compile.ts";
import { clientEntrySource } from "./entries.ts";
import { CLIENT_ENTRY, CLIENT_PREFIX, routerManifest, SERVER_FN_SEGMENT } from "./handler.ts";
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
  /** Forget both bundles: the next request builds them again (an edit in dev). */
  reset(): void;
}

/** Start's build-time `process.env` constants (its Vite plugin defines the same). */
export function startDefines(basePath: string): Record<string, string> {
  const values: Record<string, string> = {
    TSS_SERVER_FN_BASE: `${basePath}${SERVER_FN_SEGMENT}`,
    TSS_ROUTER_BASEPATH: basePath || "/",
    TSS_DEV_SERVER: "false",
    TSS_PRERENDERING: "false",
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
 */
export function createBundles(ctx: PluginContext, app: StartApp): StartBundles {
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
    define: startDefines(app.basePath),
  };
  const plugin = async (
    env: StartEnv,
    knownServerFns: Record<string, ServerFnInfo>,
    onServerFns?: (fns: Record<string, ServerFnInfo>) => void,
  ) =>
    startBuildPlugin({
      env,
      toolchain: await toolchain(),
      projectRoot: app.root,
      routerFile: app.routerFile,
      startFile: app.startFile,
      manifest: routerManifest(`${app.basePath}${CLIENT_PREFIX}${CLIENT_ENTRY}`),
      knownServerFns,
      onServerFns,
    });

  // The resolver maps every server function the compiler meets. The functions are found by a
  // scan of the sources first; one the scan missed (reached only through a module outside
  // them) rebuilds the bundle once with it.
  const buildServer = async () => {
    let known = await scanServerFns(await toolchain(), app.root, app.src);
    for (let attempt = 0;; attempt++) {
      const seen: Record<string, ServerFnInfo> = {};
      const moduleMap = await buildNextCompatModules({
        ...compat,
        modules: [app.serverEntry],
        extraPlugins: [await plugin("server", known, (fns) => Object.assign(seen, fns))],
      });
      if (coversServerFns(known, seen) || attempt > 0) return moduleMap;
      known = { ...known, ...seen };
    }
  };
  const bundle = async () =>
    buildNextCompatClientEntries({
      ...compat,
      clientDir: app.clientDir,
      entries: [{ id: "client", source: clientEntrySource(app.boot) }],
      momentumSafeScroll: ctx.config.momentumSafeScroll !== false,
      extraPlugins: [await plugin("client", {})],
    });

  let server: Promise<(path: string) => Promise<unknown>> | undefined;
  let built: Promise<string> | undefined;
  return {
    async loadServerEntry() {
      server ??= buildServer().then((moduleMap) =>
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
    reset() {
      server = undefined;
      built = undefined;
    },
  };
}
