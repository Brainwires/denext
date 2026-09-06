// Shared esbuild resolve helper for plugins that rewrite an import path (a stripped
// `?query`) and need the REAL module resolved through the full plugin chain.

import { dirname } from "@std/path";
import type * as esbuild from "esbuild";

/**
 * Resolve `path` on behalf of `args` (an `onResolve` callback's arguments): same kind,
 * importer, namespace and resolve dir, so relative/alias/npm specifiers all work exactly as
 * if the importer had written `path` itself.
 */
export function resolveOnBehalf(
  build: esbuild.PluginBuild,
  args: esbuild.OnResolveArgs,
  path: string,
): Promise<esbuild.ResolveResult> {
  return build.resolve(path, {
    kind: args.kind,
    importer: args.importer,
    resolveDir: args.resolveDir || (args.importer ? dirname(args.importer) : ""),
    namespace: args.namespace,
  });
}
