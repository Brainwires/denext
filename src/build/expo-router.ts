// expo-router in React Native mode. Its web build finds the app's routes through
// `expo-router/_ctx`, a Metro `require.context(process.env.EXPO_ROUTER_APP_ROOT, …)` that
// only Metro understands. React Native mode resolves `expo-router/_ctx` to a module generated
// at build time instead: it statically imports every route file under the app's route
// directory (`app/`, else `src/app/`) and exposes them through the same context interface
// (`ctx(key)`, `ctx.keys()`, `ctx.resolve(key)`), so `ExpoRoot` builds the same route tree.
// Each build (and each rebuild of the bundled dev loop) scans the directory again.

import { join, relative } from "@std/path";
import type * as esbuild from "esbuild";

/** The esbuild namespace of the generated context module. */
const CTX_NAMESPACE = "denext-expo-router-ctx";

/** The context specifiers expo-router imports (`expo-router/_ctx` and its platform files). */
const CTX_FILTER = /^expo-router\/_ctx(?:\.web)?(?:\.js)?$/;

/** A route source file (what Metro's `require.context` pattern admits). */
const ROUTE_FILE = /\.[jt]sx?$/;

/**
 * Files expo-router's context leaves out: API routes (`+api`), middleware, the HTML shell
 * (`+html`) and the native intent handler (`+native-intent`), declaration files, and — in a
 * web build — the native-only platform variants (`.ios` / `.android` / `.native`).
 */
function excluded(key: string): boolean {
  if (/\+api\.[jt]sx?$/.test(key)) return true;
  if (/^\.\/\+(?:middleware|html|native-intent)\.[jt]sx?$/.test(key)) return true;
  if (/\.d\.ts$/.test(key)) return true;
  return /\.(?:ios|android|native)\.[jt]sx?$/.test(key);
}

/**
 * The route directory of the app at `projectDir`: `app/`, else `src/app/` (expo-router's
 * two conventions), or null when it has neither.
 *
 * @param projectDir The app directory.
 */
export async function expoRouterRoot(projectDir: string): Promise<string | null> {
  for (const rel of ["app", "src/app"]) {
    try {
      if ((await Deno.stat(join(projectDir, rel))).isDirectory) return join(projectDir, rel);
    } catch { /* try the next one */ }
  }
  return null;
}

/** Every route file under `root`, as context keys (`./(tabs)/index.tsx`), sorted. */
async function routeKeys(root: string, dir = root): Promise<string[]> {
  const keys: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        keys.push(...await routeKeys(root, path));
      }
    } else if (entry.isFile && ROUTE_FILE.test(entry.name)) {
      const key = "./" + relative(root, path).replaceAll("\\", "/");
      if (!excluded(key)) keys.push(key);
    }
  }
  return keys.sort();
}

/**
 * The generated `expo-router/_ctx` module for the routes under `root`.
 *
 * @param root The route directory (absolute).
 * @returns The module source.
 */
async function expoRouterContextSource(root: string): Promise<string> {
  const keys = await routeKeys(root);
  const imports = keys.map((key, i) =>
    `import * as m${i} from ${JSON.stringify(join(root, key.slice(2)))};`
  );
  const entries = keys.map((key, i) => `  ${JSON.stringify(key)}: m${i},`);
  return `${imports.join("\n")}
const modules = {
${entries.join("\n")}
};
function load(key) {
  if (!Object.prototype.hasOwnProperty.call(modules, key)) {
    throw new Error("expo-router: no route module " + JSON.stringify(key));
  }
  return modules[key];
}
load.keys = function () { return Object.keys(modules); };
load.resolve = function (key) { return key; };
load.id = "denext-expo-router-ctx";
export const ctx = load;
`;
}

/**
 * The esbuild plugin that resolves `expo-router/_ctx` to the generated context of the app's
 * route directory. An app without one resolves it normally (and fails as it would on Metro
 * without `EXPO_ROUTER_APP_ROOT`).
 *
 * @param projectDir The app directory.
 */
export function expoRouterContextPlugin(projectDir: string): esbuild.Plugin {
  return {
    name: "denext-expo-router-ctx",
    setup(build) {
      build.onResolve({ filter: CTX_FILTER }, async () => {
        const root = await expoRouterRoot(projectDir);
        return root ? { path: root, namespace: CTX_NAMESPACE } : null;
      });
      // The route imports are absolute paths: hand them back as plain files, so the app's own
      // loaders and transforms apply to them as to any other source file.
      build.onResolve({ filter: /.*/, namespace: CTX_NAMESPACE }, (args) => ({ path: args.path }));
      build.onLoad({ filter: /.*/, namespace: CTX_NAMESPACE }, async (args) => ({
        contents: await expoRouterContextSource(args.path),
        loader: "js",
        resolveDir: args.path,
        watchDirs: [args.path],
      }));
    },
  };
}
