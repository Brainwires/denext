// The production server's resource limits: denext's Deno from runtime 3.0.0-rc.2 (Brainwires/deno
// DENEXT.md item 92) takes `--max-memory=<size>` (the main isolate's V8 heap; exit 137),
// `--max-cpu-time=<secs>` (process CPU time, every thread; exit 152) and `--max-time=<secs>`
// (wall clock; exit 124) on `deno run` and `deno compile` — the latter stores them in the binary,
// which enforces them as it runs. No unstable flag; refused with `--watch` and on `deno test`.
//
// `start: { limits: { memory, cpuSeconds, deadlineSeconds } }` in denext.config turns them on for
// the production server only, where it starts: the process of `denext start` that serves, the
// `build --compile` executable, the Docker image's `CMD` and the systemd unit's `ExecStart` —
// never `dev` (a watcher), tests or jobs. Stock Deno and older toolchains reject the flags, so
// they are never passed there; the server then runs without them and says so.
//
// `denext start` may re-run itself before it serves (onto the toolchain, to the project's pinned
// denext, under the CSS / module config). Only the last process, the one that serves, runs with the
// flags: a hop that may re-run again hands them down as data (`DENEXT_START_LIMITS`), so no hop's
// `--max-time` ends before the server's, leaving it running without its parent, and no hop's own
// CPU or heap is measured against them ({@linkcode hopLimits}; the gate is `maybeReexecForLimits`
// in src/cli/self-exec.ts). A compiled binary can't do that: `denort` reads the limits only from
// the binary's metadata (Brainwires/deno `cli/rt/run.rs`), so its `job` and `db` run under them too.
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
 * one that doesn't (Deno exposes no API for its own flags). Every CLI re-run sets it for its child
 * (empty when the child is not given the flags), so an inherited value never speaks for a child,
 * and the serving process removes it from its own environment once read.
 */
export const LIMITS_APPLIED_ENV = "DENEXT_LIMITS_APPLIED";

/**
 * Internal: the configured limit flags (space-joined), handed down by a `denext start` re-run that
 * does not serve itself (the toolchain re-exec, a compiled `denext` handing the project to its
 * pinned version) to the process that will. Only that one, the last, runs with them as flags; the
 * hops before it carry them as data, so their own CPU, heap and clock are not counted and no
 * hop's `--max-time` ends before the server's. Removed from the serving process's environment.
 */
export const START_LIMITS_ENV = "DENEXT_START_LIMITS";

/** The resource-limit flags a CLI child runs with, and the environment that says so. */
export interface ChildLimits {
  /** The flags, after `run`. */
  readonly flags: readonly string[];
  /** {@linkcode LIMITS_APPLIED_ENV} and {@linkcode START_LIMITS_ENV} for the child, or nothing. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * What a `denext start` re-run gives its child for the configured limits. A child that serves
 * (`serves`: the CSS / module-config re-exec, whose child never re-runs again, and the limits
 * re-run itself) gets the flags its runtime takes ({@linkcode limitFlagsFor}) and
 * `DENEXT_LIMITS_APPLIED` naming them; one that may re-run again (the toolchain re-exec, the
 * pinned-denext re-exec) gets no flags, an empty `DENEXT_LIMITS_APPLIED` and the configured flags
 * as data ({@linkcode START_LIMITS_ENV}). Nothing at all when no limits are configured.
 *
 * @param serves Whether the child is the process that serves.
 * @param runtime The toolchain the child runs (`undefined`: stock Deno; `"path"`: unknown).
 * @param configured The configured flags ({@linkcode resourceLimitFlags}).
 * @returns The child's flags and environment.
 */
export function hopLimits(
  serves: boolean,
  runtime: string | undefined,
  configured: readonly string[],
): ChildLimits {
  if (configured.length === 0) return { flags: [], env: {} };
  const flags = serves ? limitFlagsFor(runtime, configured) : [];
  return {
    flags,
    env: { [LIMITS_APPLIED_ENV]: flags.join(" "), [START_LIMITS_ENV]: configured.join(" ") },
  };
}

/**
 * The configured flags a {@linkcode START_LIMITS_ENV} value hands down (`undefined`: none was).
 *
 * @param value The variable's value.
 * @returns The flags.
 */
export function handedLimits(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(" ").filter(Boolean);
}

/**
 * The line a compiled app prints when it runs `job` or `db` with `start.limits` baked in: `deno
 * compile` stores them in the binary and `denort` enforces them on every run, whatever the verb,
 * with no flag or variable to lift them (Brainwires/deno DENEXT.md item 92).
 *
 * @param program The executable's name.
 * @param verb The verb (`job`, `db`).
 * @param baked The baked flags.
 * @returns The notice, or `null` for `start` or when none are baked.
 */
export function bakedLimitsNotice(
  program: string,
  verb: string,
  baked: readonly string[],
): string | null {
  if (baked.length === 0 || (verb !== "job" && verb !== "db")) return null;
  return `${program}: this binary enforces the start.limits it was compiled with ` +
    `(${baked.join(" ")}) on \`${verb}\` too; a run past them ends with their exit code. ` +
    "Run long jobs and migrations with `denext job` / `denext db`, or from a binary compiled " +
    "without start.limits.";
}

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

/**
 * Why a process on `runtime` runs without the limits ({@linkcode limitFlagsFor} gave it none), for
 * {@linkcode limitsNotAppliedWarning}.
 *
 * @param runtime The toolchain version, or `undefined` (stock Deno) / `"path"` (unknown version).
 * @returns The reason.
 */
export function supportsLimitsWhy(runtime: string | undefined): string {
  if (runtime === undefined) {
    return "they need denext's Deno toolchain from runtime 3.0.0-rc.2, and this server runs on " +
      "stock Deno (unset DENEXT_DENO=stock)";
  }
  if (runtime === "path") return "a DENEXT_DENO=<path> Deno's version is unknown";
  return `this Deno (${runtime}) predates runtime 3.0.0-rc.2 — \`denext toolchain install\``;
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

/**
 * `text` with its line and block comments blanked (string contents are not parsed).
 *
 * @param text A config file's text.
 * @returns The text without comments.
 */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * The body of the literal that opens at `text[open]` (`{`, or `[` with `close` `]`), balanced.
 *
 * @param text The text.
 * @param open Where the literal opens.
 * @param close The closing bracket (`}` by default; `]` for an array).
 * @returns Its body, without the brackets.
 */
export function objectBody(text: string, open: number, close = "}"): string {
  const opener = text[open];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(open + 1, i);
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
