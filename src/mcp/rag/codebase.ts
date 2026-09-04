// The per-project codebase index behind `denext_query_codebase` / `find_definition` /
// `find_references`. Unlike the shipped docs corpus, this is built at RUNTIME against the
// developer's own project, cached under `.denext/rag/codebase.json`, and refreshed
// incrementally by file mtime. Nothing here reads from the denext package or the network.

import { ensureDir } from "@std/fs";
import { dirname, join, resolve } from "@std/path";
import { resolveProject } from "../../build/paths.ts";
import { Ignorer } from "./gitignore.ts";

/** One indexed window of a source file. */
export interface CodeChunk {
  /** `${file}#${startLine}` — stable across rebuilds. */
  id: string;
  /** Project-relative path (POSIX). */
  file: string;
  /** 1-based line of the window's first line. */
  startLine: number;
  /** The raw source of the window. */
  text: string;
}

/** A project's cached code index. */
export interface CodeIndex {
  generatedAt: string;
  /** Absolute project root the index was built for. */
  root: string;
  /** rel path → staleness key (mtime in ms). */
  files: Record<string, { mtimeMs: number }>;
  chunks: CodeChunk[];
}

const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
/** Always excluded on top of `.gitignore` (VCS, our cache, vendored, generated). */
const SKIP_DIRS = new Set([
  ".git",
  ".denext",
  "node_modules",
  "out",
  "dist",
  "coverage",
  "build",
]);
const WINDOW = 50;
const MAX_FILES = 20000;

// ---------- chunking ----------

/** Split a file's text into non-overlapping `WINDOW`-line chunks. */
function chunkFile(file: string, text: string): CodeChunk[] {
  const lines = text.split("\n");
  const chunks: CodeChunk[] = [];
  for (let i = 0; i < lines.length; i += WINDOW) {
    const startLine = i + 1;
    const slice = lines.slice(i, i + WINDOW).join("\n");
    if (slice.trim() === "") continue; // skip all-blank windows
    chunks.push({ id: `${file}#${startLine}`, file, startLine, text: slice });
  }
  return chunks;
}

/** The file extension including the dot, lower-cased (`""` if none). */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

// ---------- walking ----------

/** Yield indexable source files under `root`, honoring `.gitignore` + the `SKIP_DIRS` floor. */
async function* walkSources(
  root: string,
  dir: string,
  prefix: string,
  ignorer: Ignorer,
): AsyncGenerator<string> {
  const here = await ignorer.extend(dir, prefix);
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name) || here.ignores(rel, true)) continue;
      yield* walkSources(root, join(dir, entry.name), rel, here);
    } else if (entry.isFile && EXTS.has(extOf(entry.name)) && !here.ignores(rel, false)) {
      yield rel;
    }
  }
}

// ---------- cache I/O ----------

/** The on-disk cache path for a project (`<project>/.denext/rag/codebase.json`). */
async function cachePath(root: string): Promise<string> {
  const paths = await resolveProject(root);
  return join(paths.outDir, "rag", "codebase.json");
}

/** Load a previously persisted index for `root`, or `null` if absent/unreadable/foreign. */
async function loadCache(root: string): Promise<CodeIndex | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(await cachePath(root))) as CodeIndex;
    return parsed.root === root && Array.isArray(parsed.chunks) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist `index` to the project cache. */
async function persist(index: CodeIndex): Promise<void> {
  const path = await cachePath(index.root);
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, JSON.stringify(index) + "\n");
}

// ---------- refresh ----------

/** Reuse a file's cached chunks when its mtime is unchanged, else re-read + re-chunk. */
async function chunksFor(
  root: string,
  rel: string,
  prev: CodeIndex | null,
): Promise<{ mtimeMs: number; chunks: CodeChunk[] } | null> {
  try {
    const mtimeMs = (await Deno.stat(join(root, rel))).mtime?.getTime() ?? 0;
    if (prev?.files[rel]?.mtimeMs === mtimeMs) {
      return { mtimeMs, chunks: prev.chunks.filter((c) => c.file === rel) };
    }
    return { mtimeMs, chunks: chunkFile(rel, await Deno.readTextFile(join(root, rel))) };
  } catch {
    return null; // vanished between walk and stat — drop it
  }
}

/** Walk `root`, incrementally rebuilding the index from `prev` where mtimes match. */
async function refresh(root: string, prev: CodeIndex | null): Promise<CodeIndex> {
  const files: Record<string, { mtimeMs: number }> = {};
  const chunks: CodeChunk[] = [];
  let count = 0;
  for await (const rel of walkSources(root, root, "", Ignorer.empty())) {
    if (++count > MAX_FILES) break;
    const entry = await chunksFor(root, rel, prev);
    if (!entry) continue;
    files[rel] = { mtimeMs: entry.mtimeMs };
    chunks.push(...entry.chunks);
  }
  return { generatedAt: new Date().toISOString(), root, files, chunks };
}

// ---------- public API ----------

const memo = new Map<string, CodeIndex>();

/** Whether two file-maps differ (a file added, dropped, or re-stat'd to a new mtime). */
function changed(a: Record<string, { mtimeMs: number }>, b: Record<string, { mtimeMs: number }>) {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return true;
  return ak.some((k) => a[k].mtimeMs !== b[k]?.mtimeMs);
}

/**
 * Build or incrementally refresh the code index for `dir`. Memoized per resolved root across
 * calls (the MCP process is long-lived); each call re-stats so edits are reflected. Persists
 * to `.denext/rag/codebase.json` only when something changed.
 */
export async function ensureCodeIndex(dir: string): Promise<CodeIndex> {
  const root = resolve(dir);
  const prev = memo.get(root) ?? await loadCache(root);
  const next = await refresh(root, prev);
  memo.set(root, next);
  if (!prev || changed(prev.files, next.files)) await persist(next);
  return next;
}

/** A one-line summary for `denext_index_codebase`. */
export function indexStats(index: CodeIndex): string {
  const nFiles = Object.keys(index.files).length;
  return `Indexed ${nFiles} file(s), ${index.chunks.length} chunk(s) → ` +
    `.denext/rag/codebase.json (root: ${index.root}).`;
}
