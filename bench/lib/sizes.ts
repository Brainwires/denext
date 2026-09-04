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
