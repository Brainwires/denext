// A post-build fix for Lustre's JavaScript server-component runtime
// (`lustre/runtime/server/runtime.ffi.mjs`), applied by the Gleam build step (the `gleam()`
// plugin and `denext add gleam:`) beside the `.d.mts` reference fix.
//
// In Lustre 5.7.1 three lines of `Runtime` read a binding in its own temporal dead zone
// (`const { message } = message;`, and `const { path, name, event } = message;` in a block that
// later declares `const { message }`), so every dispatched message, every client message and every
// DOM event from a client throws `ReferenceError: Cannot access 'message' before initialization`.
// The edits rename or reassign the binding and change nothing else.
//
// The patch is deliberately narrow. It applies only to a Lustre version listed below, only when
// the file is byte for byte the one that version publishes (its SHA-256), and only when the result
// is byte for byte the expected patched file. Anything else (a Lustre that fixed it upstream,
// another version, a file edited by hand) is left untouched, with one warning per file content per
// process. A file that is already the patched one is left alone silently.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { lustreVersion } from "./lustre-kit.ts";

/** One Lustre version whose server runtime denext knows how to fix. */
interface KnownRuntime {
  /** The Lustre version (`build/packages/lustre/gleam.toml`). */
  version: string;
  /** SHA-256 of the file as Lustre publishes it. */
  original: string;
  /** SHA-256 of the file after the edits. */
  patched: string;
  /** Exact `[from, to]` replacements; each `from` occurs exactly once in the original. */
  edits: ReadonlyArray<readonly [string, string]>;
}

/** The fix for the two `const { message } = message;` lines (upstream U2). */
const TDZ_NOTE = " // denext: was `const { message } = message` (a TDZ error)";

/** The runtimes denext patches. */
export const KNOWN_LUSTRE_RUNTIMES: readonly KnownRuntime[] = [{
  version: "5.7.1",
  original: "e0d42aeffaffb2e2b47909f865d649e902c0fff5d17d4a726b1b78b1c5db2d75",
  patched: "de43b55c4b94492349e4cba927fc0102ffa34e3ac4f9d92e69a2e5a0b8dc7386",
  edits: [
    [
      "      const { message } = message;\n      const next = this.#handle_client_message(message);",
      `      message = message.message;${TDZ_NOTE}\n` +
      "      const next = this.#handle_client_message(message);",
    ],
    [
      "      const { message } = message;\n" +
      "      const [model, effect] = this.#update(this.#model, message);",
      `      message = message.message;${TDZ_NOTE}\n` +
      "      const [model, effect] = this.#update(this.#model, message);",
    ],
    [
      "      const { message } = Result$Ok$0(result);\n      return this.#dispatch(message);",
      "      const { message: dispatched } = Result$Ok$0(result); // denext: a TDZ error as `message`\n" +
      "      return this.#dispatch(dispatched);",
    ],
  ],
}];

/** The server runtime's path in a Gleam project's JavaScript build. */
export function lustreServerRuntimePath(gleamDir: string): string {
  return join(
    gleamDir,
    ...["build", "dev", "javascript", "lustre", "lustre", "runtime", "server", "runtime.ffi.mjs"],
  );
}

/** What {@link patchLustreServerRuntime} did. */
export type LustrePatchResult =
  /** The project has no Lustre server runtime. */
  | "none"
  /** The file was the known original and is now the known patched file. */
  | "patched"
  /** The file was already the patched one. */
  | "already"
  /** The file is not one denext knows: left untouched (warned once). */
  | "skipped";

const sha256 = async (text: string) =>
  encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** File contents (by hash) this process already warned about. */
const warned = new Set<string>();

/**
 * Apply {@link KNOWN_LUSTRE_RUNTIMES}' fix to the project's Lustre server runtime, when the file
 * is exactly one denext knows.
 *
 * @param gleamDir The Gleam project directory.
 * @param warn Where the one warning for an unknown file goes.
 * @returns What happened.
 */
export async function patchLustreServerRuntime(
  gleamDir: string,
  warn: (message: string) => void = console.warn,
): Promise<LustrePatchResult> {
  const path = lustreServerRuntimePath(gleamDir);
  const text = await Deno.readTextFile(path).catch(() => null);
  if (text === null) return "none";
  const version = await lustreVersion(gleamDir) ?? "unknown";
  const hash = await sha256(text);
  const known = KNOWN_LUSTRE_RUNTIMES.find((k) => k.version === version);
  if (known?.patched === hash) return "already";
  const patched = known ? await patchedText(known, text, hash) : null;
  if (patched !== null) {
    await Deno.writeTextFile(path, patched);
    return "patched";
  }
  warnOnce(hash, warn, version, path);
  return "skipped";
}

/** The known fix applied to `text`, or `null` unless `text` and the result are the known files. */
async function patchedText(
  known: KnownRuntime,
  text: string,
  hash: string,
): Promise<string | null> {
  if (known.original !== hash) return null;
  const out = applyEdits(text, known.edits);
  return out !== null && await sha256(out) === known.patched ? out : null;
}

/** Say once per file content that a server runtime was left alone. */
function warnOnce(hash: string, warn: (m: string) => void, version: string, path: string): void {
  if (warned.has(hash)) return;
  warned.add(hash);
  warn(
    `denext gleam: Lustre ${version}'s server runtime is not one denext knows how to fix, so it ` +
      `is left as it is. Lustre 5.7.1's has a bug that breaks defineLustreView (a ` +
      `"Cannot access 'message' before initialization" error); a Lustre that fixed it needs ` +
      `nothing. (${path})`,
  );
}

/** `text` with every edit applied, or `null` when an edit's text is not there exactly once. */
function applyEdits(text: string, edits: KnownRuntime["edits"]): string | null {
  let out = text;
  for (const [from, to] of edits) {
    const at = out.indexOf(from);
    if (at < 0 || out.indexOf(from, at + 1) >= 0) return null;
    out = out.slice(0, at) + to + out.slice(at + from.length);
  }
  return out;
}
