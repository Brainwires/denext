// The production server's idle trim: denext's Deno from runtime 3.0.0-rc.5 (Brainwires/deno
// DENEXT.md item 104) can hand the memory a load burst left behind back to the OS once the event
// loop goes idle — a full V8 GC, then glibc's `malloc_trim(0)`. It is opt-in on the runtime
// (`--unstable-idle-trim`, or `DENO_UNSTABLE_IDLE_TRIM=1` read when the process starts); denext
// turns it on for the production server only — `denext start` when it starts the server process
// itself, the `build --compile` executable, and the Docker image / systemd unit the generators
// write — never for `dev`, tests, jobs or the desktop runtime. The runtime does nothing with it
// off glibc Linux, so it is passed whatever the host.
//
// Opt-outs: `start: { idleTrim: false }` in denext.config, or `DENEXT_IDLE_TRIM=0` in the
// environment of the command that starts the server (or writes the file that does). A
// `DENO_UNSTABLE_IDLE_TRIM` the user set themselves is left alone.

import { join } from "@std/path";
import toolchainPin from "./deno-toolchain-pin.json" with { type: "json" };
import { supportsIdleTrim } from "./deno-version.ts";

/** The environment variable denext's Deno reads at start to turn the idle trim on (`1`). */
export const IDLE_TRIM_ENV = "DENO_UNSTABLE_IDLE_TRIM";
/** The flag that bakes the idle trim into a `deno compile` executable. */
export const IDLE_TRIM_FLAG = "--unstable-idle-trim";
/** `DENEXT_IDLE_TRIM=0` keeps denext from turning the idle trim on. */
const IDLE_TRIM_OPT_OUT_ENV = "DENEXT_IDLE_TRIM";

/** `start: { idleTrim: false }` in a config file's text. */
const CONFIG_OFF = /\bidleTrim\s*:\s*false\b/;

/**
 * An environment variable of this process, or `undefined` when unset or not readable (no
 * `--allow-env`).
 *
 * @param name The variable.
 * @returns Its value.
 */
export function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** What decides whether the server runs with the idle trim. */
export interface IdleTrimInputs {
  /**
   * The version of denext's Deno that runs the server (a toolchain marker or the pinned
   * version), or `undefined` / `"path"` when it is stock Deno or of unknown version.
   */
  readonly runtime: string | undefined;
  /** Whether the project's config opts out (`start.idleTrim === false`). */
  readonly configOff: boolean;
  /** Reads an environment variable. */
  readonly env: (name: string) => string | undefined;
}

/**
 * Whether the production server gets the idle trim: its runtime is denext's Deno from 3.0.0-rc.5
 * and neither the config nor `DENEXT_IDLE_TRIM=0` opts out.
 *
 * @param inputs The runtime, the config's opt-out and the environment.
 * @returns Whether to turn it on.
 */
export function idleTrimOn(inputs: IdleTrimInputs): boolean {
  const { runtime } = inputs;
  return runtime !== undefined && runtime !== "path" && supportsIdleTrim(runtime) &&
    !inputs.configOff && inputs.env(IDLE_TRIM_OPT_OUT_ENV) !== "0";
}

/**
 * The environment a `denext start` child gets: `DENO_UNSTABLE_IDLE_TRIM=1` when
 * {@linkcode idleTrimOn}, unless the variable is already set (the user's own value stands, `0`
 * included: the runtime turns the trim on for `1` only).
 *
 * @param inputs The runtime, the config's opt-out and the environment.
 * @returns The variables to add (none, or the one).
 */
export function idleTrimEnv(inputs: IdleTrimInputs): Record<string, string> {
  if (inputs.env(IDLE_TRIM_ENV) !== undefined || !idleTrimOn(inputs)) return {};
  return { [IDLE_TRIM_ENV]: "1" };
}

/**
 * The flags a `build --compile` executable gets baked in: `--unstable-idle-trim` when
 * {@linkcode idleTrimOn}. A baked flag cannot be turned off when the binary runs, so the opt-outs
 * apply at build time.
 *
 * @param inputs The toolchain compiling (`undefined` off it), the config's opt-out, the environment.
 * @returns The flags.
 */
export function idleTrimCompileFlags(inputs: IdleTrimInputs): string[] {
  return idleTrimOn(inputs) ? [IDLE_TRIM_FLAG] : [];
}

/**
 * Whether a generated file that runs its server on denext's pinned toolchain (the Docker image,
 * a generic host's systemd unit) turns the idle trim on.
 *
 * @param configOff Whether the project's config opts out.
 * @param env Reads an environment variable (the generator's).
 * @param pinned The pinned toolchain version (default: the checked-in pin's).
 * @returns Whether to write `DENO_UNSTABLE_IDLE_TRIM=1` into it.
 */
export function pinnedIdleTrim(
  configOff: boolean,
  env: (name: string) => string | undefined,
  pinned: string = toolchainPin.version,
): boolean {
  return idleTrimOn({ runtime: pinned, configOff, env });
}

/**
 * Whether a config file's text opts out of the idle trim (`start: { idleTrim: false }`). Read as
 * text, as the Docker generator reads the config, so a process that has not loaded the config yet
 * (the parent of a toolchain re-exec) can decide without importing it.
 *
 * @param text The config file's text (several files joined).
 * @returns Whether it opts out.
 */
export function configTextDisablesIdleTrim(text: string): boolean {
  return CONFIG_OFF.test(text);
}

/**
 * {@linkcode configTextDisablesIdleTrim} for the project in `dir` (`denext.config.ts`, `.js`,
 * `.mjs` or `.mts`; none, or unreadable, opts out of nothing).
 *
 * @param dir The project directory.
 * @returns Whether its config opts out.
 */
export async function configDisablesIdleTrim(dir: string): Promise<boolean> {
  for (const ext of ["ts", "js", "mjs", "mts"]) {
    try {
      if (configTextDisablesIdleTrim(await Deno.readTextFile(join(dir, `denext.config.${ext}`)))) {
        return true;
      }
    } catch { /* absent or unreadable */ }
  }
  return false;
}
