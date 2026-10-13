/**
 * A module sidecar's children: the app's own executable started again, headless, to run the
 * sidecar's module as a separate OS process with its own stdio. It is what an Electron backend does
 * with `spawn(process.execPath, [script, "mcp-bridge"])` and `ELECTRON_RUN_AS_NODE`: a server that
 * starts an MCP stdio bridge or an agent by re-running its own entry with a subcommand.
 *
 * The contract, in both directions:
 *
 * - The parent (a module sidecar, in a worker of the app) calls `denextSidecar.spawnSelf(args)` or
 *   builds its own spawn from `denextSidecar.childCommand(args)`: the app's executable, then `run`
 *   and the app's entry module (`desktop.ts`, from `runDesktop({ importMetaUrl })`), then `args`;
 *   `DENEXT_SIDECAR_CHILD=<name>` and `DENEXT_SIDECAR_CHILD_ARGC=<args.length>` in its environment;
 *   and a Node IPC channel (`stdio: [..., "ipc"]`). Under Deno Desktop the runtime runs such a
 *   launch as a headless worker (no window, no web engine, no single-instance check) only for its
 *   own parent: denext's pinned runtime admits it with the per-launch worker token it hands the
 *   app's own forks that have an IPC channel, and only for a module the app embeds. Under the Deno
 *   CLI (an app run with `deno run`), the command is `deno run` with the permissions the app was
 *   granted unscoped.
 * - The child runs the entry, whose `runDesktop` sees the variable before anything else
 *   ({@linkcode readSidecarChildLaunch}), removes it (a grandchild does not inherit it), and instead
 *   of serving a window runs the sidecar's module ({@linkcode runSidecarChild}): `process.argv` is
 *   `[execPath, <module>, ...args]`, `globalThis.denextSidecar` has `child: true`, and the process
 *   ends with the module's exit code once its work is done.
 *
 * The child has the app's permissions (the same executable, the same baked flags), nothing more,
 * and opens no listener of its own. Its stdout is the module's alone (denext's pinned runtime prints
 * its launch messages on stderr), so a line protocol (MCP, ACP) starts clean.
 *
 * Runtime-only (imported by `runDesktop` and the sidecar host, never a client bundle).
 *
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";
import {
  SIDECAR_CHILD_ARGC_ENV,
  SIDECAR_CHILD_ENV,
  type SidecarDefinition,
  sidecarModuleUrl,
} from "./sidecar.ts";
import { prepareSidecarModules } from "./sidecar-modules.ts";
import { runtimeMarksRelay } from "./transport.ts";

/**
 * What a sidecar needs to start children of the app: the command and its leading arguments, the
 * variables that mark the child.
 * `{ error }` when the app cannot start one (the reason, thrown by `childCommand`).
 */
export type SidecarChildBase =
  | {
    /** The sidecar's name. */
    readonly name: string;
    /** The app's executable (`Deno.execPath()`). */
    readonly command: string;
    /** The arguments before the child's own: `run`, (the CLI's permission flags,) the entry. */
    readonly args: readonly string[];
    /** The variables that mark the launch as the sidecar's child. */
    readonly env: Readonly<Record<string, string>>;
    /** The variable the child's argument count goes in. */
    readonly argcEnv: string;
    /**
     * Whether the runtime authorizes the app's forks of its own executable itself, so `spawnSelf`
     * needs no `run` permission over it ({@linkcode runtimeAuthorizesSelfFork}).
     */
    readonly selfForkAuthorized: boolean;
  }
  | {
    /** Why no child can be started. */
    readonly error: string;
  };

/** The input of {@linkcode sidecarChildBase}. */
export interface SidecarChildBaseOptions {
  /** The sidecar's name. */
  readonly name: string;
  /** The app entry's file path (`fromFileUrl(importMetaUrl)`), when known. */
  readonly entryPath?: string;
  /** The app's executable. */
  readonly execPath: string;
  /** Whether the app is a compiled (desktop) binary rather than the Deno CLI. */
  readonly standalone: boolean;
  /** The Deno CLI's `--allow-*` flags (not used by a compiled app, whose flags are baked). */
  readonly permissionFlags?: readonly string[];
  /**
   * Whether the runtime authorizes a fork of its own executable without `--allow-run`
   * ({@linkcode runtimeAuthorizesSelfFork}); only a compiled app's runtime can.
   */
  readonly selfForkAuthorized?: boolean;
}

/**
 * How the sidecar `name` starts a child of the app: `<execPath> run <entry> …args` for a compiled
 * app (the runtime's headless-worker shape), `<deno> run <permission flags> <entry> …args` for the
 * Deno CLI, with {@linkcode SIDECAR_CHILD_ENV} set to the name.
 *
 * @param options The sidecar, the entry and the executable.
 * @returns The base every `childCommand(args)` extends, or why there is none.
 */
export function sidecarChildBase(options: SidecarChildBaseOptions): SidecarChildBase {
  if (options.entryPath === undefined) {
    return {
      error: `sidecar ${options.name}: childCommand() / spawnSelf() need the app's entry: pass ` +
        "runDesktop({ importMetaUrl: import.meta.url })",
    };
  }
  const flags = options.standalone ? [] : [...(options.permissionFlags ?? [])];
  return {
    name: options.name,
    command: options.execPath,
    args: ["run", ...flags, options.entryPath],
    env: { [SIDECAR_CHILD_ENV]: options.name },
    argcEnv: SIDECAR_CHILD_ARGC_ENV,
    selfForkAuthorized: options.standalone && options.selfForkAuthorized === true,
  };
}

/** The variable denext's pinned runtime hands the forks it authorizes (their per-launch token). */
const WORKER_TOKEN_ENV = "DENO_DESKTOP_WORKER_TOKEN";

/**
 * Whether the running runtime starts a fork of the app's own executable (with an IPC channel, as
 * `spawnSelf` and `childCommand` set up) without the `run` permission: denext's pinned Deno Desktop
 * runtime from `2.9.7-denext.14` (`DESKTOP_MINIMUM_RUNTIME`), which authorizes such a fork with the per-launch
 * token it hands only its own forks. Feature-detected as denext's runtime (no release number is
 * readable at run time): `Deno.desktop` with the fork's `authSession.cancel` in an app's own launch,
 * or the worker token in a child the runtime forked (which registers its own forks the same way).
 * Releases older than the minimum are not supported; the stock runtime and the Deno CLI answer
 * `false` and keep needing `run` over the executable.
 *
 * @param desktop `Deno.desktop` (default: the running runtime's).
 * @param env Reads a variable (default: `Deno.env.get`; a refused read counts as unset).
 * @returns Whether the runtime authorizes the app's self-forks.
 */
export function runtimeAuthorizesSelfFork(
  desktop: unknown = (Deno as unknown as { desktop?: unknown }).desktop,
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): boolean {
  if (runtimeMarksRelay(desktop)) return true;
  try {
    return (env(WORKER_TOKEN_ENV) ?? "") !== "";
  } catch {
    return false;
  }
}

/** The permission kinds a Deno CLI child is granted when the app holds them unscoped. */
const PERMISSION_NAMES = ["read", "write", "net", "env", "run", "ffi", "sys", "import"] as const;

/**
 * The `--allow-*` flags for the permissions this process holds unscoped (a Deno CLI run): a child
 * gets those and nothing more (a scoped grant cannot be read back, so it is left out).
 *
 * @param query The state of one permission (tests pass a fake).
 * @returns The flags.
 */
export function cliPermissionFlags(
  query: (name: (typeof PERMISSION_NAMES)[number]) => string = (name) =>
    Deno.permissions.querySync({ name } as Deno.PermissionDescriptor).state,
): string[] {
  const flags: string[] = [];
  for (const name of PERMISSION_NAMES) {
    try {
      if (query(name) === "granted") flags.push(`--allow-${name}`);
    } catch { /* a kind this Deno does not know */ }
  }
  return flags;
}

/** Whether this process is a compiled binary (a packaged or `denext desktop run` app). */
function isStandalone(): boolean {
  return (Deno.build as { standalone?: boolean }).standalone === true;
}

/** The entry's file path, or `undefined` for none or a non-`file:` URL. */
function entryPathOf(importMetaUrl: string | undefined): string | undefined {
  return importMetaUrl?.startsWith("file:") ? fromFileUrl(importMetaUrl) : undefined;
}

/**
 * {@linkcode sidecarChildBase} for this process: its executable, whether it is compiled, and (for
 * the Deno CLI) its unscoped permissions.
 *
 * @param name The sidecar's name.
 * @param importMetaUrl The app entry's `import.meta.url`.
 * @returns The base.
 */
export function parentChildBase(name: string, importMetaUrl: string | undefined): SidecarChildBase {
  const standalone = isStandalone();
  const entryPath = entryPathOf(importMetaUrl);
  return sidecarChildBase({
    name,
    execPath: Deno.execPath(),
    standalone,
    ...(entryPath !== undefined ? { entryPath } : {}),
    ...(standalone
      ? { selfForkAuthorized: runtimeAuthorizesSelfFork() }
      : { permissionFlags: cliPermissionFlags() }),
  });
}

/** A launch of the app as one of its sidecars' children. */
export interface SidecarChildLaunch {
  /** The sidecar's name. */
  readonly name: string;
  /** Its (module) definition. */
  readonly definition: SidecarDefinition;
  /** The child's own arguments (its `process.argv.slice(2)`). */
  readonly args: readonly string[];
}

/** The input of {@linkcode sidecarChildLaunch}. */
export interface SidecarChildLaunchInput {
  /** {@linkcode SIDECAR_CHILD_ENV}'s value. */
  readonly marker: string | undefined;
  /** {@linkcode SIDECAR_CHILD_ARGC_ENV}'s value. */
  readonly argc: string | undefined;
  /** The launch's arguments (`Deno.args`). */
  readonly args: readonly string[];
  /** Whether the app is a compiled binary. */
  readonly standalone: boolean;
  /** The entry's file path. */
  readonly entryPath: string | undefined;
  /** The app's sidecars (merged). */
  readonly sidecars: readonly SidecarDefinition[];
}

/**
 * Whether this launch is a sidecar's child, and of which sidecar with which arguments: `null` when
 * the marker is unset, or (in a compiled app) when the arguments are not the runtime's
 * headless-worker shape `… run <entry> …args` (a stray variable inherited by a normal launch is
 * ignored). A marker that names no module sidecar of the app, or a malformed count, throws.
 *
 * @param input The variables, the arguments and the app's sidecars.
 * @returns The launch, or `null`.
 */
export function sidecarChildLaunch(input: SidecarChildLaunchInput): SidecarChildLaunch | null {
  const name = input.marker;
  if (name === undefined || name === "") return null;
  const count = /^\d{1,6}$/.test(input.argc ?? "") ? Number(input.argc) : NaN;
  const lead = input.standalone ? 2 : 0;
  if (!(count <= input.args.length - lead)) {
    if (input.standalone) return null;
    throw new Error(`desktop: ${SIDECAR_CHILD_ARGC_ENV} must count the child's arguments`);
  }
  const own = input.args.slice(input.args.length - count);
  if (input.standalone) {
    const at = input.args.length - count;
    if (input.args[at - 2] !== "run" || input.args[at - 1] !== input.entryPath) return null;
  }
  const definition = input.sidecars.find((d) => d.name === name);
  if (!definition || !("module" in definition.run)) {
    throw new Error(`desktop: ${SIDECAR_CHILD_ENV}="${name}" names no module sidecar of this app`);
  }
  return { name, definition, args: own };
}

/** Read and remove a variable (`undefined` without `--allow-env`). */
function takeEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    if (value !== undefined) Deno.env.delete(name);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * This launch as a sidecar's child ({@linkcode sidecarChildLaunch} over this process), or `null`.
 * The marker variables are removed either way, so nothing the app starts inherits them.
 *
 * @param importMetaUrl The app entry's `import.meta.url`.
 * @param sidecars The app's sidecars (merged).
 * @returns The launch, or `null`.
 */
export function readSidecarChildLaunch(
  importMetaUrl: string | undefined,
  sidecars: readonly SidecarDefinition[],
): SidecarChildLaunch | null {
  const marker = takeEnv(SIDECAR_CHILD_ENV);
  const argc = takeEnv(SIDECAR_CHILD_ARGC_ENV);
  return sidecarChildLaunch({
    marker,
    argc,
    args: Deno.args,
    standalone: isStandalone(),
    entryPath: entryPathOf(importMetaUrl),
    sidecars,
  });
}

/**
 * The helpers both a sidecar worker and a child install on `globalThis.denextSidecar`, as one
 * module (loaded from a `blob:` URL, like the worker's wrapper, so nothing extra is compiled into
 * the app):
 *
 * - `childHelpers(base)` → `{ childCommand(args), spawnSelf(args, options) }` over a
 *   {@linkcode SidecarChildBase};
 * - `installRequireBase(requireBase, modulesPath)`: a bundled backend's `require()` and every
 *   lookup resolve from its unpacked packages too.
 */
const SIDECAR_CHILD_HELPERS = `import { spawn } from "node:child_process";
import Module, { createRequire } from "node:module";
import process from "node:process";
const runtimeVariable = (k) =>
  k === "DENO_SERVE_ADDRESS" || k.startsWith("DENO_DESKTOP_") || k === "DENO_INTERNAL_CHILD_ENTRYPOINT";
function stdioWithIpc(stdio) {
  const list = stdio === undefined ? [] : typeof stdio === "string" ? [stdio, stdio, stdio] : [...stdio];
  while (list.length < 3) list.push("pipe");
  return list.includes("ipc") ? list : [...list, "ipc"];
}
export function childHelpers(base) {
  const childCommand = (args = []) => {
    if (base.error) throw new Error(base.error);
    if (!Array.isArray(args)) throw new TypeError("childCommand(args): args must be an array of strings");
    const own = args.map(String);
    return {
      command: base.command,
      args: [...base.args, ...own],
      env: { ...base.env, [base.argcEnv]: String(own.length) },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    };
  };
  const spawnSelf = (args = [], options = {}) => {
    const cmd = childCommand(args);
    let state = "granted";
    try {
      if (!base.selfForkAuthorized) {
        state = Deno.permissions.querySync({ name: "run", command: cmd.command }).state;
      }
    } catch { /* no permissions API: let the spawn say */ }
    if (state !== "granted") {
      throw new Error("sidecar " + base.name + ": spawnSelf() starts the app's own executable, " +
        "which this runtime runs only with permissions.run on the sidecar covering it " +
        "(run: ['*']); denext's pinned runtime authorizes it without");
    }
    const env = {};
    for (const [k, v] of Object.entries(options.env ?? process.env)) {
      if (v !== undefined && !runtimeVariable(k)) env[k] = String(v);
    }
    const child = spawn(cmd.command, cmd.args, {
      ...options,
      shell: false,
      env: { ...env, ...cmd.env },
      stdio: stdioWithIpc(options.stdio),
    });
    return child;
  };
  return { childCommand, spawnSelf };
}
export function installRequireBase(requireBase, modulesPath) {
  globalThis.__denextSidecarRequire = createRequire(requireBase);
  const paths = Module._nodeModulePaths;
  Module._nodeModulePaths = function (from) {
    const found = paths.call(this, from);
    return found.includes(modulesPath) ? found : [...found, modulesPath];
  };
}
`;

/** The `blob:` URL of {@linkcode SIDECAR_CHILD_HELPERS}, made once. */
let helpersUrl: string | undefined;

/**
 * The `blob:` URL {@linkcode SIDECAR_CHILD_HELPERS} is imported from (made once per process).
 *
 * @returns The URL.
 */
export function sidecarChildHelpersUrl(): string {
  return helpersUrl ??= URL.createObjectURL(
    new Blob([SIDECAR_CHILD_HELPERS], { type: "text/javascript" }),
  );
}

/** The helpers module's shape. */
interface ChildHelpersModule {
  childHelpers(base: SidecarChildBase): Record<string, unknown>;
  installRequireBase(requireBase: string, modulesPath: string): void;
}

/** Options for {@linkcode runSidecarChild}. */
export interface RunSidecarChildOptions {
  /** The app entry's `import.meta.url`. */
  readonly importMetaUrl: string;
  /** The app's cache folder (where a bundled backend's packages are unpacked). */
  readonly cacheDir?: string;
}

/**
 * Run the sidecar's module as this process's work: a bundled backend's packages ready (already
 * unpacked by the app, once per version), `process.argv` set, `globalThis.denextSidecar` installed
 * (`child: true`; no port, bootstrap or secrets; `childCommand` / `spawnSelf` for a grandchild),
 * then the module imported. Resolves once the module is evaluated; the process then ends when its
 * work is done, with its exit code.
 *
 * @param launch The child launch.
 * @param options The entry and the cache folder.
 */
export async function runSidecarChild(
  launch: SidecarChildLaunch,
  options: RunSidecarChildOptions,
): Promise<void> {
  const def = launch.definition;
  const entry = sidecarModuleUrl(def, options.importMetaUrl);
  const helpers = await import(sidecarChildHelpersUrl()) as ChildHelpersModule;
  if ("module" in def.run && def.run.nodeModules !== undefined) {
    const root = await prepareSidecarModules(
      dirname(fromFileUrl(entry)),
      def.name,
      options.cacheDir ?? await Deno.makeTempDir({ prefix: "denext-sidecar-cache-" }),
    );
    if (root !== undefined) {
      helpers.installRequireBase(join(root, "sidecar.cjs"), join(root, "node_modules"));
    }
  }
  const { default: process } = await import("node:process");
  process.argv = [
    process.execPath,
    entry.startsWith("file:") ? fromFileUrl(entry) : entry,
    ...launch.args,
  ];
  (globalThis as { denextSidecar?: unknown }).denextSidecar = Object.freeze({
    name: def.name,
    child: true,
    port: undefined,
    bootstrap: undefined,
    secrets: Object.freeze({}),
    ready: () => {},
    onShutdown: () => {},
    ...helpers.childHelpers(parentChildBase(def.name, options.importMetaUrl)),
  });
  await import(entry);
}
