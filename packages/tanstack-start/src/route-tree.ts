// The route tree: TanStack's own generator (what Start's Vite plugin runs) over `<src>/routes/`
// into `<src>/routeTree.gen.ts`, with explicit extensions on its imports so Deno resolves them
// without sloppy imports. `tsr.config.json` in the project still applies (inline settings win
// only for the two paths and the extensions). The generator is a build-time npm tool, resolved
// from the APP's own dependencies (its package.json lists `@tanstack/router-generator`), so the
// plugin itself depends on no npm package.

import { createRequire } from "node:module";
import { join, relative, toFileUrl } from "@std/path";

/** The shape of `@tanstack/router-generator` the plugin uses. */
interface RouterGenerator {
  getConfig(inline: Record<string, unknown>, root: string): unknown;
  Generator: new (opts: { config: unknown; root: string }) => { run(): Promise<void> };
}

/** Import the app's `@tanstack/router-generator` (node resolution from the project root). */
async function loadGenerator(projectRoot: string): Promise<RouterGenerator> {
  let entry: string;
  try {
    entry = createRequire(join(projectRoot, "package.json")).resolve("@tanstack/router-generator");
  } catch {
    throw new Error(
      "@denext/tanstack-start: add @tanstack/router-generator to the app's package.json " +
        "(devDependencies) to generate the route tree, or pass `generateRouteTree: false`",
    );
  }
  const mod = await import(toFileUrl(entry).href);
  return (mod.Generator ? mod : mod.default) as RouterGenerator;
}

/**
 * Generate the route tree of the app at `projectRoot` whose sources are in `srcDir`.
 *
 * @param projectRoot The project root (the generator's root, where `tsr.config.json` lives).
 * @param srcDir The source directory (absolute).
 */
export async function generateRouteTree(projectRoot: string, srcDir: string): Promise<void> {
  const { Generator, getConfig } = await loadGenerator(projectRoot);
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
