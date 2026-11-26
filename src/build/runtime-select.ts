// The one place that decides which denext runtime release runs: the Deno toolchain the CLI
// re-runs on, the `denort` `build --compile` builds onto and the Deno Desktop runtime `desktop
// run | dev | package` build with all come from the release this module returns, so they can never
// disagree (libdenort must match the `deno desktop` CLI exactly).
//
// First match wins:
//
//   1. `DENEXT_TOOLCHAIN_PIN_FILE=<json>`: a toolchain pin file (fork development; unchanged).
//      (`DENEXT_DENO=<path> | stock` is decided before any pin, in deno-toolchain.ts.)
//   2. `DENEXT_RUNTIME=<version>`: one run on that release, which must be installed or listed in
//      the signed channel index (src/build/runtime-channel.ts); `bundled` names the bundled pin.
//   3. The project pin, read as text from the workspace root's `deno.json` / `deno.jsonc` (no
//      project code runs): `"denext": { "runtime": { "version": "3.0.0-denext.31", "integrity":
//      "sha256-<hex>" } }`. The integrity is the SHA-256 of the release document, which fixes
//      every per-target hash, so the pin is a lock: valid with an expired or unreachable channel,
//      and no key can swap its binaries.
//   4. The user default, `<DENO_DIR>/denext-deno/default.json` (`version`, `integrity`, `held`),
//      written by `denext runtime upgrade | use` and the installer: effective only at or above the
//      bundled pin unless `held`, so an old default never drags a newer denext backwards.
//   5. The bundled pin (deno-toolchain-pin.json + desktop-runtime-pin.json, with their rollback).
//
// Every selected release is verified before use: its release document must hash to the integrity
// that selected it (the bundled pins themselves count as a document of their release), and pass
// the channel's document checks (download URLs on the allow-list, one release throughout). Then
// the compatibility checks: at or above {@linkcode MIN_RUNTIME}, the esbuild denext's vendored API
// speaks, a laufey API at or above {@linkcode MIN_RUNTIME_LAUFEY_API}, and — when the channel's
// entry is known — this denext within the release's `minDenext` / `maxDenext`.
//
// The channel is never consulted to SELECT at command time. The async resolver reads the cached
// index (no network) for the entry facts, fetches a release document a lock or `DENEXT_RUNTIME`
// names when it is not cached (verified by hash), and fetches the index only for a
// `DENEXT_RUNTIME` the cached one does not list. The "newer runtime available" notice
// ({@linkcode runtimeUpdateNotice}) is the only other use: cached, rate-limited, offline-safe.
//
// A process the CLI started on a selected release gets `DENEXT_TOOLCHAIN_ACTIVE=<version>` and
// `DENEXT_RUNTIME_INTEGRITY=sha256-<hex>`: its synchronous readers ({@linkcode
// activeRuntimeRelease}) load that cached document, re-checked against the hash, so a child
// follows its parent's choice (a revocation fallback included) even from another directory.

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import toolchainPinJson from "./deno-toolchain-pin.json" with { type: "json" };
import desktopPinJson from "./desktop-runtime-pin.json" with { type: "json" };
import type { DenoToolchainPin } from "./deno-toolchain.ts";
import type { DesktopRuntimePin } from "./desktop-runtime.ts";
import { compareDenoVersions, MIN_RUNTIME, MIN_RUNTIME_LAUFEY_API } from "./deno-version.ts";
import { ESBUILD_VERSION } from "./esbuild/version.ts";
import { VERSION } from "../version.ts";
import {
  checkChannelRelease,
  checkReleaseDocument,
  isChannelReleaseVersion,
  type LoadedChannel,
  loadReleaseDocument,
  loadRuntimeChannel,
  RELEASE_DOCUMENT_MAX_BYTES,
  releaseDocumentText,
  releaseDocumentUrls,
  type RuntimeChannel,
  type RuntimeChannelRelease,
  type RuntimeReleaseDocument,
} from "./runtime-channel.ts";
import {
  type EnvGet,
  fetchTextCapped,
  processEnv,
  toolchainCacheRoot,
  writeQuietly,
} from "./signed-envelope.ts";
import {
  decideRevocation,
  findRevocation,
  type LoadRevocationsOptions,
  loadRuntimeRevocations,
  REVOCATION_NOTICED_ENV,
  type RevocationMode,
  revocationNotice,
  type RevocationSubject,
  revokesVersion,
  type RuntimeComponent,
  type RuntimeRevocationList,
} from "./runtime-revocations.ts";
import { CONFIG_NAMES, workspaceRootSync } from "./workspace-imports.ts";
import { type DepAgeRule, readProjectRule } from "./dep-age.ts";

/** `DENEXT_RUNTIME=<version | bundled>`: one run on that release. */
const RUNTIME_ENV = "DENEXT_RUNTIME";
/** The release document hash a parent hands its children with the toolchain marker. */
export const RUNTIME_INTEGRITY_ENV = "DENEXT_RUNTIME_INTEGRITY";
/** Set once the "newer runtime available" notice was said in this process tree. */
export const RUNTIME_NOTICED_ENV = "DENEXT_RUNTIME_NOTICED";
/** The user default's file name under the toolchain cache. */
export const USER_DEFAULT_FILE = "default.json";
/**
 * Another file for the user default than `<cache>/default.json` (the test harness points it at a
 * file that does not exist, so no test sees the machine's own default).
 */
export const RUNTIME_DEFAULT_FILE_ENV = "DENEXT_RUNTIME_DEFAULT_FILE";
/** Where release documents are cached under the toolchain cache (runtime-channel.ts writes it). */
const RELEASES_DIR = "releases";
/** The toolchain marker (deno-toolchain.ts `TOOLCHAIN_ACTIVE_ENV`). */
const ACTIVE_ENV = "DENEXT_TOOLCHAIN_ACTIVE";
/** The toolchain pin file override (deno-toolchain.ts). */
const PIN_FILE_ENV = "DENEXT_TOOLCHAIN_PIN_FILE";
/** The notice's rate-limit state under the toolchain cache. */
const NOTICE_STATE_FILE = "channel.notice.json";
/** The same release is announced at most once a day. */
const NOTICE_REPEAT_MS = 24 * 3600_000;
const INTEGRITY = /^sha256-([0-9a-f]{64})$/;

/** Where the release in force came from. */
export type RuntimeSource =
  /** `DENEXT_TOOLCHAIN_PIN_FILE`. */
  | "override"
  /** `DENEXT_RUNTIME`. */
  | "env"
  /** The project pin in the workspace root's `deno.json`. */
  | "project"
  /** The user default (`denext runtime use | upgrade`). */
  | "default"
  /** The parent process's choice (`DENEXT_TOOLCHAIN_ACTIVE` + `DENEXT_RUNTIME_INTEGRITY`). */
  | "inherited"
  /** The pins compiled into this denext. */
  | "bundled";

/** A release named by its version and its release document's hash (a lock). */
export interface RuntimeLock {
  /** The runtime version (`3.0.0-denext.31`). */
  readonly version: string;
  /** `sha256-<hex>`: the SHA-256 of the release document's bytes. */
  readonly integrity: string;
}

/** The user default (`<DENO_DIR>/denext-deno/default.json`). */
export interface UserRuntimeDefault extends RuntimeLock {
  /**
   * Set by `denext runtime use <version>`: effective even below the bundled pin. Unset (`runtime
   * upgrade`, the installer): a newer denext's bundled pin wins over it.
   */
  readonly held: boolean;
}

/** The project pin, and the config file it was read from. */
export interface ProjectRuntimePin {
  readonly lock: RuntimeLock;
  /** The workspace root's `deno.json` / `deno.jsonc`. */
  readonly configPath: string;
}

/** The two pins of a release: what the toolchain and the desktop runtime install from. */
export interface RuntimePins {
  readonly toolchain: DenoToolchainPin;
  readonly desktop: DesktopRuntimePin;
}

/** The release in force, and why. */
export interface RuntimeRelease extends RuntimePins {
  readonly source: RuntimeSource;
  /** The runtime version (`null`: the toolchain pin names none). */
  readonly version: string | null;
  /** The release document's `sha256-<hex>`; `null` for the bundled pins and the pin file. */
  readonly integrity: string | null;
  /** Lines to say once (a skipped user default, a revocation fallback, a yanked release). */
  readonly notices: readonly string[];
}

/** A selection that cannot run: a broken or incompatible project pin, a bad `DENEXT_RUNTIME`. */
export class RuntimeSelectError extends Error {
  override name = "RuntimeSelectError";
}

/** The pins this denext was released with (each with its `rollback`). */
export const BUNDLED_RUNTIME: RuntimePins = {
  toolchain: toolchainPinJson as DenoToolchainPin,
  desktop: desktopPinJson as DesktopRuntimePin,
};

// ---------------------------------------------------------------------------------------------
// Integrity and release documents.

/**
 * A lock's integrity for a release document's SHA-256.
 *
 * @param sha256 The hex digest.
 * @returns `sha256-<hex>`.
 */
export function releaseIntegrity(sha256: string): string {
  return `sha256-${sha256.toLowerCase()}`;
}

/** The hex digest an integrity names, or `null` when it is not `sha256-<64 hex>`. */
function integrityHex(integrity: string): string | null {
  return INTEGRITY.exec(integrity)?.[1] ?? null;
}

/** The SHA-256 of `text`'s UTF-8 bytes, hex (synchronous: the sync readers need it). */
function sha256HexSync(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A pin without its `rollback`. */
function withoutRollback<T extends { rollback?: unknown }>(pin: T): Omit<T, "rollback"> {
  const { rollback: _, ...rest } = pin;
  return rest;
}

/**
 * The release document of a release's pins: both pins without their `rollback` (what
 * `runtime:publish` hashes for the same release).
 *
 * @param pins The pins.
 * @returns The document.
 */
export function releaseDocumentOf(pins: RuntimePins): RuntimeReleaseDocument {
  return {
    toolchain: withoutRollback(pins.toolchain) as DenoToolchainPin,
    desktop: withoutRollback(pins.desktop) as DesktopRuntimePin,
  };
}

/**
 * The lock of a release's pins: its version and the integrity of {@linkcode releaseDocumentOf}.
 *
 * @param pins The pins.
 * @returns The lock, or `null` when the toolchain pin names no version.
 */
export function lockOfPins(pins: RuntimePins): RuntimeLock | null {
  const version = pins.toolchain.version;
  if (version === null) return null;
  const known = lockCache.get(pins.toolchain)?.get(pins.desktop);
  if (known) return known;
  const lock = {
    version,
    integrity: releaseIntegrity(sha256HexSync(releaseDocumentText(releaseDocumentOf(pins)))),
  };
  const byDesktop = lockCache.get(pins.toolchain) ?? new WeakMap();
  byDesktop.set(pins.desktop, lock);
  lockCache.set(pins.toolchain, byDesktop);
  return lock;
}

/** {@linkcode lockOfPins}' answers, per pin pair (the bundled pins are hashed once). */
const lockCache = new WeakMap<object, WeakMap<object, RuntimeLock>>();

/** The facts a parsed document states about itself (whatever its shape: the checks come next). */
function statedFacts(raw: unknown) {
  const doc = (raw ?? {}) as {
    toolchain?: Partial<DenoToolchainPin> & { minGlibc?: string };
    desktop?: { laufeyApiVersion?: number | null };
  };
  const toolchain = doc.toolchain ?? {};
  const first = Object.values(toolchain.targets ?? {})[0];
  return {
    deno: toolchain.deno,
    esbuild: first?.esbuild?.version,
    laufeyApi: doc.desktop?.laufeyApiVersion ?? null,
    minGlibc: toolchain.minGlibc ?? null,
  };
}

/** The index entry a document must agree with, built from the document itself (a lock has no entry). */
function entryOfDocument(raw: unknown, lock: RuntimeLock, sha: string, size: number) {
  return checkChannelRelease({
    version: lock.version,
    tag: `denext-runtime-v${lock.version}`,
    releasedAt: "1970-01-01T00:00:00Z",
    minDenext: "0.0.0",
    ...statedFacts(raw),
    doc: { sha256: sha, size },
  });
}

/**
 * Verify a release document against a lock: its bytes must hash to the lock's integrity (checked
 * before parsing), then the channel's document checks against the release the lock names (both
 * pins of that version and tag, no `rollback`, allowed download URLs only).
 *
 * @param text The document.
 * @param lock The lock.
 * @returns The document.
 * @throws {RuntimeSelectError} When it is refused.
 */
export function verifyLockedDocument(text: string, lock: RuntimeLock): RuntimeReleaseDocument {
  const want = integrityHex(lock.integrity);
  if (want === null) throw new RuntimeSelectError(`bad integrity ${lock.integrity}`);
  const size = new TextEncoder().encode(text).byteLength;
  if (size > RELEASE_DOCUMENT_MAX_BYTES) {
    throw new RuntimeSelectError(`the release document of ${lock.version} is too large`);
  }
  const got = sha256HexSync(text);
  if (got !== want) {
    throw new RuntimeSelectError(
      `the release document of ${lock.version} hashes to sha256-${got}, the lock says ${lock.integrity}`,
    );
  }
  try {
    const raw = JSON.parse(text);
    return checkReleaseDocument(raw, entryOfDocument(raw, lock, got, size));
  } catch (err) {
    throw new RuntimeSelectError(
      `the release document of ${lock.version} is refused: ${errText(err)}`,
    );
  }
}

const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

/** A cached release document's path. */
function cachedDocumentPath(cacheRoot: string, version: string): string {
  return join(cacheRoot, RELEASES_DIR, `${version}.json`);
}

/**
 * The cached release document a lock names (`<cache>/releases/<version>.json`), verified; `null`
 * when it is not cached or no longer hashes to the lock (a later fetch replaces it).
 *
 * @param cacheRoot The toolchain cache.
 * @param lock The lock.
 * @returns The document, or `null`.
 */
export function readCachedReleaseDocument(
  cacheRoot: string,
  lock: RuntimeLock,
): RuntimeReleaseDocument | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(cachedDocumentPath(cacheRoot, lock.version));
  } catch {
    return null;
  }
  try {
    return verifyLockedDocument(text, lock);
  } catch {
    return null;
  }
}

/** Options for {@linkcode fetchLockedReleaseDocument}. */
export interface FetchLockedOptions {
  readonly cacheRoot: string;
  /** Default the channel's bases. */
  readonly bases?: readonly string[];
  readonly fetch?: typeof fetch;
  /** Default 10 s. */
  readonly budgetMs?: number;
}

/**
 * Fetch the release document a lock names from the channel's bases (denext.dev, then the mirror)
 * — trusted by the lock's hash alone, so no index signature is needed — and cache it.
 *
 * @param lock The lock.
 * @param options The cache and seams.
 * @returns The document.
 * @throws {RuntimeSelectError} When no copy verifies (offline included).
 */
export async function fetchLockedReleaseDocument(
  lock: RuntimeLock,
  options: FetchLockedOptions,
): Promise<RuntimeReleaseDocument> {
  const signal = AbortSignal.timeout(options.budgetMs ?? 10_000);
  const problems: string[] = [];
  for (const url of releaseDocumentUrls(lock.version, options.bases)) {
    try {
      const text = await fetchTextCapped(
        url,
        signal,
        options.fetch ?? fetch,
        RELEASE_DOCUMENT_MAX_BYTES,
      );
      const doc = verifyLockedDocument(text, lock);
      await writeQuietly(options.cacheRoot, join(RELEASES_DIR, `${lock.version}.json`), text);
      return doc;
    } catch (err) {
      problems.push(`${url}: ${errText(err)}`);
    }
  }
  throw new RuntimeSelectError(
    `no copy of the release document of ${lock.version} verifies (${problems.join("; ")})`,
  );
}

/**
 * The pins a lock names, with no network: the bundled pins when the lock is their release (they
 * keep their `rollback`), the bundled rollback's release, else the cached document.
 */
function lockedPinsSync(
  lock: RuntimeLock,
  bundled: RuntimePins,
  cacheRoot: string | null,
): RuntimePins | null {
  for (const pins of bundledReleases(bundled)) {
    const own = lockOfPins(pins);
    if (own?.version === lock.version && own.integrity === lock.integrity) return pins;
  }
  return cacheRoot === null ? null : readCachedReleaseDocument(cacheRoot, lock);
}

/** The toolchain cache, or `null` when the environment names none (no `DENO_DIR` / home). */
function safeCacheRoot(env: EnvGet, given?: string): string | null {
  if (given) return given;
  try {
    return toolchainCacheRoot(env);
  } catch {
    return null;
  }
}

/**
 * The user default's file: `<cacheRoot>/default.json` when the caller names the cache, else
 * {@linkcode RUNTIME_DEFAULT_FILE_ENV}, else `<DENO_DIR>/denext-deno/default.json`.
 *
 * @param env Env reader (default the process's).
 * @param cacheRoot The toolchain cache, when the caller names one.
 * @returns The path, or `null` when the environment names no cache.
 */
export function userRuntimeDefaultFile(
  env: EnvGet = processEnv,
  cacheRoot?: string,
): string | null {
  if (cacheRoot) return join(cacheRoot, USER_DEFAULT_FILE);
  const override = env(RUNTIME_DEFAULT_FILE_ENV)?.trim();
  if (override) return override;
  const root = safeCacheRoot(env);
  return root === null ? null : join(root, USER_DEFAULT_FILE);
}

/** The user default in `file`, or `null` without one. */
function userDefaultIn(file: string | null): UserRuntimeDefault | null {
  return file === null ? null : readUserRuntimeDefaultFile(file);
}

/**
 * The releases this denext bundles: its pins, and their rollback release when both pins name the
 * same one (`denext runtime use | install` of either needs no channel).
 *
 * @param bundled The bundled pins (default {@linkcode BUNDLED_RUNTIME}).
 * @returns The releases, the bundled one first.
 */
export function bundledRuntimeReleases(bundled: RuntimePins = BUNDLED_RUNTIME): RuntimePins[] {
  return bundledReleases(bundled);
}

/** The bundled release, and its rollback release when both pins name the same one. */
function bundledReleases(bundled: RuntimePins): RuntimePins[] {
  const out: RuntimePins[] = [bundled];
  const t = bundled.toolchain.rollback;
  const d = bundled.desktop.rollback;
  if (t && d && t.version === d.version) {
    out.push({
      toolchain: {
        schema: 1,
        ...(bundled.toolchain.repository ? { repository: bundled.toolchain.repository } : {}),
        ...t,
      } as DenoToolchainPin,
      desktop: { schema: 1, ...d } as DesktopRuntimePin,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Compatibility.

/** What the compatibility checks read about a release. */
export interface RuntimeFacts {
  readonly version: string;
  /** The esbuild its CLI archives carry (`null`: none recorded). */
  readonly esbuild: string | null;
  /** Its Deno Desktop runtime's laufey API (`null`: none recorded). */
  readonly laufeyApi: number | null;
  /** From the channel's entry, when known. */
  readonly minDenext?: string;
  readonly maxDenext?: string;
}

/**
 * A release's facts from its pins (no `minDenext` / `maxDenext`: only the channel's entry says).
 *
 * @param pins The pins.
 * @returns The facts.
 */
export function factsOfPins(pins: RuntimePins): RuntimeFacts {
  const esbuilds = new Set(Object.values(pins.toolchain.targets).map((a) => a.esbuild?.version));
  const [only] = esbuilds;
  return {
    version: pins.toolchain.version ?? "",
    esbuild: esbuilds.size === 1 && typeof only === "string" ? only : null,
    laufeyApi: pins.desktop.laufeyApiVersion ?? null,
  };
}

/**
 * A release's facts from its channel entry.
 *
 * @param entry The entry.
 * @returns The facts.
 */
export function factsOfEntry(entry: RuntimeChannelRelease): RuntimeFacts {
  return {
    version: entry.version,
    esbuild: entry.esbuild,
    laufeyApi: entry.laufeyApi,
    minDenext: entry.minDenext,
    ...(entry.maxDenext ? { maxDenext: entry.maxDenext } : {}),
  };
}

/** Why a release does not run under this denext. */
export interface RuntimeIncompatibility {
  readonly kind: "below-floor" | "esbuild" | "laufey" | "needs-denext" | "drops-denext";
  readonly message: string;
}

/** What the compatibility checks compare against (tests pass their own). */
export interface CompatTarget {
  /** Default this denext's {@linkcode VERSION}. */
  readonly denext?: string;
  /** Default {@linkcode ESBUILD_VERSION}. */
  readonly esbuild?: string;
  /** Default {@linkcode MIN_RUNTIME}. */
  readonly minRuntime?: string;
  /** Default {@linkcode MIN_RUNTIME_LAUFEY_API}. */
  readonly minLaufeyApi?: number;
}

/** {@linkcode MIN_RUNTIME} (or the target's floor). */
function floorIncompatibility(f: RuntimeFacts, t: CompatTarget): RuntimeIncompatibility | null {
  const floor = t.minRuntime ?? MIN_RUNTIME;
  if (compareDenoVersions(f.version, floor) >= 0) return null;
  return {
    kind: "below-floor",
    message: `runtime ${f.version} is older than ${floor}, the oldest denext ${
      t.denext ?? VERSION
    } runs on`,
  };
}

/** The esbuild denext's vendored API speaks. */
function esbuildIncompatibility(f: RuntimeFacts, t: CompatTarget): RuntimeIncompatibility | null {
  const esbuild = t.esbuild ?? ESBUILD_VERSION;
  if (f.esbuild === esbuild) return null;
  return {
    kind: "esbuild",
    message: `runtime ${f.version} carries esbuild ${
      f.esbuild ?? "(none)"
    }; denext's esbuild API speaks ${esbuild}`,
  };
}

/** The laufey API level denext's desktop glue needs. */
function laufeyIncompatibility(f: RuntimeFacts, t: CompatTarget): RuntimeIncompatibility | null {
  const laufey = t.minLaufeyApi ?? MIN_RUNTIME_LAUFEY_API;
  if (f.laufeyApi !== null && f.laufeyApi >= laufey) return null;
  return {
    kind: "laufey",
    message: `runtime ${f.version}'s Deno Desktop runtime has laufey API ${
      f.laufeyApi ?? "(none)"
    }; denext's desktop glue needs ${laufey} or later`,
  };
}

/** The entry's `minDenext` / `maxDenext` range against this denext. */
function rangeIncompatibility(f: RuntimeFacts, t: CompatTarget): RuntimeIncompatibility | null {
  const denext = t.denext ?? VERSION;
  if (f.minDenext && compareDenoVersions(denext, f.minDenext) < 0) {
    return {
      kind: "needs-denext",
      message: `runtime ${f.version} needs denext ${f.minDenext} or newer: run "denext upgrade"`,
    };
  }
  if (f.maxDenext && compareDenoVersions(denext, f.maxDenext) > 0) {
    return {
      kind: "drops-denext",
      message: `runtime ${f.version} runs only up to denext ${f.maxDenext}`,
    };
  }
  return null;
}

/**
 * Why a release does not run under this denext, or `null` when it does: at or above
 * {@linkcode MIN_RUNTIME}, the esbuild denext's vendored API speaks, a laufey API at or above
 * {@linkcode MIN_RUNTIME_LAUFEY_API}, and (when the facts carry them) within `minDenext` /
 * `maxDenext`.
 *
 * @param facts The release's facts.
 * @param target What to compare against (default: this denext).
 * @returns The first problem, or `null`.
 */
export function runtimeIncompatibility(
  facts: RuntimeFacts,
  target: CompatTarget = {},
): RuntimeIncompatibility | null {
  return floorIncompatibility(facts, target) ?? esbuildIncompatibility(facts, target) ??
    laufeyIncompatibility(facts, target) ?? rangeIncompatibility(facts, target);
}

// ---------------------------------------------------------------------------------------------
// The project pin and the user default.

/**
 * The config a project pin lives in: the workspace root's `deno.json` / `deno.jsonc` for the
 * project in `dir` (outside a workspace, the nearest config).
 *
 * @param dir The project directory.
 * @returns The path, or `null` when no config is found.
 */
export function projectRuntimeConfigPath(dir: string): string | null {
  return rootConfigOf(dir);
}

/** The root config of the workspace `dir` is in (its own config outside a workspace), or `null`. */
function rootConfigOf(dir: string): string | null {
  for (let at = resolve(dir);; at = dirname(at)) {
    for (const name of CONFIG_NAMES) {
      const path = join(at, name);
      if (isFile(path)) {
        const root = workspaceRootSync(path);
        return root === null ? path : configFileIn(root) ?? path;
      }
    }
    if (dirname(at) === at) return null;
  }
}

/** The `deno.json` / `deno.jsonc` in `dir`, or `null`. */
function configFileIn(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    if (isFile(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Whether `path` is a file. */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** The fix every malformed project pin names. */
const PROJECT_PIN_FIX = "  Fix: `denext runtime use <version> --project` rewrites it.";

/** A `{ version, integrity }` object as a lock, or why not. */
function lockOf(raw: unknown): RuntimeLock | string {
  const r = raw as { version?: unknown; integrity?: unknown } | null;
  if (typeof r?.version !== "string" || !isChannelReleaseVersion(r.version)) {
    return "its version must be a denext runtime version (3.0.0-denext.N)";
  }
  if (typeof r.integrity !== "string" || integrityHex(r.integrity) === null) {
    return "its integrity must be sha256-<64 hex digits> (the release document's hash)";
  }
  return { version: r.version, integrity: r.integrity };
}

/**
 * The project pin of the workspace `dir` belongs to: `denext.runtime` in the workspace root's
 * `deno.json` / `deno.jsonc` (outside a workspace, the nearest config's), read as text.
 *
 * @param dir The project directory.
 * @returns The pin, or `null` when the project pins no runtime.
 * @throws {RuntimeSelectError} When the pin is malformed.
 */
export function readProjectRuntimePin(dir: string): ProjectRuntimePin | null {
  const configPath = rootConfigOf(dir);
  if (configPath === null) return null;
  let config: { denext?: { runtime?: unknown } } | null;
  try {
    config = parseJsonc(Deno.readTextFileSync(configPath)) as typeof config;
  } catch {
    return null; // Deno reports an unreadable config itself
  }
  const raw = config?.denext?.runtime;
  if (raw === undefined) return null;
  const lock = lockOf(raw);
  if (typeof lock === "string") {
    throw new RuntimeSelectError(
      `denext: the runtime pin in ${configPath} ("denext": { "runtime": … }) is malformed: ` +
        `${lock}.\n${PROJECT_PIN_FIX}`,
    );
  }
  return { lock, configPath };
}

/**
 * The user default (`<cache>/default.json`), or `null` when there is none or it is unreadable or
 * malformed (it is then ignored).
 *
 * @param cacheRoot The toolchain cache.
 * @returns The default.
 */
export function readUserRuntimeDefault(cacheRoot: string): UserRuntimeDefault | null {
  return readUserRuntimeDefaultFile(join(cacheRoot, USER_DEFAULT_FILE));
}

/**
 * The user default in `file` ({@linkcode userRuntimeDefaultFile}), or `null` when there is none or
 * it is unreadable or malformed.
 *
 * @param file The default's file.
 * @returns The default.
 */
export function readUserRuntimeDefaultFile(file: string): UserRuntimeDefault | null {
  let raw: { schema?: unknown; held?: unknown } | null;
  try {
    raw = JSON.parse(Deno.readTextFileSync(file));
  } catch {
    return null;
  }
  if (raw?.schema !== 1) return null;
  const lock = lockOf(raw);
  if (typeof lock === "string") return null;
  return { ...lock, held: raw.held === true };
}

/**
 * Write the user default (`denext runtime upgrade | use`, the installer): atomically, through a
 * temp file in the same directory.
 *
 * @param cacheRoot The toolchain cache.
 * @param value The default.
 * @param file The default's file (default `<cacheRoot>/default.json`).
 */
export async function writeUserRuntimeDefault(
  cacheRoot: string,
  value: UserRuntimeDefault,
  file: string = join(cacheRoot, USER_DEFAULT_FILE),
): Promise<void> {
  const lock = lockOf(value);
  if (typeof lock === "string") throw new RuntimeSelectError(`the default is malformed: ${lock}`);
  const dir = dirname(file);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
  const text = JSON.stringify({ schema: 1, ...lock, held: value.held }, null, 2) + "\n";
  try {
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, file);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Resolving.

/** Options shared by the resolvers. */
export interface ResolveRuntimeOptions {
  /** Env reader (default the process's). */
  readonly env?: EnvGet;
  /** Where the project pin is looked for (default the working directory). */
  readonly projectDir?: string;
  /** Default `<DENO_DIR>/denext-deno`. */
  readonly cacheRoot?: string;
  /** Default {@linkcode BUNDLED_RUNTIME}. */
  readonly bundled?: RuntimePins;
  /** What the compatibility checks compare against (default this denext). */
  readonly compat?: CompatTarget;
}

/** Options for {@linkcode resolveRuntimeReleaseSync}: the async resolver's findings. */
export interface ResolveRuntimeSyncOptions extends ResolveRuntimeOptions {
  /** The lock of the `DENEXT_RUNTIME` release (from the channel's entry). */
  readonly envLock?: RuntimeLock;
  /** Channel entries by version, for `minDenext` / `maxDenext` / `yanked`. */
  readonly entries?: ReadonlyMap<string, RuntimeChannelRelease>;
}

/** What every rung reads, resolved once. */
interface Ctx {
  readonly env: EnvGet;
  readonly projectDir: string;
  readonly cacheRoot: string | null;
  /** The user default's file ({@linkcode userRuntimeDefaultFile}). */
  readonly defaultFile: string | null;
  readonly bundled: RuntimePins;
  readonly compat: CompatTarget;
  readonly envLock?: RuntimeLock;
  readonly entries: ReadonlyMap<string, RuntimeChannelRelease>;
}

function ctxOf(o: ResolveRuntimeSyncOptions): Ctx {
  const env = o.env ?? processEnv;
  return {
    env,
    projectDir: o.projectDir ?? cwdOr("."),
    cacheRoot: safeCacheRoot(env, o.cacheRoot),
    defaultFile: userRuntimeDefaultFile(env, o.cacheRoot),
    bundled: o.bundled ?? BUNDLED_RUNTIME,
    compat: o.compat ?? {},
    ...(o.envLock ? { envLock: o.envLock } : {}),
    entries: o.entries ?? new Map(),
  };
}

function cwdOr(fallback: string): string {
  try {
    return Deno.cwd();
  } catch {
    return fallback;
  }
}

/** The bundled release, from `source`. */
function bundledRelease(
  bundled: RuntimePins,
  source: RuntimeSource = "bundled",
  notices: readonly string[] = [],
): RuntimeRelease {
  return { source, version: bundled.toolchain.version, ...bundled, integrity: null, notices };
}

/** A release from `pins` selected by `lock`. */
function lockedRelease(
  pins: RuntimePins,
  source: RuntimeSource,
  lock: RuntimeLock,
  notices: readonly string[] = [],
): RuntimeRelease {
  return { source, version: lock.version, ...pins, integrity: lock.integrity, notices };
}

/** The facts of `pins`, with the channel entry's range when it is known. */
function factsFor(pins: RuntimePins, ctx: Ctx): RuntimeFacts {
  const facts = factsOfPins(pins);
  const entry = ctx.entries.get(facts.version);
  return entry
    ? {
      ...facts,
      minDenext: entry.minDenext,
      ...(entry.maxDenext ? { maxDenext: entry.maxDenext } : {}),
    }
    : facts;
}

/** The one-line warning for a yanked release that still runs. */
function yankedNotices(version: string, ctx: Ctx): string[] {
  const yanked = ctx.entries.get(version)?.yanked;
  return yanked
    ? [
      `denext: runtime ${version} was withdrawn (${yanked.reason}); \`denext runtime upgrade\` ` +
      "moves to a current release.",
    ]
    : [];
}

/** The `DENEXT_TOOLCHAIN_PIN_FILE` pin (fork development, tests). */
function pinFileRelease(file: string, bundled: RuntimePins): RuntimeRelease {
  let pin: DenoToolchainPin;
  try {
    pin = JSON.parse(Deno.readTextFileSync(file));
  } catch (err) {
    throw new Error(`denext: ${PIN_FILE_ENV}=${file} is not a readable pin: ${err}`);
  }
  if (pin?.schema !== 1 || typeof pin.targets !== "object" || pin.targets === null) {
    throw new Error(`denext: ${PIN_FILE_ENV}=${file} is not a schema-1 toolchain pin`);
  }
  return {
    source: "override",
    version: pin.version,
    toolchain: pin,
    desktop: bundled.desktop,
    integrity: null,
    notices: [],
  };
}

/** The lock a `DENEXT_RUNTIME=<version>` resolves to with no network, or `null`. */
function envLockSync(version: string, ctx: Ctx): RuntimeLock | null {
  if (ctx.envLock?.version === version) return ctx.envLock;
  const integrity = ctx.env(RUNTIME_INTEGRITY_ENV)?.trim();
  if (integrity && ctx.env(ACTIVE_ENV) === version) return { version, integrity };
  const known = [safeProjectLock(ctx), userDefaultIn(ctx.defaultFile)];
  return known.find((l) => l?.version === version) ?? null;
}

/** The project lock, or `null` (a malformed one is reported by its own rung). */
function safeProjectLock(ctx: Ctx): RuntimeLock | null {
  try {
    return readProjectRuntimePin(ctx.projectDir)?.lock ?? null;
  } catch {
    return null;
  }
}

/** Rung 2: `DENEXT_RUNTIME`. */
function envRung(raw: string, ctx: Ctx): RuntimeRelease {
  const version = raw.trim();
  const { bundled } = ctx;
  if (version.toLowerCase() === "bundled") return bundledRelease(bundled, "env");
  const own = bundledReleases(bundled).find((p) => p.toolchain.version === version);
  if (own === bundled) return bundledRelease(bundled, "env");
  if (own) return lockedRelease(own, "env", lockOfPins(own)!);
  if (!isChannelReleaseVersion(version)) {
    throw new RuntimeSelectError(
      `denext: ${RUNTIME_ENV}=${version} is not a denext runtime version (3.0.0-denext.N, or ` +
        "`bundled`).",
    );
  }
  const lock = envLockSync(version, ctx);
  const pins = lock && lockedPinsSync(lock, bundled, ctx.cacheRoot);
  if (!lock || !pins) {
    throw new RuntimeSelectError(
      `denext: ${RUNTIME_ENV}=${version} is not installed.\n  Fix: run \`denext runtime install ` +
        `${version}\` (online), or unset ${RUNTIME_ENV}.`,
    );
  }
  const bad = runtimeIncompatibility(factsFor(pins, ctx), ctx.compat);
  if (bad) throw new RuntimeSelectError(`denext: ${RUNTIME_ENV}=${version}: ${bad.message}.`);
  return lockedRelease(pins, "env", lock, yankedNotices(version, ctx));
}

/** Why a project pin cannot run: the message, with its fix. */
function projectPinRefusal(pin: ProjectRuntimePin, bad: RuntimeIncompatibility): string {
  const fix = bad.kind === "needs-denext"
    ? ""
    : `\n  Fix: \`denext runtime use <version> --project\` pins a release this denext runs on ` +
      "(`denext runtime use bundled --project` pins the bundled one).";
  return `denext: the project pins runtime ${pin.lock.version} (${pin.configPath}), but ` +
    `${bad.message}.${fix}`;
}

/** Rung 3: the project pin. */
function projectRung(pin: ProjectRuntimePin, ctx: Ctx): RuntimeRelease {
  const pins = lockedPinsSync(pin.lock, ctx.bundled, ctx.cacheRoot);
  if (!pins) {
    throw new RuntimeSelectError(
      `denext: the project pins runtime ${pin.lock.version} (${pin.configPath}), which is not ` +
        "installed here (or its cached release document no longer matches the pin's integrity).\n" +
        "  Fix: run `denext runtime install` (online), then retry.",
    );
  }
  const bad = runtimeIncompatibility(factsFor(pins, ctx), ctx.compat);
  if (bad) throw new RuntimeSelectError(projectPinRefusal(pin, bad));
  return lockedRelease(pins, "project", pin.lock, yankedNotices(pin.lock.version, ctx));
}

/** Rung 4: the user default — the release, or why it is skipped (`null`: silently). */
function defaultRung(d: UserRuntimeDefault, ctx: Ctx): RuntimeRelease | string | null {
  const bundledVersion = ctx.bundled.toolchain.version;
  if (bundledVersion !== null && compareDenoVersions(d.version, bundledVersion) < 0 && !d.held) {
    return null; // a newer denext's bundled pin wins over an unheld default
  }
  const pins = lockedPinsSync(d, ctx.bundled, ctx.cacheRoot);
  if (!pins) {
    return `denext: your default runtime ${d.version} is not installed; running the bundled ` +
      `${bundledVersion}. \`denext runtime install\` installs it again.`;
  }
  const bad = runtimeIncompatibility(factsFor(pins, ctx), ctx.compat);
  if (bad) {
    return `denext: your default runtime ${d.version} is skipped (${bad.message}); running ` +
      `the bundled ${bundledVersion}.`;
  }
  return lockedRelease(pins, "default", d, yankedNotices(d.version, ctx));
}

/**
 * The release in force, with no network and no signature check of the channel: the pin file, then
 * `DENEXT_RUNTIME` (installed releases only), the project pin, the user default and the bundled
 * pins (see the module header). The async {@linkcode resolveRuntimeRelease} fetches what a lock
 * names before calling this, and adds the channel entries' facts and the revocation check.
 *
 * @param options The seams and the async resolver's findings.
 * @returns The release.
 * @throws {RuntimeSelectError} For a selection that cannot run (a project pin or `DENEXT_RUNTIME`
 *   that is malformed, not installed or incompatible). A user default never throws: it is skipped
 *   with a notice.
 */
export function resolveRuntimeReleaseSync(options: ResolveRuntimeSyncOptions = {}): RuntimeRelease {
  const env = options.env ?? processEnv;
  const bundled = options.bundled ?? BUNDLED_RUNTIME;
  const file = env(PIN_FILE_ENV);
  if (file) return pinFileRelease(file, bundled);
  const ctx = ctxOf({ ...options, env, bundled });
  const wanted = env(RUNTIME_ENV)?.trim();
  if (wanted) return envRung(wanted, ctx);
  const project = readProjectRuntimePin(ctx.projectDir);
  if (project) return projectRung(project, ctx);
  const d = userDefaultIn(ctx.defaultFile);
  const fromDefault = d ? defaultRung(d, ctx) : null;
  if (fromDefault !== null && typeof fromDefault === "object") return fromDefault;
  return bundledRelease(bundled, "bundled", fromDefault ? [fromDefault] : []);
}

// ---------------------------------------------------------------------------------------------
// The async resolver.

/** How {@linkcode resolveRuntimeRelease} checks the revoked-runtimes list. */
export interface RuntimeRevocationCheck extends Omit<LoadRevocationsOptions, "env" | "mode"> {
  /** Default `fetch`; `cache-only` for `start` / `job`. */
  readonly mode?: RevocationMode;
  /** `["cli"]` (default), or `["cli", "desktop"]` for the desktop verbs. */
  readonly components?: readonly RuntimeComponent[];
}

/** Options for {@linkcode resolveRuntimeRelease}. */
export interface ResolveRuntimeAsyncOptions extends ResolveRuntimeOptions {
  /**
   * Check a selected (not bundled) release against the revoked-runtimes list and fall back when it
   * is revoked here (the bundled pins keep their own rollback logic, deno-toolchain.ts). Absent:
   * no check.
   */
  readonly revocations?: RuntimeRevocationCheck;
  /** The host's toolchain pin key (default `<os>-<arch>`). */
  readonly target?: string;
  /** The host's Rust target triple, as the revoked-runtimes list names it (default this host's). */
  readonly triple?: string;
  /** The channel index (default {@linkcode loadRuntimeChannel} over the cache). */
  readonly loadChannel?: (mode: "cache-only" | "fetch") => Promise<LoadedChannel>;
  /** Fetch a locked document (default {@linkcode fetchLockedReleaseDocument}). */
  readonly fetchLocked?: (lock: RuntimeLock) => Promise<RuntimeReleaseDocument>;
  /** Fetch a document the channel lists (default {@linkcode loadReleaseDocument}). */
  readonly fetchListed?: (entry: RuntimeChannelRelease) => Promise<RuntimeReleaseDocument>;
}

/** The async seams, defaulted. */
interface AsyncSeams {
  readonly env: EnvGet;
  readonly cacheRoot: string | null;
  readonly defaultFile: string | null;
  readonly bundled: RuntimePins;
  readonly loadChannel: (mode: "cache-only" | "fetch") => Promise<LoadedChannel>;
  readonly fetchLocked: (lock: RuntimeLock) => Promise<RuntimeReleaseDocument>;
  readonly fetchListed: (entry: RuntimeChannelRelease) => Promise<RuntimeReleaseDocument>;
}

function seamsOf(o: ResolveRuntimeAsyncOptions): AsyncSeams {
  const env = o.env ?? processEnv;
  const cacheRoot = safeCacheRoot(env, o.cacheRoot);
  const root = cacheRoot ?? undefined;
  const noCache = () => Promise.reject(new RuntimeSelectError("no toolchain cache directory"));
  return {
    env,
    cacheRoot,
    defaultFile: userRuntimeDefaultFile(env, o.cacheRoot),
    bundled: o.bundled ?? BUNDLED_RUNTIME,
    loadChannel: o.loadChannel ?? ((mode) => loadRuntimeChannel({ mode, env, cacheRoot: root })),
    fetchLocked: o.fetchLocked ??
      ((lock) => root ? fetchLockedReleaseDocument(lock, { cacheRoot: root }) : noCache()),
    fetchListed: o.fetchListed ??
      ((entry) => root ? loadReleaseDocument(entry, { env, cacheRoot: root }) : noCache()),
  };
}

/** The index this machine holds (no network): the current one, else an expired one (still authentic). */
async function heldChannel(s: AsyncSeams): Promise<RuntimeChannel | null> {
  const loaded = await s.loadChannel("cache-only").catch(() => null);
  return loaded?.channel ?? loaded?.expired ?? null;
}

/** The entries of `channel` by version. */
function entriesOf(channel: RuntimeChannel | null): Map<string, RuntimeChannelRelease> {
  return new Map((channel?.releases ?? []).map((r) => [r.version, r]));
}

/** Make sure the document a lock names is at hand (bundled or cached), fetching it when not. */
async function ensureLocked(lock: RuntimeLock, s: AsyncSeams): Promise<void> {
  if (lockedPinsSync(lock, s.bundled, s.cacheRoot)) return;
  await s.fetchLocked(lock);
}

/** The lock of a `DENEXT_RUNTIME` release from the channel (fetched only when the cache lacks it). */
async function envLockFromChannel(
  version: string,
  held: Map<string, RuntimeChannelRelease>,
  s: AsyncSeams,
): Promise<{ lock: RuntimeLock; entry: RuntimeChannelRelease } | null> {
  let entry = held.get(version);
  if (!entry) {
    const loaded = await s.loadChannel("fetch").catch(() => null);
    entry = entriesOf(loaded?.channel ?? null).get(version);
    if (entry) held.set(version, entry);
  }
  if (!entry) return null;
  await s.fetchListed(entry);
  return { lock: { version, integrity: releaseIntegrity(entry.doc.sha256) }, entry };
}

/** The `DENEXT_RUNTIME` lock, when the release needs the channel to be found. */
async function prefetchEnvLock(
  o: ResolveRuntimeAsyncOptions,
  s: AsyncSeams,
  entries: Map<string, RuntimeChannelRelease>,
): Promise<RuntimeLock | undefined> {
  const version = s.env(RUNTIME_ENV)?.trim();
  if (!version || !isChannelReleaseVersion(version)) return undefined;
  if (bundledReleases(s.bundled).some((p) => p.toolchain.version === version)) return undefined;
  const ctx = { ...ctxOf({ ...o, env: s.env, bundled: s.bundled }), cacheRoot: s.cacheRoot };
  const local = envLockSync(version, ctx);
  if (local && lockedPinsSync(local, s.bundled, s.cacheRoot)) return local;
  try {
    return (await envLockFromChannel(version, entries, s))?.lock;
  } catch (err) {
    throw new RuntimeSelectError(
      `denext: ${RUNTIME_ENV}=${version}: its release document can't be fetched (${
        errText(err)
      }).\n  Fix: retry online, or unset ${RUNTIME_ENV}.`,
    );
  }
}

/** Fetch what the project pin and the user default name when it is not cached. */
async function prefetchLocks(o: ResolveRuntimeAsyncOptions, s: AsyncSeams): Promise<void> {
  if (s.env(RUNTIME_ENV)?.trim() || s.env(PIN_FILE_ENV)) return;
  const project = readProjectRuntimePin(o.projectDir ?? cwdOr("."));
  if (project) {
    // A failure is reported by the sync rung, with its fix.
    await ensureLocked(project.lock, s).catch(() => {});
    return;
  }
  const d = userDefaultIn(s.defaultFile);
  if (d) await ensureLocked(d, s).catch(() => {});
}

/**
 * The release in force (see the module header): {@linkcode resolveRuntimeReleaseSync} after
 * fetching what a lock or `DENEXT_RUNTIME` names and is not cached, with the cached channel
 * entries' facts (`minDenext` / `maxDenext` / `yanked`), and — with `revocations` — a selected
 * release the revoked-runtimes list revokes here replaced by the newest installed compatible
 * release it does not revoke, else the bundled pins.
 *
 * @param options The seams.
 * @returns The release.
 * @throws {RuntimeSelectError} For a selection that cannot run.
 */
export async function resolveRuntimeRelease(
  options: ResolveRuntimeAsyncOptions = {},
): Promise<RuntimeRelease> {
  const s = seamsOf(options);
  if (s.env(PIN_FILE_ENV)) return resolveRuntimeReleaseSync(options);
  const held = await heldChannel(s);
  const entries = entriesOf(held);
  const envLock = await prefetchEnvLock(options, s, entries);
  await prefetchLocks(options, s);
  const release = resolveRuntimeReleaseSync({
    ...options,
    env: s.env,
    bundled: s.bundled,
    ...(envLock ? { envLock } : {}),
    entries,
  });
  if (!options.revocations) return release;
  return await revocationFallback(release, options, s, held);
}

// ---------------------------------------------------------------------------------------------
// Revocation of a selected release.

/** Whether `release` is one of the bundled releases (their rollback logic is deno-toolchain.ts's). */
function isBundledPins(release: RuntimePins, bundled: RuntimePins): boolean {
  return release.toolchain === bundled.toolchain;
}

/** The subjects a selected release runs as, for the list. */
function subjectsOf(
  version: string,
  triple: string,
  components: readonly RuntimeComponent[],
): RevocationSubject[] {
  return components.map((component) => ({ component, version, rollback: null, triple }));
}

/** Whether the list revokes `version` for any of `components` on `triple`. */
function revokedHere(
  list: RuntimeRevocationList | null,
  version: string,
  triple: string,
  components: readonly RuntimeComponent[],
): boolean {
  return components.some((c) => findRevocation(list, c, version, triple) !== null);
}

/** Whether the toolchain of `version` is installed for `target` (its verified binary's stamp). */
function installed(cacheRoot: string | null, version: string, target: string): boolean {
  return cacheRoot !== null && isFile(join(cacheRoot, version, target, ".denext-toolchain.json"));
}

/** What picking a fallback reads. */
interface FallbackScope {
  readonly list: RuntimeRevocationList | null;
  readonly triple: string;
  readonly target: string;
  readonly components: readonly RuntimeComponent[];
  readonly compat: CompatTarget;
}

/** Whether `entry` may replace a revoked release: not yanked, compatible, not revoked, installed. */
function eligibleFallback(entry: RuntimeChannelRelease, scope: FallbackScope, s: AsyncSeams) {
  return !entry.yanked && !runtimeIncompatibility(factsOfEntry(entry), scope.compat) &&
    !revokedHere(scope.list, entry.version, scope.triple, scope.components) &&
    installed(s.cacheRoot, entry.version, scope.target);
}

/** The newest installed, compatible, un-yanked release the list does not revoke here. */
function installedAlternative(
  channel: RuntimeChannel | null,
  skip: string,
  scope: FallbackScope,
  s: AsyncSeams,
): RuntimeRelease | null {
  for (const entry of channel?.releases ?? []) {
    if (entry.version === skip || !eligibleFallback(entry, scope, s)) continue;
    const lock = { version: entry.version, integrity: releaseIntegrity(entry.doc.sha256) };
    const pins = lockedPinsSync(lock, s.bundled, s.cacheRoot);
    if (pins) return lockedRelease(pins, "inherited", lock);
  }
  return null;
}

/** Whether the revocation check applies: a selected release that is not one of the bundled ones. */
function checksRevocation(release: RuntimeRelease, s: AsyncSeams): release is RuntimeRelease & {
  version: string;
} {
  return release.version !== null && release.source !== "override" &&
    !isBundledPins(release, s.bundled);
}

/** The list in force and what to look it up for. */
async function fallbackScope(o: ResolveRuntimeAsyncOptions, s: AsyncSeams): Promise<FallbackScope> {
  const r = o.revocations ?? {};
  const root = s.cacheRoot ? { cacheRoot: s.cacheRoot } : {};
  const { list } = await loadRuntimeRevocations({ ...r, env: s.env, ...root });
  return {
    list,
    triple: o.triple ?? Deno.build.target,
    target: o.target ?? `${Deno.build.os}-${Deno.build.arch}`,
    components: r.components ?? ["cli"],
    compat: o.compat ?? {},
  };
}

/** A revoked selected release: the newest installed safe release, else the bundled pins. */
async function revocationFallback(
  release: RuntimeRelease,
  o: ResolveRuntimeAsyncOptions,
  s: AsyncSeams,
  channel: RuntimeChannel | null,
): Promise<RuntimeRelease> {
  if (!checksRevocation(release, s)) return release;
  const scope = await fallbackScope(o, s);
  const subjects = subjectsOf(release.version, scope.triple, scope.components);
  const { hit } = decideRevocation(scope.list, subjects);
  if (!hit) return release;
  const alt = installedAlternative(channel, release.version, scope, s);
  const fallback = alt ?? bundledRelease(s.bundled);
  const notices = s.env(REVOCATION_NOTICED_ENV) === "1" ? [] : [
    `${revocationNotice(hit, scope.triple, fallback.version)} \`denext runtime upgrade\` moves ` +
    "to a release that is not revoked.",
  ];
  return { ...fallback, source: release.source, notices: [...release.notices, ...notices] };
}

// ---------------------------------------------------------------------------------------------
// The release this process runs (synchronous readers).

let remembered: RuntimeRelease | null = null;

/**
 * Remember the release the async resolver chose for this process (the CLI's toolchain gate), so
 * the synchronous readers ({@linkcode activeRuntimeRelease}) agree with it. `null` forgets it.
 *
 * @param release The release, or `null`.
 */
export function rememberRuntimeRelease(release: RuntimeRelease | null): void {
  remembered = release;
}

/** The release a parent handed down (marker + integrity), when its document is cached. */
function inheritedRelease(
  env: EnvGet,
  bundled: RuntimePins,
  root: string | undefined,
): RuntimeRelease | null {
  const version = env(ACTIVE_ENV);
  const integrity = env(RUNTIME_INTEGRITY_ENV)?.trim();
  if (!version || !integrity || !isChannelReleaseVersion(version)) return null;
  const lock = { version, integrity };
  const pins = lockedPinsSync(lock, bundled, safeCacheRoot(env, root));
  return pins ? lockedRelease(pins, "inherited", lock) : null;
}

/**
 * The release this process runs on, synchronously: the pin file override; the release the async
 * resolver chose here ({@linkcode rememberRuntimeRelease}, process env only); the release a parent
 * handed down by `DENEXT_TOOLCHAIN_ACTIVE` + `DENEXT_RUNTIME_INTEGRITY` when it is not what this
 * process would pick itself (a revocation fallback, another directory); else
 * {@linkcode resolveRuntimeReleaseSync}.
 *
 * @param env Env reader (default the process's).
 * @param options The seams.
 * @returns The release.
 * @throws {RuntimeSelectError} When nothing that runs can be selected (a broken project pin).
 */
export function activeRuntimeRelease(
  env: EnvGet = processEnv,
  options: ResolveRuntimeOptions = {},
): RuntimeRelease {
  const bundled = options.bundled ?? BUNDLED_RUNTIME;
  if (env(PIN_FILE_ENV)) return resolveRuntimeReleaseSync({ ...options, env });
  if (remembered && env === processEnv && !options.projectDir) return remembered;
  const marker = env(ACTIVE_ENV);
  let own: RuntimeRelease | null = null;
  let failure: unknown = null;
  try {
    own = resolveRuntimeReleaseSync({ ...options, env });
  } catch (err) {
    failure = err;
  }
  if (own && (!marker || own.version === marker)) return own;
  const inherited = inheritedRelease(env, bundled, options.cacheRoot);
  if (inherited) return inherited;
  // The parent fell back to the bundled pins (or their rollback) from a revoked selection.
  if (marker && bundledReleases(bundled).some((p) => p.toolchain.version === marker)) {
    return bundledRelease(bundled, "inherited");
  }
  if (own) return own;
  throw failure;
}

/**
 * The Deno Desktop runtime pin of the release this process runs on ({@linkcode
 * activeRuntimeRelease}): what `desktop run | dev | package` build with by default.
 *
 * @param env Env reader.
 * @param projectDir Where the project pin is read (default the working directory).
 * @returns The pin.
 */
export function activeDesktopRuntimePin(
  env: EnvGet = processEnv,
  projectDir?: string,
): DesktopRuntimePin {
  return activeRuntimeRelease(env, projectDir ? { projectDir } : {}).desktop;
}

/**
 * {@linkcode activeDesktopRuntimePin}, or the bundled pin when no release can be selected (a report
 * or a warning that must not fail: the command that runs reports the broken selection).
 *
 * @param env Env reader.
 * @param projectDir Where the project pin is read (default the working directory).
 * @returns The pin.
 */
export function activeDesktopRuntimePinOrBundled(
  env: EnvGet = processEnv,
  projectDir?: string,
): DesktopRuntimePin {
  try {
    return activeDesktopRuntimePin(env, projectDir);
  } catch {
    return BUNDLED_RUNTIME.desktop;
  }
}

// ---------------------------------------------------------------------------------------------
// The "newer runtime available" notice.

/** What {@linkcode newestAvailableRelease} picks with. */
export interface AvailableOptions {
  /** The dependency-age rule in force (its cutoff holds a fresh release back; no exemption). */
  readonly rule: Pick<DepAgeRule, "cutoff">;
  readonly compat?: CompatTarget;
  /** Whether the revoked-runtimes list names a version (default: none is revoked). */
  readonly revoked?: (version: string) => boolean;
}

/** What {@linkcode newestAvailableRelease} found. */
export interface AvailableRelease {
  /** The newest compatible, un-yanked release the hold lets in, or `null`. */
  readonly pick: RuntimeChannelRelease | null;
  /** The newest compatible, un-yanked release newer than `pick` that the hold keeps out. */
  readonly held: RuntimeChannelRelease | null;
}

/** Whether the dependency-age hold lets a release published at `releasedAt` in. */
function pastHold(rule: Pick<DepAgeRule, "cutoff">, releasedAt: string): boolean {
  return rule.cutoff === null || Date.parse(releasedAt) < rule.cutoff.getTime();
}

/**
 * The newest release a floating upgrade may take (`runtime upgrade`, the installer, the notice):
 * compatible with this denext, not yanked, not revoked (`options.revoked`), and published before
 * the dependency-age rule's cutoff (the same rule `denext upgrade` follows; a `security` release
 * is held like any other).
 *
 * @param releases The channel's entries, newest first.
 * @param options The rule and the compatibility target.
 * @returns The pick, and the newest release the hold keeps out.
 */
export function newestAvailableRelease(
  releases: readonly RuntimeChannelRelease[],
  options: AvailableOptions,
): AvailableRelease {
  let held: RuntimeChannelRelease | null = null;
  for (const entry of releases) {
    if (entry.yanked || options.revoked?.(entry.version)) continue;
    if (runtimeIncompatibility(factsOfEntry(entry), options.compat)) continue;
    if (pastHold(options.rule, entry.releasedAt)) return { pick: entry, held };
    held ??= entry;
  }
  return { pick: null, held };
}

/** Options for {@linkcode runtimeUpdateNotice}. */
export interface RuntimeNoticeOptions {
  /** The release this command runs. */
  readonly selected: RuntimeRelease;
  readonly env?: EnvGet;
  readonly cacheRoot?: string;
  /** Where the dependency-age rule is read (default the working directory). */
  readonly projectDir?: string;
  readonly now?: () => number;
  /** The index (default {@linkcode loadRuntimeChannel} in `fetch` mode: the network at most every 12 h). */
  readonly loadChannel?: () => Promise<LoadedChannel>;
  /** The dependency-age rule (default the project's). */
  readonly rule?: () => Promise<Pick<DepAgeRule, "cutoff">>;
  readonly compat?: CompatTarget;
  /**
   * How the revoked-runtimes list is read, so a revoked release is never announced (default: the
   * cached list, never the network).
   */
  readonly revocations?: LoadRevocationsOptions;
}

/** Whether the same release was announced within the last day. */
function announcedRecently(cacheRoot: string, version: string, now: number): boolean {
  try {
    const s = JSON.parse(Deno.readTextFileSync(join(cacheRoot, NOTICE_STATE_FILE)));
    return s?.version === version && typeof s.at === "number" && now - s.at < NOTICE_REPEAT_MS &&
      s.at <= now;
  } catch {
    return false;
  }
}

/** The sources a notice is said for (an explicit override already chose). */
const NOTICE_SOURCES: ReadonlySet<RuntimeSource> = new Set(["project", "default", "bundled"]);

/**
 * The one line that says a newer runtime is available — `denext: runtime 3.0.0-denext.31 is
 * available: denext runtime upgrade` (`--project` for a project pin) — or `null`: already said in
 * this process tree (`DENEXT_RUNTIME_NOTICED`), an explicit `DENEXT_RUNTIME` / pin file, no channel
 * (off, offline, unsigned, expired), nothing newer the hold lets in, or the same release announced
 * within a day. Never throws and never waits past the channel's fetch budget. The caller sets
 * `DENEXT_RUNTIME_NOTICED=1` after saying it.
 *
 * @param options The selected release and the seams.
 * @returns The line, or `null`.
 */
export async function runtimeUpdateNotice(options: RuntimeNoticeOptions): Promise<string | null> {
  try {
    return await noticeLine(options);
  } catch {
    return null;
  }
}

/** Whether a notice may be said at all for `o` (not said yet here, and not an explicit choice). */
function noticeWanted(o: RuntimeNoticeOptions, env: EnvGet): boolean {
  return env(RUNTIME_NOTICED_ENV) !== "1" && NOTICE_SOURCES.has(o.selected.source);
}

/** The newest release a floating upgrade would take, when it is newer than the selected one. */
async function newerPick(
  o: RuntimeNoticeOptions,
  channel: RuntimeChannel,
  now: number,
): Promise<RuntimeChannelRelease | null> {
  const projectDir = o.projectDir ?? cwdOr(".");
  const rule = await (o.rule ?? (() => readProjectRule(projectDir, new Date(now))))();
  const { list } = await loadRuntimeRevocations({
    mode: "cache-only",
    env: o.env ?? processEnv,
    ...(o.cacheRoot !== undefined ? { cacheRoot: o.cacheRoot } : {}),
    ...o.revocations,
  });
  const { pick } = newestAvailableRelease(channel.releases, {
    rule,
    compat: o.compat,
    revoked: (version) => revokesVersion(list, version),
  });
  const current = o.selected.version ?? "0.0.0";
  return pick && compareDenoVersions(pick.version, current) > 0 ? pick : null;
}

/** The channel index the notice reads (`fetch` mode: the network at most every 12 hours). */
function noticeChannel(o: RuntimeNoticeOptions, env: EnvGet, cacheRoot: string) {
  return (o.loadChannel ?? (() => loadRuntimeChannel({ env, cacheRoot })))();
}

async function noticeLine(o: RuntimeNoticeOptions): Promise<string | null> {
  const env = o.env ?? processEnv;
  if (!noticeWanted(o, env)) return null;
  const cacheRoot = o.cacheRoot ?? toolchainCacheRoot(env);
  const { channel } = await noticeChannel(o, env, cacheRoot);
  if (!channel) return null;
  const now = (o.now ?? Date.now)();
  const pick = await newerPick(o, channel, now);
  if (!pick || announcedRecently(cacheRoot, pick.version, now)) return null;
  const state = JSON.stringify({ version: pick.version, at: now }) + "\n";
  await writeQuietly(cacheRoot, NOTICE_STATE_FILE, state);
  const flag = o.selected.source === "project" ? " --project" : "";
  return `denext: runtime ${pick.version} is available: denext runtime upgrade${flag}`;
}
