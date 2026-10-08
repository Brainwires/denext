// SPA mode: the chunk-load error event — Vite's `vite:preloadError`, plus `denext:chunkError`.
//
// A deploy (or an OTA update) replaces the content-hashed chunks; a tab still running the old
// entry then asks for a chunk that is gone, and its `import()` rejects. Vite wraps every dynamic
// import in `__vitePreload`, which on a rejection dispatches a cancelable `vite:preloadError`
// Event on `window` with the error as `event.payload`, and rethrows unless a listener called
// `preventDefault()` — the hook apps use to reload once onto the new build. A migrated app
// listens for that event, so a denext SPA build dispatches the same one (and `denext:chunkError`,
// the same event under denext's name).
//
// How: after the bundle is written, each `import("./<chunk>.js")` (or, on the esbuild path,
// `import("/_denext/client/<chunk>.js")`) emitted for a split module gets a `.catch` that calls
// `globalThis.__denextChunkError`, and the entry installs that handler from a `data:` module.
// The handler is looked up when the import FAILS, not when it starts: esbuild may hoist app code
// into a shared chunk that evaluates (and starts imports) before the entry's own body has run.
// Where no handler is installed (a worker chunk), the rejection passes through unchanged. Only
// production SPA bundles are rewritten; the App Router's shared runtime is not touched, so its
// byte budget is unaffected.

import { join } from "@std/path";

/** The global the rewritten imports call (installed by {@linkcode CHUNK_ERROR_SEED}). */
const HANDLER = "__denextChunkError";

/**
 * The handler, as Vite's `handlePreloadError`: dispatch each event (cancelable, `payload` = the
 * error) and rethrow unless one of them was default-prevented, in which case the `import()`
 * resolves to `undefined`, as under Vite.
 */
const HANDLER_SOURCE = `globalThis.${HANDLER}=function(e){var p=!1;` +
  `for(var t of["vite:preloadError","denext:chunkError"]){var v=new Event(t,{cancelable:!0});` +
  `v.payload=e;globalThis.dispatchEvent(v);p=p||v.defaultPrevented}if(!p)throw e};`;

/** The import that installs the handler, prepended to a production SPA entry. */
export const CHUNK_ERROR_SEED = `import "data:text/javascript;base64,${btoa(HANDLER_SOURCE)}";\n`;

/**
 * An `import("./x.js")` call, or one of the client prefix's (`import("/_denext/client/x.js")`, the
 * esbuild path's `publicPath`), naming a top-level file — not a member call such as `a.import(…)`.
 */
const DYNAMIC_IMPORT =
  /(?<![\w$.])import\(\s*(["'])(?:\.\/|\/_denext\/client\/)([\w$.@-]+\.js)\1\s*\)/g;

/** What a rewrite inserts after each matched call (the handler, read when the import fails). */
const SUFFIX = `.catch(e=>(globalThis.${HANDLER}||(e=>Promise.reject(e)))(e))`;

/** One insertion: at `index` of the original text. */
interface Insertion {
  readonly index: number;
}

/**
 * Rewrite one output file's dynamic imports of sibling files (`chunks` = the names in its
 * directory), returning the new text and where the suffix went (indices in the old text).
 */
export function wrapImportsInSource(
  source: string,
  chunks: ReadonlySet<string>,
): { code: string; insertions: Insertion[] } {
  const insertions: Insertion[] = [];
  const code = source.replace(DYNAMIC_IMPORT, (match, _q, file: string, offset: number) => {
    if (!chunks.has(file)) return match;
    insertions.push({ index: offset + match.length });
    return match + SUFFIX;
  });
  return { code, insertions };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode the first base64-VLQ value of `segment`: the value and the characters it used. */
function decodeFirstVlq(segment: string): { value: number; length: number } {
  let result = 0;
  let shift = 0;
  let i = 0;
  for (;;) {
    const digit = B64.indexOf(segment[i++]);
    if (digit < 0) throw new Error("invalid source map segment");
    result += (digit & 31) * 2 ** shift;
    shift += 5;
    if ((digit & 32) === 0) break;
  }
  const value = result % 2 === 1 ? -Math.floor(result / 2) : Math.floor(result / 2);
  return { value, length: i };
}

/** Encode one base64-VLQ value. */
function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value * 2) + 1 : value * 2;
  let out = "";
  do {
    let digit = vlq % 32;
    vlq = Math.floor(vlq / 32);
    if (vlq > 0) digit |= 32;
    out += B64[digit];
  } while (vlq > 0);
  return out;
}

/**
 * Shift a source map's generated columns for text inserted into the file it maps: each
 * insertion of `length` characters at (line, column) moves every later segment on that line
 * right. Only the generated-column field changes (it is the one field relative to the line);
 * the source/line/column/name fields are deltas across segments and stay as written.
 *
 * @param mappings The map's `mappings` string.
 * @param inserts Per line (0-based), the columns of the insertions, ascending, and their length.
 */
export function shiftMappings(
  mappings: string,
  inserts: ReadonlyMap<number, readonly number[]>,
  length: number,
): string {
  const lines = mappings.split(";");
  for (const [line, columns] of inserts) {
    if (!lines[line]) continue;
    let prev = 0;
    let prevShifted = 0;
    lines[line] = lines[line].split(",").map((segment) => {
      if (segment === "") return segment;
      const { value, length: used } = decodeFirstVlq(segment);
      const col = prev + value;
      prev = col;
      const shifted = col + length * columns.filter((c) => c <= col).length;
      const out = encodeVlq(shifted - prevShifted) + segment.slice(used);
      prevShifted = shifted;
      return out;
    }).join(",");
  }
  return lines.join(";");
}

/** Group text offsets of `source` by line → the columns, ascending. */
function linesAndColumns(source: string, insertions: Insertion[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let line = 0;
  let lineStart = 0;
  let pos = 0;
  for (const { index } of insertions) {
    for (; pos < index; pos++) {
      if (source.charCodeAt(pos) === 10) {
        line++;
        lineStart = pos + 1;
      }
    }
    const cols = out.get(line) ?? [];
    cols.push(index - lineStart);
    out.set(line, cols);
  }
  return out;
}

/** Whether `path` names an existing file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Adjust `<file>.map`, when there is one, for the insertions made in `source`. */
async function shiftSiblingMap(
  path: string,
  source: string,
  insertions: Insertion[],
): Promise<void> {
  const mapPath = `${path}.map`;
  if (!(await isFile(mapPath))) return;
  const map = JSON.parse(await Deno.readTextFile(mapPath));
  if (typeof map.mappings !== "string") return;
  map.mappings = shiftMappings(
    map.mappings,
    linesAndColumns(source, insertions),
    SUFFIX.length,
  );
  await Deno.writeTextFile(mapPath, JSON.stringify(map));
}

/**
 * Route every split-chunk `import()` of the production bundle in `clientDir` (its top-level
 * `.js` files: the entry and the chunks) through the chunk-error handler, keeping any source
 * map beside a rewritten file in step.
 *
 * @returns How many `import()` calls were rewritten.
 */
export async function wrapDynamicImports(clientDir: string): Promise<number> {
  const names = new Set<string>();
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && e.name.endsWith(".js")) names.add(e.name);
  }
  let total = 0;
  for (const name of names) {
    const path = join(clientDir, name);
    const source = await Deno.readTextFile(path);
    const { code, insertions } = wrapImportsInSource(source, names);
    if (insertions.length === 0) continue;
    await Deno.writeTextFile(path, code);
    await shiftSiblingMap(path, source, insertions);
    total += insertions.length;
  }
  return total;
}
