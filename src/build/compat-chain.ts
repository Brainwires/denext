// denext's own source transforms over a module a caller plugin answered, for the next-compat
// bundles.
//
// esbuild honours only the first `onLoad` that answers a module. A caller plugin (a router
// plugin's compiler, such as TanStack Start's) sits ahead of denext's own plugins, so a module it
// rewrites would skip the transforms denext applies to every other app module: the `"use cache"`
// transform on the server (`cacheComponents`) and the `platform` fold (denext/platform). This
// wraps the caller's plugins so each module they answer goes through those transforms after
// them, the order a module the caller leaves alone sees: the caller's compiler first, denext's
// transforms on its output.

import type * as esbuild from "./esbuild/mod.ts";
import { isAbsolute, relative, toFileUrl } from "@std/path";
import { foldBuildConstants, PLATFORM_SPECIFIER } from "./feature-transform.ts";
import { wrapOnLoad } from "./onload-wrap.ts";
import { inNodeModules } from "./path-segments.ts";
import type { Platform } from "./platform-extensions.ts";
import { transformUseCache } from "./use-cache-transform.ts";
import {
  findInlineServerActions,
  inlineServerActionError,
  transformInlineServerActions,
} from "./inline-server-action.ts";

/** Rewrite one app module's source; `null` leaves it as it is. */
export type SourceTransform = (code: string, path: string) => Promise<string | null>;

/** The JS/TS modules the transforms apply to. */
const SOURCE_MODULE = /\.(?:[cm]?[jt]sx?)$/;

/** What {@link compatSourceTransform} applies. */
export interface CompatTransformOptions {
  /** Apply the `"use cache"` transform (the server bundle, with `cacheComponents` on). */
  useCache?: boolean;
  /** Hoist inline `"use server"` functions to server references (the server bundle). */
  inlineActions?: boolean;
  /**
   * Refuse a module holding an inline `"use server"` function (a client bundle): Next.js's
   * build error, so the function's body never ships.
   */
  refuseInlineActions?: boolean;
  /** Fold `platform` to this target in the project's own modules. */
  platform?: Platform;
  /** The project root: only modules under it are folded. */
  projectDir?: string;
}

/**
 * The transforms denext applies to an app module after a caller plugin answered it, or `null`
 * when none is on: the `platform` fold, then `"use cache"`, then the inline `"use server"` check
 * (refused in a client bundle, hoisted in the server one; each skips a module without its marker
 * before parsing).
 *
 * @param options Which transforms the bundle runs.
 */
export function compatSourceTransform(options: CompatTransformOptions): SourceTransform | null {
  const { useCache, inlineActions, refuseInlineActions, platform, projectDir } = options;
  const fold = platform && projectDir ? platform : undefined;
  if (!useCache && !inlineActions && !refuseInlineActions && !fold) return null;
  return async (code, path) => {
    let out = code;
    if (fold && out.includes(PLATFORM_SPECIFIER) && isInside(path, projectDir!)) {
      const folded = await foldBuildConstants(out, { platform: fold });
      if (folded.changed) out = folded.code;
    }
    if (useCache && out.includes("use cache")) {
      const cached = await transformUseCache(out, toFileUrl(path).href);
      if (cached.changed) out = cached.code;
    }
    if (refuseInlineActions && out.includes("use server")) {
      await refuseInline(out, path, projectDir);
    }
    if (inlineActions && out.includes("use server")) {
      const hoisted = await transformInlineServerActions(out, toFileUrl(path).href);
      if (hoisted.changed) out = hoisted.code;
    }
    return out === code ? null : out;
  };
}

/** Throw Next's build error when `code` (the module at `path`) holds an inline action. */
async function refuseInline(code: string, path: string, projectDir?: string): Promise<void> {
  const at = await findInlineServerActions(code);
  if (at.length === 0) return;
  const shown = projectDir && isInside(path, projectDir) ? relative(projectDir, path) : path;
  throw new Error(inlineServerActionError(new Map([[shown, at]])));
}

/**
 * Whether `path` lies under `dir`, by `relative` rather than a string prefix: on Windows either
 * may be spelled with `/` or a backslash (a drive-less `/p` resolves against the current drive), and
 * a prefix test with the host separator misses the other spelling.
 */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}

/**
 * `plugins` with every `onLoad` result they give for one of the app's own JS/TS modules (the
 * `file` namespace, outside `node_modules`) passed through `transform`. `plugins` itself when
 * there is no transform.
 *
 * @param plugins The caller's plugins, in precedence order.
 * @param transform What denext applies after them (see {@link compatSourceTransform}).
 */
export function chainSourceTransforms(
  plugins: esbuild.Plugin[],
  transform: SourceTransform | null,
): esbuild.Plugin[] {
  if (!transform || plugins.length === 0) return plugins;
  return wrapOnLoad(plugins, (result, args) => chained(result, args, transform));
}

async function chained(
  result: esbuild.OnLoadResult | null | undefined,
  args: esbuild.OnLoadArgs,
  transform: SourceTransform,
): Promise<esbuild.OnLoadResult | null | undefined> {
  if (!result || result.contents === undefined) return result;
  if (args.namespace !== "file" || inNodeModules(args.path) || !SOURCE_MODULE.test(args.path)) {
    return result;
  }
  const code = typeof result.contents === "string"
    ? result.contents
    : new TextDecoder().decode(result.contents);
  const out = await transform(code, args.path);
  return out === null ? result : { ...result, contents: out };
}
