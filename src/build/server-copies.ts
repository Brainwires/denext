// The production server render's module copies, made at build time.
//
// A native App Router app's server render loads some modules through copies: the web target's
// platform files (`BigButton.web.tsx`, applied by rewriting the importers), Cache Components'
// `"use cache"` compile and inline `"use server"` functions (./use-cache-loader.ts). `denext build` writes those copies under
// `<outDir>/server-copies/` and records them, with the redirects, in `manifest.json`
// ({@linkcode ServerCopiesManifest}), so `denext start` walks nothing and writes nothing: it
// serves the same files the build's client bundles resolved, on a read-only filesystem too.
//
// The same copies carry the app's stylesheet imports: Deno cannot import a `.css` file, so dev and
// build run under an import map sending each one to its JS shim (the CLI's CSS re-exec). Every
// module that reaches a stylesheet is copied with that import pointed at the shim instead, so
// `denext start` needs no import map, no re-exec and no `--allow-run`
// ({@linkcode buildServesCss}).

import { fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import { resolveCacheComponents } from "../server/config.ts";
import type { ModuleLoader } from "../server/types.ts";
import type { ProjectPaths } from "./paths.ts";
import { createPlatformScanner } from "./platform-extensions.ts";
import { compileServerCopies, createPrecompiledLoader } from "./use-cache-loader.ts";
import { inlineServerActionModules } from "./inline-server-action.ts";

/** Where the build writes the copies, under the out dir. */
const COPIES_DIR = "server-copies";

/** What `manifest.json` records (`serverCopies`); paths are relative, URLs use `/`. */
export interface ServerCopiesManifest {
  /** The project root the copies were compiled against (their imports are absolute). */
  readonly root: string;
  /** Module (relative to the project) → the module the web target loads instead. */
  readonly redirects: Record<string, string>;
  /** Module (relative to the project) → its copy (relative to the out dir). */
  readonly copies: Record<string, string>;
  /**
   * Whether the copies point the app's stylesheet imports at their shims. Always written by a
   * build that knows how (`false` when it found no stylesheet); absent from an older build, whose
   * server render still needs the CSS import map.
   */
  readonly css?: boolean;
  /**
   * Whether the copies are relocatable (each imports what it reaches by a relative path and pins
   * `import.meta` relative to itself), so they serve the project wherever it now is — a
   * `deno compile`d app embeds it under another root. Absent from an older build, whose copies
   * import the project's modules by absolute path.
   */
  readonly relocatable?: boolean;
}

/** `url` (a file URL under `base`) as a `/`-separated relative path, or null. */
function relativeTo(base: string, url: string): string | null {
  if (!url.startsWith("file:")) return null;
  const rel = relative(base, fromFileUrl(url)).replaceAll("\\", "/");
  return rel.startsWith("..") ? null : rel;
}

/** `rel` (from {@linkcode relativeTo}) back as a file URL under `base`. */
function urlUnder(base: string, rel: string): string {
  return toFileUrl(join(base, ...rel.split("/"))).href;
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

/** `value` as a {@linkcode ServerCopiesManifest}, or null when it is not one. */
export function parseServerCopies(value: unknown): ServerCopiesManifest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const isMap = (m: unknown): m is Record<string, string> =>
    !!m && typeof m === "object" && Object.values(m).every((x) => typeof x === "string");
  if (typeof v.root !== "string" || !isMap(v.redirects) || !isMap(v.copies)) return null;
  return {
    root: v.root,
    redirects: v.redirects,
    copies: v.copies,
    ...(typeof v.css === "boolean" ? { css: v.css } : {}),
    ...(v.relocatable === true ? { relocatable: true } : {}),
  };
}

/**
 * Whether `denext start` can serve the build in `outDir` without the CSS import map (and so
 * without the CLI's CSS re-exec, which spawns a second `deno` and needs `--allow-run`): a native
 * App Router build whose server copies point every stylesheet import at its shim, made for this
 * project where it now is (or relocatable copies, wherever it is). False for a next-compat build, a
 * SPA, an older build, no build, or a project moved since a build whose copies are not relocatable
 * (start then compiles copies without the stylesheets).
 *
 * @param projectDir The project root.
 * @param outDir The build output dir (`.denext`).
 */
export async function buildServesCss(projectDir: string, outDir: string): Promise<boolean> {
  let doc: unknown;
  try {
    doc = JSON.parse(await Deno.readTextFile(join(outDir, "manifest.json")));
  } catch {
    return false;
  }
  if (!doc || typeof doc !== "object") return false;
  const bm = doc as { nextCompat?: unknown; serverCopies?: unknown };
  if (bm.nextCompat === true) return false;
  const recorded = parseServerCopies(bm.serverCopies);
  return recorded?.css !== undefined && madeFor(recorded, projectDir);
}

/** Whether `recorded`'s copies serve the project at `projectDir`: relocatable, or made there. */
function madeFor(recorded: ServerCopiesManifest, projectDir: string): boolean {
  return recorded.relocatable === true || recorded.root === toFileUrl(resolve(projectDir)).href;
}

/**
 * The production server's loader over the build's copies, or null when the build recorded none
 * or the project moved since a build whose copies import its modules by absolute path: the caller
 * then compiles at startup, as for an older build.
 *
 * @param base The underlying loader.
 * @param paths The project paths.
 * @param recorded The manifest's `serverCopies`.
 */
export function precompiledServerLoader(
  base: ModuleLoader,
  paths: ProjectPaths,
  recorded: ServerCopiesManifest | null | undefined,
): ModuleLoader | null {
  const projectDir = resolve(paths.projectDir);
  if (!recorded || !madeFor(recorded, projectDir)) return null;
  const outDir = resolve(paths.outDir);
  const redirects: Record<string, string> = {};
  for (const [from, to] of Object.entries(recorded.redirects)) {
    redirects[urlUnder(projectDir, from)] = urlUnder(projectDir, to);
  }
  const copies: Record<string, string> = {};
  for (const [from, to] of Object.entries(recorded.copies)) {
    copies[urlUnder(projectDir, from)] = urlUnder(outDir, to);
  }
  if (Object.keys(redirects).length === 0 && Object.keys(copies).length === 0) return base;
  return createPrecompiledLoader(base, { projectDir, redirects, copies });
}
