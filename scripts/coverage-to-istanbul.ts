// Convert Deno's lcov coverage into an Istanbul `coverage-final.json` for fallow.
//
//   deno task coverage:fallow      # tests → lcov → coverage/coverage-final.json
//   deno run -A scripts/coverage-to-istanbul.ts <in.lcov> <out.json> [projectRoot]
//
// Why: fallow's CRAP score (complexity × untested-ness) needs per-function coverage.
// Without a coverage file it ESTIMATES coverage from the import graph — a module that
// tests reach only transitively (driven through another module's API, never imported
// by a test itself) is scored at a pessimistic 40% tier, which makes CRAP fire on any
// function with cyclomatic ≥ 10 regardless of how well-tested it really is. fallow accepts only the
// Istanbul JSON map (not lcov, not raw V8), so this script bridges the two.
//
// `deno coverage --lcov` is already source-mapped to TypeScript lines, so the line
// numbers here line up with the source fallow parses. The Istanbul map is built from
// the lcov records directly: one statement per `DA` line, one function per `FN`
// (spanning to the next function's start), and one branch group per `BRDA` line/block.

type Loc = { line: number; column: number };
type Range = { start: Loc; end: Loc };

/** One file's entry in an Istanbul coverage map. */
export interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, Range>;
  fnMap: Record<
    string,
    { name: string; decl: Range; loc: Range; line: number }
  >;
  branchMap: Record<
    string,
    { loc: Range; type: string; locations: Range[]; line: number }
  >;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

/** Istanbul coverage map: absolute file path → file coverage. */
export type IstanbulCoverageMap = Record<string, IstanbulFileCoverage>;

interface LcovRecord {
  path: string;
  fns: { name: string; line: number; count: number }[];
  lines: [line: number, count: number][];
  branches: Map<string, { line: number; counts: number[] }>;
}

const lineRange = (from: number, to: number): Range => ({
  start: { line: from, column: 0 },
  end: { line: to, column: 10_000 },
});

function newRecord(path: string): LcovRecord {
  return { path, fns: [], lines: [], branches: new Map() };
}

/** Feed one lcov line into the record being built; returns true at `end_of_record`. */
function readLcovLine(rec: LcovRecord, line: string): boolean {
  if (line.startsWith("FN:")) {
    const [l, ...name] = line.slice(3).split(",");
    rec.fns.push({ name: name.join(","), line: Number(l), count: 0 });
  } else if (line.startsWith("FNDA:")) {
    const [c, ...name] = line.slice(5).split(",");
    const fn = rec.fns.find((f) => f.name === name.join(","));
    if (fn) fn.count = Number(c);
  } else if (line.startsWith("DA:")) {
    const [l, c] = line.slice(3).split(",");
    rec.lines.push([Number(l), Number(c)]);
  } else if (line.startsWith("BRDA:")) {
    const [l, block, _branch, c] = line.slice(5).split(",");
    const key = `${l}:${block}`;
    const entry = rec.branches.get(key) ?? { line: Number(l), counts: [] };
    entry.counts.push(c === "-" ? 0 : Number(c));
    rec.branches.set(key, entry);
  }
  return line === "end_of_record";
}

function toIstanbul(rec: LcovRecord): IstanbulFileCoverage {
  const out: IstanbulFileCoverage = {
    path: rec.path,
    statementMap: {},
    fnMap: {},
    branchMap: {},
    s: {},
    f: {},
    b: {},
  };
  const lines = [...rec.lines].sort((a, b) => a[0] - b[0]);
  const lastLine = lines.length > 0 ? lines[lines.length - 1][0] : 1;
  lines.forEach(([line, count], i) => {
    out.statementMap[i] = lineRange(line, line);
    out.s[i] = count;
  });
  const fns = [...rec.fns].sort((a, b) => a.line - b.line);
  fns.forEach((fn, i) => {
    const endLine = i + 1 < fns.length ? fns[i + 1].line - 1 : lastLine;
    out.fnMap[i] = {
      name: fn.name,
      decl: lineRange(fn.line, fn.line),
      loc: lineRange(fn.line, Math.max(fn.line, endLine)),
      line: fn.line,
    };
    out.f[i] = fn.count;
  });
  let bi = 0;
  for (const { line, counts } of rec.branches.values()) {
    out.branchMap[bi] = {
      loc: lineRange(line, line),
      type: "branch",
      locations: counts.map(() => lineRange(line, line)),
      line,
    };
    out.b[bi] = counts;
    bi++;
  }
  return out;
}

/**
 * `path` with every symlink resolved (`/var/…` → `/private/var/…` on macOS), so the records of
 * one file reached through two spellings meet. A path that no longer exists keeps its missing
 * tail on its deepest existing (resolved) ancestor; one with no such ancestor is returned as is.
 * (Self-contained, no imports: this script is also scaffolded into apps.)
 *
 * @param path An absolute path.
 * @param realPath The resolver (`Deno.realPathSync`; injectable for tests).
 */
export function canonicalPath(
  path: string,
  realPath: (path: string) => string = Deno.realPathSync,
): string {
  const tail: string[] = [];
  for (let dir = path;;) {
    try {
      const real = realPath(dir);
      if (tail.length === 0) return real;
      const sep = real.includes("\\") && !real.includes("/") ? "\\" : "/";
      return [real.replace(/[\\/]+$/, ""), ...tail.reverse()].join(sep);
    } catch { /* missing (or unreadable): try its parent */ }
    const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
    // The root (`/`, `C:\\`) or a bare name: nothing above it to resolve.
    if (cut <= 0 || /^[A-Za-z]:$/.test(dir.slice(0, cut))) return path;
    tail.push(dir.slice(cut + 1));
    dir = dir.slice(0, cut);
  }
}

/** Fold `from` (another record of the same file) into `into`: hits add up. */
function mergeRecord(into: LcovRecord, from: LcovRecord): void {
  const lines = new Map(into.lines);
  for (const [line, count] of from.lines) {
    lines.set(line, (lines.get(line) ?? 0) + count);
  }
  into.lines = [...lines];
  for (const fn of from.fns) {
    const same = into.fns.find((f) => f.name === fn.name && f.line === fn.line);
    if (same) same.count += fn.count;
    else into.fns.push({ ...fn });
  }
  for (const [key, entry] of from.branches) {
    const same = into.branches.get(key);
    if (!same) {
      into.branches.set(key, { line: entry.line, counts: [...entry.counts] });
      continue;
    }
    entry.counts.forEach((c, i) => {
      same.counts[i] = (same.counts[i] ?? 0) + c;
    });
  }
}

/**
 * Convert lcov text to an Istanbul coverage map. Relative `SF:` paths are resolved
 * against `root` (lcov from `deno coverage` is already absolute), then mapped through
 * `canonical`; records that land on one path are merged (a run under a symlinked
 * directory writes both spellings of a file).
 */
export function lcovToIstanbul(
  lcov: string,
  root: string,
  canonical: (path: string) => string = (p) => p,
): IstanbulCoverageMap {
  const records = new Map<string, LcovRecord>();
  let rec: LcovRecord | null = null;
  for (const raw of lcov.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const p = line.slice(3);
      rec = newRecord(
        canonical(p.startsWith("/") ? p : `${root.replace(/\/$/, "")}/${p}`),
      );
      continue;
    }
    if (rec !== null && readLcovLine(rec, line)) {
      const seen = records.get(rec.path);
      if (seen) mergeRecord(seen, rec);
      else records.set(rec.path, rec);
      rec = null;
    }
  }
  const map: IstanbulCoverageMap = {};
  for (const [path, record] of records) map[path] = toIstanbul(record);
  return map;
}

if (import.meta.main) {
  const [inPath, outPath, rootArg] = Deno.args;
  if (!inPath || !outPath) {
    console.error(
      "usage: coverage-to-istanbul.ts <in.lcov> <out.json> [projectRoot]",
    );
    Deno.exit(2);
  }
  const map = lcovToIstanbul(
    await Deno.readTextFile(inPath),
    rootArg ?? Deno.cwd(),
    canonicalPath,
  );
  await Deno.writeTextFile(outPath, JSON.stringify(map));
  const count = Object.keys(map).length;
  console.log(`coverage-to-istanbul: wrote ${count} files to ${outPath}`);
}
