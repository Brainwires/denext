// Unified diffs, in-house: create one from two texts (Myers' O(ND) line diff) and apply
// one to a text (context-verified hunks with a bounded offset search). Backs
// `denext patch`, which stores a package edit as `patches/<name>+<version>.patch` —
// patch-package's reviewable, portable format — and re-applies it at load time. No npm
// `diff` dependency: the framework pulls no npm at runtime.

/** One line of a hunk: kept context, a removed line, or an added line. */
export interface HunkLine {
  kind: " " | "-" | "+";
  text: string;
}

/** A unified-diff hunk (`@@ -a,b +c,d @@`). */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

/** One file's diff (`--- a/x` / `+++ b/x` + hunks). */
export interface FileDiff {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

interface Edit {
  kind: " " | "-" | "+";
  a?: number;
  b?: number;
}

/** The furthest-reaching x per diagonal at one edit distance (Myers' `V`), plus its offset. */
interface Frontier {
  v: Int32Array;
  offset: number;
}

/** Myers' forward pass: one frontier snapshot per edit distance until the end is reached. */
function forwardTrace(a: string[], b: string[]): Frontier[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Frontier[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push({ v: v.slice(), offset });
    for (let k = -d; k <= d; k += 2) {
      let x = stepDown(v, offset, k, d) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return trace;
    }
  }
  return trace;
}

/** Whether diagonal `k` at distance `d` is reached by moving down (an insertion) rather than right. */
function stepDown(v: Int32Array, offset: number, k: number, d: number): boolean {
  return k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
}

/** Walk the trace back from the end to recover the edit sequence. */
function backtrack(trace: Frontier[], a: string[], b: string[]): Edit[] {
  const edits: Edit[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const { v, offset } = trace[d];
    const k = x - y;
    const prevK = stepDown(v, offset, k, d) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) edits.push({ kind: " ", a: --x, b: --y });
    if (x === prevX) edits.push({ kind: "+", b: --y });
    else edits.push({ kind: "-", a: --x });
  }
  while (x > 0 && y > 0) edits.push({ kind: " ", a: --x, b: --y });
  return edits.reverse();
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The unified diff of `oldText` → `newText` (`context` lines around each change), or `""`
 * when the texts are identical.
 */
export function createUnifiedDiff(
  oldText: string,
  newText: string,
  oldPath: string,
  newPath = oldPath,
  context = 3,
): string {
  if (oldText === newText) return "";
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const edits = backtrack(forwardTrace(a, b), a, b);
  const out = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const h of groupHunks(edits, a, b, context)) {
    out.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`);
    for (const l of h.lines) out.push(l.kind + l.text);
  }
  const noEol = !newText.endsWith("\n") && newText !== "";
  return out.join("\n") + "\n" + (noEol ? "\\ No newline at end of file\n" : "");
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Group an edit sequence into hunks with `context` shared lines around each change. */
function groupHunks(edits: Edit[], a: string[], b: string[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i].kind === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    const end = lastChangeOf(edits, i, 2 * context);
    const stop = Math.min(edits.length, end + context);
    hunks.push(toHunk(edits.slice(start, stop), a, b));
    i = stop;
  }
  return hunks;
}

/** The index just past the last change reachable from `from` without a gap of more than `maxGap` context lines. */
function lastChangeOf(edits: Edit[], from: number, maxGap: number): number {
  let end = from;
  let j = from;
  while (j < edits.length) {
    if (edits[j].kind !== " ") {
      end = ++j;
      continue;
    }
    let gap = 0;
    while (j + gap < edits.length && edits[j + gap].kind === " ") gap++;
    if (j + gap >= edits.length || gap > maxGap) break;
    j += gap;
  }
  return end;
}

function toHunk(slice: Edit[], a: string[], b: string[]): Hunk {
  const first = slice[0];
  const oldStart = (first.a ?? firstIndex(slice, "a")) + 1;
  const newStart = (first.b ?? firstIndex(slice, "b")) + 1;
  const lines: HunkLine[] = slice.map((e) => ({
    kind: e.kind,
    text: e.kind === "+" ? b[e.b!] : a[e.a!],
  }));
  return {
    oldStart,
    oldLines: lines.filter((l) => l.kind !== "+").length,
    newStart,
    newLines: lines.filter((l) => l.kind !== "-").length,
    lines,
  };
}

function firstIndex(slice: Edit[], side: "a" | "b"): number {
  for (const e of slice) if (e[side] !== undefined) return e[side]!;
  return 0;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a (possibly multi-file) unified diff. Throws on a malformed hunk header. */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      file = { oldPath: diffPath(line), newPath: diffPath(lines[i + 1]), hunks: [] };
      files.push(file);
      hunk = null;
      i++;
    } else if (line.startsWith("@@ ")) {
      hunk = parseHunkHeader(line, file);
    } else if (hunk) {
      pushHunkLine(hunk, line);
    }
  }
  return files;
}

function parseHunkHeader(line: string, file: FileDiff | null): Hunk {
  const m = line.match(HUNK_HEADER);
  if (!m || !file) throw new Error(`patch: malformed hunk header: ${line}`);
  const hunk: Hunk = {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    lines: [],
  };
  file.hunks.push(hunk);
  return hunk;
}

/** A hunk body line: `+`/`-`/` ` prefixed; an unprefixed empty line is trimmed context. */
function pushHunkLine(hunk: Hunk, line: string): void {
  if (line.startsWith("\\ ")) return; // "\ No newline at end of file"
  const kind = line[0];
  if (kind === " " || kind === "-" || kind === "+") {
    hunk.lines.push({ kind, text: line.slice(1) });
  } else if (line === "") {
    hunk.lines.push({ kind: " ", text: "" });
  }
}

/** The path of a `--- a/x` / `+++ b/x` line, without the `a/`/`b/` prefix or a tab suffix. */
function diffPath(line: string): string {
  return line.slice(4).split("\t")[0].trim().replace(/^[ab]\//, "");
}

/** The inverse diff: applying it to the patched text yields the original. */
export function reverseFileDiff(diff: FileDiff): FileDiff {
  return {
    oldPath: diff.newPath,
    newPath: diff.oldPath,
    hunks: diff.hunks.map((h) => ({
      oldStart: h.newStart,
      oldLines: h.newLines,
      newStart: h.oldStart,
      newLines: h.oldLines,
      lines: h.lines.map((l) => ({
        kind: l.kind === "+" ? "-" : l.kind === "-" ? "+" : " ",
        text: l.text,
      })),
    })),
  };
}

/** How far from its stated position a hunk may be found (lines above or below). */
const MAX_OFFSET = 200;

/**
 * Apply one file's hunks to `text`. Each hunk must match its context exactly, at its
 * stated line or within {@link MAX_OFFSET} lines of it; throws naming the hunk otherwise.
 */
export function applyFileDiff(text: string, diff: FileDiff): string {
  const lines = text.split("\n");
  const hadEol = text.endsWith("\n");
  if (hadEol) lines.pop();
  let drift = 0;
  for (const [index, hunk] of diff.hunks.entries()) {
    const expected = hunk.lines.filter((l) => l.kind !== "+").map((l) => l.text);
    const at = locate(lines, expected, hunk.oldStart - 1 + drift);
    if (at === -1) {
      throw new Error(
        `patch: hunk #${index + 1} (@@ -${hunk.oldStart} @@) of ${diff.newPath} does not apply`,
      );
    }
    const replacement = hunk.lines.filter((l) => l.kind !== "-").map((l) => l.text);
    lines.splice(at, expected.length, ...replacement);
    drift += at - (hunk.oldStart - 1) + (replacement.length - expected.length);
  }
  return lines.join("\n") + (hadEol ? "\n" : "");
}

/** Whether `diff` applies cleanly to `text` (a dry run). */
export function fileDiffApplies(text: string, diff: FileDiff): boolean {
  try {
    applyFileDiff(text, diff);
    return true;
  } catch {
    return false;
  }
}

/** The index where `expected` occurs in `lines`, nearest to `hint` (or -1). */
function locate(lines: string[], expected: string[], hint: number): number {
  if (expected.length === 0) return Math.min(Math.max(hint, 0), lines.length);
  for (let d = 0; d <= MAX_OFFSET; d++) {
    if (matchesAt(lines, expected, hint + d)) return hint + d;
    if (d > 0 && matchesAt(lines, expected, hint - d)) return hint - d;
  }
  return -1;
}

function matchesAt(lines: string[], expected: string[], at: number): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) if (lines[at + i] !== expected[i]) return false;
  return true;
}

/**
 * Apply a whole patch to a set of files: `read(path)` supplies each file's current text and
 * the result maps path → patched text. Throws when a hunk does not apply.
 */
export async function applyUnifiedDiff(
  patch: string,
  read: (path: string) => Promise<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of parseUnifiedDiff(patch)) {
    out.set(file.newPath, applyFileDiff(await read(file.oldPath), file));
  }
  return out;
}
