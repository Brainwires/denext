// Editing the stack's `.env` in place for `denext stack passwd` / `roll`: only the value of each
// changed variable is replaced; comments, blank lines, ordering, line endings, `export ` prefixes,
// inline comments and every other variable keep their bytes. A variable the file lacks is
// appended. The file is replaced atomically (a temp file in the same directory, then a rename)
// with the mode it had, or 0600 for a new one: it holds the stack's secrets.

import { dirname, join } from "@std/path";

/** A value written bare: nothing compose or a dotenv reader would interpret. */
const BARE = /^[A-Za-z0-9_\-.:/+=@,~%^]*$/;

/** `KEY=…` (optionally `export KEY=…`), capturing everything up to the value. */
function assignment(name: string): RegExp {
  return new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=\\s*)(.*)$`);
}

/**
 * A value as `.env` holds it: bare when it can be, else single-quoted (literal for compose and
 * denext's reader alike).
 *
 * @param value The value.
 * @returns The text after `=`.
 * @throws When the value has a newline, a NUL or a single quote (no quoting keeps those literal).
 */
export function formatEnvValue(value: string): string {
  if (/[\n\r\0']/.test(value)) {
    throw new Error("a .env value may not contain a newline, a NUL or a single quote");
  }
  return BARE.test(value) ? value : `'${value}'`;
}

/** The inline comment an unquoted value carries (` # …`), kept when the value is replaced. */
function inlineComment(value: string): string {
  if (value.startsWith("'") || value.startsWith('"')) return "";
  const hash = value.search(/\s#/);
  return hash === -1 ? "" : value.slice(hash);
}

/** Replace one line's value, keeping its prefix, inline comment and `\r`. */
function replaceLine(line: string, pattern: RegExp, formatted: string): string | undefined {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  const m = pattern.exec(body);
  if (!m) return undefined;
  return `${m[1]}${formatted}${inlineComment(m[2])}${cr}`;
}

/** Replace every assignment of `name` in `lines` (in place); whether there was one. */
function replaceAssignments(lines: string[], name: string, formatted: string): boolean {
  const pattern = assignment(name);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const next = replaceLine(lines[i], pattern, formatted);
    if (next === undefined) continue;
    lines[i] = next;
    found = true;
  }
  return found;
}

/**
 * `.env` text with `updates` applied: each variable's value replaced wherever it is assigned
 * (every occurrence, so a later duplicate can't win with the old value), or appended at the end
 * (after `comments[name]` as a `#` line) when the file lacks it.
 *
 * @param text The current `.env`.
 * @param updates The new values.
 * @param comments A comment for each variable that has to be appended.
 * @returns The new text.
 */
export function setEnvValues(
  text: string,
  updates: Readonly<Record<string, string>>,
  comments: Readonly<Record<string, string>> = {},
): string {
  const lines = text.split("\n");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const appended: string[] = [];
  for (const [name, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid variable name ${name}`);
    const formatted = formatEnvValue(value);
    if (replaceAssignments(lines, name, formatted)) continue;
    if (comments[name]) appended.push(`# ${comments[name]}`);
    appended.push(`${name}=${formatted}`);
  }
  let out = lines.join("\n");
  if (!appended.length) return out;
  if (out !== "" && !out.endsWith("\n")) out += eol;
  return out + appended.join(eol) + eol;
}

/** A replacement written beside its file and not yet renamed over it. */
export interface PreparedWrite {
  /** Rename it over the file. */
  commit(): Promise<void>;
  /** Drop it, leaving the file as it was. */
  discard(): Promise<void>;
}

/**
 * Stage `text` as the next contents of `path`: a temp file beside it (created 0600 by itself,
 * then given the old file's mode), synced. {@linkcode PreparedWrite.commit} renames it over the
 * file (atomic); a symlinked file is written through to its target. Staging first lets a caller
 * change the outside world (a database password) only once the file is known to be writable.
 *
 * @param path The file.
 * @param text Its new contents.
 * @returns The staged write.
 */
export async function prepareWrite(path: string, text: string): Promise<PreparedWrite> {
  const target = await Deno.realPath(path).catch(() => path);
  const mode = await Deno.stat(target).then((s) => (s.mode ?? 0o600) & 0o777, () => 0o600);
  const suffix = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
  const tmp = join(dirname(target), `.${suffixName(target)}.${suffix}.tmp`);
  const discard = () => Deno.remove(tmp).catch(() => {});
  try {
    const file = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    try {
      await file.write(new TextEncoder().encode(text));
      await file.sync();
    } finally {
      file.close();
    }
    if (Deno.build.os !== "windows") await Deno.chmod(tmp, mode);
  } catch (error) {
    await discard();
    throw error;
  }
  return {
    commit: async () => {
      try {
        await Deno.rename(tmp, target);
      } catch (error) {
        await discard();
        throw error;
      }
    },
    discard,
  };
}

/**
 * Replace the file at `path` with `text` atomically ({@linkcode prepareWrite}, then commit).
 *
 * @param path The file.
 * @param text Its new contents.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await (await prepareWrite(path, text)).commit();
}

/** The file's own name (the temp file is named after it). */
function suffixName(path: string): string {
  return path.split(/[\\/]/).pop() || "file";
}

/** Random hex for a password: URL-safe, so it fits inside `DATABASE_URL` unchanged. */
export function generatePassword(bytes = 24): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
