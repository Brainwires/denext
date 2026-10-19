// Post-build fixes for two of Lustre's JavaScript runtime files, applied by the Gleam build step
// (the `gleam()` plugin and `denext add gleam:`) beside the `.d.mts` reference fix.
//
// 1. The server-component runtime (`lustre/runtime/server/runtime.ffi.mjs`). In Lustre 5.7.1 (and
//    on `main` as of 2026-10) three lines of `Runtime` read a binding in its own temporal dead zone
//    (`const { message } = message;`, and `const { path, name, event } = message;` in a block that
//    later declares `const { message }`), so every dispatched message, every client message and
//    every DOM event from a client throws `ReferenceError: Cannot access 'message' before
//    initialization`. The edits rename or reassign the binding and change nothing else.
// 2. The client (SPA) runtime (`lustre/runtime/client/spa.ffi.mjs`). Its `send` leaves
//    `SystemRequestedShutdown` as a `// TODO`, so `lustre.shutdown()` does nothing for a client
//    app: the timers and subscriptions its effects started keep dispatching into the stopped app.
//    The edit stops the runtime: every later dispatch, emit and context message is ignored.
//
// Both fixes match the code's pattern, not a version's exact bytes, so a Lustre release that only
// moved or reformatted the code is fixed too. A file is left as it is when:
// - it is already fixed (by denext: silently);
// - the bug is gone (an upstream fix: silently);
// - it is not the shape denext expects (a rewritten runtime, or the bug in a form the rewrite
//   doesn't know): with one warning per file content per process, naming what breaks without the
//   fix.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { lustreVersion } from "./lustre-kit.ts";

/** What one fix does to its file. */
interface LustreFix {
  /** The file, under the Lustre package's JavaScript build directory. */
  readonly file: readonly string[];
  /** Whether `text` is the kind of file this fix knows (its class, its methods). */
  shape(text: string): boolean;
  /** Whether `text` still has the bug. */
  broken(text: string): boolean;
  /** Whether denext's fix is in `text`. */
  fixed(text: string): boolean;
  /** `text` with the bug rewritten. */
  rewrite(text: string): string;
  /** What breaks while the file is left unfixed (the warning's second sentence). */
  readonly consequence: string;
}

/** The note on each rewritten `const { message } = message;` line. */
const TDZ_NOTE = " // denext: the destructuring read its own binding (a TDZ error)";

/** The note on the rewritten event-dispatch line. */
const DISPATCH_NOTE = " // denext: a TDZ error as `message`";

/** Any destructuring declaration of `message` itself (`const { message } = …`): the bug's shape. */
const DECLARES_MESSAGE = /\bconst\s*\{\s*message\s*\}\s*=/;

/** `text` without its line comments (where a fix's notes, old or new, quote the code it replaced). */
const code = (text: string) => text.replace(/\/\/[^\n]*/g, "");

/** What every note denext writes into a Lustre file starts with. */
const NOTE_MARK = "// denext:";

/** `const { message } = message;`, in any spacing. */
const SELF_DESTRUCTURE = /\bconst\s*\{\s*message\s*\}\s*=\s*message\s*;/g;

/** `const { message } = Result$Ok$0(x); return this.#dispatch(message);`, in any spacing. */
const DISPATCH_DESTRUCTURE =
  /\bconst\s*\{\s*message\s*\}\s*=\s*(Result\$Ok\$0\(\s*[\w$]+\s*\))\s*;(\s*)return\s+this\.#dispatch\(\s*message\s*\)\s*;/g;

/** The server-component runtime's fix (upstream U2 and U3). */
const SERVER_FIX: LustreFix = {
  file: ["lustre", "runtime", "server", "runtime.ffi.mjs"],
  shape: (text) =>
    /\bexport\s+class\s+Runtime\b/.test(text) && /#handle_client_message\s*\(/.test(text) &&
    /\bsend\s*\(\s*message\s*\)\s*\{/.test(text),
  broken: (text) => DECLARES_MESSAGE.test(code(text)),
  // Also an earlier denext's fix (its notes read differently).
  fixed: (text) => text.includes(NOTE_MARK),
  rewrite: (text) =>
    text.replace(SELF_DESTRUCTURE, `message = message.message;${TDZ_NOTE}`).replace(
      DISPATCH_DESTRUCTURE,
      (_m, ok: string, gap: string) =>
        `const { message: dispatched } = ${ok};${DISPATCH_NOTE}${gap}` +
        "return this.#dispatch(dispatched);",
    ),
  consequence: "Without the fix defineLustreView fails (a \"Cannot access 'message' before " +
    'initialization" error)',
};

/** The name of the stop function the SPA fix adds (also what marks the file as fixed). */
const SPA_STOP = "denextStopLustreRuntime";

/** `Message$isSystemRequestedShutdown(message)) { // TODO }`, in any spacing. */
const SPA_SHUTDOWN_TODO =
  /(Message\$isSystemRequestedShutdown\(\s*message\s*\)\s*\)\s*\{)\s*\/\/\s*TODO[^\n]*(\s*\})/;

/** What the SPA fix appends: stop a client `Runtime` for good. */
const SPA_STOP_FUNCTION = `
// denext: Lustre leaves SystemRequestedShutdown as a TODO for client apps, so lustre.shutdown() did
// nothing and an app's effects (timers, subscriptions) kept dispatching after it stopped. Stopping
// the runtime makes every later dispatch, emit and context message a no-op. The effects' own
// timers can't be cancelled from here (an Effect has no handle); what they send is ignored.
function ${SPA_STOP}(runtime) {
  if (!runtime || runtime.denextStopped) return;
  runtime.denextStopped = true;
  runtime.unsubscribeAll?.();
  const ignore = () => {};
  for (const key of ["dispatch", "emit", "provide", "subscribe", "unsubscribe"]) {
    runtime[key] = ignore;
  }
}
`;

/** The client (SPA) runtime's fix: `shutdown` stops the app. */
const SPA_FIX: LustreFix = {
  file: ["lustre", "runtime", "client", "spa.ffi.mjs"],
  shape: (text) =>
    /\bexport\s+class\s+Spa\b/.test(text) && /#runtime\b/.test(text) &&
    /Message\$isSystemRequestedShutdown\(/.test(text),
  broken: (text) => SPA_SHUTDOWN_TODO.test(text),
  fixed: (text) => text.includes(`function ${SPA_STOP}(`),
  rewrite: (text) =>
    text.replace(
      SPA_SHUTDOWN_TODO,
      (_m, open: string, close: string) =>
        `${open}\n      ${SPA_STOP}(this.#runtime); // denext: was a TODO${close}`,
    ) + SPA_STOP_FUNCTION,
  consequence: "Without the fix a stopped Lustre island's effects (timers, subscriptions) keep " +
    "dispatching into it",
};

/** The fixes, by the file they apply to. */
const LUSTRE_FIXES = { server: SERVER_FIX, spa: SPA_FIX } as const;

/** Which of Lustre's runtime files a fix applies to. */
export type LustreFixName = keyof typeof LUSTRE_FIXES;

/**
 * A Lustre runtime file's path in a Gleam project's JavaScript build.
 *
 * @param gleamDir The Gleam project directory.
 * @param fix Which file: the server-component runtime (default) or the client (SPA) runtime.
 * @returns The path.
 */
export function lustreRuntimePath(gleamDir: string, fix: LustreFixName = "server"): string {
  return join(gleamDir, "build", "dev", "javascript", "lustre", ...LUSTRE_FIXES[fix].file);
}

/** What {@link patchLustreRuntime} did to one file. */
export type LustrePatchResult =
  /** The project has no such Lustre file. */
  | "none"
  /** The bug was there and is now fixed. */
  | "patched"
  /** denext's fix was already in the file. */
  | "already"
  /** The file has no bug to fix (fixed upstream). */
  | "clean"
  /** The file is not a shape denext knows: left untouched (warned once). */
  | "skipped";

const sha256 = async (text: string) =>
  encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** File contents (by hash) this process already warned about. */
const warned = new Set<string>();

/**
 * Fix one of the project's Lustre runtime files when it has the known bug in a shape denext
 * recognises.
 *
 * @param gleamDir The Gleam project directory.
 * @param fix Which file.
 * @param warn Where the one warning for an unknown file goes.
 * @returns What happened.
 */
export async function patchLustreRuntime(
  gleamDir: string,
  fix: LustreFixName,
  warn: (message: string) => void = console.warn,
): Promise<LustrePatchResult> {
  const known = LUSTRE_FIXES[fix];
  const path = lustreRuntimePath(gleamDir, fix);
  const text = await Deno.readTextFile(path).catch(() => null);
  if (text === null) return "none";
  const outcome = classify(known, text);
  if (outcome === "patch") {
    await Deno.writeTextFile(path, known.rewrite(text));
    return "patched";
  }
  if (outcome !== "skipped") return outcome;
  const version = await lustreVersion(gleamDir) ?? "unknown";
  warnOnce(await sha256(text), warn, version, known, path);
  return "skipped";
}

/** What to do with `text`: patch it, leave it (already / clean), or skip it with a warning. */
function classify(known: LustreFix, text: string): "patch" | "already" | "clean" | "skipped" {
  if (!known.shape(text)) return "skipped";
  if (!known.broken(text)) return known.fixed(text) ? "already" : "clean";
  // The rewrite must leave no trace of the bug: a form it doesn't know stays as it is.
  return known.broken(known.rewrite(text)) ? "skipped" : "patch";
}

/**
 * Apply every Lustre runtime fix to the project's build.
 *
 * @param gleamDir The Gleam project directory.
 * @param warn Where the one warning per unknown file goes.
 * @returns What happened to each file.
 */
export async function patchLustreRuntimes(
  gleamDir: string,
  warn: (message: string) => void = console.warn,
): Promise<Record<LustreFixName, LustrePatchResult>> {
  return {
    server: await patchLustreRuntime(gleamDir, "server", warn),
    spa: await patchLustreRuntime(gleamDir, "spa", warn),
  };
}

/** Say once per file content that a runtime file was left alone. */
function warnOnce(
  hash: string,
  warn: (m: string) => void,
  version: string,
  known: LustreFix,
  path: string,
): void {
  if (warned.has(hash)) return;
  warned.add(hash);
  warn(
    `denext gleam: Lustre ${version}'s ${known.file.at(-1)} is not a shape denext knows how to ` +
      `fix, so it is left as it is. ${known.consequence}; a Lustre that fixed it upstream needs ` +
      `nothing. (${path})`,
  );
}
