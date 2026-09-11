// Build bundle-size report (2.0 Pillar VI, observability): make the "0 KB by default /
// small bundles" story visible on every build.

import { join } from "@std/path";

/** A built client chunk and its byte size. */
export interface BundleChunk {
  name: string;
  /** Raw (uncompressed) size. */
  bytes: number;
  /** Gzipped size (the `.gz` sibling), when precompression ran. */
  gzip?: number;
}

/**
 * Read the emitted `.js` chunks and their `.gz` sizes from a client output dir (the
 * `.denext/client` a production build wrote) — the shared source for `denext analyze`
 * and `denext doctor --report`. A missing dir reads as no chunks (a fully static app).
 *
 * @param clientDir The build's client output directory.
 * @returns One entry per emitted chunk, in directory order.
 */
export async function readClientChunks(clientDir: string): Promise<BundleChunk[]> {
  const chunks: BundleChunk[] = [];
  try {
    for await (const e of Deno.readDir(clientDir)) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const bytes = (await Deno.stat(join(clientDir, e.name))).size;
      let gzip: number | undefined;
      try {
        gzip = (await Deno.stat(join(clientDir, e.name + ".gz"))).size;
      } catch { /* below the precompress floor — no .gz sibling */ }
      chunks.push({ name: e.name, bytes, gzip });
    }
  } catch { /* no client dir → fully static (0 KB JS) */ }
  return chunks;
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

/** Raw + gzip totals for a chunk set, plus the ranking total (gzip when any, else raw). */
function chunkTotals(chunks: BundleChunk[]): { raw: number; gz: number; ranked: number } {
  const raw = chunks.reduce((s, c) => s + c.bytes, 0);
  const gz = chunks.reduce((s, c) => s + (c.gzip ?? 0), 0);
  return { raw, gz, ranked: gz > 0 ? gz : raw };
}

/**
 * The slice of an esbuild metafile the markdown report reads: per-output `inputs` with the
 * bytes each contributes, so a chunk can be attributed to the modules that dominate it.
 * Only present on the esbuild (compat/SPA) path — the native `deno bundle` path emits none.
 */
export interface BundleMetafile {
  outputs: Record<string, { inputs?: Record<string, { bytesInOutput: number }> }>;
}

/** The metafile `outputs` entry whose file basename matches `chunkName`, or undefined. */
function outputForChunk(
  metafile: BundleMetafile,
  chunkName: string,
): { inputs?: Record<string, { bytesInOutput: number }> } | undefined {
  for (const [path, out] of Object.entries(metafile.outputs)) {
    if (path.split("/").pop() === chunkName) return out;
  }
  return undefined;
}

/** A readable label for a bundled input path (drop everything up to the last `node_modules/`). */
function inputLabel(path: string): string {
  const i = path.lastIndexOf("node_modules/");
  return i >= 0 ? path.slice(i + "node_modules/".length) : path;
}

/** The top `n` modules (by bytes contributed) of one chunk, as `label — size` lines. */
function topModules(
  out: { inputs?: Record<string, { bytesInOutput: number }> },
  n: number,
): string[] {
  return Object.entries(out.inputs ?? {})
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, n)
    .map(([path, m]) => `- \`${inputLabel(path)}\` — ${kb(m.bytesInOutput)}`);
}

/**
 * A markdown bundle report for `denext analyze --md` (Bun 1.4's `--metafile-md`): a per-chunk
 * size table + per-role subtotals (both bundler paths), and — when an esbuild `metafile` is
 * given (the compat/SPA path) — a per-chunk breakdown of the modules that dominate each chunk.
 *
 * @param chunks The emitted client chunks and their sizes.
 * @param metafile The esbuild metafile, when captured (esbuild path only).
 * @returns Markdown lines.
 */
export function bundleReportMarkdown(chunks: BundleChunk[], metafile?: BundleMetafile): string[] {
  if (chunks.length === 0) {
    return ["# Bundle report", "", "This app ships **0 KB** of client JavaScript. 🎉"];
  }
  const { raw, gz, ranked } = chunkTotals(chunks);
  const sorted = [...chunks].sort((a, b) => chunkMetric(b) - chunkMetric(a));
  const lines = [
    "# Bundle report",
    "",
    `**Client JS:** ${kb(raw)} raw${gz > 0 ? ` · ${kb(gz)} gz` : ""} across ` +
    `${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`,
    "",
    ...mdChunkTable(sorted, ranked),
  ];
  const roleLines = bundleRoleLines(chunks);
  // Reuse the terminal role subtotals verbatim, inside a fenced block (already aligned).
  if (roleLines.length > 0) lines.push("", "## By role", "", "```", ...roleLines, "```");
  if (metafile) lines.push(...mdTopModules(sorted, metafile));
  return lines;
}

/** The per-chunk markdown table (chunks pre-sorted largest-first; `ranked` is the % basis). */
function mdChunkTable(sorted: BundleChunk[], ranked: number): string[] {
  const lines = [
    "## Chunks",
    "",
    "| Chunk | Role | Raw | Gzip | % |",
    "| --- | --- | --: | --: | --: |",
  ];
  for (const c of sorted) {
    const share = ranked > 0 ? (chunkMetric(c) / ranked) * 100 : 0;
    const gz = c.gzip !== undefined ? kb(c.gzip) : "—";
    const role = ROLE_LABEL[classifyChunk(c.name)];
    lines.push(`| \`${c.name}\` | ${role} | ${kb(c.bytes)} | ${gz} | ${share.toFixed(1)}% |`);
  }
  return lines;
}

/** The per-chunk "top modules" markdown sections, or empty when no chunk maps to metafile inputs. */
function mdTopModules(sorted: BundleChunk[], metafile: BundleMetafile): string[] {
  const lines = ["", "## Top modules per chunk", ""];
  let any = false;
  for (const c of sorted) {
    const out = outputForChunk(metafile, c.name);
    const mods = out ? topModules(out, 8) : [];
    if (mods.length === 0) continue;
    lines.push(`### \`${c.name}\``, "", ...mods, "");
    any = true;
  }
  return any ? lines : [];
}

/**
 * The role a client chunk plays, inferred from its emitted name. `chunk-*` is the
 * shared runtime (the code-split common graph every interactive route imports —
 * the piece the bundle-size budgets track); `island-*` is a lazily-hydrated island
 * chunk; everything else (route/flight entries) is an app entry.
 */
export type ChunkRole = "shared" | "island" | "entry";

/** Classify a chunk by its content-hashed name prefix. */
export function classifyChunk(name: string): ChunkRole {
  if (name.startsWith("chunk-")) return "shared";
  if (name.startsWith("island-")) return "island";
  return "entry";
}

const ROLE_LABEL: Record<ChunkRole, string> = {
  shared: "shared runtime",
  entry: "route entries",
  island: "islands",
};

/**
 * A per-role subtotal breakdown (shared runtime vs route entries vs islands) — the
 * shared-runtime line is the number the bundle-size budgets track across the
 * minimization work, which the flat per-chunk table above doesn't isolate. Sums
 * gzip from the `.gz` siblings the way {@linkcode bundleAnalysisLines} does.
 *
 * @param chunks The emitted client chunks and their sizes.
 * @returns Section lines (already indented for the body), or empty for a 0-JS app.
 */
export function bundleRoleLines(chunks: BundleChunk[]): string[] {
  if (chunks.length === 0) return [];
  const order: ChunkRole[] = ["shared", "entry", "island"];
  const lines = ["By role:"];
  for (const role of order) {
    const group = chunks.filter((c) => classifyChunk(c.name) === role);
    if (group.length === 0) continue;
    const raw = group.reduce((s, c) => s + c.bytes, 0);
    const gz = group.reduce((s, c) => s + (c.gzip ?? 0), 0);
    const size = gz > 0 ? `${kb(raw)} raw · ${kb(gz)} gz` : kb(raw);
    const n = `${group.length} chunk${group.length === 1 ? "" : "s"}`;
    lines.push(`  ${ROLE_LABEL[role].padEnd(16)}${size}  (${n})`);
  }
  return lines;
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
  const { raw: totalRaw, gz: totalGz, ranked: total } = chunkTotals(chunks);
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
