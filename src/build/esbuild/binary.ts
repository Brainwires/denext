// Which esbuild executable denext's vendored esbuild API (./mod.ts) spawns. In order:
//
//   1. `ESBUILD_BINARY_PATH` when set — esbuild's own override, used as given (the version
//      handshake still refuses a binary that is not ESBUILD_VERSION);
//   2. the esbuild that denext's Deno toolchain ships beside its `deno`: extracted from the
//      verified toolchain zip, checked against the pin's SHA-256 and recorded in the toolchain
//      stamp by `ensureDenoToolchain` — see `toolchainEsbuild` in ../deno-toolchain.ts.
//
// Nothing else runs: denext 5.0 runs only on its own Deno runtime, which always carries it. A
// toolchain that is not installed, or whose esbuild was refused (a SHA-256 or version mismatch),
// makes a build refuse with the fix (`denext toolchain install`, which re-verifies it).

import { toolchainEsbuild } from "../deno-toolchain.ts";
import type { DenoToolchainPin } from "../deno-toolchain.ts";
import { ESBUILD_VERSION } from "./version.ts";

/** esbuild's own override: the binary to run, unverified. */
export const ESBUILD_BINARY_PATH_ENV = "ESBUILD_BINARY_PATH";

/** Where an esbuild binary came from. */
export type EsbuildBinarySource = "env" | "toolchain";

/** The esbuild binary to run. */
export interface ResolvedEsbuildBinary {
  /** Its absolute path (as given, for `ESBUILD_BINARY_PATH`). */
  readonly path: string;
  readonly source: EsbuildBinarySource;
}

/** Env reader. */
type EnvGet = (k: string) => string | undefined;
const processEnv: EnvGet = (k) => {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined; // no env permission
  }
};

/** Seams for {@linkcode resolveEsbuildBinary} and {@linkcode esbuildBinaryStatus}. */
export interface ResolveEsbuildBinaryOptions {
  readonly env?: EnvGet;
  /** The toolchain pin (default: the one in force). */
  readonly pin?: DenoToolchainPin;
  /** Default: the host's toolchain target. */
  readonly target?: string;
  /** The OS the binary runs on (its file name), default the host's. */
  readonly os?: string;
  /** The toolchain cache root (default `<deno cache>/denext-deno`). */
  readonly toolchainCacheRoot?: string;
}

/** The toolchain's esbuild for `options`. */
function fromToolchain(env: EnvGet, options: ResolveEsbuildBinaryOptions) {
  return toolchainEsbuild({
    env,
    pin: options.pin,
    target: options.target,
    os: options.os,
    cacheRoot: options.toolchainCacheRoot,
  });
}

/**
 * Pick the esbuild binary (see the module header for the order). Never downloads.
 *
 * @param options Seams; all default to the process.
 * @returns The binary.
 * @throws When there is no override and the toolchain's esbuild is not installed and verified.
 */
export async function resolveEsbuildBinary(
  options: ResolveEsbuildBinaryOptions = {},
): Promise<ResolvedEsbuildBinary> {
  const env = options.env ?? processEnv;
  const override = env(ESBUILD_BINARY_PATH_ENV);
  if (override) return { path: override, source: "env" };
  const tc = await fromToolchain(env, options);
  if (tc.state === "ok" && tc.path) return { path: tc.path, source: "toolchain" };
  throw new Error(
    `denext: no usable esbuild ${ESBUILD_VERSION}: ${tc.detail}.\n` +
      "  Fix: run `denext toolchain install` (it installs and verifies denext's Deno toolchain " +
      `and the esbuild it ships), or point ${ESBUILD_BINARY_PATH_ENV} at an esbuild ` +
      `${ESBUILD_VERSION} binary.`,
  );
}

/** What {@linkcode esbuildBinaryStatus} reports. */
export interface EsbuildBinaryStatus {
  /** Where the binary comes from on the next build. */
  readonly source: EsbuildBinarySource;
  /** The binary, when it is in place (`null`: a build refuses until the toolchain installs it). */
  readonly path: string | null;
  /** `false` when a build would refuse (the toolchain's esbuild is missing or was refused). */
  readonly ok: boolean;
  /** One line for a report. */
  readonly detail: string;
}

/**
 * Which esbuild the next build spawns, without downloading anything (`denext toolchain status`).
 *
 * @param options Seams; all default to the process.
 * @returns The source, the binary when present, and a line for a report.
 */
export async function esbuildBinaryStatus(
  options: ResolveEsbuildBinaryOptions = {},
): Promise<EsbuildBinaryStatus> {
  const env = options.env ?? processEnv;
  const override = env(ESBUILD_BINARY_PATH_ENV);
  if (override) {
    return {
      source: "env",
      path: override,
      ok: true,
      detail: `${ESBUILD_BINARY_PATH_ENV}=${override} (unverified; must be esbuild ` +
        `${ESBUILD_VERSION})`,
    };
  }
  const tc = await fromToolchain(env, options);
  const ok = tc.state === "ok";
  return {
    source: "toolchain",
    path: ok ? tc.path : null,
    ok,
    detail: ok ? `${tc.detail}, from the toolchain` : `${tc.detail} (builds refuse until fixed)`,
  };
}
