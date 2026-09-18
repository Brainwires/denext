// What environment variables does this project read, and which of them is nothing declaring?
//
// The environment step of `denext ui`'s Setup page answers that without evaluating a line of the
// project: the sources are *scanned*, never imported (the hard rule of the UI process). The
// scan is deliberately lexical — {@linkcode stripComments} first, then a match that is
// discarded when it lands inside a string literal — so a commented-out `Deno.env.get("X")`
// and a `"Deno.env.get(\"X\")"` inside a doc string are both correctly ignored.
//
// Values are never read or printed: Setup reports names, and the only file it offers to
// write is `.env.example` (`KEY=` lines). `.env` is never touched.

import { walk } from "@std/fs";
import { join } from "@std/path";
import { parseEnv } from "../server/env.ts";
import { stripComments } from "../utils/strip-comments.ts";

/** The extensions scanned for environment reads. */
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".mjs"];

/** Directories the walk never descends into. */
const SKIP: RegExp[] = [/(^|[\\/])(node_modules|\.denext|\.git|out|coverage)([\\/]|$)/];

/** The scan runs on a page render, so it is capped in both directions. */
const MAX_FILES = 4000;

/** Files larger than this are skipped (a bundle or a fixture, not hand-written source). */
const MAX_BYTES = 512 * 1024;

/** The `.env` files whose *keys* are treated as "declared" (values are never read). */
const ENV_FILES = [".env", ".env.local"];

/** One lexical pattern plus the capture group holding the variable name. */
interface NamePattern {
  /** The (global) pattern. */
  readonly re: RegExp;
  /** Which capture group is the name. */
  readonly group: number;
}

/** `Deno.env.get("X")`, `process.env.X` and `process.env["X"]`. */
const PATTERNS: readonly NamePattern[] = [
  { re: /\bDeno\.env\.get\(\s*(["'`])([A-Za-z_$][\w$]*)\1\s*\)/g, group: 2 },
  { re: /\bprocess\.env\.([A-Za-z_$][\w$]*)/g, group: 1 },
  { re: /\bprocess\.env\[\s*(["'])([A-Za-z_$][\w$]*)\1\s*\]/g, group: 2 },
];

/** String and template literals in comment-free source (a match inside one is not code). */
const STRING_LITERAL = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

/** What {@linkcode scanEnvUsage} found. Names only — never a value. */
export interface EnvScan {
  /** Every variable the project's source reads, sorted. */
  readonly used: string[];
  /** The names declared by the project's `.env` files, sorted. */
  readonly declared: string[];
  /** Which `.env` files exist (project-relative names, in load order). */
  readonly files: string[];
  /** Used names the UI process already has in its own environment, sorted. */
  readonly inProcess: string[];
  /** `used` minus `declared` minus `inProcess`: what `.env.example` would gain. */
  readonly missing: string[];
  /** How many source files were read (capped at {@linkcode MAX_FILES}). */
  readonly scanned: number;
}

/**
 * The environment variable names read by one module's source.
 *
 * @param source The file's text.
 * @returns The names, in first-seen order, with comment and in-string occurrences dropped.
 */
export function envNamesIn(source: string): string[] {
  const code = stripComments(source);
  const strings = literalRanges(code);
  const names: string[] = [];
  for (const { re, group } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const name = m[group];
      if (inside(strings, m.index)) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The `[start, end)` span of every string/template literal in comment-free source. */
function literalRanges(code: string): number[][] {
  const ranges: number[][] = [];
  STRING_LITERAL.lastIndex = 0;
  for (let m = STRING_LITERAL.exec(code); m !== null; m = STRING_LITERAL.exec(code)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Whether `index` falls inside one of the literal spans. */
function inside(ranges: number[][], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * How long one scan stays reusable. The walk is the most expensive thing `GET /setup` does
 * (a second or more on a large tree) and a page render asks for it more than once, so a result
 * is held briefly — long enough for one interaction, short enough that an edit made while the
 * page is open is still picked up on the next reload.
 */
const SCAN_TTL_MS = 2_000;

/** The last scan, keyed by project directory and that directory's own mtime. */
let lastScan: { key: string; at: number; scan: EnvScan } | null = null;

/**
 * Scan a project for the environment variables it reads and compare them with what its
 * `.env` files declare. No project module is imported and no value is read.
 *
 * Memoised for {@linkcode SCAN_TTL_MS} per directory — see {@linkcode SCAN_TTL_MS}.
 *
 * @param dir The project directory.
 * @returns The used / declared / missing name sets.
 */
export async function scanEnvUsage(dir: string): Promise<EnvScan> {
  const key = await scanKey(dir);
  const now = Date.now();
  if (lastScan && lastScan.key === key && now - lastScan.at < SCAN_TTL_MS) return lastScan.scan;
  const scan = await walkEnvUsage(dir);
  lastScan = { key, at: Date.now(), scan };
  return scan;
}

/** The cache key: the directory, plus its own mtime so an added or removed entry invalidates. */
async function scanKey(dir: string): Promise<string> {
  try {
    const stat = await Deno.stat(dir);
    return `${dir}\u0000${stat.mtime?.getTime() ?? 0}`;
  } catch {
    return `${dir}\u0000?`;
  }
}

/** The uncached scan. */
async function walkEnvUsage(dir: string): Promise<EnvScan> {
  const used = new Set<string>();
  let scanned = 0;
  try {
    for await (const entry of walkSources(dir)) {
      if (scanned >= MAX_FILES) break;
      scanned++;
      const text = await readCapped(entry.path);
      if (text !== null) { for (const name of envNamesIn(text)) used.add(name); }
    }
  } catch { /* an unreadable tree still reports what was seen */ }
  const env = await declaredEnvNames(dir);
  const sorted = [...used].sort();
  const inProcess = sorted.filter(processHas);
  const missing = sorted.filter((n) => !env.declared.includes(n) && !inProcess.includes(n));
  return { used: sorted, declared: env.declared, files: env.files, inProcess, missing, scanned };
}

/** The source files under `dir`, minus the never-walked directories. */
function walkSources(dir: string): AsyncIterableIterator<{ path: string }> {
  return walk(dir, {
    exts: SOURCE_EXTS,
    skip: SKIP,
    includeDirs: false,
    followSymlinks: false,
  });
}

/** A file's text, or `null` when it is missing, unreadable, or too large to be source. */
async function readCapped(path: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(path);
    if (stat.size > MAX_BYTES) return null;
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** The names declared by the project's `.env` files, and which of those files exist. */
async function declaredEnvNames(dir: string): Promise<{ declared: string[]; files: string[] }> {
  const declared = new Set<string>();
  const files: string[] = [];
  for (const name of ENV_FILES) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, name));
    } catch {
      continue; // absent is the normal case
    }
    files.push(name);
    for (const key of Object.keys(parseEnv(text))) declared.add(key);
  }
  return { declared: [...declared].sort(), files };
}

/** Whether the UI process's own environment already has `name` (its value is never read). */
function processHas(name: string): boolean {
  try {
    return Deno.env.has(name);
  } catch {
    return false; // a partial --allow-env: treat as "not set"
  }
}

/**
 * The `.env.example` a project should have: every key it already documents, in order, plus a
 * `KEY=` line for each name nothing declares.
 *
 * @param existing The current `.env.example` text, or `null` when there is none.
 * @param missing The undeclared names to append.
 * @returns The proposed file text (unchanged when nothing is missing).
 */
export function envExampleSource(existing: string | null, missing: string[]): string {
  const base = existing ?? "# Environment variables this project reads.\n" +
      "# Copy to .env and fill in the values; .env is never written by denext ui.\n";
  const known = new Set(Object.keys(parseEnv(base)));
  const added = missing.filter((name) => !known.has(name));
  if (added.length === 0) return base;
  const prefix = base.length === 0 || base.endsWith("\n") ? base : base + "\n";
  return prefix + added.map((name) => `${name}=`).join("\n") + "\n";
}
