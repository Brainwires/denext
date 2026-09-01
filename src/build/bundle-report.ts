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

/** The metric a chunk is ranked/sized by: gzip when available, else raw bytes. */
function chunkMetric(c: BundleChunk): number {
  return c.gzip ?? c.bytes;
}

/**
 * A detailed per-chunk breakdown for `denext analyze` — every chunk sorted largest-first
 * with a proportion bar and its share of the total (a terminal stand-in for a treemap),
 * plus the raw/gz totals. Ranks by gzip (over-the-wire) size when precompression ran.
 *
 * @param chunks The emitted client chunks and their sizes.
 * @param barWidth Bar width in characters (default 24).
 * @returns Lines to print (already indented for the section body).
 */
export function bundleAnalysisLines(chunks: BundleChunk[], barWidth = 24): string[] {
  if (chunks.length === 0) {
    return ["No client chunks — this app ships 0 KB of JavaScript. 🎉"];
  }
  const totalRaw = chunks.reduce((s, c) => s + c.bytes, 0);
  const totalGz = chunks.reduce((s, c) => s + (c.gzip ?? 0), 0);
  const total = totalGz > 0 ? totalGz : totalRaw;
  const sorted = [...chunks].sort((a, b) => chunkMetric(b) - chunkMetric(a));
  const max = chunkMetric(sorted[0]) || 1;
  const nameW = Math.min(44, Math.max(...sorted.map((c) => c.name.length)));

  const lines = [
    `Client JS: ${kb(totalRaw)} raw · ${kb(totalGz)} gz across ${chunks.length} chunk(s)`,
    "",
  ];
  for (const c of sorted) {
    const metric = chunkMetric(c);
    const filled = Math.max(1, Math.round((metric / max) * barWidth));
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled));
    const share = total > 0 ? (metric / total) * 100 : 0;
    const size = c.gzip !== undefined ? `${kb(c.bytes)} · ${kb(c.gzip)} gz` : kb(c.bytes);
    lines.push(`${c.name.padEnd(nameW)}  ${bar}  ${share.toFixed(1).padStart(5)}%  ${size}`);
  }
  return lines;
}
