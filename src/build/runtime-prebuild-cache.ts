// The per-process cache behind `prebuildDenextRuntime` (next-compat.ts). The prebuilt denext
// runtime depends on what the framework is (its root, its import map, the dependency-age
// policy), on `classComponents` and on the project's denext patch — never on the app, the
// target platform or the generation. A next-compat dev server used to rebuild it twice per
// target per generation (server runtime + Flight client runtime): four identical whole-runtime
// builds inside a shell's first request, and two more on every edit. Now a process builds each
// distinct runtime once and writes the remembered outputs wherever a later build wants them.
//
// The key holds every option-level input; the local source files the build read (the
// framework checkout's own sources, a patched file's pristine copy) are stamped by mtime and
// size, so editing any of them rebuilds. Remote (`https:` JSR) sources are immutable per
// version, and the version is part of the framework root.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import type { DenextPatchSet } from "./patches.ts";

/** One built runtime: its output files and the local inputs they were built from. */
export interface PrebuiltRuntime {
  /** Each output, relative to the runtime directory, with its bytes. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>;
  /** Each local input file (absolute path) → its stamp at build time. */
  readonly stamps: ReadonlyMap<string, string>;
}

/** Everything besides the local source files that decides what the prebuild produces. */
export interface RuntimeCacheInputs {
  /** The framework root URL (`file://` checkout, or the versioned JSR URL). */
  readonly rootUrl: string;
  /** Whether the class-component runtime is compiled in. */
  readonly classComponents: boolean;
  /** The framework's import map, as the build's temp config carries it. */
  readonly imports: Record<string, string>;
  /** The dependency-age policy the build's temp config carries. */
  readonly depAge: unknown;
  /** The project's denext patch (null when it has none). */
  readonly patch: DenextPatchSet | null;
}

/**
 * The cache key for one prebuild: every option-level input, serialized. Two prebuilds share an
 * output only when all of them are equal.
 *
 * @param inputs The prebuild's inputs.
 * @returns The key.
 */
export function runtimeCacheKey(inputs: RuntimeCacheInputs): string {
  return JSON.stringify([
    inputs.rootUrl,
    inputs.classComponents,
    Object.entries(inputs.imports).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    inputs.depAge ?? null,
    inputs.patch ? [...inputs.patch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null,
  ]);
}

/** A file's stamp: its modification time and size, or `missing`. */
async function stampOf(path: string): Promise<string> {
  try {
    const info = await Deno.stat(path);
    return `${info.mtime?.getTime() ?? "?"}:${info.size}`;
  } catch {
    return "missing";
  }
}

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The local files among an esbuild metafile's inputs, absolute. Inputs are paths relative to
 * the build's working directory (or `file:` URLs); one with another scheme (`https:` JSR
 * sources) is immutable and not stamped.
 */
function localInputs(inputs: Iterable<string>, cwd: string): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (input.startsWith("file://")) out.push(fromFileUrl(input));
    // A drive letter (`C:\x.ts`, a Windows path) is no scheme: that file is stamped too.
    else if (WINDOWS_DRIVE.test(input) || !URL_SCHEME.test(input)) out.push(resolve(cwd, input));
  }
  return out;
}

/**
 * Stamp the local files a build read.
 *
 * @param inputs The esbuild metafile's input keys.
 * @param cwd The build's working directory (what relative inputs are relative to).
 * @returns Each local input → its current stamp.
 */
export async function stampInputs(
  inputs: Iterable<string>,
  cwd: string,
): Promise<Map<string, string>> {
  const stamps = new Map<string, string>();
  for (const path of localInputs(inputs, cwd)) stamps.set(path, await stampOf(path));
  return stamps;
}

/**
 * Whether every local input still has the stamp it was built from.
 *
 * @param stamps The stamps recorded at build time.
 * @returns `true` when nothing changed.
 */
export async function inputsUnchanged(stamps: ReadonlyMap<string, string>): Promise<boolean> {
  for (const [path, stamp] of stamps) {
    if (await stampOf(path) !== stamp) return false;
  }
  return true;
}

/**
 * Write a built runtime's files under `outDir`.
 *
 * @param outDir The runtime directory.
 * @param runtime The built runtime.
 */
export async function writeRuntime(outDir: string, runtime: PrebuiltRuntime): Promise<void> {
  await Deno.mkdir(outDir, { recursive: true });
  for (const file of runtime.files) {
    const path = join(outDir, file.path);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(path, file.contents);
  }
}

/** This process's built runtimes, by {@link runtimeCacheKey}. */
const runtimes = new Map<string, Promise<PrebuiltRuntime>>();

/** How many runtimes this process actually built (a cache miss each). */
let builds = 0;

/**
 * The runtime for `key`: the remembered one while its local inputs are unchanged, else a fresh
 * `build()` (remembered in its place). Concurrent callers with one key share one build; a
 * failed build is forgotten, so the next call retries.
 *
 * @param key The {@link runtimeCacheKey}.
 * @param build Builds the runtime.
 * @returns The runtime.
 */
export async function cachedRuntime(
  key: string,
  build: () => Promise<PrebuiltRuntime>,
): Promise<PrebuiltRuntime> {
  const known = runtimes.get(key);
  if (known) {
    const hit = await known.catch(() => null);
    if (hit && await inputsUnchanged(hit.stamps)) return hit;
    // A peer may have replaced it while this call was checking: share that build.
    const current = runtimes.get(key);
    if (current && current !== known) return await current;
  }
  builds++;
  const fresh = build();
  runtimes.set(key, fresh);
  fresh.catch(() => {
    if (runtimes.get(key) === fresh) runtimes.delete(key);
  });
  return await fresh;
}

/**
 * Test seam: how many runtimes this process has built (cache misses). Not part of the public
 * API.
 *
 * @returns The count.
 */
export function __runtimeBuildsForTests(): number {
  return builds;
}
