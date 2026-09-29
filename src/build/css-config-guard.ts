// Keeps the css→shim redirects denext writes into an app's own `deno.json` from outliving
// the run that wrote them.
//
// A converted app resolves its modules' `.css` imports through its OWN `deno.json`, so the
// build injects absolute `file:///…/x.css` → `file:///…/.denext/css-shims/css_N.js` entries
// there for the length of the run (see `injectAppConfigRedirects` in ./css.ts), and the CSS
// graph crawl strips them again around each `deno info`. Both edits are transient. A process
// stopped mid-window — Ctrl-C, `kill`, a closed terminal, `Deno.exit` from a shutdown path —
// used to skip the restore, and the machine-specific entries ended up in the committed config.
//
// This module is the safety net: {@linkcode guardRestore} restores on the shutdown signals and
// on `unload`; {@linkcode healLeakedCssShims} removes leftovers at the next start (comments and
// formatting kept); {@linkcode leakedCssShimKeys} lets `denext doctor` report them.

import { join } from "@std/path";
import { deleteJsonValue, readJson } from "./json-edit.ts";
import { writeManagedFile } from "./self-writes.ts";

/** A shim module denext generates: `<outDir>/css-shims/css_<n>.js`. */
const SHIM_VALUE = /[/\\]css-shims[/\\]css_\d+\.js$/;
/** A stylesheet specifier (`.css`, `.scss`, `.sass`, with `.module.` forms). */
const STYLE_FILE = /\.(?:css|scss|sass)$/i;

/**
 * Whether one import-map entry is a css→shim redirect denext injected: its value points at a
 * generated shim, or its key is an absolute `file:` URL of a stylesheet (never hand-written —
 * it only resolves on the machine that wrote it).
 *
 * @param key The import-map key.
 * @param value The import-map value.
 * @returns True for an injected (and, in a committed config, leaked) entry.
 */
export function isInjectedCssShimEntry(key: string, value: unknown): boolean {
  if (typeof value === "string" && SHIM_VALUE.test(value)) return true;
  return key.startsWith("file:") && STYLE_FILE.test(key);
}

/**
 * The injected css→shim keys in a `deno.json` / `deno.jsonc` text (empty when none, or when
 * the text is not valid JSONC).
 *
 * @param source The config text.
 * @returns The offending `imports` keys, in file order.
 */
export function leakedCssShimKeysIn(source: string): string[] {
  // Cheap pre-check: both markers are absent from a clean config.
  if (!source.includes("css-shims") && !source.includes("file:")) return [];
  let cfg: unknown;
  try {
    cfg = readJson(source);
  } catch {
    return [];
  }
  const imports = (cfg as { imports?: unknown } | null)?.imports;
  if (!imports || typeof imports !== "object") return [];
  return Object.entries(imports as Record<string, unknown>)
    .filter(([k, v]) => isInjectedCssShimEntry(k, v))
    .map(([k]) => k);
}

/** The sidecar that holds the app `deno.json`'s pre-injection bytes during a build. */
export function appConfigBackupPath(outDir: string): string {
  return join(outDir, "app-config.pre-css.json");
}

/**
 * The css→shim entries left in an app's COMMITTED config — for `denext doctor`. While a run
 * has its own redirects injected (a backup sidecar exists), the backup is the committed state
 * and is what gets inspected, so a run's legitimate transient entries are never reported.
 *
 * @param configPath The app's `deno.json`.
 * @param outDir The `.denext` output dir (where the backup sidecar lives).
 * @returns The leaked `imports` keys (empty when clean or unreadable).
 */
export async function leakedCssShimKeys(configPath: string, outDir: string): Promise<string[]> {
  const committed = await Deno.readTextFile(appConfigBackupPath(outDir)).catch(() => null) ??
    await Deno.readTextFile(configPath).catch(() => null);
  return committed === null ? [] : leakedCssShimKeysIn(committed);
}

/**
 * Remove leftover css→shim entries from an app config, splicing out only those members so the
 * rest of the file — comments, key order, formatting — stays byte-for-byte. Falls back to a
 * plain JSON rewrite only when the splice refuses (a document the editor cannot parse). Logs
 * one line when it cleaned anything.
 *
 * Run only while no transient injection of this run is in place (before the CLI patches the
 * config), or it would strip that run's own redirects.
 *
 * @param configPath The app's `deno.json` / `deno.jsonc`.
 * @returns The keys removed.
 */
export async function healLeakedCssShims(configPath: string): Promise<string[]> {
  const source = await Deno.readTextFile(configPath).catch(() => null);
  if (source === null) return [];
  const keys = leakedCssShimKeysIn(source);
  if (keys.length === 0) return [];
  let next = source;
  for (const key of keys) {
    const r = await deleteJsonValue(next, ["imports", key]);
    if (!r.ok) {
      next = plainRewrite(source, keys);
      break;
    }
    next = r.source;
  }
  await writeManagedFile(configPath, next);
  console.warn(
    `denext: removed ${keys.length} leaked css-shim import entr${
      keys.length === 1 ? "y" : "ies"
    } from ${configPath} (left by an interrupted build/dev run).`,
  );
  return keys;
}

/** `source` re-serialized without `keys` in its `imports` (comments are lost). */
function plainRewrite(source: string, keys: string[]): string {
  const cfg = readJson(source) as { imports: Record<string, unknown> };
  for (const key of keys) delete cfg.imports[key];
  return JSON.stringify(cfg, null, 2) + "\n";
}

/** The signals a transient config edit is restored on (Windows has no SIGTERM/SIGHUP). */
function restoreSignals(): Deno.Signal[] {
  return Deno.build.os === "windows" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/** The exit code a shell reports for a process ended by `signal` (128 + its number). */
export function signalExitCode(signal: Deno.Signal): number {
  const numbers: Partial<Record<Deno.Signal, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
    SIGBREAK: 21,
  };
  return 128 + (numbers[signal] ?? 15);
}

/** Options for {@linkcode guardRestore}. */
export interface GuardOptions {
  /**
   * What to do after the restore when a signal arrives, in place of the default
   * `Deno.exit(128 + signal)`. The CLI's re-exec parent uses it while its build child runs:
   * it lets the child stop and exits with the child's code itself.
   */
  onSignal?: (signal: Deno.Signal) => void;
}

/**
 * Run `restore` if the process is stopped while a transient edit is in place: on SIGINT /
 * SIGTERM / SIGHUP (SIGINT / SIGBREAK on Windows) — then exit with `128 + signal` — and on
 * `unload` (a `Deno.exit` or the event loop draining). `restore` must be synchronous: the
 * process may be exiting. It runs at most once.
 *
 * @param restore Put the original bytes back.
 * @param opts See {@linkcode GuardOptions}.
 * @returns Remove the listeners (call it after the normal restore).
 */
export function guardRestore(restore: () => void, opts: GuardOptions = {}): () => void {
  let done = false;
  const runOnce = () => {
    if (done) return;
    done = true;
    try {
      restore();
    } catch { /* best effort: the next start self-heals */ }
  };
  const handlers = new Map<Deno.Signal, () => void>();
  const dispose = () => {
    for (const [sig, fn] of handlers) {
      try {
        Deno.removeSignalListener(sig, fn);
      } catch { /* not installed */ }
    }
    handlers.clear();
    globalThis.removeEventListener("unload", runOnce);
  };
  for (const sig of restoreSignals()) {
    const fn = () => {
      runOnce();
      dispose();
      if (opts.onSignal) opts.onSignal(sig);
      else Deno.exit(signalExitCode(sig));
    };
    try {
      Deno.addSignalListener(sig, fn);
      handlers.set(sig, fn);
    } catch { /* unsupported here */ }
  }
  globalThis.addEventListener("unload", runOnce);
  return dispose;
}
