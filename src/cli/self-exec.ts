// How the CLI re-runs ITSELF in a child `deno run` (the CSS import-map re-exec and the
// server-side-npm re-exec), for a local checkout, a JSR / https install, or a compiled binary.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

/** The config file names a Deno project may use, in resolution order. */
const CONFIG_NAMES = ["deno.json", "deno.jsonc"] as const;

/**
 * A `jsr:@denext/denext` specifier, however the import map spells it: with a version (range
 * operator included), or without one — which `deno run` resolves to the latest published
 * version, so it is a pin too.
 */
const DENEXT_SPEC = /^jsr:@denext\/denext(?:@([^/]+))?(?:\/|$)/;

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
    if (typeof spec === "string" && DENEXT_SPEC.test(spec)) return spec;
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
        `this), or run the CLI as:\n    deno run -A jsr:@denext/denext@${version}/cli ` +
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
