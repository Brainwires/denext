// The minimum Deno release denext supports, checked by `denext doctor` and before spawning
// `deno bundle`. `deno bundle` shipped in 2.4 and `deno desktop` in 2.9; CI pins 2.9.x.
//
// And the two version schemes of denext's own Deno (the Brainwires/deno fork, which is both the
// Deno toolchain and the Deno Desktop runtime): up to `2.9.7-denext.22` each release was the stock
// Deno release it was built from plus `-denext.N`; from `3.0.0-rc.1` the fork has its own version
// (`3.0.0-rc.2`, …, `3.0.0`), and the stock release it is built from is the pin's `deno` field.
// Semver orders the two schemes in release order (`2.9.7-denext.22` < `3.0.0-rc.1`), so every
// comparison goes through {@linkcode compareDenoVersions}.

import toolchainPin from "./deno-toolchain-pin.json" with { type: "json" };

/** The minimum supported Deno version. */
export const MIN_DENO_VERSION = "2.9.0";

/** The first release of denext's Deno under its own version (see {@linkcode isDenextDenoVersion}). */
export const FIRST_OWN_VERSION_RUNTIME = "3.0.0-rc.1";

/** Whether `version` (e.g. `Deno.version.deno`) satisfies {@linkcode MIN_DENO_VERSION}. */
export function denoVersionOk(version: string, min: string = MIN_DENO_VERSION): boolean {
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** A semver version's parts: the numeric core and the prerelease identifiers (build metadata dropped). */
interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): ParsedVersion | null {
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Semver's order of two prerelease identifiers: numeric below alphanumeric, numbers by value. */
function compareIdentifier(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver's order of two prerelease lists (both non-empty). */
function comparePrerelease(x: readonly string[], y: readonly string[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = compareIdentifier(x[i], y[i]);
    if (c !== 0) return c;
  }
  return Math.sign(x.length - y.length);
}

/**
 * Semver precedence of two Deno versions (build metadata ignored): `2.9.7-denext.9` <
 * `2.9.7-denext.10` < `2.9.7` (a prerelease sorts below its release) and `2.9.7-denext.22` <
 * `3.0.0-rc.1` < `3.0.0-rc.10` < `3.0.0`. A version that does not parse sorts below every one that
 * does.
 *
 * @param a A version.
 * @param b Another version.
 * @returns A negative number, zero or a positive number as `a` is older than, the same as or
 *   newer than `b`.
 */
export function compareDenoVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i]);
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    return Math.sign(y.pre.length - x.pre.length);
  }
  return comparePrerelease(x.pre, y.pre);
}

/** `2.9.7-denext.N`: a release of denext's Deno before it took its own version. */
const OLD_SCHEME = /^(\d+\.\d+\.\d+)-denext\.\d+(?:\+[0-9A-Za-z.-]+)?$/;

/** `3.0.0-rc.N`: the fork's own release candidates (a CI build's `+ci.N` included). */
const OWN_RC = /^3\.0\.0-rc\.\d+(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether `version` names a build of denext's own Deno (the toolchain, or a Deno Desktop runtime):
 * `2.9.7-denext.N`, the fork's own `3.0.0-rc.N` (from {@linkcode FIRST_OWN_VERSION_RUNTIME}), or
 * exactly the toolchain pin's version. A plain release (`3.0.0`, `3.1.0`) is stock Deno's unless
 * it is the pinned one: by its version alone, the fork's `3.0.0` final could not be told from
 * stock Deno's, nor its `3.0.0-rc.N` from a stock release candidate of that name.
 *
 * @param version A `Deno.version.deno` or `deno --version` version.
 * @param pinned The toolchain pin's version (default: the checked-in pin's).
 * @returns Whether it is denext's Deno.
 */
export function isDenextDenoVersion(
  version: string,
  pinned: string | null = toolchainPin.version,
): boolean {
  return OLD_SCHEME.test(version) || OWN_RC.test(version) ||
    (pinned !== null && version === pinned);
}

/**
 * The stock Deno release a version is built from: `2.9.7-denext.15` is Deno 2.9.7, a version of
 * denext's Deno under its own scheme (`3.0.0-rc.1`) is the stock release the pinned toolchain is
 * built from (`upstream`, the pin's `deno`), and any other version is itself. Every image tag,
 * `setup-deno` version and "is this the Deno the runtime was built for" check goes through this.
 *
 * @param version A `Deno.version.deno` or `deno --version` version.
 * @param upstream The stock release denext's own Deno is built from (default: the toolchain
 *   pin's `deno`).
 * @returns The stock Deno release.
 */
export function denoReleaseVersion(
  version: string,
  upstream: string = toolchainPin.deno,
): string {
  const old = OLD_SCHEME.exec(version);
  if (old) return old[1];
  return isDenextDenoVersion(version) ? upstream : version;
}

function parts(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
