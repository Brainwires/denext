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
// environment of the command that starts the server (or writes the file that does) — for a
// `build --compile` executable, which has the trim baked in, `DENEXT_IDLE_TRIM=0` when the binary
// runs too (it then keeps its event loop from ever going idle long enough to trim). A
// `DENO_UNSTABLE_IDLE_TRIM` the user set themselves is left alone.
//
// The config's opt-out is the evaluated value: what the last `denext build` recorded in its deploy
// manifest; only before a first build, the file's text (comments ignored).

import { join } from "@std/path";
import { CONFIG_FILES } from "./config-files.ts";
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
 * {@linkcode idleTrimOn}. A baked flag cannot be turned off when the binary runs; a
 * `DENEXT_IDLE_TRIM=0` then holds the trim off instead ({@linkcode holdOffBakedIdleTrim}).
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

/** `text` with its line and block comments blanked (string contents are not parsed). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * Whether a config file's text opts out of the idle trim (`start: { idleTrim: false }`), its
 * comments ignored. What {@linkcode configDisablesIdleTrim} reads before a first build.
 *
 * @param text The config file's text (several files joined).
 * @returns Whether it opts out.
 */
export function configTextDisablesIdleTrim(text: string): boolean {
  return CONFIG_OFF.test(withoutComments(text));
}

/** The deploy manifest's `server.idleTrim` from the last `denext build` in `dir`, if any. */
async function builtIdleTrim(dir: string): Promise<boolean | undefined> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, ".denext", "deploy-manifest.json")),
    ) as { server?: { idleTrim?: unknown } };
    const value = manifest.server?.idleTrim;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined; // no build yet, or one from before the field
  }
}

/**
 * Whether the project in `dir` opts out of the idle trim (`start: { idleTrim: false }`), read
 * from the evaluated config: what the last `denext build` recorded in its deploy manifest (the
 * loaded config's value, with a `DENEXT_IDLE_TRIM=0` at build time). Before any build, the config
 * file's text, comments ignored: the config is never imported here (the Docker generator and
 * `denext ui` run no project code, and `denext start`'s parent decides before it re-executes).
 * No config opts out of nothing.
 *
 * @param dir The project directory.
 * @returns Whether its config opts out.
 */
export async function configDisablesIdleTrim(dir: string): Promise<boolean> {
  const built = await builtIdleTrim(dir);
  if (built !== undefined) return !built;
  for (const name of CONFIG_FILES) {
    try {
      if (configTextDisablesIdleTrim(await Deno.readTextFile(join(dir, name)))) return true;
    } catch { /* absent or unreadable */ }
  }
  return false;
}

/** The runtime's default idle delay before a trim (`DENO_IDLE_TRIM_DELAY_MS`), in ms. */
const DEFAULT_TRIM_DELAY_MS = 1000;

/**
 * Keep a `build --compile` executable that has the idle trim baked in from ever trimming, when
 * `DENEXT_IDLE_TRIM=0` is set as it runs. A baked flag can't be turned off once the binary has
 * started, but the runtime trims only after its event loop has gone `DENO_IDLE_TRIM_DELAY_MS`
 * (default 1 s) without a wake-up, so an unref'd timer firing at half that delay keeps it from
 * ever being idle that long (and costs one empty callback per half-delay; it never keeps the
 * process alive).
 *
 * @param baked Whether the binary was compiled with the trim baked in.
 * @param env Reads an environment variable.
 * @param every Starts the repeating timer (a seam for tests).
 * @returns Whether the trim is held off.
 */
export function holdOffBakedIdleTrim(
  baked: boolean,
  env: (name: string) => string | undefined = readEnv,
  every: (fn: () => void, ms: number) => void = (fn, ms) => Deno.unrefTimer(setInterval(fn, ms)),
): boolean {
  if (!baked || env(IDLE_TRIM_OPT_OUT_ENV) !== "0") return false;
  const raw = Number(env("DENO_IDLE_TRIM_DELAY_MS")?.trim());
  const delay = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRIM_DELAY_MS;
  every(() => {}, Math.max(1, Math.floor(delay / 2)));
  return true;
}
