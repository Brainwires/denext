// What the last project-verb discovery found, cached next to the project so `denext --help` can
// list a project's own verbs without importing it.
//
// Discovering verbs means importing `denext.config.ts` and running every plugin `setup()` —
// arbitrary user code, under whatever permissions the CLI holds. `denext commands` does that on
// purpose; `denext --help` must not. So the verb writes what it found to `.denext/commands.json`
// with a fingerprint of the files that decide the verb set, and help reads it back: a listing
// whose fingerprint still matches is the project's own verbs, and anything else is no listing at
// all (help then points at `denext commands`). Reading and writing are best-effort — a cache that
// is missing, stale or unreadable only costs the listing.

import { dirname, join } from "@std/path";
import { CONFIG_FILES } from "../build/paths.ts";

/** One verb a project contributes, as help lists it. */
export interface ProjectVerb {
  /** The verb, as in `denext <name>`. */
  readonly name: string;
  /** Its one-line summary. */
  readonly summary: string;
}

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

/**
 * A fingerprint of the files that decide a project's verb set: its denext config, `deno.json`
 * and `deno.lock`. A plugin's own source is not among them — a plugin that changes which verbs
 * it contributes without any of these changing is the one case a cached listing can be stale.
 *
 * @param dir The project directory.
 * @returns The fingerprint, as hex.
 */
async function fingerprintOf(dir: string): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const path of inputs(dir)) {
    const bytes = await bytesOf(path);
    if (bytes === null) continue;
    parts.push(new TextEncoder().encode(`${path}:${bytes.length}:`), bytes);
  }
  const data = concat(parts) as BufferSource;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a parsed cache has the shape this module writes. */
function isCache(value: unknown): value is CommandCache {
  if (typeof value !== "object" || value === null) return false;
  const { fingerprint, verbs } = value as Record<string, unknown>;
  return typeof fingerprint === "string" && Array.isArray(verbs) &&
    verbs.every((verb) =>
      typeof verb === "object" && verb !== null &&
      typeof (verb as ProjectVerb).name === "string" &&
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
  return parsed.fingerprint === await fingerprintOf(dir) ? parsed.verbs : null;
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
  const cache: CommandCache = { fingerprint: await fingerprintOf(dir), verbs };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch { /* a listing is worth having, not worth failing for */ }
}
