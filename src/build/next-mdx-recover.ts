// Live recovery of `@next/mdx` plugin options for the compat build.
//
// `@next/mdx`'s `createMDX({ options })` hides its remark/rehype/recma plugin lists in a
// webpack-loader closure — they are LIVE FUNCTION REFERENCES, so migrate cannot serialize
// them into a generated config. Instead, a migrated App Router app's `denext.config.ts`
// calls {@linkcode resolveNextMdx} at build time: it runs the app's own `next.config` with
// `@next/mdx` swapped for the capturing shim below (this module's default export), so the
// real plugin functions are captured in-process and handed straight to MDX's `compile`.
// No serialization, no hand-editing — the generated config is deterministic and the plugins
// resolve from the app's own node_modules exactly as Next runs them.

import type { MdxBuildOptions } from "./next-compat.ts";

/** Options objects captured from `createMDX(...)` calls during a probe import. */
const captured: Array<Record<string, unknown>> = [];

/**
 * Drop-in for `@next/mdx`'s `createMDX`: records the plugin options and returns a
 * passthrough `withMDX` (`(nextConfig) => nextConfig`). The rewritten `next.config` imports
 * THIS as its `@next/mdx` default during a {@linkcode resolveNextMdx} probe. Exported as the
 * module default so `import createMDX from "denext/build/next-mdx"` in the rewritten config
 * binds to it.
 */
export default function createMDXCapture(
  pluginOptions: { options?: Record<string, unknown> } | undefined = {},
): (nextConfig?: unknown) => unknown {
  captured.push((pluginOptions?.options ?? pluginOptions ?? {}) as Record<string, unknown>);
  return (nextConfig: unknown = {}) => nextConfig;
}

/** The `@next/mdx` option keys denext forwards to MDX's `compile` (see {@link MdxBuildOptions}). */
function pickMdxOptions(o: Record<string, unknown>): MdxBuildOptions | undefined {
  const out: MdxBuildOptions = {};
  if (Array.isArray(o.remarkPlugins)) out.remarkPlugins = o.remarkPlugins;
  if (Array.isArray(o.rehypePlugins)) out.rehypePlugins = o.rehypePlugins;
  if (Array.isArray(o.recmaPlugins)) out.recmaPlugins = o.recmaPlugins;
  if (o.remarkRehypeOptions && typeof o.remarkRehypeOptions === "object") {
    out.remarkRehypeOptions = o.remarkRehypeOptions as Record<string, unknown>;
  }
  if (typeof o.providerImportSource === "string") out.providerImportSource = o.providerImportSource;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Recover the MDX plugin options an app configures in its `next.config` (via `@next/mdx`),
 * for use as `denext.config.ts`'s `mdx` field. Runs the app's `next.config` with `@next/mdx`
 * captured, so the live remark/rehype/recma plugin functions are returned directly — no
 * serialization. Returns `undefined` (baseline plain-MDX) when there is no MDX wiring, when
 * `next.config` can't be run, or when no plugins are configured; warns rather than throwing
 * so a build never fails on config recovery.
 *
 * @param baseUrl `import.meta.url` of the calling `denext.config.ts`.
 * @param relPath Relative path to the app's `next.config.*` (e.g. `"./next.config.mjs"`).
 */
export async function resolveNextMdx(
  baseUrl: string,
  relPath: string,
): Promise<MdxBuildOptions | undefined> {
  let nextConfigUrl: URL;
  try {
    nextConfigUrl = new URL(relPath, baseUrl);
  } catch {
    return undefined;
  }
  let source: string;
  try {
    source = await Deno.readTextFile(nextConfigUrl);
  } catch {
    return undefined; // no readable next.config
  }
  // Only probe when MDX plugins are actually wired — a plain `@next/mdx` (or none) needs
  // no recovery (the baseline loader handles it), and running an unrelated config is waste.
  if (!/@next\/mdx|createMDX|(?:remark|rehype|recma)Plugins/.test(source)) return undefined;

  // Point every `"@next/mdx"` specifier at THIS module (default = the capturing createMDX).
  // Only the module string is rewritten, so the config's own local import name is preserved
  // and all its OTHER imports (the plugin packages, local files) are untouched.
  const rewritten = source.replace(/(["'])@next\/mdx\1/g, JSON.stringify(import.meta.url));
  if (rewritten === source) return undefined; // no @next/mdx import to capture through

  // Write the rewritten config beside the original (same extension, so Deno picks the right
  // loader; same dir, so the config's relative + bare plugin imports resolve identically).
  const dir = new URL(".", nextConfigUrl);
  const ext = (nextConfigUrl.pathname.match(/\.[^./]+$/)?.[0]) ?? ".mjs";
  const probeUrl = new URL(`./.denext-mdx-probe-${crypto.randomUUID()}${ext}`, dir);

  captured.length = 0;
  try {
    await Deno.writeTextFile(probeUrl, rewritten);
    // Importing runs the config top-to-bottom: `createMDX(opts)` (captured here) and the
    // passthrough `withMDX(nextConfig)`. The probe filename is UUID-unique, so each import
    // is a fresh module URL (no stale module cache) without a query-string cache-buster —
    // a `file:` URL query would break Deno's on-disk lookup.
    await import(probeUrl.href);
  } catch (err) {
    console.warn(
      `denext: could not recover MDX plugins from ${relPath} (${
        err instanceof Error ? err.message : String(err)
      }); building with baseline MDX.`,
    );
    return undefined;
  } finally {
    await Deno.remove(probeUrl).catch(() => {});
  }

  const opts = captured[0];
  if (!opts) {
    console.warn(
      `denext: ${relPath} imports @next/mdx but no createMDX(options) call was captured; ` +
        `building with baseline MDX.`,
    );
    return undefined;
  }
  return pickMdxOptions(opts);
}
