/**
 * `@denext/tanstack-start` — Start-style server rendering for a TanStack Router app on denext,
 * through the plugin-kit seams alone (the way `@denext/react-router` runs a React Router app):
 *
 * - **The route tree** is the plugin's to generate: a prepare step runs TanStack's own
 *   generator (`@tanstack/router-generator`) over `src/routes/` into `src/routeTree.gen.ts` at
 *   `denext build` and `denext dev` startup, and again whenever a route file changes in dev.
 * - **Every page request** renders on the server through TanStack Router's SSR
 *   (`createRequestHandler` + `defaultRenderHandler` from `@tanstack/react-router/ssr/server`):
 *   the router loads the matched routes (their `loader`s and `beforeLoad`s run on the server),
 *   the root route's `shellComponent` renders the document with `<HeadContent />` and
 *   `<Scripts />`, and the router's state is dehydrated into it.
 * - **The browser** hydrates the document with `RouterClient`
 *   (`@tanstack/react-router/ssr/client`) from a client bundle denext builds, which the router
 *   manifest names so `<Scripts />` loads it; navigation is TanStack's from there.
 *
 * The app keeps Start's layout: `src/router.tsx` exports `getRouter()` (or `createRouter()`),
 * `src/routes/__root.tsx` renders the document. React resolves to denext through the app's
 * import map, as `denext migrate` writes it.
 *
 * @example
 * ```ts
 * // denext.config.ts
 * import { tanstackStart } from "@denext/tanstack-start";
 * export default { plugins: [tanstackStart()] };
 * ```
 *
 * @module
 */

import type { DenextPlugin, PluginContext } from "@denext/denext/server";
import {
  buildNextCompatClientEntries,
  buildNextCompatModules,
  createNextCompatServerLoader,
} from "@denext/denext/build/next-compat";
import { join, relative } from "@std/path";
import {
  clientBootSource,
  clientEntrySource,
  entryPaths,
  serverEntrySource,
  writeIfChanged,
} from "./src/entries.ts";
import { createHandler } from "./src/handler.ts";
import { generateRouteTree } from "./src/route-tree.ts";

/** Options for {@link tanstackStart}. */
export interface TanStackStartOptions {
  /** The source directory, relative to the project (default `src`). */
  srcDirectory?: string;
  /** The router module, relative to `srcDirectory` (default `router.tsx`). */
  router?: string;
  /** Generate `routeTree.gen.ts` from `routes/` (default `true`). */
  generateRouteTree?: boolean;
}

/**
 * The TanStack Start plugin: register it in `denext.config.ts` (`plugins: [tanstackStart()]`).
 *
 * @param options Where the app lives when it deviates from Start's defaults.
 * @returns The denext plugin.
 */
export function tanstackStart(options: TanStackStartOptions = {}): DenextPlugin {
  return {
    name: "@denext/tanstack-start",
    async setup(ctx: PluginContext) {
      const src = join(ctx.projectRoot, options.srcDirectory ?? "src");
      const routerFile = join(src, options.router ?? "router.tsx");
      if (!(await exists(routerFile))) return; // not a Start app — nothing to do
      const outDir = join(ctx.projectRoot, ".denext", "tanstack-start");
      const clientDir = join(outDir, "client");

      if (options.generateRouteTree !== false) {
        const routes = relative(ctx.projectRoot, join(src, "routes")).replace(/\\/g, "/");
        ctx.addPrepareStep(() => generateRouteTree(ctx.projectRoot, src), {
          watch: [`${routes}/**`],
        });
      }

      const { server: serverEntry, boot } = entryPaths(outDir);
      await writeIfChanged(serverEntry, serverEntrySource(outDir, routerFile));
      await writeIfChanged(boot, clientBootSource(outDir, routerFile));
      const configPath = await firstExisting(ctx.projectRoot, ["deno.json", "deno.jsonc"]);
      if (!configPath) throw new Error("@denext/tanstack-start: the project has no deno.json");
      const compat = {
        projectDir: ctx.projectRoot,
        configPath,
        outDir,
        minify: ctx.mode !== "dev",
        // TanStack Router's error boundaries are class components.
        classComponents: ctx.config.classComponents !== false,
      };
      // The server entry and the client bundle are compiled onto denext's React (the app's
      // npm packages import `react`), as a Pages Router app's are.
      let server: Promise<(path: string) => Promise<unknown>> | undefined;
      const loadServerEntry = async () => {
        server ??= buildNextCompatModules({
          ...compat,
          modules: [serverEntry],
          resolveAllNodeModules: ctx.config.nodeResolve !== false,
        }).then((moduleMap) => createNextCompatServerLoader(ctx.load, { moduleMap }));
        return (await server)(serverEntry) as never;
      };
      const bundle = () =>
        buildNextCompatClientEntries({
          ...compat,
          clientDir,
          entries: [{ id: "client", source: clientEntrySource(boot) }],
          momentumSafeScroll: ctx.config.momentumSafeScroll !== false,
          resolveAllNodeModules: ctx.config.nodeResolve !== false,
        });
      let built: Promise<string> | undefined;
      const client = () =>
        built ??= (ctx.mode === "prod" ? Promise.resolve() : bundle()).then(() => clientDir);

      ctx.addRequestHandler(createHandler({
        loadServerEntry,
        client,
        basePath: ctx.config.basePath ?? "",
      }));
      ctx.addBuildStep(async () => {
        if (ctx.mode === "export") {
          console.warn(
            "[@denext/tanstack-start] a static export does not server-render TanStack routes; " +
              "`denext start` serves them.",
          );
          return;
        }
        await bundle();
      });
    },
  };
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
