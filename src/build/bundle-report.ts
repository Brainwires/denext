// Build bundle-size report (2.0 Pillar VI, observability): make the "0 KB by default /
// small bundles" story visible on every build.

/** A built client chunk and its byte size. */
export interface BundleChunk {
  name: string;
  /** Raw (uncompressed) size. */
  bytes: number;
  /** Gzipped size (the `.gz` sibling), when precompression ran. */
  gzip?: number;
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/**
 * Human-readable bundle summary lines: total routes, how many ship 0 KB JS, the total
 * client JS, and the largest few chunks.
 *
 * @param totalRoutes Total page routes in the app.
 * @param zeroJsRoutes How many of them ship no client JavaScript.
 * @param chunks The emitted client chunks and their sizes.
 * @returns Lines to print (the first is the summary; the rest are the biggest chunks).
 */
export function bundleSummaryLines(
  totalRoutes: number,
  zeroJsRoutes: number,
  chunks: BundleChunk[],
): string[] {
  const total = chunks.reduce((s, c) => s + c.bytes, 0);
  const gz = chunks.reduce((s, c) => s + (c.gzip ?? 0), 0);
  // Show gzip alongside raw so the raw figure isn't mistaken for over-the-wire size.
  const size = gz > 0 ? `${kb(total)} raw · ${kb(gz)} gz` : kb(total);
  const lines = [
    `bundle: ${totalRoutes} route(s), ${zeroJsRoutes} ship 0 KB JS · ` +
    `client JS ${size} in ${chunks.length} chunk(s)`,
  ];
  for (const c of [...chunks].sort((a, b) => b.bytes - a.bytes).slice(0, 3)) {
    lines.push(`  ${c.name} — ${kb(c.bytes)}`);
  }
  return lines;
}
