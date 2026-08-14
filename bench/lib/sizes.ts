// Byte-accounting helpers for Layer 1 (bytes over the wire).
//
// "Over the wire" means gzip-compressed transfer size, since every production
// HTTP server ships JS gzipped (or brotli). We gzip each file ourselves rather
// than trust any framework's printed build summary, so both sides are measured
// by the exact same yardstick.

// gzip via the platform-native CompressionStream — no third-party dependency,
// the same algorithm a production server applies on the wire.
async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** gzip a byte buffer and return the compressed length. */
export async function gzipSize(bytes: Uint8Array): Promise<number> {
  return (await gzipBytes(bytes)).length;
}

export interface FileSize {
  file: string;
  raw: number;
  gzip: number;
}

/** gzip a single file on disk. */
export async function measureFile(
  path: string,
  label?: string,
): Promise<FileSize> {
  const bytes = await Deno.readFile(path);
  return {
    file: label ?? path,
    raw: bytes.length,
    gzip: await gzipSize(bytes),
  };
}

export interface SizeTotal {
  files: FileSize[];
  rawTotal: number;
  gzipTotal: number;
}

/** Sum raw + gzip over a set of files (each gzipped individually, as served). */
export async function measureFiles(
  paths: Array<{ path: string; label: string }>,
): Promise<SizeTotal> {
  const files: FileSize[] = [];
  for (const p of paths) {
    files.push(await measureFile(p.path, p.label));
  }
  return {
    files,
    rawTotal: files.reduce((n, f) => n + f.raw, 0),
    gzipTotal: files.reduce((n, f) => n + f.gzip, 0),
  };
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
