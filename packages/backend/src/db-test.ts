// `denext db test [files…]`: the Supabase CLI's `test db` — pgTAP test files
// (`supabase/tests/**/*.sql` by default) — without `pg_prove`. Each file runs in a transaction
// that is always rolled back (its own `BEGIN` / `ROLLBACK` are skipped), statement by statement,
// and the TAP lines pgTAP's functions return are collected: `ok` / `not ok`, the `1..N` plan.
// The pgtap extension must be available on the server (it is created inside that transaction).

import { join, relative, resolve } from "@std/path";
import type { DbActionInput } from "./db-action.ts";
import { filesUnder } from "./files.ts";

/** A `$tag$` that opens a dollar-quoted string (not a `$1` parameter). */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Where the comment / quoted text / dollar body starting at `i` ends (or `i` when none does). */
type Skipper = (text: string, i: number) => number;

/** `-- …` to the end of the line. */
const lineComment: Skipper = (text, i) => {
  const end = text.indexOf("\n", i);
  return end < 0 ? text.length : end + 1;
};

/** `/* … *\/`, nested. */
const blockComment: Skipper = (text, i) => {
  let depth = 1;
  let at = i + 2;
  while (at < text.length && depth) {
    const pair = text.slice(at, at + 2);
    depth += pair === "/*" ? 1 : pair === "*/" ? -1 : 0;
    at += pair === "/*" || pair === "*/" ? 2 : 1;
  }
  return at;
};

/** `'…'` (`''` escapes; `E'…'` also backslash escapes) or `"…"`. */
const quoted: Skipper = (text, i) => {
  const q = text[i];
  const backslash = q === "'" && /[eE]/.test(text[i - 1] ?? "");
  let at = i + 1;
  while (at < text.length && !(text[at] === q && text[at + 1] !== q)) {
    at += (backslash && text[at] === "\\") || (text[at] === q && text[at + 1] === q) ? 2 : 1;
  }
  return at + 1;
};

/** `$tag$ … $tag$`. */
const dollarBody: Skipper = (text, i) => {
  const tag = DOLLAR_TAG.exec(text.slice(i, i + 64))![0];
  const end = text.indexOf(tag, i + tag.length);
  return end < 0 ? text.length : end + tag.length;
};

/** The skipper for what starts at `i`, if anything does. */
function skipperAt(text: string, i: number): Skipper | undefined {
  const c = text[i];
  if (c === "-" && text[i + 1] === "-") return lineComment;
  if (c === "/" && text[i + 1] === "*") return blockComment;
  if (c === "'" || c === '"') return quoted;
  if (c === "$" && DOLLAR_TAG.test(text.slice(i, i + 64))) return dollarBody;
  return undefined;
}

/** A piece as a statement: leading line comments dropped (so `-- note\nBEGIN` reads as BEGIN). */
function statementOf(piece: string): string | undefined {
  const statement = piece.replace(/^(?:\s*--[^\n]*(?:\n|$))+/, "").trim();
  return statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() ? statement : undefined;
}

/**
 * Split a SQL script into statements, honouring quotes, `$tag$` bodies and comments.
 *
 * @param text The script.
 * @returns The statements (comment-only pieces dropped), without their `;`.
 */
export function splitSql(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const skip = skipperAt(text, i);
    if (skip) {
      i = skip(text, i);
      continue;
    }
    if (text[i] === ";") {
      const statement = statementOf(text.slice(start, i));
      if (statement) out.push(statement);
      start = i + 1;
    }
    i++;
  }
  const last = statementOf(text.slice(start));
  if (last) out.push(last);
  return out;
}

/** A statement that begins or ends a transaction (the runner owns the transaction). */
const TRANSACTION =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b(?!\s+TO\b)(?:\s+(?:WORK|TRANSACTION))?\s*$/i;

/** One file's result. */
export interface TapResult {
  file: string;
  planned?: number;
  passed: number;
  failed: number;
  ok: boolean;
  lines: string[];
}

/** Rolls the test transaction back. */
class Rollback extends Error {}

/** The TAP lines a statement's rows carry (each row's text cells, split on newlines). */
function tapLines(rows: Record<string, unknown>[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "string") lines.push(...value.split("\n"));
    }
  }
  return lines;
}

/**
 * Tally TAP output.
 *
 * @param file The file, for the result.
 * @param lines The TAP lines.
 * @returns The result.
 */
export function tally(file: string, lines: string[]): TapResult {
  let planned: number | undefined;
  let passed = 0;
  let failed = 0;
  for (const line of lines) {
    const plan = /^1\.\.(\d+)/.exec(line);
    if (plan) planned = Number(plan[1]);
    else if (/^not ok\b/.test(line)) {
      if (/#\s*TODO\b/i.test(line)) passed++;
      else failed++;
    } else if (/^ok\b/.test(line)) passed++;
  }
  const ok = failed === 0 && (planned === undefined ? passed > 0 : planned === passed);
  return { file, ...(planned !== undefined ? { planned } : {}), passed, failed, ok, lines };
}

/** Run one file in a rolled-back transaction. */
async function runFile(input: DbActionInput, path: string): Promise<TapResult> {
  const name = relative(input.projectDir, path).replaceAll("\\", "/");
  const lines: string[] = [];
  try {
    await input.sql.begin(async (tx) => {
      await tx.unsafe("CREATE EXTENSION IF NOT EXISTS pgtap");
      for (const statement of splitSql(await Deno.readTextFile(path))) {
        if (TRANSACTION.test(statement)) continue;
        lines.push(...tapLines([...await tx.unsafe<Record<string, unknown>>(statement)]));
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      lines.push(`not ok - ${(error as Error)?.message ?? error}`);
    }
  }
  return tally(name, lines);
}

/**
 * `denext db test`.
 *
 * @param input The action's input.
 */
export async function testAction(input: DbActionInput): Promise<void> {
  const available = await input.sql.unsafe<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgtap') AS found",
  );
  if (!available[0]?.found) {
    throw new Error(
      "the pgtap extension is not available on this Postgres: use an image that has it " +
        "(supabase/postgres), or install it (apt install postgresql-17-pgtap)",
    );
  }
  const given = input.ctx.positionals.slice(1).map((file) => resolve(input.projectDir, file));
  const files = given.length
    ? given
    : (await filesUnder(join(input.projectDir, "supabase", "tests")))
      .filter((file) => file.endsWith(".sql"));
  if (!files.length) {
    throw new Error("no tests: add pgTAP files under supabase/tests/ (or name the files)");
  }
  const results: TapResult[] = [];
  for (const file of files) {
    const result = await runFile(input, file);
    results.push(result);
    if (input.ctx.global.json) continue;
    for (const line of result.lines) input.io.log(`    ${line}`);
    input.io.log(`${result.file} .. ${result.ok ? "ok" : "Failed"}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (input.ctx.global.json) {
    input.io.log(JSON.stringify(results.map(({ lines: _, ...r }) => r), null, 2));
  } else {
    input.io.log(failed.length ? "Result: FAIL" : `All tests successful (${files.length} files).`);
  }
  if (failed.length) throw new Error(`${failed.length} of ${results.length} test files failed`);
}
