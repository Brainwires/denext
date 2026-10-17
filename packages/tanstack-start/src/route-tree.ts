// The route tree: TanStack's own generator (what Start's Vite plugin runs) over `<src>/routes/`
// into `<src>/routeTree.gen.ts`, with explicit extensions on its imports so Deno resolves them
// without sloppy imports. The routes it found come back as {@link RouteInfo}s (what Start's own
// generator plugin reads to discover the paths it prerenders). `tsr.config.json` in the project still applies (inline settings win
// only for the two paths and the extensions). The generator is a build-time npm tool, resolved
// from the APP's own dependencies (its package.json lists `@tanstack/router-generator`), so the
// plugin itself depends on no npm package.

import { createRequire } from "node:module";
import { join, relative, resolve, toFileUrl } from "@std/path";
import type { RouteInfo } from "./prerender.ts";

/** A route node, as far as the plugin reads one (`RouteNode` in TanStack's types). */
interface RouteNode {
  fullPath: string;
  routePath?: string;
  isNonPath?: boolean;
  parent?: RouteNode;
  createFileRouteProps?: Set<string>;
}

/** The shape of `@tanstack/router-generator` the plugin uses. */
interface RouterGenerator {
  getConfig(inline: Record<string, unknown>, root: string): unknown;
  Generator: new (opts: { config: unknown; root: string }) => { run(): Promise<void> };
  inferFullPath(node: RouteNode): string;
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
 * @returns The routes, the root route first.
 */
export async function generateRouteTree(projectRoot: string, srcDir: string): Promise<RouteInfo[]> {
  const generator = await loadGenerator(projectRoot);
  const { Generator, getConfig } = generator;
  const src = "./" + relative(projectRoot, srcDir).replace(/\\/g, "/");
  let routes: RouteInfo[] = [];
  const config = getConfig({
    target: "react",
    routesDirectory: `${src}/routes`,
    generatedRouteTree: `${src}/routeTree.gen.ts`,
    addExtensions: true,
    disableLogging: true,
    // A fresh generator always reports the tree (its first run writes it).
    plugins: [{
      name: "denext-route-info",
      onRouteTreeChanged: (
        { routeNodes, rootRouteNode }: { routeNodes: RouteNode[]; rootRouteNode?: RouteNode },
      ) => {
        routes = routeInfos(rootRouteNode, routeNodes, (n) => generator.inferFullPath(n));
      },
    }],
  }, projectRoot);
  await new Generator({ config, root: projectRoot }).run();
  return routes;
}

/** The generator's route nodes as the plugin's {@link RouteInfo}s, parents linked. */
function routeInfos(
  root: RouteNode | undefined,
  nodes: RouteNode[],
  fullPathOf: (node: RouteNode) => string,
): RouteInfo[] {
  const byNode = new Map<RouteNode, RouteInfo>();
  const info = (node: RouteNode, isRoot: boolean): RouteInfo => {
    const known = byNode.get(node);
    if (known) return known;
    const made: RouteInfo = {
      id: isRoot ? "__root__" : node.routePath ?? "",
      path: isRoot ? "/" : fullPathOf(node),
      // The generator writes `/`; the bundles' module ids use the platform's separator.
      file: resolve(node.fullPath),
      layout: isRoot || node.isNonPath === true,
      options: [...(node.createFileRouteProps ?? [])],
    };
    byNode.set(node, made);
    return made;
  };
  const rootInfo = root ? info(root, true) : undefined;
  const out = rootInfo ? [rootInfo] : [];
  for (const node of nodes) {
    if (node === root) continue;
    const made = info(node, false);
    made.parent = node.parent && node.parent !== root ? info(node.parent, false) : rootInfo;
    out.push(made);
  }
  return out;
}
