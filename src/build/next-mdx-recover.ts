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

/** An app-context dynamic import (`(specifier) => import(specifier)`), exported by the probe. */
type AppImport = (specifier: string) => Promise<Record<string, unknown>>;

/** Extract the plugin function from a resolved plugin module (default, interop-default, or self). */
function pickPluginFn(mod: unknown): ((...a: unknown[]) => unknown) | null {
  if (typeof mod === "function") return mod as (...a: unknown[]) => unknown;
  const m = mod as { default?: unknown } | null;
  if (m && typeof m.default === "function") return m.default as (...a: unknown[]) => unknown;
  // CJS/ESM interop: `default` may itself be `{ default: fn }`.
  const d = (m?.default ?? null) as { default?: unknown } | null;
  if (d && typeof d.default === "function") return d.default as (...a: unknown[]) => unknown;
  return null;
}

/**
 * Normalize one unified plugin list. `@next/mdx`/webpack accept a plugin as a STRING
 * specifier (or `[specifier, options]`) and resolve it from node_modules — but MDX's
 * `compile` needs the actual function. So resolve each string entry via `appImport` (an
 * import rooted in the APP, where the plugin package is installed); non-string entries
 * (already functions or `[fn, options]`) pass through. An unresolvable string is dropped
 * with a warning rather than left to crash `compile`.
 */
async function resolvePluginList(list: unknown[], appImport: AppImport): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const entry of list) {
    const spec = typeof entry === "string"
      ? entry
      : (Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] as string : null);
    if (spec === null) {
      out.push(entry); // already a function or [fn, options]
      continue;
    }
    let fn: ((...a: unknown[]) => unknown) | null = null;
    try {
      fn = pickPluginFn(await appImport(spec));
    } catch { /* resolution failed → warn + drop below */ }
    if (!fn) {
      console.warn(
        `denext: MDX plugin "${spec}" from next.config could not be resolved from the app; ` +
          `skipping it.`,
      );
      continue;
    }
    out.push(Array.isArray(entry) ? [fn, ...entry.slice(1)] : fn);
  }
  return out;
}

/** Build {@link MdxBuildOptions} from captured `@next/mdx` options, resolving string plugins. */
async function pickMdxOptions(
  o: Record<string, unknown>,
  appImport: AppImport,
): Promise<MdxBuildOptions | undefined> {
  const out: MdxBuildOptions = {};
  for (const key of ["remarkPlugins", "rehypePlugins", "recmaPlugins"] as const) {
    if (Array.isArray(o[key])) {
      const resolved = await resolvePluginList(o[key] as unknown[], appImport);
      if (resolved.length > 0) out[key] = resolved;
    }
  }
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
  const config = await readNextConfigSource(baseUrl, relPath);
  if (!config) return undefined;
  // Point every `"@next/mdx"` specifier at THIS module (default = the capturing createMDX).
  // Only the module string is rewritten, so the config's own local import name is preserved
  // and all its OTHER imports (the plugin packages, local files) are untouched. Append an
  // app-context importer so string plugin specifiers (`"remark-codehike"`) resolve from the
  // APP's node_modules — the probe lives in the app dir, so its `import()` uses the app map.
  const swapped = config.source.replace(/(["'])@next\/mdx\1/g, JSON.stringify(import.meta.url));
  if (swapped === config.source) return undefined; // no @next/mdx import to capture through
  const rewritten = swapped + `\nexport const __denextImport = (s) => import(s);\n`;
  const appImport = await runProbe(config.url, rewritten, relPath);
  if (!appImport) return undefined;
  const opts = captured[0];
  if (!opts) {
    console.warn(
      `denext: ${relPath} imports @next/mdx but no createMDX(options) call was captured; ` +
        `building with baseline MDX.`,
    );
    return undefined;
  }
  return await pickMdxOptions(opts, appImport);
}

/**
 * The app's `next.config` URL + source, or null when it can't be read or wires no MDX
 * plugins — a plain `@next/mdx` (or none) needs no recovery (the baseline loader handles
 * it), and running an unrelated config is waste.
 */
async function readNextConfigSource(
  baseUrl: string,
  relPath: string,
): Promise<{ url: URL; source: string } | null> {
  let url: URL;
  try {
    url = new URL(relPath, baseUrl);
  } catch {
    return null;
  }
  let source: string;
  try {
    source = await Deno.readTextFile(url);
  } catch {
    return null; // no readable next.config
  }
  if (!/@next\/mdx|createMDX|(?:remark|rehype|recma)Plugins/.test(source)) return null;
  return { url, source };
}

/**
 * Write the rewritten config beside the original (same extension, so Deno picks the right
 * loader; same dir, so the config's relative + bare plugin imports resolve identically) and
 * import it. Importing runs the config top-to-bottom: `createMDX(opts)` (captured) and the
 * passthrough `withMDX(nextConfig)`. The probe filename is UUID-unique, so each import is a
 * fresh module URL (no stale module cache) without a query-string cache-buster — a `file:`
 * URL query would break Deno's on-disk lookup. Returns the app-context importer, or null
 * (with a warning) when the config can't be run.
 */
async function runProbe(
  nextConfigUrl: URL,
  rewritten: string,
  relPath: string,
): Promise<AppImport | null> {
  const dir = new URL(".", nextConfigUrl);
  const ext = (nextConfigUrl.pathname.match(/\.[^./]+$/)?.[0]) ?? ".mjs";
  const probeUrl = new URL(`./.denext-mdx-probe-${crypto.randomUUID()}${ext}`, dir);
  captured.length = 0;
  try {
    await Deno.writeTextFile(probeUrl, rewritten);
    const probe = await import(probeUrl.href) as { __denextImport: AppImport };
    return probe.__denextImport;
  } catch (err) {
    console.warn(
      `denext: could not recover MDX plugins from ${relPath} (${
        err instanceof Error ? err.message : String(err)
      }); building with baseline MDX.`,
    );
    return null;
  } finally {
    await Deno.remove(probeUrl).catch(() => {});
  }
}
