// `.env` file loading (server-only). Reads `.env` then `.env.local` (later wins)
// from the project directory and applies them to `Deno.env`, so server code —
// server components, route handlers, middleware — reads them the usual way with
// `Deno.env.get(...)`. Real shell environment variables win over file values
// unless `override` is set, matching common dotenv semantics.
//
// The client/server isolation (which variables the browser may see) lives in
// `../runtime/public-env.ts`; this module only handles loading.

import { join } from "@std/path";
import { filterPublicEnv } from "../runtime/public-env.ts";

export {
  filterPublicEnv,
  isPublicEnvKey,
  PUBLIC_ENV_PREFIXES,
  publicEnv,
} from "../runtime/public-env.ts";

/**
 * Parse `.env`-style text into key/value pairs. Supports `KEY=value`,
 * `export KEY=value`, `#` comments, blank lines, and single- or double-quoted
 * values (double-quoted values interpret `\n`/`\t`/`\r` escapes). Unquoted
 * values are trimmed and may carry an inline `#` comment. Invalid lines are
 * skipped. No shell/variable expansion is performed.
 *
 * @param text The dotenv file contents.
 * @returns The parsed variables (later duplicate keys win).
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no key, or "=value"
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // not a valid env name

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
          .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      // Unquoted: strip an inline comment (preceded by whitespace) and trim.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Options for {@linkcode loadEnv}. */
export interface LoadEnvOptions {
  /** Directory holding the `.env` files (default: `Deno.cwd()`). */
  dir?: string;
  /**
   * Filenames to load, in increasing precedence (later files override earlier).
   * Default: `[".env", ".env.local"]`.
   */
  files?: string[];
  /**
   * Overwrite variables already present in `Deno.env` (e.g. real shell vars).
   * Default false — the existing environment wins, so deploy-time config is not
   * clobbered by a committed `.env`.
   */
  override?: boolean;
}

/**
 * Load `.env` files into `Deno.env`. Missing files are ignored. Returns the
 * merged file values (before the existing-environment precedence is applied), so
 * callers can inspect what the files declared.
 *
 * @param opts Directory, filenames, and override behavior.
 * @returns The merged variables parsed from the files.
 */
export async function loadEnv(opts: LoadEnvOptions = {}): Promise<Record<string, string>> {
  const dir = opts.dir ?? Deno.cwd();
  const files = opts.files ?? [".env", ".env.local"];

  // Merge file values first so a later file (e.g. .env.local) wins over an
  // earlier one, independent of what is already in the process environment.
  const merged: Record<string, string> = {};
  for (const name of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, name));
    } catch {
      continue; // missing/unreadable file is fine
    }
    Object.assign(merged, parseEnv(text));
  }

  for (const [key, value] of Object.entries(merged)) {
    if (opts.override || Deno.env.get(key) === undefined) Deno.env.set(key, value);
  }
  return merged;
}

/**
 * The public (client-exposable) subset of the loaded file values, useful when
 * you have a parsed record from {@linkcode loadEnv} and want just the public
 * part without re-reading the environment.
 *
 * @param merged A parsed env record (e.g. the return of {@link loadEnv}).
 * @returns The public subset.
 */
export function publicEnvFrom(merged: Record<string, string>): Record<string, string> {
  return filterPublicEnv(merged);
}
