// `denext build`'s half of the server copies (./server-copies.ts): compile them and describe them
// for `manifest.json`. Build-only: the production server reads the record, never this module.

import { fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import { resolveCacheComponents } from "../server/config.ts";
import type { ProjectPaths } from "./paths.ts";
import { createPlatformScanner } from "./platform-extensions.ts";
import { compileServerCopies } from "./use-cache-loader.ts";
import { inlineServerActionModules } from "./inline-server-action.ts";
import type { ServerCopiesManifest } from "./server-copies.ts";

/** Where the build writes the copies, under the out dir. */
const COPIES_DIR = "server-copies";

/** `url` (a file URL under `base`) as a `/`-separated relative path, or null. */
function relativeTo(base: string, url: string): string | null {
  if (!url.startsWith("file:")) return null;
  const rel = relative(base, fromFileUrl(url)).replaceAll("\\", "/");
  return rel.startsWith("..") ? null : rel;
}

/** The file-URL entries of the build's CSS import map (stylesheet → its JS shim). */
function cssRedirects(cssImportMap: Readonly<Record<string, string>> | undefined) {
  return Object.fromEntries(
    Object.entries(cssImportMap ?? {}).filter(([from, to]) =>
      from.startsWith("file:") && to.startsWith("file:")
    ),
  );
}

/**
 * Compile the server copies of a native App Router build (the web target's platform files,
 * `"use cache"` when Cache Components are on, inline `"use server"` functions as registered
 * server references, and every stylesheet import pointed at its shim)
 * into `<outDir>/server-copies/`, and describe them for `manifest.json`. Null for a next-compat
 * build, whose server bundles carry the first two.
 *
 * @param paths The project paths.
 * @param compat Whether the build is next-compat.
 * @param cssImportMap The build's CSS import map (`AppCss.importMap`: stylesheet file URL → its
 *   shim's), or undefined when the app has no stylesheet.
 */
export async function buildServerCopies(
  paths: ProjectPaths,
  compat: boolean,
  cssImportMap?: Readonly<Record<string, string>>,
): Promise<ServerCopiesManifest | null> {
  if (compat) return null;
  const projectDir = resolve(paths.projectDir);
  const cacheDir = join(paths.outDir, COPIES_DIR);
  await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  const scanner = createPlatformScanner(projectDir);
  const redirects = await scanner.redirects(paths.config, "web");
  const css = cssRedirects(cssImportMap);
  const hasCss = Object.keys(css).length > 0;
  const useCache = resolveCacheComponents(paths.config);
  const manifest = {
    root: toFileUrl(projectDir).href,
    redirects: {},
    copies: {},
    css: hasCss,
    relocatable: true,
  };
  const files = await scanner.files();
  const inline = await inlineServerActionModules(files);
  if (!useCache && !hasCss && inline.length === 0 && Object.keys(redirects).length === 0) {
    return manifest;
  }
  // Only the platform redirects are recorded: the server loads a module, never a stylesheet, as
  // an entry, so the CSS ones live in the copies alone.
  for (const [from, to] of Object.entries(redirects)) {
    const a = relativeTo(projectDir, from);
    const b = relativeTo(projectDir, to);
    if (a !== null && b !== null) (manifest.redirects as Record<string, string>)[a] = b;
  }
  const copies = await compileServerCopies(
    { projectDir, cacheDir, redirects: { ...css, ...redirects }, useCache, relocatable: true },
    files,
  );
  for (const [from, to] of Object.entries(copies)) {
    const a = relativeTo(projectDir, from);
    const b = relativeTo(resolve(paths.outDir), to);
    if (a !== null && b !== null) (manifest.copies as Record<string, string>)[a] = b;
  }
  return manifest;
}
