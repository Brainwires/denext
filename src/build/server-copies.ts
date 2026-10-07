// The production server render's module copies, made at build time.
//
// A native App Router app's server render loads some modules through copies: the web target's
// platform files (`BigButton.web.tsx`, applied by rewriting the importers) and Cache Components'
// `"use cache"` compile (./use-cache-loader.ts). `denext build` writes those copies under
// `<outDir>/server-copies/` and records them, with the redirects, in `manifest.json`
// ({@linkcode ServerCopiesManifest}), so `denext start` walks nothing and writes nothing: it
// serves the same files the build's client bundles resolved, on a read-only filesystem too.

import { fromFileUrl, join, relative, resolve, toFileUrl } from "@std/path";
import { resolveCacheComponents } from "../server/config.ts";
import type { ModuleLoader } from "../server/types.ts";
import type { ProjectPaths } from "./paths.ts";
import { createPlatformScanner } from "./platform-extensions.ts";
import { compileServerCopies, createPrecompiledLoader } from "./use-cache-loader.ts";

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

/**
 * Compile the server copies of a native App Router build (the web target's platform files,
 * and `"use cache"` when Cache Components are on) into `<outDir>/server-copies/`, and describe
 * them for `manifest.json`. Null for a next-compat build, whose server bundles carry both.
 *
 * @param paths The project paths.
 * @param compat Whether the build is next-compat.
 */
export async function buildServerCopies(
  paths: ProjectPaths,
  compat: boolean,
): Promise<ServerCopiesManifest | null> {
  if (compat) return null;
  const projectDir = resolve(paths.projectDir);
  const cacheDir = join(paths.outDir, COPIES_DIR);
  await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  const scanner = createPlatformScanner(projectDir);
  const redirects = await scanner.redirects(paths.config, "web");
  const useCache = resolveCacheComponents(paths.config);
  const manifest = { root: toFileUrl(projectDir).href, redirects: {}, copies: {} };
  if (!useCache && Object.keys(redirects).length === 0) return manifest;
  for (const [from, to] of Object.entries(redirects)) {
    const a = relativeTo(projectDir, from);
    const b = relativeTo(projectDir, to);
    if (a !== null && b !== null) (manifest.redirects as Record<string, string>)[a] = b;
  }
  const copies = await compileServerCopies(
    { projectDir, cacheDir, redirects, useCache },
    await scanner.files(),
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
  return { root: v.root, redirects: v.redirects, copies: v.copies };
}

/**
 * The production server's loader over the build's copies, or null when the build recorded none
 * or the project moved since (the copies import its modules by absolute path): the caller then
 * compiles at startup, as for an older build.
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
  if (!recorded || recorded.root !== toFileUrl(projectDir).href) return null;
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
