// Metro's `require.context(directory, recursive?, regExp?, mode?)` in the app's own modules, for
// React Native mode. An Expo app that renders its own root (`<ExpoRoot context={require.context(
// "./app")} />`, the starter of Tamagui's Expo app among others) calls it in its entry; esbuild
// has no such API, so the call reached the browser and threw "require.context is not a
// function". Each call with literal arguments is replaced at build time by a generated module
// that statically imports the matching files (lazily, as `import()`, for the `lazy` / `async`
// modes) and exposes Metro's context interface: `ctx(key)`, `ctx.keys()`, `ctx.resolve(key)`,
// `ctx.id`. Each build scans the directory again.
//
// Metro's defaults: `recursive` true, `regExp` /^\.\/.*$/, mode `sync`; the keys are
// `./`-relative paths of the files with a source extension.

import { dirname, join, relative, resolve } from "@std/path";
import type * as esbuild from "./esbuild/mod.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";

/** The esbuild namespace of a generated context module. */
const NAMESPACE = "denext-require-context";

/** The files a context lists: Metro's source extensions. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

/** A `require.context(…)` call with literal arguments (string, boolean, regex, mode). */
const CALL =
  /\brequire\.context\(\s*(["'`])([^"'`\n]+)\1\s*(?:,\s*(true|false)\s*)?(?:,\s*\/((?:\\.|[^/\n\\])+)\/([a-z]*)\s*)?(?:,\s*(["'])(sync|eager|lazy|lazy-once|async)\6\s*)?,?\s*\)/g;

/** One context: the directory and Metro's options for it. */
interface RequireContextSpec {
  /** The directory (absolute). */
  dir: string;
  /** Whether subdirectories are listed (Metro's default: true). */
  recursive: boolean;
  /** The key filter's source and flags (Metro's default: `^\.\/.*$`). */
  pattern: string;
  /** Its flags. */
  flags: string;
  /** `sync` (modules), or `lazy` (`ctx(key)` returns a promise of the module). */
  mode: "sync" | "lazy";
}

/**
 * Replace each `require.context(…)` call with literal arguments in `source` by an import of the
 * generated context module.
 *
 * @param source The module's source.
 * @param path The module's absolute path (the directory argument is relative to it).
 * @returns The new source, or null when it makes no such call.
 */
export function rewriteRequireContext(source: string, path: string): string | null {
  const imports: string[] = [];
  const out = source.replace(CALL, (_all, _q, dir, recursive, pattern, flags, _q2, mode) => {
    const spec: RequireContextSpec = {
      dir: resolve(dirname(path), dir),
      recursive: recursive !== "false",
      pattern: pattern ?? "^\\.\\/.*$",
      flags: flags ?? "",
      mode: mode === "lazy" || mode === "async" || mode === "lazy-once" ? "lazy" : "sync",
    };
    const name = `__denextRequireContext${imports.length}`;
    imports.push(
      `import { ctx as ${name} } from ${JSON.stringify(`${NAMESPACE}:${JSON.stringify(spec)}`)};`,
    );
    return name;
  });
  return imports.length === 0 ? null : `${imports.join("\n")}\n${out}`;
}

/** The keys (`./a/b.tsx`) of the files under `root` a context lists, sorted. */
async function contextKeys(spec: RequireContextSpec, dir = spec.dir): Promise<string[]> {
  const re = new RegExp(spec.pattern, spec.flags.replace(/[gy]/g, ""));
  const keys: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return keys; // Metro lists nothing for a missing directory
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (spec.recursive && entry.name !== "node_modules") {
        keys.push(...await contextKeys(spec, path));
      }
    } else if (entry.isFile && SOURCE_FILE.test(entry.name)) {
      const key = "./" + relative(spec.dir, path).replaceAll("\\", "/");
      if (re.test(key)) keys.push(key);
    }
  }
  return keys.sort();
}

/**
 * The generated context module for `spec`.
 *
 * @param spec The context.
 * @returns The module source.
 */
async function requireContextSource(spec: RequireContextSpec): Promise<string> {
  const keys = await contextKeys(spec);
  const file = (key: string) => JSON.stringify(join(spec.dir, key.slice(2)));
  const head = spec.mode === "sync"
    ? keys.map((key, i) => `import * as m${i} from ${file(key)};`).join("\n")
    : "";
  const entries = keys.map((key, i) =>
    `  ${JSON.stringify(key)}: ${spec.mode === "sync" ? `m${i}` : `() => import(${file(key)})`},`
  );
  return `${head}
const modules = {
${entries.join("\n")}
};
function load(key) {
  if (!Object.prototype.hasOwnProperty.call(modules, key)) {
    throw new Error("require.context: no module " + JSON.stringify(key));
  }
  return ${spec.mode === "sync" ? "modules[key]" : "modules[key]()"};
}
load.keys = function () { return Object.keys(modules); };
load.resolve = function (key) { return key; };
load.id = ${JSON.stringify(`${NAMESPACE}:${spec.dir}`)};
export const ctx = load;
`;
}

/**
 * The esbuild plugins behind React Native mode's `require.context`: the rewrite of the app's own
 * modules that call it, and the generated context modules.
 *
 * @param projectDir The app directory (only its own modules are rewritten).
 * @returns The plugins.
 */
export function requireContextPlugins(projectDir: string): esbuild.Plugin[] {
  return [
    firstPartyTsxPlugin("denext-require-context-rewrite", projectDir, rewriteRequireContext, {
      filter: /\.(?:tsx|jsx|m?ts|m?js)$/,
      deferUnless: "require.context",
    }),
    {
      name: "denext-require-context",
      setup(build) {
        build.onResolve({ filter: new RegExp(`^${NAMESPACE}:`) }, (args) => ({
          path: args.path.slice(NAMESPACE.length + 1),
          namespace: NAMESPACE,
        }));
        // The listed files are absolute paths: hand them back as plain files, so the app's own
        // loaders and transforms apply to them.
        build.onResolve({ filter: /.*/, namespace: NAMESPACE }, (args) => ({ path: args.path }));
        build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
          const spec = JSON.parse(args.path) as RequireContextSpec;
          return {
            contents: await requireContextSource(spec),
            loader: "js",
            resolveDir: spec.dir,
            watchDirs: [spec.dir],
          };
        });
      },
    },
  ];
}
