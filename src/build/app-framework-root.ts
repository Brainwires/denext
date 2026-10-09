// Which copy of denext an app's own `denext` import reaches, and the import-map entry that makes
// a native client bundle carry ONE copy of the runtime when that is not the running framework.
//
// A native client bundle (`deno bundle`) reaches the framework two ways. The build's own imports —
// the generated entries' `denext/client-runtime`, `denext/live`, `denext/lazy`, …, and the client
// transforms' output (auto-memo / AsyncContext import `src/runtime/compiler-runtime.ts`, qrl
// segments `src/runtime/qrl.ts`) — name the RUNNING framework by URL (`frameworkFileUrl`), and
// they must: the generated code is written against that version's runtime. The app's modules
// resolve `denext` through the app's own `deno.json` (deno bundle discovers it for them, so the
// merged `--config` cannot re-point it). When the two differ — the CLI run from a checkout or
// another URL while the app maps `jsr:@denext/denext@<a version the checkout does not satisfy>`,
// a published CLI building an app locked to another version, an app that maps `denext` to
// another checkout — the bundle carried two copies of the hooks and the reconciler, and only the
// global-symbol dispatcher kept the hooks working.
//
// What the merged config CAN re-point is a URL: every module an entry of the app's copy imports
// is a relative import, resolved to a URL under the copy's root, and Deno applies the import map
// to that. {@linkcode foldAppDenext} maps the copy's root onto the running framework's, so the
// app's entry modules (`mod.ts`, `src/jsx/jsx-runtime.ts`, …, as its import map names them) load
// as written and everything they import is the running framework's: one runtime, the one the
// generated code and the server renderer use (as the compat build and unbundled dev, which serve
// every `denext` specifier from the running framework, already did). {@linkcode appDenextRoot}
// names the copy's root. A local checkout whose version satisfies the app's `jsr:` range IS the
// app's copy: Deno links it (a "linked package") because the build's import-map entries point
// into it.

import { dirname, resolve } from "@std/path";

/** A published denext version's module root on JSR (`<root><version>/`). */
export const JSR_DENEXT_ROOT = "https://jsr.io/@denext/denext/";

/** `jsr:@denext/denext` with an optional version requirement (group 1). */
const JSR_DENEXT = /^jsr:@denext\/denext(?:@([^/]+))?\/?$/;

/** The framework a process runs: its module root URL (ends with `/`) and its version. */
export interface FrameworkIdentity {
  /** The root URL, `file://…/` for a checkout, `https://jsr.io/@denext/denext/<v>/` from JSR. */
  readonly root: string;
  /** The version its `deno.json` declares. */
  readonly version: string;
}

/** A `major.minor.patch[-pre]` version. */
const FULL_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** `[major, minor, patch]` of a version (prerelease ignored). */
function triple(v: string): [number, number, number] {
  const [a, b, c] = v.split("-")[0].split(".").map(Number);
  return [a, b ?? 0, c ?? 0];
}

/** Whether `version` satisfies `^floor` (or `~floor` when `tilde`), npm's semantics. */
function caretOrTilde(floor: string, version: string, tilde: boolean): boolean {
  const [fMaj, fMin, fPat] = triple(floor);
  const [maj, min, pat] = triple(version);
  // `~x.y.z` keeps the minor; `^0.y.z` too; `^0.0.z` keeps the patch.
  if (maj !== fMaj) return false;
  const lockMinor = tilde || fMaj === 0;
  if (lockMinor && min !== fMin) return false;
  if (!tilde && fMaj === 0 && fMin === 0) return pat === fPat;
  if (min !== fMin) return min > fMin;
  return pat >= fPat;
}

/**
 * Whether a JSR version requirement admits `version`, the way Deno reads one: a full version is
 * exact, `x` / `x.y` a partial range, `^` / `~` npm's caret and tilde, `*` (or none) anything.
 *
 * @param range The requirement as an import map writes it (`3.4.2`, `^3.4.0`, `3`).
 * @param version A concrete version.
 * @returns Whether it does, or null for a requirement this does not model (`>=`, `||`, …).
 */
export function jsrRangeAdmits(range: string, version: string): boolean | null {
  if (range === "" || range === "*") return true;
  if (FULL_VERSION.test(range)) return range === version;
  if (/^\d+(?:\.\d+)?$/.test(range)) return version.startsWith(`${range}.`);
  const m = /^([\^~])(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(range);
  return m ? caretOrTilde(m[2], version, m[1] === "~") : null;
}

/**
 * The module root an app's `denext` import resolves to.
 *
 * @param denext The app's `denext` import-map value, absolutized (a `file:` / `http(s):` URL of
 *   `mod.ts`, or a `jsr:@denext/denext[@range]` specifier); undefined when the app maps none.
 * @param running The framework this process runs.
 * @param locked The version the app's lockfile resolved its `jsr:` specifier to, if any.
 * @returns A root URL ending with `/`: `running.root` when the app reaches the running framework
 *   or when where it leads cannot be told (a value that is not `mod.ts`, a range with no lock).
 */
export function appDenextRoot(
  denext: string | undefined,
  running: FrameworkIdentity,
  locked?: string,
): string {
  if (!denext) return running.root;
  const jsr = JSR_DENEXT.exec(denext);
  if (jsr) return jsrDenextRoot(jsr[1] ?? "*", running, locked);
  return /^(?:file|https?):/.test(denext) && denext.endsWith("/mod.ts")
    ? new URL("./", denext).href
    : running.root;
}

/** {@linkcode appDenextRoot} for a `jsr:` requirement. */
function jsrDenextRoot(range: string, running: FrameworkIdentity, locked?: string): string {
  // A local checkout the requirement admits is linked in place of the published package.
  if (running.root.startsWith("file:") && jsrRangeAdmits(range, running.version) !== false) {
    return running.root;
  }
  const version = locked ?? (FULL_VERSION.test(range) ? range : undefined);
  return version ? `${JSR_DENEXT_ROOT}${version}/` : running.root;
}

/**
 * The version a `deno.lock` resolved `spec` to (the v4/v5 `specifiers` table; a v3 value is a
 * full specifier whose version follows its last `@`).
 *
 * @param lock The parsed lockfile.
 * @param spec The specifier as the import map writes it (`jsr:@denext/denext@^3.4.0`).
 * @returns The version, or undefined when the lock does not list it.
 */
export function lockedVersion(lock: unknown, spec: string): string | undefined {
  const table = (lock as { specifiers?: Record<string, unknown> } | null)?.specifiers;
  if (!table || typeof table !== "object") return undefined;
  // `jsr:@scope/name` names no version: Deno records it as `@*`.
  const keys = spec.indexOf("@", 5) === -1 ? [spec, `${spec}@*`] : [spec];
  for (const key of keys) {
    const value = Object.hasOwn(table, key) ? table[key] : undefined;
    if (typeof value === "string") return value.slice(value.lastIndexOf("@") + 1);
  }
  return undefined;
}

/**
 * The import-map entry that folds the app's copy of denext into the running framework: its root
 * as a prefix of the running root, so every module under it that the app's entry modules import
 * resolves to the running framework's module.
 *
 * @param running The running framework's root URL.
 * @param app The root the app's `denext` reaches ({@linkcode appDenextRoot}).
 * @returns The entry; empty when the roots are the same (or nest, which no real layout does).
 */
export function foldAppDenext(running: string, app: string): Record<string, string> {
  return running.startsWith(app) || app.startsWith(running) ? {} : { [app]: running };
}

/**
 * The path of the lockfile a config uses: its `lock` field (`false` for none, a path, or
 * `{ path }`), else `deno.lock` beside it.
 *
 * @param configFsPath The config's filesystem path.
 * @param lockField The config's `lock` value.
 * @returns The lockfile's path, or undefined when the config turns locking off.
 */
export function lockfilePath(configFsPath: string, lockField: unknown): string | undefined {
  if (lockField === false) return undefined;
  const named = typeof lockField === "string"
    ? lockField
    : (lockField as { path?: unknown } | null)?.path;
  return resolve(dirname(configFsPath), typeof named === "string" ? named : "deno.lock");
}

/**
 * The app's denext root ({@linkcode appDenextRoot}) for a config, reading its lockfile for the
 * version a `jsr:` mapping resolved to.
 *
 * @param configFsPath The app config's filesystem path.
 * @param config The parsed config.
 * @param denext Its `denext` import-map value, absolutized.
 * @param running The framework this process runs.
 * @returns The root URL.
 */
export async function appDenextRootFor(
  configFsPath: string,
  config: { lock?: unknown },
  denext: string | undefined,
  running: FrameworkIdentity,
): Promise<string> {
  let locked: string | undefined;
  const lockPath = denext?.startsWith("jsr:") ? lockfilePath(configFsPath, config.lock) : undefined;
  if (lockPath) {
    try {
      locked = lockedVersion(
        JSON.parse(await Deno.readTextFile(lockPath)),
        denext!.replace(/\/$/, ""),
      );
    } catch {
      // No lockfile (or an unreadable one): the requirement alone decides.
    }
  }
  return appDenextRoot(denext, running, locked);
}
