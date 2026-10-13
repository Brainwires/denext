// The minimum Deno release denext supports, checked by `denext doctor` and before spawning
// `deno bundle`. `deno bundle` shipped in 2.4 and `deno desktop` in 2.9; CI pins 2.9.x.

/** The minimum supported Deno version. */
export const MIN_DENO_VERSION = "2.9.0";

/** Whether `version` (e.g. `Deno.version.deno`) satisfies {@linkcode MIN_DENO_VERSION}. */
export function denoVersionOk(version: string, min: string = MIN_DENO_VERSION): boolean {
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * The Deno release a version names, without the `-denext.N` suffix of denext's Deno toolchain
 * (`2.9.7-denext.15` is Deno 2.9.7). Semver sorts such a prerelease BELOW its release, so every
 * comparison, image tag or `setup-deno` version goes through this first.
 *
 * @param version A `Deno.version.deno` or `deno --version` version.
 * @returns The stock Deno release it is built from.
 */
export function denoReleaseVersion(version: string): string {
  return version.replace(/-denext\.\d+$/, "");
}

function parts(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
