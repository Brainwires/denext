// Per-module byte attribution of a bundled file from its source map: what `denext analyze --md`
// reports on the native `deno bundle` path (esbuild's metafile gives the compat/SPA path the same
// numbers), and what the bundle tests use to prove a module's code is not in a startup chunk.

import { isAbsolute, join, relative, SEPARATOR } from "@std/path";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = /* @__PURE__ */ new Map([...B64].map((c, i) => [c, i]));

/** One decoded mapping segment: its generated column, and its source index when it has one. */
interface Segment {
  column: number;
  source: number | undefined;
}

/** Decode one Base64 VLQ field of `text` starting at `at.i` (advanced past it). */
function vlq(text: string, at: { i: number }): number {
  let value = 0;
  let shift = 0;
  let digit: number;
  do {
    digit = B64_INDEX.get(text[at.i++]) ?? 0;
    value += (digit & 31) << shift;
    shift += 5;
  } while (digit & 32);
  return value & 1 ? -(value >>> 1) : value >>> 1;
}

/** The segments of each generated line of a source map's `mappings`. */
function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let source = 0;
  for (const line of mappings.split(";")) {
    const segments: Segment[] = [];
    let column = 0;
    for (const raw of line.split(",")) {
      if (raw === "") continue;
      const at = { i: 0 };
      column += vlq(raw, at);
      if (at.i < raw.length) {
        source += vlq(raw, at); // source index; the original line/column (and name) follow
        segments.push({ column, source });
      } else {
        segments.push({ column, source: undefined });
      }
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * How many bytes of `code` each source of its map produced: every generated span from one
 * mapping segment to the next (or the line's end) counts toward the segment's source. Spans with
 * no source (the bundler's own glue) and line breaks are not attributed. Bytes are UTF-8.
 *
 * @param code The bundled file's text.
 * @param mapJson Its source map (JSON text).
 * @returns `source → bytes`, keyed by the map's `sources` entries as written; empty for a map
 *   that cannot be read.
 */
export function attributeBytes(code: string, mapJson: string): Map<string, number> {
  const out = new Map<string, number>();
  let map: { sources?: unknown; mappings?: unknown };
  try {
    map = JSON.parse(mapJson);
  } catch {
    return out;
  }
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string") return out;
  const sources = map.sources as unknown[];
  const encoder = new TextEncoder();
  const codeLines = code.split("\n");
  decodeMappings(map.mappings).forEach((segments, lineNo) => {
    const text = codeLines[lineNo] ?? "";
    segments.forEach((seg, i) => {
      const name = seg.source === undefined ? undefined : sources[seg.source];
      if (typeof name !== "string") return;
      const end = i + 1 < segments.length ? segments[i + 1].column : text.length;
      const bytes = encoder.encode(text.slice(seg.column, end)).length;
      if (bytes > 0) out.set(name, (out.get(name) ?? 0) + bytes);
    });
  });
  return out;
}

/** One output's per-module bytes, in the shape of an esbuild metafile's `outputs[x].inputs`. */
export type OutputInputs = Record<string, { bytesInOutput: number }>;

/** `denext analyze --md`'s native-path attribution, recorded by each `deno bundle` run. */
const recorded = {
  byName: new Map<string, OutputInputs>(),
  byCode: new Map<string, OutputInputs>(),
};

/** Whether `denext analyze --md` asked this process's bundles to record their attribution. */
export function analyzeRequested(): boolean {
  return Deno.env.get("DENEXT_ANALYZE") === "1";
}

/**
 * Record one emitted file's per-module bytes for {@linkcode nativeAnalyzeMeta}: by its emitted
 * name (a content-hashed chunk keeps it) and by its code (an entry is renamed when written).
 *
 * @param name The emitted basename.
 * @param code Its code.
 * @param bytes `module path → bytes` ({@linkcode attributeBytes}, keys made absolute).
 */
export function recordAttribution(name: string, code: string, bytes: Map<string, number>): void {
  const inputs: OutputInputs = {};
  for (const [path, n] of bytes) inputs[path] = { bytesInOutput: n };
  recorded.byName.set(name, inputs);
  recorded.byCode.set(code, inputs);
}

/**
 * The per-module breakdown of the client files in `clientDir` that this process's native
 * `deno bundle` runs recorded (under `DENEXT_ANALYZE=1`), as the slice of an esbuild metafile the
 * markdown report reads. A module is labelled relative to `projectDir` when inside it, else
 * relative to `frameworkDir` under `denext/`, else by its absolute path.
 *
 * @param clientDir The build's client output directory.
 * @param projectDir The app's directory.
 * @param frameworkDir The framework checkout's root directory.
 * @returns The outputs, or `undefined` when nothing was recorded for these files.
 */
export async function nativeAnalyzeMeta(
  clientDir: string,
  projectDir: string,
  frameworkDir: string,
): Promise<{ outputs: Record<string, { inputs: OutputInputs }> } | undefined> {
  const outputs: Record<string, { inputs: OutputInputs }> = {};
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(clientDir));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".js")) continue;
    const inputs = recorded.byName.get(entry.name) ??
      recorded.byCode.get(await Deno.readTextFile(join(clientDir, entry.name)));
    if (!inputs) continue;
    const labelled: OutputInputs = {};
    for (const [path, n] of Object.entries(inputs)) {
      labelled[moduleLabel(path, projectDir, frameworkDir)] = n;
    }
    outputs[entry.name] = { inputs: labelled };
  }
  return Object.keys(outputs).length > 0 ? { outputs } : undefined;
}

/** A module path relative to the app, else `denext/…` inside the framework, else as given. */
function moduleLabel(path: string, projectDir: string, frameworkDir: string): string {
  const under = (dir: string) => {
    const rel = relative(dir, path);
    return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(SEPARATOR).join("/");
  };
  const inApp = under(projectDir);
  if (inApp !== null) return inApp;
  const inFramework = under(frameworkDir);
  return inFramework === null ? path : `denext/${inFramework}`;
}

/** A sibling file an emitted bundle file names (`"./chunk-X.js"`: static, dynamic or a URL). */
const SIBLING_REF = /\.\/([\w$.-]+\.js)\b/g;

/**
 * Remove from `files` every emitted file no entry can load: a chunk whose only `import()` site
 * was tree-shaken after code splitting placed it (the class runtime of a `classComponents:
 * false` build, a native-only module a web page never reaches). Follows every `./name.js` an
 * entry, then each file it reaches, names. Nothing is removed when an entry is missing.
 *
 * @param files Every emitted file by basename (modified in place).
 * @param entries The entry basenames.
 * @returns The removed basenames.
 */
export function pruneUnreachable(files: Map<string, string>, entries: string[]): string[] {
  if (!entries.every((e) => files.has(e))) return [];
  const reached = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    for (const m of files.get(name)!.matchAll(SIBLING_REF)) {
      if (files.has(m[1]) && !reached.has(m[1])) queue.push(m[1]);
    }
  }
  const removed = [...files.keys()].filter((name) => !reached.has(name));
  for (const name of removed) files.delete(name);
  return removed;
}
