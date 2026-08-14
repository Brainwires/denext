// Build-time asset precompression: write a gzipped `.gz` sibling next to each
// compressible client asset, so the production server can serve it with
// `Content-Encoding: gzip` at **zero per-request CPU** — immutable build output
// is compressed exactly once, here. Uses the platform-native CompressionStream,
// so no dependency is added (denext stays zero-dep).

import { extname, join } from "@std/path";

/** Extensions worth compressing (already-compressed formats gain nothing). */
const COMPRESSIBLE = new Set([".js", ".css", ".svg", ".json", ".map", ".txt", ".ico"]);
// Below this, gzip's framing overhead can exceed the savings; not worth a sibling.
const MIN_SIZE = 512;

/** gzip a byte buffer via the native CompressionStream. */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Recursively write a `<file>.gz` gzip sibling for every compressible file in
 * `dir` above the size floor. Skips files whose gzip isn't actually smaller (the
 * server then falls back to serving the identity file). Returns the count written.
 */
export async function precompressDir(dir: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      count += await precompressDir(full);
      continue;
    }
    if (!entry.isFile || entry.name.endsWith(".gz")) continue;
    if (!COMPRESSIBLE.has(extname(entry.name))) continue;
    try {
      const bytes = await Deno.readFile(full);
      if (bytes.length < MIN_SIZE) continue;
      const gz = await gzipBytes(bytes);
      if (gz.length >= bytes.length) continue; // no win — leave it identity-only
      await Deno.writeFile(`${full}.gz`, gz);
      count++;
    } catch {
      // A file that can't be read/written (e.g. it vanished mid-walk) is simply
      // left uncompressed — the server falls back to serving it as identity.
      continue;
    }
  }
  return count;
}
