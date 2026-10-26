// What the last project-verb discovery found, cached next to the project so `denext --help` can
// list a project's own verbs without importing it.
//
// Discovering verbs means importing `denext.config.ts` and running every plugin `setup()` —
// arbitrary user code, under whatever permissions the CLI holds. `denext commands` does that on
// purpose; `denext --help` must not. So the verb writes what it found to `.denext/commands.json`
// with a fingerprint of the files that decide the verb set — keyed with a per-machine secret in
// the user's cache, so a listing committed to a repository is never trusted on another machine —
// and help reads it back: a listing whose fingerprint still matches is the project's own verbs,
// and anything else is no listing at all (help then points at `denext commands`). Reading and
// writing are best-effort — a cache that is missing, stale or unreadable only costs the listing.

import { dirname, join } from "@std/path";
import { CONFIG_FILES } from "../build/config-files.ts";
import { denoCacheDir } from "../build/deno-cache-dir.ts";
import { type ProjectVerb, VERB_NAME } from "./command.ts";

/** The cache file's contents. */
interface CommandCache {
  /** {@linkcode fingerprintOf} when the listing was written. */
  readonly fingerprint: string;
  /** The project's own verbs. */
  readonly verbs: ProjectVerb[];
}

/** Where the cache lives, inside the project's build directory. */
function cachePath(dir: string): string {
  return join(dir, ".denext", "commands.json");
}

/** The files that decide which verbs a project has. */
function inputs(dir: string): string[] {
  return [...CONFIG_FILES, "deno.json", "deno.jsonc", "deno.lock"].map((name) => join(dir, name));
}

/** A file's bytes, or null when it is not there. */
async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

/** Every part joined into one buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** Where this machine's listing key lives: the user's cache, outside any project. */
function keyPath(): string {
  return join(denoCacheDir(), "denext", "command-cache.key");
}

/** The listing key once read (or made), per key path. */
const keys = new Map<string, Promise<CryptoKey | null>>();

/** The key file's bytes, made (32 random bytes, owner-only) when there is none yet. */
async function keyBytes(path: string): Promise<Uint8Array | null> {
  try {
    const bytes = await Deno.readFile(path);
    if (bytes.length >= 32) return bytes;
  } catch { /* none yet */ }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(path, fresh, { createNew: true, mode: 0o600 });
    return fresh;
  } catch {
    // Another process made it first (read theirs), or the cache can't be written (no key).
    try {
      const bytes = await Deno.readFile(path);
      return bytes.length >= 32 ? bytes : null;
    } catch {
      return null;
    }
  }
}

/**
 * This machine's key for the listing's fingerprint, or null when it can't be had (then no
 * listing is ever trusted). It never leaves the user's cache, so a listing committed to a
 * repository — whose fingerprint inputs and absolute path an attacker can predict — can't carry
 * a fingerprint this machine accepts.
 */
function listingKey(): Promise<CryptoKey | null> {
  let path: string;
  try {
    path = keyPath();
  } catch {
    return Promise.resolve(null); // no per-user cache directory: no key, so no listing is trusted
  }
  let key = keys.get(path);
  if (!key) {
    key = keyBytes(path).then((bytes) =>
      bytes === null ? null : crypto.subtle.importKey(
        "raw",
        bytes as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
    ).catch(() => null);
    keys.set(path, key);
  }
  return key;
}

/**
 * A fingerprint of the files that decide a project's verb set: its denext config, `deno.json`
 * and `deno.lock`, keyed with this machine's {@linkcode listingKey} (HMAC-SHA-256). A plugin's
 * own source is not among them — a plugin that changes which verbs it contributes without any of
 * these changing is the one case a cached listing can be stale.
 *
 * @param dir The project directory.
 * @returns The fingerprint, as hex; null when this machine has no key.
 */
async function fingerprintOf(dir: string): Promise<string | null> {
  const key = await listingKey();
  if (key === null) return null;
  const parts: Uint8Array[] = [];
  for (const path of inputs(dir)) {
    const bytes = await bytesOf(path);
    if (bytes === null) continue;
    parts.push(new TextEncoder().encode(`${path}:${bytes.length}:`), bytes);
  }
  const data = concat(parts) as BufferSource;
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a parsed cache has the shape this module writes. The file is project content (a
 * clone can commit one), so a name is held to the verb-name grammar rather than taken as any
 * string: help prints the names, and `denext <name>` is what they invite.
 */
function isCache(value: unknown): value is CommandCache {
  if (typeof value !== "object" || value === null) return false;
  const { fingerprint, verbs } = value as Record<string, unknown>;
  return typeof fingerprint === "string" && Array.isArray(verbs) &&
    verbs.every((verb) =>
      typeof verb === "object" && verb !== null &&
      typeof (verb as ProjectVerb).name === "string" &&
      VERB_NAME.test((verb as ProjectVerb).name) &&
      typeof (verb as ProjectVerb).summary === "string"
    );
}

/**
 * The verbs the last discovery in `dir` found, when the files it read have not changed since.
 *
 * @param dir The project directory.
 * @returns The verbs (possibly none), or null when there is no listing to trust.
 */
export async function readCommandCache(dir: string): Promise<ProjectVerb[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(cachePath(dir)));
  } catch {
    return null;
  }
  if (!isCache(parsed)) return null;
  const fingerprint = await fingerprintOf(dir);
  return fingerprint !== null && parsed.fingerprint === fingerprint ? parsed.verbs : null;
}

/**
 * Record what a discovery found, for help to list. Best-effort: a directory it cannot write
 * (a read-only checkout) simply keeps no cache.
 *
 * @param dir The project directory.
 * @param verbs The project's own verbs.
 */
export async function writeCommandCache(dir: string, verbs: ProjectVerb[]): Promise<void> {
  const path = cachePath(dir);
  const fingerprint = await fingerprintOf(dir);
  if (fingerprint === null) return; // no key on this machine: a listing could never be trusted
  const cache: CommandCache = { fingerprint, verbs };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch { /* a listing is worth having, not worth failing for */ }
}

/**
 * Whether `dir` holds a denext config — a file-existence probe, never an import, so a caller
 * that only needs to know (help's project footer, the listing hint) evaluates none of the
 * project's code.
 *
 * @param dir The directory to probe.
 * @returns Whether one of the config file names is a file there.
 */
export async function hasDenextConfig(dir: string): Promise<boolean> {
  for (const name of CONFIG_FILES) {
    try {
      const stat = await Deno.stat(join(dir, name));
      if (stat.isFile) return true;
    } catch { /* not this name */ }
  }
  return false;
}

/** The notices file's contents: which one-time notices were shown under which fingerprint. */
interface NoticeLog {
  readonly fingerprint: string;
  readonly shown: string[];
}

/**
 * Whether a one-time notice (`key`) should be shown now: true the first time for the project's
 * current verb-set fingerprint (its denext config, `deno.json`, `deno.lock`), and recorded so the
 * same notice stays quiet until one of those files changes. Best-effort: a project whose
 * `.denext/` can't be written shows the notice every time rather than never.
 *
 * @param dir The project directory.
 * @param key The notice's identity (e.g. `shadow:bench`).
 * @returns Whether to print it.
 */
export async function firstNotice(dir: string, key: string): Promise<boolean> {
  const path = join(dir, ".denext", "notices.json");
  const fingerprint = await fingerprintOf(dir) ?? "";
  let log: NoticeLog = { fingerprint, shown: [] };
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as NoticeLog;
    if (parsed?.fingerprint === fingerprint && Array.isArray(parsed.shown)) log = parsed;
  } catch { /* no log yet */ }
  if (log.shown.includes(key)) return false;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      `${JSON.stringify({ fingerprint, shown: [...log.shown, key] })}\n`,
    );
  } catch { /* shown again next time */ }
  return true;
}
