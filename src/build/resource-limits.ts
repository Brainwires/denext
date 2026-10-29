// The production server's resource limits: denext's Deno from runtime 3.0.0-rc.2 (Brainwires/deno
// DENEXT.md item 92) takes `--max-memory=<size>` (the main isolate's V8 heap; exit 137),
// `--max-cpu-time=<secs>` (process CPU time, every thread; exit 152) and `--max-time=<secs>`
// (wall clock; exit 124) on `deno run` and `deno compile` — the latter stores them in the binary,
// which enforces them as it runs. No unstable flag; refused with `--watch` and on `deno test`.
//
// `start: { limits: { memory, cpuSeconds, deadlineSeconds } }` in denext.config turns them on for
// the production server only, where it starts: the process `denext start` starts itself, the
// `build --compile` executable, the Docker image's `CMD` and the systemd unit's `ExecStart` —
// never `dev` (a watcher), tests or jobs. Stock Deno and older toolchains reject the flags, so
// they are never passed there; the server then runs without them and says so.
//
// The config is read as the idle trim's is (src/build/idle-trim.ts): what the last `denext build`
// recorded in its deploy manifest (`server.limits`, the evaluated config); only before a first
// build, the literal values in the config file's text (comments ignored).

import { join } from "@std/path";
import { CONFIG_FILES } from "./config-files.ts";
import toolchainPin from "./deno-toolchain-pin.json" with { type: "json" };
import { supportsResourceLimits } from "./deno-version.ts";
import type { StartLimits } from "../server/config.ts";
import { memoryLimitBytes, validSeconds } from "../server/config-validate/limits.ts";

/**
 * Set on a server process started with the limit flags: their command-line words, space-joined.
 * `denext start` reads it to tell a process that already runs under the configured limits from
 * one that doesn't (Deno exposes no API for its own flags).
 */
export const LIMITS_APPLIED_ENV = "DENEXT_LIMITS_APPLIED";

/**
 * The runtime flags `start.limits` asks for (`--max-memory=512m`, `--max-cpu-time=<n>`,
 * `--max-time=<n>`, in that order). A value the runtime would refuse is left out (the config
 * validator reports it).
 *
 * @param limits The configured limits.
 * @returns The flags (none when nothing is limited).
 */
export function resourceLimitFlags(limits: StartLimits | undefined): string[] {
  if (!limits) return [];
  const flags: string[] = [];
  const { memory, cpuSeconds, deadlineSeconds } = limits;
  if (memoryLimitBytes(memory) !== null) {
    flags.push(
      `--max-memory=${
        typeof memory === "number" ? `${memory}m` : String(memory).replace(/\s+/g, "").toLowerCase()
      }`,
    );
  }
  if (validSeconds(cpuSeconds)) flags.push(`--max-cpu-time=${cpuSeconds}`);
  if (validSeconds(deadlineSeconds)) flags.push(`--max-time=${deadlineSeconds}`);
  return flags;
}

/**
 * The limit flags a process running on `runtime` gets: all of `flags` on denext's Deno from
 * 3.0.0-rc.2, none on stock Deno (`undefined`), a `DENEXT_DENO=<path>` binary of unknown version
 * (`"path"`) or an older toolchain, which would refuse them.
 *
 * @param runtime The toolchain version the process runs, or `undefined` / `"path"`.
 * @param flags The configured flags ({@linkcode resourceLimitFlags}).
 * @returns The flags to pass.
 */
export function limitFlagsFor(runtime: string | undefined, flags: readonly string[]): string[] {
  return runtime !== undefined && runtime !== "path" && supportsResourceLimits(runtime)
    ? [...flags]
    : [];
}

/**
 * The limit flags a generated file whose server runs on denext's pinned toolchain gets (the
 * Docker image, a generic host's systemd unit).
 *
 * @param flags The configured flags.
 * @param pinned The pinned toolchain version (default: the checked-in pin's).
 * @returns The flags.
 */
export function pinnedLimitFlags(
  flags: readonly string[],
  pinned: string = toolchainPin.version,
): string[] {
  return limitFlagsFor(pinned, flags);
}

/**
 * `words` (a `deno run …` command) with `flags` inserted right after `run`, or `null` when it is
 * not a `deno run` command (a `deno task`, `deno serve`, a shell line), where they can't go.
 *
 * @param words The command's words.
 * @param flags The flags to add.
 * @returns The command, or `null`.
 */
export function withLimitFlags(
  words: readonly string[],
  flags: readonly string[],
): string[] | null {
  if (words[1] !== "run" || !/(^|[\\/])deno(\.exe)?$/.test(words[0] ?? "")) return null;
  return [words[0], "run", ...flags, ...words.slice(2)];
}

/** The warning when configured limits can't be applied to the server process. */
export function limitsNotAppliedWarning(flags: readonly string[], why: string): string {
  return `denext: start.limits (${flags.join(" ")}) are not applied: ${why}.`;
}

/**
 * The limit flags a `build --compile` executable gets baked in (`deno compile` stores them in the
 * binary, and the toolchain's `denort` enforces them): `start.limits` when the compile runs on
 * denext's Deno from 3.0.0-rc.2; otherwise none, with a warning when limits are configured.
 *
 * @param limits The configured limits.
 * @param toolchain The toolchain version compiling, or `undefined` (stock Deno, an explicit `deno`).
 * @param warn Where the warning goes.
 * @returns The flags.
 */
export function compileLimitFlags(
  limits: StartLimits | undefined,
  toolchain: string | undefined,
  warn: (message: string) => void = (m) => console.error(m),
): string[] {
  const flags = resourceLimitFlags(limits);
  const baked = limitFlagsFor(toolchain, flags);
  if (flags.length > 0 && baked.length === 0) {
    warn(limitsNotAppliedWarning(
      flags,
      "only denext's Deno toolchain from runtime 3.0.0-rc.2 bakes them into an executable " +
        "(`denext toolchain install`, and no DENEXT_DENO=stock)",
    ));
  }
  return baked;
}

/** `text` with its line and block comments blanked (string contents are not parsed). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** The body of the object literal that opens at `text[open]` (`{`), braces balanced. */
function objectBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** A literal number or quoted string after `key:` in `body`, if there is one. */
function literal(body: string, key: string): number | string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(?:(\\d+)\\b|"([^"]*)"|'([^']*)')`).exec(body);
  if (!m) return undefined;
  return m[1] !== undefined ? Number(m[1]) : m[2] ?? m[3];
}

/**
 * The `start.limits` a config file's text sets with literal values (comments ignored), or
 * `undefined`. Only the `start` object's own `limits` counts (not `live.limits`). What
 * {@linkcode configuredLimitFlags} reads before a first build; a computed value needs a build.
 *
 * @param text The config file's text.
 * @returns The literal limits.
 */
export function configTextLimits(text: string): StartLimits | undefined {
  const clean = withoutComments(text);
  const start = /\bstart\s*:\s*\{/.exec(clean);
  if (!start) return undefined;
  const body = objectBody(clean, start.index + start[0].length - 1);
  const limits = /\blimits\s*:\s*\{/.exec(body);
  if (!limits) return undefined;
  const inner = objectBody(body, limits.index + limits[0].length - 1);
  const out: StartLimits = {};
  const memory = literal(inner, "memory");
  const cpu = literal(inner, "cpuSeconds");
  const deadline = literal(inner, "deadlineSeconds");
  if (memory !== undefined) out.memory = memory;
  if (typeof cpu === "number") out.cpuSeconds = cpu;
  if (typeof deadline === "number") out.deadlineSeconds = deadline;
  return out;
}

/** The deploy manifest's `server.limits` from the last `denext build` in `dir`, if any. */
async function builtLimits(dir: string): Promise<string[] | undefined> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, ".denext", "deploy-manifest.json")),
    ) as { server?: { limits?: unknown } };
    const value = manifest.server?.limits;
    return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
  } catch {
    return undefined; // no build yet, or one from before the field
  }
}

/**
 * The limit flags the project in `dir` configures (`start.limits`): what the last `denext build`
 * recorded in its deploy manifest (the evaluated config); before any build, the literal values in
 * the config file's text. The config is never imported here (the Docker generator and `denext ui`
 * run no project code, and `denext start`'s parent decides before it re-executes).
 *
 * @param dir The project directory.
 * @returns The flags (none when nothing is limited).
 */
export async function configuredLimitFlags(dir: string): Promise<string[]> {
  const built = await builtLimits(dir);
  if (built !== undefined) return built;
  for (const name of CONFIG_FILES) {
    try {
      const limits = configTextLimits(await Deno.readTextFile(join(dir, name)));
      if (limits) return resourceLimitFlags(limits);
    } catch { /* absent or unreadable */ }
  }
  return [];
}
