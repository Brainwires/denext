// Compose a transform with esbuild plugins that answer a module first: esbuild honours only the
// first `onLoad` that answers, so a later transform wraps the earlier plugins' results instead of
// competing with them (the `optimizePackageImports` rewrite, the compat chain's `"use cache"` and
// `platform` fold).

import type * as esbuild from "./esbuild/mod.ts";

/**
 * `plugins` with every `onLoad` result they give passed through `post` (which may return it
 * unchanged): how a later transform composes with plugins that answer a module first.
 *
 * @param plugins The plugins to wrap, in precedence order.
 * @param post Rewrites one result.
 */
export function wrapOnLoad(
  plugins: esbuild.Plugin[],
  post: (
    result: esbuild.OnLoadResult | null | undefined,
    args: esbuild.OnLoadArgs,
  ) => Promise<esbuild.OnLoadResult | null | undefined>,
): esbuild.Plugin[] {
  return plugins.map((plugin): esbuild.Plugin => ({
    name: plugin.name,
    setup(build) {
      return plugin.setup({
        ...build,
        onLoad(opts, callback) {
          build.onLoad(opts, async (args) => post(await callback(args), args));
        },
      });
    },
  }));
}
