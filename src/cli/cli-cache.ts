// Keep a CLI loaded from JSR (or any https URL) usable offline. The `denext` entrypoint imports a
// verb's implementation only when that verb runs (src/cli/lazy-command.ts), so `deno install -g
// jsr:@denext/denext/cli` caches the entrypoint's small graph but not the verbs': a verb first
// run offline (`--cached-only`, `denext ui --offline`'s children) would fail to load. This caches
// every on-demand module — `deno cache` of src/cli/lazy-modules.generated.ts, from the same URL
// as the running CLI — once per CLI version:
//
//   * in the background on the first run of a remote CLI (`warmCliModules`, any verb);
//   * and in the foreground from `denext toolchain install` (`cacheCliModules`), the post-install
//     step the installers and the docs run.
//
// A local checkout (`file:`) and a compiled binary (its modules are embedded) need neither.

import { join } from "@std/path";
import { denoCacheDir } from "../build/deno-cache-dir.ts";

/** The module whose graph is every module the entrypoint imports on demand. */
// Spelled so no tool reads it as an import: this module is itself in that graph (through
// `denext toolchain install`), and the URL is only ever handed to `deno cache`.
const CLI_MODULES_URL: string =
  new URL(["./lazy-modules", "generated.ts"].join("."), import.meta.url)
    .href;

/** Retry a background warm-up that has not finished (failed, offline) after this long. */
const RETRY_AFTER_MS = 10 * 60_000;

/** Whether this CLI loads its modules over the network (not a checkout, not a binary). */
export function isRemoteCli(url: string = CLI_MODULES_URL): boolean {
  return !url.startsWith("file:") && (Deno.build as { standalone?: boolean }).standalone !== true;
}

/** Marker files under `<deno cache>/denext-cli/`, one per CLI module URL (version included). */
function cliCacheMarker(url: string = CLI_MODULES_URL, cacheDir = denoCacheDir()): string {
  const key = url.replace(/^[a-z]+:\/\//i, "").replace(/[^\w.@-]+/g, "_");
  return join(cacheDir, "denext-cli", `${key}.cached`);
}

/** Whether `path` exists (and, with `youngerThanMs`, was modified within that window). */
function fresh(path: string, youngerThanMs = Infinity): boolean {
  try {
    const mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
    return Date.now() - mtime < youngerThanMs;
  } catch {
    return false;
  }
}

/** The `deno cache` argv for `url` with the resolution flags this process was started with. */
async function cacheArgs(url: string): Promise<string[]> {
  // A computed URL, so the CLI's startup graph does not take self-exec.ts in with this module.
  const { toolchainConfigArgs }: typeof import("./self-exec.ts") = await import(
    new URL("./self-exec.ts", import.meta.url).href
  );
  return ["cache", "--quiet", ...await toolchainConfigArgs(url), url];
}

/**
 * Cache every on-demand CLI module now (`denext toolchain install`). No-op for a local checkout or
 * a binary.
 *
 * @param url The lazy-modules URL (the running CLI's own, by default).
 * @returns Whether the modules are cached (`true` when there was nothing to do).
 */
export async function cacheCliModules(url: string = CLI_MODULES_URL): Promise<boolean> {
  if (!isRemoteCli(url)) return true;
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: await cacheArgs(url),
    stdin: "null",
    stdout: "null",
    stderr: "inherit",
  }).output();
  if (success) markCached(url);
  return success;
}

/** Record that `url`'s graph is cached. */
function markCached(url: string): void {
  const marker = cliCacheMarker(url);
  Deno.mkdirSync(join(marker, ".."), { recursive: true });
  Deno.writeTextFileSync(marker, new Date().toISOString());
}

/**
 * On a remote CLI's first run (per version), cache every on-demand module in a detached
 * background `deno cache`, so the verbs work offline afterwards without the caller waiting on it.
 * Never throws: a warm-up that can't start (no write access, no `--allow-run`) leaves the CLI
 * exactly as it was, and is retried on a later run.
 *
 * @param url The lazy-modules URL (the running CLI's own, by default).
 */
export async function warmCliModules(url: string = CLI_MODULES_URL): Promise<void> {
  if (!isRemoteCli(url)) return;
  try {
    const marker = cliCacheMarker(url);
    if (fresh(marker) || fresh(`${marker}.attempt`, RETRY_AFTER_MS)) return;
    Deno.mkdirSync(join(marker, ".."), { recursive: true });
    Deno.writeTextFileSync(`${marker}.attempt`, new Date().toISOString());
    // `deno eval` runs the cache and writes the marker only when it succeeded; it outlives this
    // process (detached, unref'd, no stdio). `detached` matters on Windows, where a child that
    // is not detached ends with the process that started it.
    const script = `const r = await new Deno.Command(Deno.execPath(), { args: JSON.parse(` +
      `Deno.env.get("DENEXT_CLI_CACHE_ARGS")), stdin: "null", stdout: "null", stderr: "null" })` +
      `.output(); if (r.success) Deno.writeTextFileSync(Deno.env.get("DENEXT_CLI_CACHE_MARKER"),` +
      ` new Date().toISOString());`;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "--quiet", script],
      env: {
        DENEXT_CLI_CACHE_ARGS: JSON.stringify(await cacheArgs(url)),
        DENEXT_CLI_CACHE_MARKER: marker,
      },
      stdin: "null",
      stdout: "null",
      stderr: "null",
      detached: true,
    }).spawn();
    child.unref();
  } catch {
    // Best effort: the next run tries again.
  }
}
