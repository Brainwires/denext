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
  /**
   * The sibling chunks it imports statically (`import … from "./x.js"`, `import "./x.js"`;
   * not `import()`), when read from disk: what tells an island-only `chunk-*` from the shared
   * runtime (see {@linkcode chunkRoles}).
   */
  imports?: string[];
  /** The sibling chunks it loads with `import("./x.js")`, when read from disk. */
  lazyImports?: string[];
}

/** A static `from "./x.js"` / `import "./x.js"` in emitted code (a dynamic `import(` has a paren). */
const STATIC_IMPORT = /\b(?:from|import)\s*["']\.\/([^"'/]+\.js)["']/g;
/** A dynamic `import("./x.js")` in emitted code. */
const DYNAMIC_IMPORT = /\bimport\(\s*["']\.\/([^"'/]+\.js)["']\s*\)/g;

/** The sibling chunks `code` imports, statically or with `import()`, in first-seen order. */
export function chunkImports(code: string): { imports: string[]; lazyImports: string[] } {
  const names = (re: RegExp) => [...new Set(Array.from(code.matchAll(re), (m) => m[1]))];
  return { imports: names(STATIC_IMPORT), lazyImports: names(DYNAMIC_IMPORT) };
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
      const code = await Deno.readTextFile(join(clientDir, e.name));
      const bytes = new TextEncoder().encode(code).length;
      let gzip: number | undefined;
      try {
        gzip = (await Deno.stat(join(clientDir, e.name + ".gz"))).size;
      } catch { /* below the precompress floor — no .gz sibling */ }
      chunks.push({ name: e.name, bytes, gzip, ...chunkImports(code) });
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
  const roles = chunkRoles(sorted);
  for (const c of sorted) {
    const share = ranked > 0 ? (chunkMetric(c) / ranked) * 100 : 0;
    const gz = c.gzip !== undefined ? kb(c.gzip) : "—";
    const role = ROLE_LABEL[roles.get(c.name)!];
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
export type ChunkRole = "shared" | "island" | "on-demand" | "entry";

/** Name prefixes of the framework's on-demand chunks (see {@linkcode classifyChunk}). */
const ON_DEMAND_PREFIXES = ["lazy-", "class-runtime-", "momentum-scroll-", "nav-document-"];

/**
 * Classify a chunk by its content-hashed name prefix. `lazy-*` (deferred island hydration),
 * `class-runtime-*` (the class-component runtime), `momentum-scroll-*` (the iOS scroll shim) and
 * `nav-document-*` (the soft-navigation commit) are the framework's on-demand chunks: fetched only by a page that needs them, so they count
 * against neither the shared runtime nor the route entries.
 */
export function classifyChunk(name: string): ChunkRole {
  if (name.startsWith("chunk-")) return "shared";
  if (name.startsWith("island-")) return "island";
  return ON_DEMAND_PREFIXES.some((p) => name.startsWith(p)) ? "on-demand" : "entry";
}

/** A content-hashed module name (`counter-V6JCWT7F.js`, a client component's own module). */
const HASHED = /-[A-Z0-9]{8}\.js$/;

/**
 * Each chunk's role, refining {@linkcode classifyChunk} with the static import graph when the
 * chunks carry their `imports` (as {@linkcode readClientChunks} reads them). A `chunk-*` no route
 * entry reaches is not shared runtime: one only islands and client components reach (an
 * `island-*`, or a content-hashed module another loads with `import()`) is an island chunk — a
 * library a few islands share, say — and one only the framework's on-demand chunks reach is
 * on-demand.
 *
 * @param chunks The emitted client chunks.
 * @returns The role of each chunk, by name.
 */
export function chunkRoles(chunks: BundleChunk[]): Map<string, ChunkRole> {
  const roles = new Map(chunks.map((c) => [c.name, classifyChunk(c.name)]));
  if (!chunks.some((c) => c.imports)) return roles;
  // Which non-chunk modules (the importers that load a chunk) reach each chunk, transitively.
  const owners = new Map<string, Set<string>>();
  const visit = (owner: string, name: string): void => {
    const seen = owners.get(name) ?? new Set<string>();
    if (seen.has(owner)) return;
    owners.set(name, seen.add(owner));
    for (const dep of byName.get(name)?.imports ?? []) {
      if (roles.get(dep) === "shared") visit(owner, dep);
    }
  };
  const byName = new Map(chunks.map((c) => [c.name, c]));
  for (const c of chunks) {
    if (roles.get(c.name) === "shared") continue;
    for (const dep of c.imports ?? []) if (roles.get(dep) === "shared") visit(c.name, dep);
  }
  const lazy = new Set(chunks.flatMap((c) => c.lazyImports ?? []));
  const ownerRole = (name: string): ChunkRole => {
    const role = roles.get(name)!;
    return role === "entry" && HASHED.test(name) && lazy.has(name) ? "island" : role;
  };
  for (const [name, from] of owners) roles.set(name, ownedRole([...from].map(ownerRole)));
  return roles;
}

/** The role of a chunk its importers of these roles reach: shared once any route entry does. */
function ownedRole(importers: ChunkRole[]): ChunkRole {
  if (importers.includes("entry")) return "shared";
  return importers.includes("island") ? "island" : "on-demand";
}

const ROLE_LABEL: Record<ChunkRole, string> = {
  shared: "shared runtime",
  entry: "route entries",
  island: "islands",
  "on-demand": "on-demand runtime",
};

/** The role column's width: the longest label plus a two-space gap before the size. */
const ROLE_COLUMN = Math.max(...Object.values(ROLE_LABEL).map((l) => l.length)) + 2;

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
  const order: ChunkRole[] = ["shared", "entry", "island", "on-demand"];
  const roles = chunkRoles(chunks);
  const lines = ["By role:"];
  for (const role of order) {
    const group = chunks.filter((c) => roles.get(c.name) === role);
    if (group.length === 0) continue;
    const raw = group.reduce((s, c) => s + c.bytes, 0);
    const gz = group.reduce((s, c) => s + (c.gzip ?? 0), 0);
    const size = gz > 0 ? `${kb(raw)} raw · ${kb(gz)} gz` : kb(raw);
    const n = `${group.length} chunk${group.length === 1 ? "" : "s"}`;
    lines.push(`  ${ROLE_LABEL[role].padEnd(ROLE_COLUMN)}${size}  (${n})`);
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
