/**
 * `@denext/tanstack-start` — a TanStack Start app on denext, through the plugin-kit seams alone
 * (the way `@denext/react-router` runs a React Router app). TanStack's own runtime answers every
 * request; denext builds the app, applies its request rules and serves it:
 *
 * - **The route tree** is the plugin's to generate: a prepare step runs TanStack's own
 *   generator (`@tanstack/router-generator`) over `src/routes/` into `src/routeTree.gen.ts` at
 *   `denext build` and `denext dev` startup, and again whenever a route file changes in dev.
 * - **Every request** goes through Start's own handler (`createStartHandler(defaultStreamHandler)`
 *   from `@tanstack/react-start/server`): a page is matched by TanStack Router, its matches'
 *   `beforeLoad`s and `loader`s run on the server, and the root route's `shellComponent` streams
 *   with each route's pending / error / not-found component as in Start, a deferred loader
 *   promise streaming in when it settles; a server function (`createServerFn`) is answered at
 *   `/_serverFn/<id>` in Start's own RPC format, its middleware and validator running; a route's
 *   `server.handlers` answer as a server route.
 * - **TanStack's own compiler** (`@tanstack/start-plugin-core`) builds both sides: in the
 *   browser a server function is an RPC stub and server-only code is dropped; on the server a
 *   function's handler is split into the module the RPC resolves. denext's own transforms run on
 *   what it compiles (`"use cache"` with `cacheComponents` on); a `"use server"` module ships to
 *   the browser as its server functions' RPC stubs alone.
 * - **Both builds are guarded** by Start's import protection, its rules, options
 *   (`importProtection`) and messages: in the browser a `*.server.*` file,
 *   `@tanstack/react-start/server` or a module marked server-only, on the server a `*.client.*`
 *   file or a module marked client-only, fails the build when tree-shaking kept the import; the
 *   browser build also runs denext's server-only scan. `denext build` builds the server bundle
 *   too, so `denext start` serves its first request without building.
 * - **`denext export` prerenders** the app's pages with Start's prerender (its `prerender` and
 *   `pages` options, the route tree's static paths, the links each page has), and leaves out and
 *   lists the routes that need a server: server routes, pages that call a server function, and
 *   dynamic routes no page covered.
 * - **denext's rules:** a server function called with a mutating method must come from the
 *   app's origin (the check Server Actions use; a cross-site call is a 403), and request bodies
 *   are capped (`maxBodyBytes`, default `actionMaxBodyBytes` or 1 MiB).
 * - **The browser** hydrates the document with Start's `StartClient` from a client bundle
 *   denext builds, which the router manifest names so `<Scripts />` loads it.
 *
 * The app keeps Start's layout: `src/router.tsx` exports `getRouter()`, `src/routes/__root.tsx`
 * renders the document, `src/start.ts` (optional) exports `startInstance`, `src/server.ts` and
 * `src/client.tsx` (optional) replace the default entries. `@tanstack/react-start` and
 * `@tanstack/router-generator` come from the app's own `package.json`; React resolves to denext
 * through the app's import map, as `denext migrate` writes it.
 *
 * @example
 * ```ts
 * // denext.config.ts
 * import { tanstackStart } from "@denext/tanstack-start";
 * export default { compatibilityMode: true, plugins: [tanstackStart()] };
 * ```
 *
 * @module
 */

import type { DenextPlugin, PluginContext } from "@denext/denext/server";
import type { OriginCheckOptions } from "@denext/denext/plugin-kit";
import { join, relative } from "@std/path";
import { buildStep, createBundles, type StartApp } from "./src/bundles.ts";
import type { PrerenderOptions, RouteInfo, StartPage } from "./src/prerender.ts";
import { compileImportProtection, type ImportProtectionOptions } from "./src/protect.ts";
import { clientBootSource, entryPaths, serverEntrySource, writeIfChanged } from "./src/entries.ts";
import { createHandler } from "./src/handler.ts";
import { generateRouteTree, generatorPaths } from "./src/route-tree.ts";
import {
  checkBasepath,
  resolveRouter,
  type StartRouterOptions,
  validateOptions,
} from "./src/options.ts";

export type {
  ImportProtectionBehavior,
  ImportProtectionEnvRules,
  ImportProtectionOptions,
  ImportProtectionViolation,
  Pattern,
  ProtectionEnv,
  TraceStep,
} from "./src/protect.ts";
export type { PagePrerenderOptions, PrerenderOptions, StartPage } from "./src/prerender.ts";
export type { StartRouterOptions } from "./src/options.ts";

/** Options for {@link tanstackStart}. */
export interface TanStackStartOptions {
  /** The source directory, relative to the project (default `src`). */
  srcDirectory?: string;
  /**
   * The router module, relative to `srcDirectory` (default `router.tsx`), or Start's own
   * `router` option: `{ entry, basepath, ...the route generator's options }`. `entry` may leave
   * out the extension; `basepath` must match the app's `basePath`; the generator's options
   * (`routesDirectory` and `generatedRouteTree` relative to `srcDirectory`, as in Start) apply
   * over `tsr.config.json`.
   */
  router?: string | StartRouterOptions;
  /** Generate `routeTree.gen.ts` from `routes/` (default `true`). */
  generateRouteTree?: boolean;
  /**
   * The request-body cap for server functions and server routes, in bytes; a larger body is a
   * 413 before Start sees it. Default: the app's `actionMaxBodyBytes`, else 1 MiB.
   */
  maxBodyBytes?: number;
  /**
   * Origins (`https://app.example.com`) or bare hosts allowed to call a server function with a
   * mutating method, on top of the app's own origin.
   */
  allowedOrigins?: string[];
  /**
   * Start's `importProtection` options (as `tanstackStart({ importProtection })` takes them in
   * Start's Vite plugin): extra denied specifiers and files per side, the importers checked,
   * `onViolation`, `enabled`, `maxTraceDepth`. A violation always fails the build and the dev
   * request (Start's `error` behavior); `behavior: "mock"` is warned about, once per process
   * (`log: "once"`, the default) or on every build (`log: "always"`).
   */
  importProtection?: ImportProtectionOptions;
  /**
   * Start's `prerender` options for `denext export` (on by default there; `enabled: false`
   * exports no TanStack routes).
   */
  prerender?: PrerenderOptions;
  /** Start's `pages`: the paths `denext export` prerenders (default `/`, plus discovery). */
  pages?: StartPage[];
}

/**
 * The TanStack Start plugin: register it in `denext.config.ts` (`plugins: [tanstackStart()]`).
 *
 * @param options Where the app lives when it deviates from Start's defaults, and its limits.
 * @returns The denext plugin.
 */
export function tanstackStart(options: TanStackStartOptions = {}): DenextPlugin {
  // A bad shape fails when denext.config.ts loads, not at the first build.
  validateOptions(options);
  const router = resolveRouter(options.router);
  return {
    name: "@denext/tanstack-start",
    async setup(ctx: PluginContext) {
      const src = join(ctx.projectRoot, options.srcDirectory ?? "src");
      const routerFile = await routerModule(src, router.entry);
      if (!routerFile) return; // not a Start app — nothing to do
      checkBasepath(router.basepath, ctx.config.basePath);
      let routes: RouteInfo[] | null = null;
      if (options.generateRouteTree !== false) {
        const { routesDirectory } = generatorPaths(ctx.projectRoot, src, router.generator);
        ctx.addPrepareStep(async () => {
          routes = await generateRouteTree(ctx.projectRoot, src, router.generator);
        }, { watch: [`${projectRelative(ctx, join(ctx.projectRoot, routesDirectory))}/**`] });
      }
      const app = await prepareApp(ctx, src, routerFile);
      const protection = compileImportProtection(options.importProtection, app.projectRoot, src);
      const bundles = createBundles(ctx, app, protection);
      if (ctx.mode === "dev") {
        // An edit under the source directory: the next request builds both bundles again.
        ctx.addPrepareStep(() => bundles.reset(), { watch: [`${projectRelative(ctx, src)}/**`] });
      }
      const publicDir = join(ctx.projectRoot, "public");
      ctx.addRequestHandler(createHandler({
        loadServerEntry: () => bundles.loadServerEntry(),
        client: () => bundles.client(),
        basePath: ctx.config.basePath ?? "",
        origin: originOptions(ctx, options),
        maxBodyBytes: options.maxBodyBytes ?? ctx.config.actionMaxBodyBytes ?? 1024 * 1024,
        isStaticFile: (path) => isFile(join(publicDir, ...path.split("/"))),
      }));
      ctx.addBuildStep((build) =>
        buildStep(ctx.mode, bundles, build, {
          options: options.prerender ?? {},
          pages: options.pages ?? [],
          routes: () => routes,
          projectRoot: app.projectRoot,
          basePath: app.basePath,
        })
      );
    },
  };
}

/** Write the generated entries and collect where the app's modules are. */
async function prepareApp(ctx: PluginContext, src: string, routerFile: string): Promise<StartApp> {
  // The export's bundles (its server bundle is built to prerender) beside the build's.
  const outDir = join(
    ctx.projectRoot,
    ".denext",
    ctx.mode === "export" ? "tanstack-start-export" : "tanstack-start",
  );
  const { server: serverEntry, boot } = entryPaths(outDir);
  await writeIfChanged(
    serverEntry,
    serverEntrySource(await firstExisting(src, ["server.ts", "server.tsx"])),
  );
  await writeIfChanged(
    boot,
    clientBootSource(await firstExisting(src, ["client.tsx", "client.ts"])),
  );
  const configPath = await firstExisting(ctx.projectRoot, ["deno.json", "deno.jsonc"]);
  if (!configPath) throw new Error("@denext/tanstack-start: the project has no deno.json");
  const startFile = await firstExisting(src, ["start.ts", "start.tsx"]);
  return {
    projectRoot: ctx.projectRoot,
    // Server-function ids hash the module's path relative to the root: the real path, so a
    // symlinked checkout gives the browser and the server the same ids.
    root: await Deno.realPath(ctx.projectRoot),
    src,
    routerFile: await Deno.realPath(routerFile),
    startFile: startFile && await Deno.realPath(startFile),
    serverEntry,
    boot,
    outDir,
    clientDir: join(outDir, "client"),
    configPath,
    basePath: ctx.config.basePath ?? "",
  };
}

/** The same-origin rule a mutating server-function call must pass (Server Actions' rule). */
function originOptions(ctx: PluginContext, options: TanStackStartOptions): OriginCheckOptions {
  const dev = ctx.mode === "dev" ? ctx.config.allowedDevOrigins ?? [] : [];
  return {
    allowedOrigins: [...(options.allowedOrigins ?? []), ...dev],
    canonicalOrigin: ctx.config.canonicalOrigin ?? env("DENEXT_CANONICAL_ORIGIN"),
    trustForwardedHeaders: ctx.config.trustForwardedHeaders ?? env("DENEXT_TRUST_PROXY") === "1",
    desktopAppOrigin: ctx.config.desktop?.app?.origin,
  };
}

const projectRelative = (ctx: PluginContext, path: string) =>
  relative(ctx.projectRoot, path).replace(/\\/g, "/");

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined; // no --allow-env
  }
}

/** The router module: `entry` under `src`, as given or with a module extension (Start's rule). */
async function routerModule(src: string, entry: string): Promise<string | null> {
  for (const name of [entry, ...[".tsx", ".ts", ".jsx", ".js"].map((ext) => entry + ext)]) {
    if (await isFile(join(src, name))) return join(src, name);
  }
  return null;
}

async function firstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    if (await exists(join(dir, name))) return join(dir, name);
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}
