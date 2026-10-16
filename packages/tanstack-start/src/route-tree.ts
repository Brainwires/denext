// The route tree: TanStack's own generator (what Start's Vite plugin runs) over `<src>/routes/`
// into `<src>/routeTree.gen.ts`, with explicit extensions on its imports so Deno resolves them
// without sloppy imports. `tsr.config.json` in the project still applies (inline settings win
// only for the two paths and the extensions).

import { relative } from "@std/path";

/**
 * Generate the route tree of the app at `projectRoot` whose sources are in `srcDir`.
 *
 * @param projectRoot The project root (the generator's root, where `tsr.config.json` lives).
 * @param srcDir The source directory (absolute).
 */
export async function generateRouteTree(projectRoot: string, srcDir: string): Promise<void> {
  const { Generator, getConfig } = await import("@tanstack/router-generator");
  const src = "./" + relative(projectRoot, srcDir).replace(/\\/g, "/");
  const config = getConfig({
    target: "react",
    routesDirectory: `${src}/routes`,
    generatedRouteTree: `${src}/routeTree.gen.ts`,
    addExtensions: true,
    disableLogging: true,
  }, projectRoot);
  await new Generator({ config, root: projectRoot }).run();
}
