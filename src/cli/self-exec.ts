// How the CLI re-runs ITSELF in a child `deno run` (the CSS import-map re-exec and the
// server-side-npm re-exec), for a local checkout, a JSR / https install, or a compiled binary.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  type DenoToolchainChoice,
  TOOLCHAIN_ACTIVE_ENV,
  toolchainEnvValue,
} from "../build/deno-toolchain.ts";
import { type DenoIdentity, isDenextDenoVersion } from "../build/deno-version.ts";
import { windowsCommandLine } from "./windows-command-line.ts";
import { runToExit } from "../build/exited-output.ts";

/** The config file names a Deno project may use, in resolution order. */
const CONFIG_NAMES = ["deno.json", "deno.jsonc"] as const;

/**
 * A `jsr:@denext/denext` specifier, however the import map spells it: with a version (range
 * operator included), or without one — which `deno run` resolves to the latest published
 * version, so it is a pin too. The version is held to a semver-range charset (letters, digits,
 * `. - ^ ~ * < > =`): no whitespace, quotes or `; | & $` — the pin ends up in commands.
 */
const DENEXT_SPEC = /^jsr:@denext\/denext(?:@([\w.^~<>=*-]+))?(?:\/|$)/;

/** Any `jsr:@denext/denext` specifier, whatever its version holds. */
const DENEXT_SPEC_LOOSE = /^jsr:@denext\/denext(?:@|\/|$)/;

/**
 * A CLI specifier safe to splice into a `deno task` command line (`denext mcp init`): the
 * version may not hold `<` / `>` (the task shell's redirections) or `*` (a glob) either.
 */
export const DENEXT_TASK_CLI_SPEC = /^jsr:@denext\/denext(?:@[\w.^~=-]+)?\/cli$/;

let warnedUnsafePin = false;

/** The import-map keys a project maps denext under. */
const DENEXT_KEYS = ["denext", "denext/", "@denext/denext"] as const;

/** How many directories {@linkcode pinnedDenextCli} walks up looking for a workspace root. */
const WORKSPACE_WALK_LIMIT = 64;

/** True only inside a `deno compile`d standalone binary (never for JSR/remote/file runs). */
export function isStandaloneBinary(): boolean {
  return (Deno.build as { standalone?: boolean }).standalone === true;
}

/**
 * The argument that re-runs the CLI module at `moduleUrl` in a child `deno run`: a
 * filesystem path for a local checkout, and the module URL itself for a JSR / https
 * install — Deno runs remote entrypoints directly, so a re-exec works from either.
 */
export function entrypointArg(moduleUrl: string): string {
  return moduleUrl.startsWith("file://") ? fromFileUrl(moduleUrl) : moduleUrl;
}

/** A parsed `deno.json(c)` — only the keys the pin lookup reads. */
interface DenoConfig {
  imports?: unknown;
  importMap?: unknown;
  workspace?: unknown;
}

/**
 * Read and parse `dir`'s `deno.json` (else `deno.jsonc`) — comments and trailing commas
 * allowed in either, as Deno allows them. `undefined` when there is no config, `null` when it
 * is malformed (a config that cannot be parsed pins nothing we can trust).
 */
function readConfig(dir: string): { config: DenoConfig; path: string } | null | undefined {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name);
    let source: string;
    try {
      source = Deno.readTextFileSync(path);
    } catch {
      continue;
    }
    try {
      const data = parseJsonc(source);
      return typeof data === "object" && data !== null
        ? { config: data as DenoConfig, path }
        : null;
    } catch {
      return null;
    }
  }
  return undefined;
}

/** The denext specifier an `imports` map holds under any of {@linkcode DENEXT_KEYS}. */
function denextImport(imports: unknown): string | null {
  if (typeof imports !== "object" || imports === null) return null;
  for (const key of DENEXT_KEYS) {
    const spec = (imports as Record<string, unknown>)[key];
    if (typeof spec !== "string") continue;
    if (DENEXT_SPEC.test(spec)) return spec;
    if (DENEXT_SPEC_LOOSE.test(spec) && !warnedUnsafePin) {
      warnedUnsafePin = true;
      console.warn(
        `denext: ignoring the denext import ${JSON.stringify(spec)}: its version is not a plain ` +
          "semver range (only letters, digits and . - ^ ~ * < > =), so it is not the project's pin",
      );
    }
  }
  return null;
}

/**
 * The denext specifier a config pins: its own `imports`, else the `imports` of the file its
 * `importMap` names (relative to the config).
 */
function pinOfConfig(config: DenoConfig, configPath: string): string | null {
  const own = denextImport(config.imports);
  if (own !== null) return own;
  if (typeof config.importMap !== "string") return null;
  try {
    const map = parseJsonc(Deno.readTextFileSync(resolve(dirname(configPath), config.importMap)));
    return denextImport((map as { imports?: unknown } | null)?.imports);
  } catch {
    return null; // a missing or malformed import map pins nothing
  }
}

/**
 * Whether a workspace member entry (`./apps/web`, `packages/*`) names `member`, both resolved
 * against the root's directory. Only `*` is understood, as one path segment.
 */
function workspaceLists(config: DenoConfig, rootDir: string, member: string): boolean {
  const entries = Array.isArray(config.workspace)
    ? config.workspace
    : (config.workspace as { members?: unknown } | null)?.members;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const full = resolve(rootDir, entry);
    if (!full.includes("*")) {
      if (full === member) return true;
      continue;
    }
    const pattern = full.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(
      "[^/\\\\]*",
    );
    if (new RegExp(`^${pattern}$`).test(member)) return true;
  }
  return false;
}

/**
 * The denext version the project at `dir` pins in its import map, as a runnable CLI specifier.
 *
 * A compiled binary carries one framework version; a project pins its own. When they differ the
 * binary must not build the app with its own copy — the project's pin decides, so the module
 * verbs re-exec that version's CLI. Outside a project (no config, or no `denext` import) there
 * is nothing to defer to and the binary's own framework is correct.
 *
 * The pin is what `deno run` in that directory would resolve `denext` to, so the lookup follows
 * Deno's rules rather than one JSON key: `deno.json` or `deno.jsonc` (comments and trailing
 * commas included), the import under `denext`, `denext/` or `@denext/denext`, an `imports` map
 * held in a separate `importMap` file, and — for a workspace member — the ROOT config's map,
 * found by walking up to the nearest `deno.json(c)` whose `workspace` lists this directory
 * (the walk stops at the filesystem root or at the directory holding `.git`). An UNVERSIONED
 * `jsr:@denext/denext` is a pin to the latest published version — that is what `deno run`
 * resolves it to — so it re-execs `jsr:@denext/denext/cli` rather than counting as "no pin".
 *
 * Reading the config synchronously is deliberate: every caller is on the verge of spawning a
 * `deno` process, so a few microseconds of file I/O is noise against it, and it keeps
 * {@link ../ui/proc.ts | `cliInvocation`} — which assembles argv on the UI's request path — an
 * ordinary synchronous function rather than forcing four call sites to become async.
 *
 * @param dir The project directory.
 * @returns `jsr:@denext/denext@<version>/cli` (`jsr:@denext/denext/cli` for an unversioned
 * pin), or null when the directory pins no denext. The version is passed through verbatim,
 * range operator included, so the child resolves exactly what the project asked for;
 * {@linkcode samePin} compares it to a concrete version.
 */
export function pinnedDenextCli(dir: string): string | null {
  const member = resolve(dir);
  const own = readConfig(member);
  if (own === null) return null; // malformed
  let spec = own === undefined ? null : pinOfConfig(own.config, own.path);
  // A workspace member inherits the root's import map; find the root that lists this dir. The
  // directory holding `.git` is checked and then the walk stops: a repository is never a member
  // of a workspace above it.
  for (let at = member, i = 0; spec === null && !isGitRoot(at) && i < WORKSPACE_WALK_LIMIT; i++) {
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
    const root = readConfig(at);
    if (root && workspaceLists(root.config, at, member)) {
      spec = pinOfConfig(root.config, root.path);
      break;
    }
  }
  if (spec === null) return null;
  const version = pinnedVersion(spec);
  return version === null ? "jsr:@denext/denext/cli" : `jsr:@denext/denext@${version}/cli`;
}

/**
 * The config flags the pinned-CLI child needs so it reads the PROJECT's config — what `deno run`
 * in the project directory would discover ({@linkcode nearestConfig}, a workspace member's own
 * file included). The child runs `jsr:@denext/denext@…/cli`, which discovers its config from the
 * working directory, so a verb aimed at a project from outside it (`denext build ./app`) would
 * start the child with another config or none at all — and so with another
 * `minimumDependencyAge` rule (and import map) than the project's own. From inside the project
 * the child finds the same file itself, so nothing is added ({@linkcode configArgsFor}).
 *
 * @param dir The project directory the verb targets.
 * @param cwd The child's working directory (production: the process's own).
 * @returns `["--config", <absolute path>]`, `["--no-config"]`, or `[]`.
 */
export function pinnedConfigArgs(dir: string, cwd: string = Deno.cwd()): string[] {
  return configArgsFor(nearestConfig(dir), "jsr:@denext/denext/cli", cwd);
}

/** Whether `dir` holds `.git` (a directory, or a worktree's file) — the walk's boundary. */
function isGitRoot(dir: string): boolean {
  try {
    Deno.lstatSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The version a `jsr:@denext/denext` specifier names, range operator included — null for an
 * unversioned specifier (latest) and for a string that is not a denext specifier at all.
 *
 * @param spec A `jsr:@denext/denext…` specifier (an import-map value or a CLI specifier from
 *   {@linkcode pinnedDenextCli}).
 * @returns The version as written, or null.
 */
export function pinnedVersion(spec: string): string | null {
  return DENEXT_SPEC.exec(spec)?.[1] ?? null;
}

/**
 * Whether a pinned CLI specifier names `version`, ignoring the range operator a project writes
 * (`^2.5.0` and `2.5.0` are the same pin here). A scaffolded project pins `^<version>`, so
 * comparing the raw specifiers would make a binary re-exec itself for its own version. An
 * unversioned pin (latest) never counts as the same: what "latest" is cannot be known here.
 *
 * @param cli A specifier from {@linkcode pinnedDenextCli}.
 * @param version The concrete version to compare against.
 * @returns Whether they name the same version.
 */
export function samePin(cli: string, version: string): boolean {
  const pinned = pinnedVersion(cli);
  return pinned !== null && pinned.replace(/^[\^~=<>]+/, "") === version;
}

/**
 * What {@linkcode maybeReexecPinned} touches in the process, injectable so the decision can be
 * tested without a compiled binary or a real child.
 */
export interface ReexecPinnedDeps {
  /** Whether this process is a compiled binary (production: {@linkcode isStandaloneBinary}). */
  readonly standalone: () => boolean;
  /** An environment variable (production: `Deno.env.get`). */
  readonly env: (name: string) => string | undefined;
  /**
   * Run the pinned CLI with the process's own argv and resolve with its exit code
   * (production: a `deno run` child with stdio and shutdown signals forwarded).
   */
  readonly spawn: (cli: string) => Promise<number>;
  /** End the process (production: `Deno.exit`; a test's may record the code and return). */
  readonly exit: (code: number) => void;
  /** Say something on stderr (production: `console.error`). */
  readonly warn: (message: string) => void;
}

/**
 * A compiled binary never loads an app's modules in its own process — it re-execs the denext the
 * project pins and lets that child do the work.
 *
 * Two reasons, and the second is why this happens even when the pin names this binary's own
 * version. First, skew: the binary carries ONE framework version while a project pins its own,
 * and building an app with the wrong one silently swaps its framework. Second, a binary simply
 * cannot bundle in-process. `frameworkFileUrl()` resolves the generated client entry's imports
 * (`denext/client-runtime`, `denext/class-runtime`, `denext/devtools` — see `writeMergedConfig`
 * in src/build/bundle.ts) against `import.meta.url`, which inside a binary is a `deno-compile://`
 * path visible only to that process; the child `deno bundle` is a separate process and fails with
 * `Module not found …/deno-compile-denext/src/client/client-runtime.ts`. A compat app fails even
 * earlier, inside esbuild's Node child-process shim. A `deno run` child has a real framework root
 * and both paths work, so deferring is the fix for both.
 *
 * Only a standalone binary does this. Under `deno run` the CLI and the framework are the same
 * package by construction, so there is nothing to defer to. The child runs under `deno run`,
 * where it is not a binary — but it may itself re-exec for CSS/modules, so the
 * `DENEXT_PINNED_ACTIVE` guard (not the version comparison) is what makes a loop impossible.
 *
 * @param dir The project directory the verb targets.
 * @param version This CLI's own version (what the refusal names, and what the pin is compared
 *   to so a switch is only announced for a DIFFERENT denext).
 * @param args The process's argv, for the refusal's suggested command.
 * @param deps The process seams.
 * @returns Whether the caller should stop: the process re-exec'd, or refused. In production
 *   both end the process through `deps.exit`, so `true` is only ever observed by a test.
 */
export async function maybeReexecPinned(
  dir: string,
  version: string,
  args: readonly string[],
  deps: ReexecPinnedDeps,
): Promise<boolean> {
  if (!deps.standalone() || deps.env("DENEXT_PINNED_ACTIVE")) return false;
  const cli = pinnedDenextCli(dir);
  if (cli === null) {
    deps.warn(
      `denext: this directory pins no denext, and a compiled binary cannot build an app in its ` +
        `own process.\n  Add denext to the project's deno.json imports (\`denext create\` does ` +
        `this), or run the CLI as:\n    denext deno run -A jsr:@denext/denext@${version}/cli ` +
        `${args.join(" ")}`,
    );
    deps.exit(1);
    return true;
  }
  // Only worth saying when it is a DIFFERENT denext; announcing a switch to the version already
  // running would be noise at best and a lie at worst.
  if (!samePin(cli, version)) {
    deps.warn(`denext: using this project's pinned denext (${pinnedVersion(cli) ?? "latest"})`);
  }
  deps.exit(await deps.spawn(cli));
  return true;
}

/** The verbs that run project code everywhere they run (beside a project's own verbs). */
const TOOLCHAIN_VERBS: ReadonlySet<string> = new Set([
  "dev",
  "build",
  "export",
  "start",
  "deploy",
  "test",
  "check",
  "job",
  "analyze",
  "profile",
  "doctor",
]);

/** The actions of `desktop` / `mobile` that build or run the app (`desktop`'s default is `run`). */
const TOOLCHAIN_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  desktop: new Set(["run", "dev", "build", "package"]),
  mobile: new Set(["dev", "build"]),
};

/**
 * Whether a verb runs the project's code — and so runs on denext's Deno toolchain: the serve and
 * build verbs, `test` / `check` / `job`, `analyze` / `profile` / `doctor`, `desktop
 * run|dev|build|package`, `mobile dev|build`, and every verb a project or plugin contributes.
 * Help, `--version`, scaffolding, dependency edits, `toolchain`, `upgrade` and `create` stay on
 * the Deno that started the CLI.
 *
 * @param command The verb's name and where it came from.
 * @param action Its first positional (the `desktop` / `mobile` action).
 * @returns Whether the toolchain applies.
 */
export function runsProjectCode(
  command: { readonly name: string; readonly source?: "core" | "plugin" | "project" },
  action: string | undefined,
): boolean {
  if ((command.source ?? "core") !== "core") return true;
  if (TOOLCHAIN_VERBS.has(command.name)) return true;
  const actions = TOOLCHAIN_ACTIONS[command.name];
  if (!actions) return false;
  return actions.has(action ?? (command.name === "desktop" ? "run" : ""));
}

/**
 * The verbs a compiled binary runs without any Deno: `toolchain` manages the toolchain itself (its
 * `status` must never download it) and `completions` only prints a script. Every other verb may
 * spawn `deno` — a module verb's pinned-denext re-exec, `fmt` / `lint` / `add`, the UI's and MCP's
 * children — so a binary hands those the toolchain up front.
 */
const DENO_FREE_VERBS: ReadonlySet<string> = new Set(["toolchain", "completions"]);

/**
 * Whether denext's Deno toolchain applies to a verb in THIS process: in a compiled binary, every
 * verb that may spawn `deno` (a binary has no `deno` of its own: `Deno.execPath()` is denext
 * itself, and the machine may have no Deno installed at all); under `deno run`, the verbs that run
 * project code ({@linkcode runsProjectCode}), which re-exec onto it.
 *
 * @param command The verb's name and where it came from.
 * @param action Its first positional (the `desktop` / `mobile` action).
 * @param standalone Whether this process is a compiled binary.
 * @returns Whether the toolchain gate applies.
 */
export function toolchainApplies(
  command: { readonly name: string; readonly source?: "core" | "plugin" | "project" },
  action: string | undefined,
  standalone: boolean,
): boolean {
  if (standalone) {
    return (command.source ?? "core") !== "core" || !DENO_FREE_VERBS.has(command.name);
  }
  return runsProjectCode(command, action);
}

/**
 * Whether a verb, under `deno run` (not a compiled binary), hands denext's Deno toolchain to the
 * processes it starts without re-running itself on it: every verb that may spawn `deno` but runs
 * no project code — `fmt`, `lint`, `add`, `create`, `generate`, `migrate`, `upgrade`, `ui`, `mcp`,
 * `task`, … — so their children (`deno fmt`, the UI's and MCP's `deno` children, a task's steps)
 * run on the toolchain, as they do under the binary. The project-code verbs re-exec instead
 * ({@linkcode toolchainApplies}); `toolchain` and `completions` run no Deno at all.
 *
 * @param command The verb's name and where it came from.
 * @param action Its first positional (the `desktop` / `mobile` action).
 * @param standalone Whether this process is a compiled binary.
 * @returns Whether the verb's children get the toolchain.
 */
export function handsToolchainToChildren(
  command: { readonly name: string; readonly source?: "core" | "plugin" | "project" },
  action: string | undefined,
  standalone: boolean,
): boolean {
  if (standalone || runsProjectCode(command, action)) return false;
  return !DENO_FREE_VERBS.has(command.name);
}

/**
 * The resolution flags a child must repeat to resolve modules the way its parent did: the lock
 * file, the import map, the npm mode, the vendor directory, the dependency-age hold.
 */
const RESOLUTION_FLAGS: ReadonlySet<string> = new Set([
  "--lock",
  "--no-lock",
  "--frozen",
  "--frozen-lockfile",
  "--import-map",
  "--node-modules-dir",
  "--vendor",
  "--min-dep-age",
  "--cached-only",
  "--no-npm",
  "--no-remote",
]);

/**
 * The `deno run` flags that take their value as the NEXT token unless given `--flag=value`, so the
 * script is not mistaken for one (every permission flag, `--reload`, `--env-file`, … take theirs
 * after `=` only). `--lock`'s value is optional; like Deno's own parser, it takes the next token
 * when that is not a flag.
 */
const SEPARATE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--config",
  "-c",
  "--lock",
  "--import-map",
  "--min-dep-age",
  "--location",
  "--seed",
  "--cert",
  "--ext",
  "--preload",
  "--require",
  "--log-level",
  "-L",
  "--conditions",
]);

/** What a `deno run` command line said about resolution, read up to its script. */
export interface RunCommandLine {
  /** The `--config` / `-c` path as written, when one was given. */
  config?: string;
  /** Whether it ran with `--no-config`. */
  noConfig: boolean;
  /** The main module as written (`jsr:@denext/denext@…/cli`, `cli.ts`, a URL). */
  script?: string;
  /** Its {@linkcode RESOLUTION_FLAGS}, verbatim and in order, each with its value. */
  readonly resolution: string[];
}

/** The name a `--flag[=value]` token sets (`--lock=x` → `--lock`). */
function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/** The tokens of the runtime flag at `argv[i]`: itself, then its value when that comes next. */
function runFlagTokens(argv: readonly string[], i: number): string[] {
  const next = argv[i + 1];
  const takesNext = SEPARATE_VALUE_FLAGS.has(argv[i]) && next !== undefined &&
    !next.startsWith("-");
  return takesNext ? [argv[i], next] : [argv[i]];
}

/** Record what one runtime flag (its {@linkcode runFlagTokens}) says about resolution. */
function applyRunFlag(tokens: readonly string[], out: RunCommandLine): void {
  const name = flagName(tokens[0]);
  if (name === "--no-config") out.noConfig = true;
  else if (name === "--config" || name === "-c") {
    out.config = tokens[1] ?? (tokens[0].slice(name.length + 1) || undefined);
  } else if (RESOLUTION_FLAGS.has(name)) out.resolution.push(...tokens);
}

/**
 * Read a `deno run` command line's runtime flags — the ones before the script; after it, flags
 * belong to the program.
 *
 * @param argv The process's whole command line (`deno run … <script> …`).
 * @returns What it said; empty when it is not a `deno run`.
 */
export function parseRunCommandLine(argv: readonly string[]): RunCommandLine {
  const out: RunCommandLine = { noConfig: false, resolution: [] };
  const run = argv.indexOf("run");
  for (let i = run + 1; run !== -1 && i < argv.length; i++) {
    if (!argv[i].startsWith("-")) {
      out.script = argv[i];
      break;
    }
    const tokens = runFlagTokens(argv, i);
    applyRunFlag(tokens, out);
    i += tokens.length - 1;
  }
  return out;
}

/** Whether `path` is a file. */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * The `deno.json` (else `deno.jsonc`) Deno's discovery finds from `dir`: the nearest one at or
 * above it. In a workspace that is the member's own file; Deno finds the root from there, which an
 * explicit `--config <member>` does too.
 *
 * @param dir Where the walk starts.
 * @returns The config's absolute path, or null when there is none up to the filesystem root.
 */
export function nearestConfig(dir: string): string | null {
  for (let at = resolve(dir);; at = dirname(at)) {
    for (const name of CONFIG_NAMES) {
      if (isFile(join(at, name))) return join(at, name);
    }
    if (dirname(at) === at) return null;
  }
}

/**
 * The config a `deno run <script>` started in `cwd` discovers on its own (Deno 2.9): a local
 * script's from the script's directory, a `jsr:` / `npm:` one's from the working directory, and a
 * remote URL's (`https://jsr.io/…/cli.ts`) none at all — which is why a toolchain child started on
 * the URL a JSR-installed CLI loaded from has to be TOLD the config its parent found.
 *
 * @param script The main module as written.
 * @param cwd The working directory.
 * @returns The config's absolute path, or null.
 */
export function discoveredConfig(script: string, cwd: string): string | null {
  if (/^(?:jsr|npm):/.test(script)) return nearestConfig(cwd);
  if (/^[a-z][a-z0-9+.-]+:/i.test(script)) { // a scheme (a drive letter is one character)
    return script.startsWith("file:") ? nearestConfig(dirname(fromFileUrl(script))) : null;
  }
  return nearestConfig(dirname(resolve(cwd, script)));
}

/**
 * The flags that make a `deno run <childScript>` in `cwd` resolve exactly `config`: nothing when
 * its own discovery finds that file already, `--config <path>` when it would find another or none,
 * and `--no-config` when the parent had none but the child would find one. The one rule behind
 * every CLI child denext starts — the toolchain re-exec, a binary's pinned-denext re-exec and
 * `denext ui`'s verb runs.
 *
 * @param config The config the parent resolved (absolute), or null for none.
 * @param childScript The child's main module as it will be written.
 * @param cwd The child's working directory.
 * @returns `[]`, `["--config", config]` or `["--no-config"]`.
 */
export function configArgsFor(config: string | null, childScript: string, cwd: string): string[] {
  const own = discoveredConfig(childScript, cwd);
  if (config === null) return own === null ? [] : ["--no-config"];
  return own === config ? [] : ["--config", config];
}

/**
 * This process's command line (Linux `/proc`, macOS `ps`, Windows `GetCommandLineW`); `null`
 * where it can't be read.
 *
 * @returns The arguments, the Deno executable first.
 */
export async function ownCommandLine(): Promise<string[] | null> {
  if (Deno.build.os === "windows") return windowsCommandLine();
  try {
    if (Deno.build.os === "linux") {
      return (await Deno.readTextFile("/proc/self/cmdline")).split("\0").filter(Boolean);
    }
    if (Deno.build.os === "darwin") {
      const out = await runToExit("ps", {
        args: ["-ww", "-o", "args=", "-p", String(Deno.pid)],
        stderr: "null",
      });
      return new TextDecoder().decode(out.stdout).trim().split(/\s+/);
    }
  } catch { /* no permission, no ps */ }
  return null;
}

/**
 * The resolution flags the toolchain child needs to resolve exactly what this process resolved —
 * Deno offers no API for either. The config: an explicit `--config` (absolute), none after
 * `--no-config`, else the file this process's own discovery found ({@linkcode discoveredConfig}
 * of the script it was started on), passed only when the child's discovery would differ
 * ({@linkcode configArgsFor}). Then the lock / import-map / npm-mode / vendor / dependency-age
 * flags it was started with, verbatim (the child's working directory is the same). Read from this
 * process's command line where the OS exposes it; where it can't be read, a local CLI is assumed
 * started on its own file and a remote one from `jsr:` in this working directory.
 *
 * @param childScript The child's main module (`entrypointArg(import.meta.url)` of `cli.ts`).
 * @param readArgv Reads the command line (tests pass a fake).
 * @param cwd The working directory, shared by both processes.
 * @returns The flags, to go before the child's script.
 */
export async function toolchainConfigArgs(
  childScript: string,
  readArgv: () => Promise<string[] | null> = ownCommandLine,
  cwd: string = Deno.cwd(),
): Promise<string[]> {
  const argv = await readArgv();
  const line = argv ? parseRunCommandLine(argv) : undefined;
  const assumed = /^[a-z][a-z0-9+.-]+:\/\//i.test(childScript) ? "jsr:" : childScript;
  const config = line?.noConfig
    ? null
    : line?.config !== undefined
    ? resolve(cwd, line.config)
    : discoveredConfig(line?.script ?? assumed, cwd);
  return [...configArgsFor(config, childScript, cwd), ...line?.resolution ?? []];
}

/**
 * The toolchain a CLI child spawned with `denoExecutable()` runs: the `DENEXT_TOOLCHAIN_ACTIVE`
 * marker, else this process's own Deno's version when it is denext's Deno (its `Deno.build.denext`
 * marker, or a pre-marker `2.9.7-denext.N` build; src/build/deno-version.ts).
 *
 * @param env Reads an environment variable.
 * @param identity This process's Deno (`currentDenoIdentity()`).
 * @returns The marker, or `undefined` (not denext's Deno).
 */
export function childToolchainMarker(
  env: (name: string) => string | undefined,
  identity: DenoIdentity,
): string | undefined {
  const marker = env(TOOLCHAIN_ACTIVE_ENV);
  if (marker) return marker;
  return isDenextDenoVersion(identity) ? identity.deno : undefined;
}

/**
 * `base` (denext's own child flags) followed by `inherited` (the parent's), with every `base`
 * flag the parent set itself dropped — Deno takes the last of a repeated flag, but the parent's
 * own choice should not depend on that.
 *
 * @param base Flags denext adds (`--node-modules-dir=none`, `--min-dep-age=…`).
 * @param inherited Flags from {@linkcode toolchainConfigArgs}.
 * @returns The merged flags.
 */
export function mergeRunFlags(base: readonly string[], inherited: readonly string[]): string[] {
  const set = new Set(inherited.filter((t) => t.startsWith("-")).map(flagName));
  return [...base.filter((t) => !set.has(flagName(t))), ...inherited];
}

/** What {@linkcode maybeReexecToolchain} touches in the process (injectable for tests). */
export interface ReexecToolchainDeps {
  /** An environment variable (production: `Deno.env.get`). */
  readonly env: (name: string) => string | undefined;
  /** Set one for this process and its children (production: `Deno.env.set`). */
  readonly setEnv: (name: string, value: string) => void;
  /** This process's `Deno.version.deno`. */
  readonly denoVersion: string;
  /**
   * This process's `Deno.build.denext`, the identity marker of denext's Deno (absent on upstream
   * Deno and on the toolchain builds from before it).
   */
  readonly denext?: string;
  /** The pinned toolchain version (`null` when this denext version pins none). */
  readonly pinnedVersion: string | null;
  /** Whether this process is a compiled binary. */
  readonly standalone: () => boolean;
  /** Pick the Deno to run on (production: `resolveDenoToolchain`; throws when it can't be had). */
  readonly resolve: () => Promise<DenoToolchainChoice>;
  /**
   * Re-run this exact invocation under `deno` with `DENEXT_TOOLCHAIN_ACTIVE=<marker>` and resolve
   * its exit code (production: a `deno run` child, stdio + shutdown signals forwarded).
   */
  readonly spawn: (deno: string, marker: string) => Promise<number>;
  /** End the process (production: `Deno.exit`). */
  readonly exit: (code: number) => void;
  /** Say something on stderr. */
  readonly warn: (message: string) => void;
  /**
   * The environment that makes `deno` on a child's PATH the given binary (production:
   * `denoPathEnv` from src/cli/deno-path.ts). A compiled binary adds it to its own environment,
   * so every child it starts — and every `deno` a child looks up — runs the toolchain.
   */
  readonly pathEnv?: (deno: string) => Promise<Record<string, string>>;
  /**
   * For a verb that runs no project code under `deno run`: hand the toolchain to its children
   * instead ({@linkcode handsToolchainToChildren}).
   */
  readonly handOff?: boolean;
}

/**
 * Whether `DENO_BIN` was set by the user rather than handed down by denext (which sets the
 * toolchain marker beside it): such a binary must be denext's runtime too, so the resolver checks
 * it.
 */
function userDenoBin(deps: ReexecToolchainDeps): boolean {
  return Boolean(deps.env("DENO_BIN")) && !deps.env(TOOLCHAIN_ACTIVE_ENV);
}

/**
 * Whether the children already get denext's runtime with nothing to resolve: a `DENO_BIN` denext
 * handed down (the marker beside it), or — under `deno run` on the toolchain already, with no
 * `DENO_BIN` of the user's to verify — this very binary, which `denoExecutable()` returns.
 */
function alreadyHanded(deps: ReexecToolchainDeps): boolean {
  if (deps.env("DENO_BIN") && deps.env(TOOLCHAIN_ACTIVE_ENV)) return true;
  return !deps.standalone() && onToolchainNow(deps) && !userDenoBin(deps);
}

/**
 * A compiled binary's half of {@linkcode maybeReexecToolchain}: it cannot swap its own runtime, so
 * it resolves the toolchain (downloading it on first need) and hands it to every child through its
 * own environment — `DENO_BIN` (what `denoExecutable()` spawns), the toolchain marker, and a PATH
 * whose `deno` is the toolchain (only `deno` lookups change). A `DENO_BIN` denext already handed
 * down (the marker beside it) stands; one the user set is resolved like `DENEXT_DENO=<path>`
 * (verified as denext's runtime, else refused).
 */
async function handToolchainToChildren(deps: ReexecToolchainDeps): Promise<false> {
  if (alreadyHanded(deps)) return false;
  const choice = await deps.resolve();
  if (choice.warning) deps.warn(choice.warning);
  deps.setEnv(TOOLCHAIN_ACTIVE_ENV, choice.version);
  deps.setEnv("DENO_BIN", choice.deno);
  const path = (await deps.pathEnv?.(choice.deno))?.PATH;
  if (path) deps.setEnv("PATH", path);
  return false;
}

/**
 * Whether this `deno run` process already runs on denext's runtime: it is denext's Deno (its
 * `Deno.build.denext` marker, or a pre-marker build's version; src/build/deno-version.ts) and the
 * toolchain marker names its own version (a re-exec'd child, a `DENEXT_DENO=<path>` build's
 * included), or its version is the pinned build's. Upstream Deno of the pinned number does not
 * count.
 */
function onToolchainNow(deps: ReexecToolchainDeps): boolean {
  const marker = deps.env(TOOLCHAIN_ACTIVE_ENV);
  const identity = deps.denext
    ? { deno: deps.denoVersion, denext: deps.denext }
    : { deno: deps.denoVersion };
  if (!isDenextDenoVersion(identity, deps.pinnedVersion)) return false;
  return marker === deps.denoVersion || deps.denoVersion === deps.pinnedVersion;
}

/**
 * Run a verb on denext's Deno runtime — the only Deno denext 5.0 runs on. A project-code verb
 * under any other Deno re-execs the same invocation (argv, cwd, stdio, exit code, shutdown signals)
 * under the pinned toolchain binary (or the `DENEXT_DENO=<path>` / `DENO_BIN` build the user
 * named). A compiled binary cannot swap its own runtime, so it hands the toolchain to its children
 * instead ({@linkcode handToolchainToChildren}) — and its pinned-denext re-exec runs on it; so does
 * a verb that only starts `deno` children (`deps.handOff`).
 *
 * Loops are impossible: the child carries `DENEXT_TOOLCHAIN_ACTIVE=<version>` and runs that
 * version, and a process whose Deno is that marker's version (or the pinned version) never
 * re-execs. Neither a leaked marker (an absolute-path upstream `deno` inside `denext task`) nor an
 * older build (a stale `toolchain link`) counts as the toolchain: they re-exec onto the pinned one.
 * Anything that keeps denext's runtime from running — `DENEXT_DENO=stock`, a `DENEXT_DENO` /
 * `DENO_BIN` that is not denext's runtime, a process without the grants to start the toolchain,
 * offline on first use, no build for this host, a failed download — throws the resolver's
 * `denext:` error with the fix; nothing runs on another Deno.
 *
 * @param applies Whether the verb runs project code ({@linkcode runsProjectCode}).
 * @param deps The process seams.
 * @returns Whether the caller should stop (the process re-exec'd; only a test observes `true`).
 */
export async function maybeReexecToolchain(
  applies: boolean,
  deps: ReexecToolchainDeps,
): Promise<boolean> {
  if (!applies && !deps.handOff) return false;
  if (!applies || deps.standalone()) return await handToolchainToChildren(deps);
  if (onToolchainNow(deps)) {
    // Already on the runtime: still refuse what the environment asks for that denext won't run
    // (`DENEXT_DENO=stock`, a `DENO_BIN` of the user's that is not denext's runtime).
    if (stockRequested(deps.env) || userDenoBin(deps)) {
      const choice = await deps.resolve();
      if (choice.warning) deps.warn(choice.warning);
    }
    return false;
  }
  const choice = await deps.resolve();
  if (choice.warning) deps.warn(choice.warning);
  deps.exit(await deps.spawn(choice.deno, choice.version));
  return true;
}

/** Whether the environment asks for `DENEXT_DENO=stock` (which the resolver refuses). */
function stockRequested(env: (name: string) => string | undefined): boolean {
  return toolchainEnvValue(env).toLowerCase() === "stock";
}
