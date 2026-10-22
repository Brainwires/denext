// The minimum Deno release denext supports, checked by `denext doctor` and before spawning
// `deno bundle`. `deno bundle` shipped in 2.4 and `deno desktop` in 2.9; CI pins 2.9.x.
//
// And the two version schemes of denext's own Deno (the Brainwires/deno fork, which is both the
// Deno toolchain and the Deno Desktop runtime): up to `2.9.7-denext.22` each release was the stock
// Deno release it was built from plus `-denext.N`; from `3.0.0-rc.1` the fork has its own version
// (`3.0.0-rc.2`, …, `3.0.0`), and the stock release it is built from is the pin's `deno` field.
// Semver orders the two schemes in release order (`2.9.7-denext.22` < `3.0.0-rc.1`), so every
// comparison goes through {@linkcode compareDenoVersions}.
//
// Upstream Deno releases a 3.0.0 too, so a version no longer says whose runtime a Deno is. From
// 3.0.0-rc.3 denext's Deno carries an identity marker (`Deno.build.denext`, and a
// `denext <version> (Brainwires)` line in `deno --version`), and a running Deno is recognised by it
// ({@linkcode isDenextDenoVersion}); the version alone counts only for the runtimes from before the
// marker ({@linkcode isPreMarkerDenextVersion}). A version read from denext's own pins or release
// manifests is denext's by where it came from ({@linkcode isDenextReleaseVersion}).

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

/**
 * The first release of denext's Deno that carries its identity marker: `Deno.build.denext` in
 * process and a `denext <version> (Brainwires)` line in `deno --version` (Brainwires/deno
 * DENEXT.md item 99). Upstream Deno releases a 3.0.0 too, so from here on the marker, never the
 * version, says whose runtime a Deno is.
 */
export const FIRST_MARKER_RUNTIME = "3.0.0-rc.3";

/** What a Deno says about itself: its version and, on denext's Deno, its identity marker. */
export interface DenoIdentity {
  /** `Deno.version.deno`, or the version on the first line of `deno --version`. */
  readonly deno: string;
  /**
   * `Deno.build.denext`, or the version on the `denext <version> (Brainwires)` line of
   * `deno --version`: present only on denext's Deno from {@linkcode FIRST_MARKER_RUNTIME} on.
   */
  readonly denext?: string;
}

/** The identity marker's line in `deno --version`. */
const MARKER_LINE = /^denext (\S+) \(Brainwires\)\s*$/m;

/** The first line of `deno --version` / `deno -V`. */
const VERSION_LINE = /^deno (\d+\.\d+\.\d+\S*)/m;

/**
 * The line denext's Deno adds to `deno --version` (from {@linkcode FIRST_MARKER_RUNTIME}).
 *
 * @param version The runtime's version.
 * @returns `denext <version> (Brainwires)`.
 */
export function denextVersionLine(version: string): string {
  return `denext ${version} (Brainwires)`;
}

/**
 * This process's Deno: `Deno.version.deno` and, on denext's Deno, `Deno.build.denext`.
 *
 * @returns The identity.
 */
export function currentDenoIdentity(): DenoIdentity {
  const marker = (Deno.build as { denext?: unknown }).denext;
  return typeof marker === "string" && marker !== ""
    ? { deno: Deno.version.deno, denext: marker }
    : { deno: Deno.version.deno };
}

/**
 * A child Deno's identity from its `deno --version` output: the version on the first line and,
 * when denext's Deno printed one, the `denext <version> (Brainwires)` line's version.
 *
 * @param text The output of `deno --version` (or `deno -V`, which has no marker line).
 * @returns The identity, or `null` when there is no `deno <version>` line.
 */
export function parseDenoVersionOutput(text: string): DenoIdentity | null {
  const first = VERSION_LINE.exec(text);
  if (!first) return null;
  const marker = MARKER_LINE.exec(text);
  return marker ? { deno: first[1], denext: marker[1] } : { deno: first[1] };
}

/**
 * The fallback for a Deno without the identity marker: whether its version alone names one of
 * denext's runtimes from before {@linkcode FIRST_MARKER_RUNTIME}. `X.Y.Z-denext.N` always does
 * (upstream never uses the suffix); a version under the fork's own scheme does only when it is
 * exactly the pinned toolchain and that pin predates the marker (`3.0.0-rc.2` and earlier), since
 * upstream's own `3.0.0-rc.N` and `3.0.0` cannot be told from the fork's by the version.
 *
 * @param version A `Deno.version.deno` or `deno --version` version.
 * @param pinned The toolchain pin's version (default: the checked-in pin's).
 * @returns Whether it is a pre-marker build of denext's Deno.
 */
export function isPreMarkerDenextVersion(
  version: string,
  pinned: string | null = toolchainPin.version,
): boolean {
  if (OLD_SCHEME.test(version)) return true;
  return pinned !== null && version === pinned &&
    compareDenoVersions(pinned, FIRST_MARKER_RUNTIME) < 0;
}

/**
 * Whether a running Deno is denext's own Deno (the toolchain, or a Deno Desktop runtime): it
 * carries the identity marker (`Deno.build.denext`, or the `denext <version> (Brainwires)` line
 * of `deno --version`), or it predates the marker and its version says so
 * ({@linkcode isPreMarkerDenextVersion}). Upstream Deno's `3.0.0-rc.N` / `3.0.0` is not, whatever
 * its number.
 *
 * @param identity What the Deno says about itself ({@linkcode currentDenoIdentity},
 *   {@linkcode parseDenoVersionOutput}).
 * @param pinned The toolchain pin's version (default: the checked-in pin's).
 * @returns Whether it is denext's Deno.
 */
export function isDenextDenoVersion(
  identity: DenoIdentity,
  pinned: string | null = toolchainPin.version,
): boolean {
  if (identity.denext !== undefined && identity.denext !== "") return true;
  return isPreMarkerDenextVersion(identity.deno, pinned);
}

/**
 * Whether a running Deno is exactly the pinned toolchain: denext's Deno
 * ({@linkcode isDenextDenoVersion}) whose version is the pin's.
 *
 * @param identity What the Deno says about itself.
 * @param pinned The toolchain pin's version (`null`: none pinned).
 * @returns Whether it runs the pinned toolchain.
 */
export function isPinnedDenextDeno(identity: DenoIdentity, pinned: string | null): boolean {
  return pinned !== null && identity.deno === pinned && isDenextDenoVersion(identity, pinned);
}

/**
 * Whether a version taken from denext's own pins or a Brainwires/deno release manifest (never from
 * a running Deno, which {@linkcode isDenextDenoVersion} answers) is in a scheme of denext's Deno
 * releases: `X.Y.Z-denext.N`, or the fork's own version from {@linkcode FIRST_OWN_VERSION_RUNTIME}
 * on.
 *
 * @param version A pin's or a release manifest's version.
 * @returns Whether it names a release of denext's Deno.
 */
export function isDenextReleaseVersion(version: string): boolean {
  return OLD_SCHEME.test(version) ||
    (parseVersion(version) !== null &&
      compareDenoVersions(version, FIRST_OWN_VERSION_RUNTIME) >= 0);
}

/**
 * The stock Deno release a running Deno is built from: `2.9.7-denext.15` is Deno 2.9.7, denext's
 * Deno under its own version (`3.0.0-rc.1`, told by {@linkcode isDenextDenoVersion}) is the stock
 * release the pinned toolchain is built from (`upstream`, the pin's `deno`), and any other Deno —
 * upstream's `3.0.0-rc.N` included — is its own version. Every image tag, `setup-deno` version and
 * "is this the Deno the runtime was built for" check goes through this.
 *
 * @param identity What the Deno says about itself.
 * @param upstream The stock release denext's own Deno is built from (default: the toolchain
 *   pin's `deno`).
 * @returns The stock Deno release.
 */
export function denoReleaseVersion(
  identity: DenoIdentity,
  upstream: string = toolchainPin.deno,
): string {
  const old = OLD_SCHEME.exec(identity.deno);
  if (old) return old[1];
  return isDenextDenoVersion(identity) ? upstream : identity.deno;
}

/**
 * {@linkcode denoReleaseVersion} for a version from denext's own pins or a release manifest
 * ({@linkcode isDenextReleaseVersion}): `2.9.7-denext.15` is 2.9.7, the fork's own version is
 * `upstream`.
 *
 * @param version A pin's or a release manifest's version.
 * @param upstream The stock release it is built from (default: the toolchain pin's `deno`).
 * @returns The stock Deno release.
 */
export function pinnedDenoReleaseVersion(
  version: string,
  upstream: string = toolchainPin.deno,
): string {
  const old = OLD_SCHEME.exec(version);
  if (old) return old[1];
  return isDenextReleaseVersion(version) ? upstream : version;
}

function parts(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
