// Unified diffs, in-house: create one from two texts (Myers' line diff in its LINEAR-SPACE
// form — the middle-snake divide and conquer, O((N+M)·D) time, O(N+M) memory — after
// trimming the common prefix/suffix) and apply one to a text (context-verified hunks with a
// bounded offset search). Backs `denext patch`, which stores a package edit as
// `patches/<name>+<version>.patch` — patch-package's reviewable, portable format — and
// re-applies it at load time. No npm `diff` dependency: the framework pulls no npm at runtime.
//
// Fidelity notes: the `\ No newline at end of file` marker is kept per line (`HunkLine.noEol`)
// so a patch that adds or removes the final newline round-trips; `/dev/null` on either side
// marks a created / deleted file (`FileDiff.created` / `.deleted`), with the real path on both
// sides so callers keep addressing files by `newPath`.

/** One line of a hunk: kept context, a removed line, or an added line. */
export interface HunkLine {
  kind: " " | "-" | "+";
  text: string;
  /** The file has no newline after this line (`\ No newline at end of file` follows it). */
  noEol?: true;
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
  /** The file did not exist before (`--- /dev/null`); `oldPath` mirrors `newPath`. */
  created?: true;
  /** The file no longer exists after (`+++ /dev/null`); `newPath` mirrors `oldPath`. */
  deleted?: true;
}

/** The header path meaning "no file on this side". */
export const DEV_NULL = "/dev/null";

interface Edit {
  kind: " " | "-" | "+";
  a?: number;
  b?: number;
}

/**
 * The edit script (`Edit[]`, in order) turning `a` into `b`: common prefix/suffix trimmed, then
 * Myers' linear-space recursion on the middle. Two `Int32Array`s sized for the whole problem
 * are shared by every subproblem, so memory is O(N+M) however long the script is.
 */
function diffLines(a: string[], b: string[]): Edit[] {
  const edits: Edit[] = [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre && suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) suf++;
  for (let i = 0; i < pre; i++) edits.push({ kind: " ", a: i, b: i });
  const size = 2 * (a.length + b.length) + 3;
  const snakes: Snakes = {
    vf: new Int32Array(size),
    vb: new Int32Array(size),
    off: a.length + b.length + 1,
  };
  recurse(a, b, pre, a.length - suf, pre, b.length - suf, snakes, edits);
  for (let i = 0; i < suf; i++) {
    edits.push({ kind: " ", a: a.length - suf + i, b: b.length - suf + i });
  }
  return edits;
}

/** The two furthest-reaching vectors (forward / backward) and the diagonal offset into them. */
interface Snakes {
  vf: Int32Array;
  vb: Int32Array;
  off: number;
}

/** Emit the edits for `a[a0,a1)` → `b[b0,b1)`: trim, base cases, else split at the middle snake. */
function recurse(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  s: Snakes,
  out: Edit[],
): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push({ kind: " ", a: a0++, b: b0++ });
  let tail = 0;
  while (a0 < a1 - tail && b0 < b1 - tail && a[a1 - 1 - tail] === b[b1 - 1 - tail]) tail++;
  const aEnd = a1 - tail;
  const bEnd = b1 - tail;
  if (a0 === aEnd || b0 === bEnd) {
    pushAll(out, a0, aEnd, b0, bEnd);
  } else {
    const [x, y] = middleSnake(a, b, a0, aEnd, b0, bEnd, s);
    if ((x === 0 && y === 0) || (x === aEnd - a0 && y === bEnd - b0)) {
      pushAll(out, a0, aEnd, b0, bEnd); // cannot happen for a trimmed problem; never loop on it
    } else {
      recurse(a, b, a0, a0 + x, b0, b0 + y, s, out);
      recurse(a, b, a0 + x, aEnd, b0 + y, bEnd, s, out);
    }
  }
  for (let t = tail; t > 0; t--) out.push({ kind: " ", a: a1 - t, b: b1 - t });
}

/** Delete every `a` line of the range, then insert every `b` line (the no-common-line case). */
function pushAll(out: Edit[], a0: number, aEnd: number, b0: number, bEnd: number): void {
  for (let i = a0; i < aEnd; i++) out.push({ kind: "-", a: i });
  for (let j = b0; j < bEnd; j++) out.push({ kind: "+", b: j });
}

/** One subproblem, in coordinates relative to `(a0, b0)`. */
interface Sub {
  a: string[];
  b: string[];
  a0: number;
  b0: number;
  N: number;
  M: number;
}

/**
 * Myers' middle snake: run the forward and reverse searches from both corners until they
 * overlap; a point of the overlapping snake lies on an optimal edit path, so the problem splits
 * there. `N`, `M` > 0 and `a[a0] !== b[b0]`, `a[a1-1] !== b[b1-1]` (the caller trimmed), so the
 * script has ≥ 2 edits and neither search reaches the far corner before they meet.
 */
function middleSnake(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  s: Snakes,
): [number, number] {
  const sub: Sub = { a, b, a0, b0, N: a1 - a0, M: b1 - b0 };
  const delta = sub.N - sub.M;
  s.vf[s.off + 1] = 0;
  s.vb[s.off + delta - 1] = sub.N;
  const half = Math.ceil((sub.N + sub.M) / 2);
  for (let d = 0; d <= half; d++) {
    const fwd = forwardStep(sub, s, d, delta);
    if (fwd) return fwd;
    const back = backwardStep(sub, s, d, delta);
    if (back) return back;
  }
  return [sub.N, sub.M]; // unreachable for a well-formed problem; the caller guards it
}

/** Extend every forward diagonal at distance `d`; the overlap check applies when `delta` is odd. */
function forwardStep(sub: Sub, s: Snakes, d: number, delta: number): [number, number] | null {
  const { vf, vb, off } = s;
  const odd = (delta & 1) !== 0;
  for (let k = -d; k <= d; k += 2) {
    let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])
      ? vf[off + k + 1]
      : vf[off + k - 1] + 1;
    let y = x - k;
    while (x < sub.N && y < sub.M && sub.a[sub.a0 + x] === sub.b[sub.b0 + y]) {
      x++;
      y++;
    }
    vf[off + k] = x;
    if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && vf[off + k] >= vb[off + k]) {
      return [x, y]; // the forward snake is the middle snake
    }
  }
  return null;
}

/** Extend every reverse diagonal at distance `d`; the overlap check applies when `delta` is even. */
function backwardStep(sub: Sub, s: Snakes, d: number, delta: number): [number, number] | null {
  const { vf, vb, off } = s;
  const even = (delta & 1) === 0;
  for (let k = -d; k <= d; k += 2) {
    const kk = k + delta;
    let x = k === d || (k !== -d && vb[off + kk - 1] < vb[off + kk + 1])
      ? vb[off + kk - 1]
      : vb[off + kk + 1] - 1;
    let y = x - kk;
    while (x > 0 && y > 0 && sub.a[sub.a0 + x - 1] === sub.b[sub.b0 + y - 1]) {
      x--;
      y--;
    }
    vb[off + kk] = x;
    if (even && kk >= -d && kk <= d && vb[off + kk] <= vf[off + kk]) {
      return [x, y]; // the reverse snake is the middle snake
    }
  }
  return null;
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
  const eol = {
    old: oldText === "" || oldText.endsWith("\n"),
    new: newText === "" || newText.endsWith("\n"),
  };
  const edits = diffLines(a, b);
  // Only the final newline changed (the last line is otherwise unchanged): the line-level
  // diff sees context, but the format expresses it as `-last\ No newline` / `+last`.
  const last = edits[edits.length - 1];
  if (eol.old !== eol.new && last?.kind === " ") {
    edits.splice(edits.length - 1, 1, { kind: "-", a: last.a }, { kind: "+", b: last.b });
  }
  const out = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const h of groupHunks(edits, a, b, context, eol)) {
    out.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`);
    for (const l of h.lines) {
      out.push(l.kind + l.text);
      if (l.noEol) out.push(NO_EOL_MARKER);
    }
  }
  return out.join("\n") + "\n";
}

const NO_EOL_MARKER = "\\ No newline at end of file";

/** Which side ends with a newline (an empty text counts as terminated: nothing to mark). */
interface Eol {
  old: boolean;
  new: boolean;
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Group an edit sequence into hunks with `context` shared lines around each change. */
function groupHunks(edits: Edit[], a: string[], b: string[], context: number, eol: Eol): Hunk[] {
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
    hunks.push(toHunk(deletionsFirst(edits.slice(start, stop)), a, b, eol));
    i = stop;
  }
  return hunks;
}

/**
 * Within each run of consecutive changes, list the `-` lines before the `+` lines — the
 * convention every diff tool follows, and independent of which optimal script the search
 * happened to find.
 */
function deletionsFirst(slice: Edit[]): Edit[] {
  const out: Edit[] = [];
  let run: Edit[] = [];
  const flush = () => {
    out.push(...run.filter((e) => e.kind === "-"), ...run.filter((e) => e.kind === "+"));
    run = [];
  };
  for (const e of slice) {
    if (e.kind === " ") {
      flush();
      out.push(e);
    } else run.push(e);
  }
  flush();
  return out;
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

function toHunk(slice: Edit[], a: string[], b: string[], eol: Eol): Hunk {
  const first = slice[0];
  const lines: HunkLine[] = slice.map((e) => {
    const line: HunkLine = { kind: e.kind, text: e.kind === "+" ? b[e.b!] : a[e.a!] };
    // The marker attaches to a side's LAST line when that side has no final newline.
    if ((!eol.old && e.a === a.length - 1) || (!eol.new && e.b === b.length - 1)) line.noEol = true;
    return line;
  });
  const oldLines = lines.filter((l) => l.kind !== "+").length;
  const newLines = lines.filter((l) => l.kind !== "-").length;
  // GNU's convention: a hunk against an empty side starts at 0 (`@@ -0,0 +1,N @@`).
  const oldStart = oldLines === 0 && a.length === 0 ? 0 : (first.a ?? firstIndex(slice, "a")) + 1;
  const newStart = newLines === 0 && b.length === 0 ? 0 : (first.b ?? firstIndex(slice, "b")) + 1;
  return { oldStart, oldLines, newStart, newLines, lines };
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
      file = fileHeader(diffPath(line), diffPath(lines[i + 1]));
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

/**
 * The file header from its two paths. `/dev/null` on a side marks a created / deleted file;
 * the real path is kept on both sides so callers address the file by `newPath` either way.
 */
function fileHeader(oldPath: string, newPath: string): FileDiff {
  if (oldPath === DEV_NULL && newPath !== DEV_NULL) {
    return { oldPath: newPath, newPath, hunks: [], created: true };
  }
  if (newPath === DEV_NULL && oldPath !== DEV_NULL) {
    return { oldPath, newPath: oldPath, hunks: [], deleted: true };
  }
  return { oldPath, newPath, hunks: [] };
}

/** A hunk body line: `+`/`-`/` ` prefixed; an unprefixed empty line is trimmed context. */
function pushHunkLine(hunk: Hunk, line: string): void {
  if (line.startsWith("\\ ")) { // "\ No newline at end of file" → flag the line before it
    const prev = hunk.lines[hunk.lines.length - 1];
    if (prev) prev.noEol = true;
    return;
  }
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
  const out: FileDiff = {
    oldPath: diff.newPath,
    newPath: diff.oldPath,
    hunks: diff.hunks.map((h) => ({
      oldStart: h.newStart,
      oldLines: h.newLines,
      newStart: h.oldStart,
      newLines: h.oldLines,
      lines: h.lines.map((l) => {
        const line: HunkLine = {
          kind: l.kind === "+" ? "-" : l.kind === "-" ? "+" : " ",
          text: l.text,
        };
        if (l.noEol) line.noEol = true; // the marker belongs to the line, whichever side it is on
        return line;
      }),
    })),
  };
  if (diff.created) out.deleted = true;
  if (diff.deleted) out.created = true;
  return out;
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
  // The result's final newline: the input's, unless a hunk reaches the end of the NEW file —
  // then its last new-side line says (a `\ No newline` marker means none).
  let eol = hadEol;
  let drift = 0;
  for (const [index, hunk] of diff.hunks.entries()) {
    const expected = hunk.lines.filter((l) => l.kind !== "+").map((l) => l.text);
    const at = locate(lines, expected, hunk.oldStart - 1 + drift);
    if (at === -1) {
      throw new Error(
        `patch: hunk #${index + 1} (@@ -${hunk.oldStart} @@) of ${diff.newPath} does not apply`,
      );
    }
    const kept = hunk.lines.filter((l) => l.kind !== "-");
    if (
      expected.length > 0 && at + expected.length === lines.length && !oldEolMatches(hunk, hadEol)
    ) {
      throw new Error(
        `patch: hunk #${
          index + 1
        } (@@ -${hunk.oldStart} @@) of ${diff.newPath} does not apply (final newline differs)`,
      );
    }
    lines.splice(at, expected.length, ...kept.map((l) => l.text));
    drift += at - (hunk.oldStart - 1) + (kept.length - expected.length);
    if (at + kept.length === lines.length) eol = kept.length === 0 || !kept[kept.length - 1].noEol;
  }
  return lines.join("\n") + (eol && lines.length > 0 ? "\n" : "");
}

/**
 * A newline-aware hunk at EOF also asserts the OLD file's final-newline state (so the
 * idempotency probe can tell `"a\nB"` from `"a\nB\n"`). A legacy hunk with no marker is lenient.
 */
function oldEolMatches(hunk: Hunk, hadEol: boolean): boolean {
  if (!hunk.lines.some((l) => l.noEol)) return true;
  const oldSide = hunk.lines.filter((l) => l.kind !== "+");
  const oldNoEol = oldSide[oldSide.length - 1]?.noEol === true;
  return oldNoEol !== hadEol;
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
