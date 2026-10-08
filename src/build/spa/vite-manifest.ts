// SPA mode: `spa.viteManifest` — a Vite-shaped `.vite/manifest.json` over the export's
// content-hashed client files.
//
// A server written for a Vite build (T3 Code's `apps/server` is one) reads
// `<static root>/.vite/manifest.json` to learn which files are content-hashed and so safe to
// serve as `immutable`: it collects every entry's `file`, `css` and `assets`. Vite keys its
// manifest by source path; a denext export knows output files, not the source each came from,
// so each entry here is keyed by its output path and names itself as `file`. Only files whose
// name carries a content hash are listed: the entry (`index.js`) and stylesheet (`index.css`)
// keep their names across builds, so listing them would let such a server cache a stale entry
// for a year. With `spa.assetsDir: "assets"` the files are `assets/<name>-<HASH>.<ext>`, the
// paths such a server expects (T3 Code's admits `^assets/.+-[\w-]{8}\.[^/]+$`).

import { walk } from "@std/fs";
import { join, relative, SEPARATOR } from "@std/path";
import { isContentHashed } from "../../server/serve-utils.ts";
import { CLIENT_PREFIX } from "./shared.ts";

/** One manifest entry, in Vite's `ManifestChunk` shape (the fields a denext export can fill). */
export interface ViteManifestChunk {
  /** The output file, relative to the export root (`_denext/client/chunk-AB12CD34.js`). */
  file: string;
  /** Stylesheets the chunk loads (Vite's field; a denext export has none per chunk). */
  css?: string[];
  /** Other assets the chunk references (Vite's field; a denext export has none per chunk). */
  assets?: string[];
}

/** `.vite/manifest.json`'s content: output path → chunk. */
export type ViteManifest = Record<string, ViteManifestChunk>;

/**
 * The manifest for the client files under `<exportRoot>/_denext/client/` (or the `spa.assetsDir`
 * prefix): every content-hashed file except precompressed `.gz` siblings and source maps, sorted
 * by path.
 *
 * @param exportRoot The export directory (or its staging dir).
 * @param clientPrefix The client's URL prefix (`/_denext/client/`, `/assets/`).
 */
export async function collectViteManifest(
  exportRoot: string,
  clientPrefix: string = CLIENT_PREFIX,
): Promise<ViteManifest> {
  const prefix = clientPrefix.slice(1); // "_denext/client/"
  const clientDir = join(exportRoot, ...prefix.split("/").filter(Boolean));
  const files: string[] = [];
  try {
    for await (const e of walk(clientDir, { includeDirs: false })) {
      const rel = relative(clientDir, e.path).split(SEPARATOR).join("/");
      if (rel.endsWith(".gz") || rel.endsWith(".map") || !isContentHashed(rel)) continue;
      files.push(prefix + rel);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  files.sort();
  const manifest: ViteManifest = {};
  for (const file of files) manifest[file] = { file };
  return manifest;
}

/**
 * Write `manifest` (see {@linkcode collectViteManifest}) to `<exportRoot>/.vite/manifest.json`.
 *
 * @param exportRoot The export directory (or its staging dir).
 * @param manifest The manifest to write.
 * @returns How many files the manifest lists.
 */
export async function writeViteManifest(
  exportRoot: string,
  manifest: ViteManifest,
): Promise<number> {
  await Deno.mkdir(join(exportRoot, ".vite"), { recursive: true });
  await Deno.writeTextFile(
    join(exportRoot, ".vite", "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return Object.keys(manifest).length;
}
