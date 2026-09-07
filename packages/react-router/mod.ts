// @denext/react-router — run a React Router v7 framework-mode app on denext with its source
// untouched. A plugin-kit plugin: it evaluates the app's `app/routes.ts` (the `route()` /
// `index()` / `layout()` / `prefix()` config, imported from `@react-router/dev/routes` — aliased
// to `@denext/react-router/routes`), generates the denext wrappers for every route module
// under `.denext/react-router/`, and feeds them to the core App Router through the
// route-synthesizer seam — so Flight, streaming, per-segment boundaries, soft navigation,
// ISR and Fast Refresh all come from denext itself. Loaders, actions, `meta`, `links`,
// `ErrorBoundary`, the root `Layout` export and the `Route.ComponentProps` props contract run
// on the `denext/remix` runtime (RR7's framework API is Remix's).
//
//   // denext.config.ts
//   import { reactRouter } from "@denext/react-router";
//   export default { plugins: [reactRouter()] };

import type { DenextPlugin, PluginContext } from "@denext/denext/plugin-kit";
import { join } from "@std/path";
import { generateRoutes } from "./src/generate.ts";
import { resolveReactRouterConfig, resolveRouteConfig } from "./src/load-config.ts";
import { synthesizeRoutes } from "./src/manifest.ts";
import { buildRouteTree } from "./src/route-tree.ts";

export type { ReactRouterConfig } from "./src/load-config.ts";
export type { RouteNode } from "./src/route-tree.ts";
export type { RouteConfig, RouteConfigEntry } from "./routes.ts";

/** Options for {@link reactRouter}. */
export interface ReactRouterOptions {
  /**
   * The RR app directory relative to the project (default: `react-router.config.ts`'s
   * `appDirectory`, else `app`).
   */
  appDirectory?: string;
  /** The routes config module relative to the app directory (default `routes.ts`). */
  routesFile?: string;
}

const CONFIG_FILES = [
  "react-router.config.ts",
  "react-router.config.js",
  "react-router.config.mjs",
];
const ROOT_FILES = ["root.tsx", "root.jsx", "root.ts", "root.js"];

/**
 * The React Router v7 plugin: register it in `denext.config.ts` (`plugins: [reactRouter()]`).
 *
 * @param options Where the app lives when it deviates from RR's defaults.
 * @returns The denext plugin.
 */
export function reactRouter(options: ReactRouterOptions = {}): DenextPlugin {
  return {
    name: "@denext/react-router",
    async setup(ctx: PluginContext) {
      const rrConfig = resolveReactRouterConfig(
        await loadFirst(ctx, ctx.projectRoot, CONFIG_FILES),
      );
      const appDir = join(ctx.projectRoot, options.appDirectory ?? rrConfig.appDirectory);
      const routesFile = join(appDir, options.routesFile ?? "routes.ts");
      if (!(await exists(routesFile))) return; // not an RR framework app — nothing to do
      if (rrConfig.ssr === false) {
        console.warn(
          "denext/react-router: react-router.config `ssr: false` (RR's SPA mode) is not what this plugin serves — routes are server-rendered; use denext's `mode: \"spa\"` for a pure SPA.",
        );
      }
      const rootFile = await firstExisting(appDir, ROOT_FILES);
      const outDir = join(ctx.projectRoot, ".denext", "react-router");

      // Runs on every manifest scan (once per build/start, per request in dev): read the
      // config, (re)generate what changed, and add the routes.
      ctx.addRouteSynthesizer(async (manifest) => {
        const entries = await resolveRouteConfig(await ctx.load(routesFile), routesFile);
        const nodes = buildRouteTree(entries);
        const generated = await generateRoutes({ appDir, outDir, nodes, rootFile });
        synthesizeRoutes(manifest, nodes, generated);
      });
    },
  };
}

async function loadFirst(ctx: PluginContext, dir: string, names: string[]): Promise<unknown> {
  const file = await firstExisting(dir, names);
  return file ? await ctx.load(file) : {};
}

async function firstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const path = join(dir, name);
    if (await exists(path)) return path;
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
