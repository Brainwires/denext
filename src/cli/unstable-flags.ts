// The app's `deno.json` `"unstable"` list, as the flags of the process that runs the app's code.
//
// Deno reads `"unstable": ["kv", "cron", …]` from the config file the PROCESS resolved. A denext
// verb that runs project code (`dev`, `start`, `build`, …) does that in the CLI's own process, or
// in a child the CLI re-runs (the toolchain re-exec, the CSS / module-config re-exec, the limits
// re-run). A CLI run from a checkout (`deno run -A …/cli.ts`) resolves the CHECKOUT's deno.json,
// and a re-run child takes only the flags it is given, so an app's `Deno.openKv()` failed under
// `denext start` with "Deno.openKv is not a function". These helpers turn the app's list into
// `--unstable-<name>` flags each re-run child gets, and tell the last gate before the verb runs
// whether this process still lacks some (it then re-runs once with them).

import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

/** The config names a project directory may hold. */
const CONFIG_NAMES = ["deno.json", "deno.jsonc"];

/** A valid `"unstable"` entry (`kv`, `sloppy-imports`, `temporal`). */
const UNSTABLE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The `"unstable"` entries of the config file at `path`, or none (no file, not JSON, no list).
 *
 * @param path A `deno.json` / `deno.jsonc` path.
 * @returns The entries, validated.
 */
function unstableEntriesOf(path: string): string[] {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return [];
  }
  try {
    const config = parseJsonc(text) as { unstable?: unknown } | null;
    const list = Array.isArray(config?.unstable) ? config.unstable : [];
    return list.filter((v): v is string => typeof v === "string" && UNSTABLE_NAME.test(v));
  } catch {
    return [];
  }
}

/**
 * The `--unstable-<name>` flags for the `"unstable"` list of the project in `dir` (its
 * `deno.json` or `deno.jsonc`), each once.
 *
 * @param dir The project directory.
 * @returns The flags.
 */
export function appUnstableFlags(dir: string): string[] {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name);
    try {
      Deno.statSync(path);
    } catch {
      continue;
    }
    return [...new Set(unstableEntriesOf(path).map((n) => `--unstable-${n}`))];
  }
  return [];
}

/**
 * The flags of `wanted` this process does not have: neither on its command line (`--unstable-kv`,
 * or the catch-all `--unstable`) nor in the config file it resolved.
 *
 * @param wanted The app's flags ({@linkcode appUnstableFlags}).
 * @param commandLine This process's `deno run` flags (before the script), or null when unknown.
 * @param ownConfig The config file this process resolved, or null.
 * @returns The missing flags.
 */
export function missingUnstableFlags(
  wanted: readonly string[],
  commandLine: readonly string[] | null,
  ownConfig: string | null,
): string[] {
  const have = new Set(commandLine ?? []);
  if (have.has("--unstable")) return [];
  for (const n of ownConfig ? unstableEntriesOf(ownConfig) : []) have.add(`--unstable-${n}`);
  return wanted.filter((f) => !have.has(f));
}
