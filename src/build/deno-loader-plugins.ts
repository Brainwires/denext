// `@luca/esbuild-deno-loader`, made to work on Windows.
//
// The loader's workspace discovery and resolver run in WASM, which sees a POSIX filesystem:
//  - a config path spelled `C:\app\deno.json` is not absolute there, so it is joined onto the
//    cwd and discovery walks the wrong directories (inside this repo it lands on the root
//    `deno.json` and fails with `WorkspaceDiscoverError(ResolveMember(NotFound … "/packages/…"))`);
//    the POSIX-absolute spelling `/C:/app/deno.json` is what maps back to `file:///C:/app/…`;
//  - a specifier that is a Windows absolute path (an esbuild entry point, or an import a plugin
//    wrote as a path) resolves with its drive letter dropped (`\Users\…`), so it is handed on
//    as the `file://` URL it names instead.
// The native loader also passes its config to `deno info --config`, which needs the real
// Windows path — so it gets that one, plus an explicit `nodeModulesDir` so it never runs the
// WASM discovery at all. On every other OS the options pass through untouched.

import {
  DEFAULT_LOADER,
  denoLoaderPlugin,
  type DenoPluginsOptions,
  denoResolverPlugin,
} from "@luca/esbuild-deno-loader";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import type * as esbuild from "esbuild";

const WINDOWS = Deno.build.os === "windows";

/** A Windows absolute path (`C:\…` or `C:/…`). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

type NodeModulesDir = NonNullable<DenoPluginsOptions["nodeModulesDir"]>;

/** A config given as a `file://` URL, as its filesystem path. */
function asPath(configPath: string): string {
  return configPath.startsWith("file:") ? fromFileUrl(configPath) : configPath;
}

/**
 * The `configPath` the loader's WASM understands. On Windows: a POSIX-absolute `/C:/…` path
 * (from a native path or a `file://` URL); elsewhere the value as given.
 *
 * @param configPath A filesystem path or `file://` URL of a deno.json.
 * @returns The spelling to hand to the loader's WASM side.
 */
function loaderConfigArg(configPath: string): string {
  if (!WINDOWS) return configPath;
  const path = asPath(configPath);
  return WINDOWS_ABSOLUTE.test(path) ? "/" + path.replaceAll("\\", "/") : path;
}

/**
 * The `nodeModulesDir` mode a config selects, as Deno reads it: the config's own field (the
 * legacy boolean included), else `manual` beside a package.json, else `none`.
 *
 * @param configPath A deno.json path.
 * @returns The mode.
 */
function configNodeModulesDir(configPath: string): NodeModulesDir {
  let field: unknown;
  try {
    const json = parseJsonc(Deno.readTextFileSync(configPath)) as Record<string, unknown> | null;
    field = json?.nodeModulesDir;
  } catch {
    field = undefined; // unreadable: decide from the directory alone
  }
  if (field === "auto" || field === "manual" || field === "none") return field;
  if (typeof field === "boolean") return field ? "auto" : "none";
  try {
    Deno.statSync(join(dirname(configPath), "package.json"));
    return "manual";
  } catch {
    return "none";
  }
}

/**
 * Re-resolve a Windows absolute-path specifier as its `file://` URL, so the deno resolver
 * sees a URL rather than a path it cannot parse. The resolver's own second pass (a bare
 * `build.resolve(path)`: no importer, no resolve dir) is left to esbuild's file resolution.
 */
function windowsPathSpecifiers(): esbuild.Plugin {
  return {
    name: "denext-windows-path-specifiers",
    setup(build) {
      build.onResolve({ filter: WINDOWS_ABSOLUTE }, (args) => {
        if (!args.importer && !args.resolveDir) return undefined;
        return build.resolve(toFileUrl(args.path).href, {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: args.pluginData,
        });
      });
    },
  };
}

/** The loader plugin's options on Windows (see the header for why they differ). */
function windowsLoaderOptions(options: DenoPluginsOptions): DenoPluginsOptions {
  if (options.configPath === undefined) return options;
  if ((options.loader ?? DEFAULT_LOADER) === "portable") {
    return { ...options, configPath: loaderConfigArg(options.configPath) };
  }
  const configPath = asPath(options.configPath);
  const nodeModulesDir = options.nodeModulesDir ?? configNodeModulesDir(configPath);
  return { ...options, configPath, nodeModulesDir };
}

/**
 * `denoPlugins(options)` with the Windows path fixes applied (identical elsewhere).
 *
 * @param options The loader options; `configPath` may be a path or a `file://` URL.
 * @returns The plugins to append to an esbuild plugin chain.
 */
export function denoLoaderPlugins(options: DenoPluginsOptions = {}): esbuild.Plugin[] {
  if (!WINDOWS) {
    return [denoResolverPlugin(options), denoLoaderPlugin(options)] as esbuild.Plugin[];
  }
  const resolverOptions = options.configPath === undefined
    ? options
    : { ...options, configPath: loaderConfigArg(options.configPath) };
  return [
    windowsPathSpecifiers(),
    denoResolverPlugin(resolverOptions),
    denoLoaderPlugin(windowsLoaderOptions(options)),
  ] as esbuild.Plugin[];
}
