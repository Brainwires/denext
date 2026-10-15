// The run half of the `denext` entrypoint: what happens once argv names a verb to run — the
// re-execs (denext's Deno toolchain, the project's pinned denext for a compiled binary, the CSS
// import map, the merged module config), `.env` loading and the build locks — then the verb.
// It lives apart from cli.ts so `denext --version`, `--help`, `commands` and completions never
// load it (or the bundler and CSS tooling it pulls in); cli.ts imports it when a verb runs and
// hands it its own module URL, which every re-exec re-runs.

import { join } from "@std/path";
import {
  childToolchainMarker,
  entrypointArg,
  isStandaloneBinary,
  maybeReexecPinned as reexecPinned,
  maybeReexecToolchain,
  mergeRunFlags,
  pinnedConfigArgs,
  pinnedDenextCli,
  toolchainApplies,
  toolchainConfigArgs,
  toolchainRuntimeFlags,
} from "./self-exec.ts";
import { loadDenoToolchainPin, resolveDenoToolchain } from "../build/deno-toolchain.ts";
import { denoPathEnv } from "./deno-path.ts";
import { resolveProject } from "../build/paths.ts";
import {
  buildAppCss,
  injectAppConfigRedirects,
  restoreAppConfig,
  restoreAppConfigSync,
} from "../build/css.ts";
import { guardRestore, healLeakedCssShims, signalExitCode } from "../build/css-config-guard.ts";
import { tailwindPaths } from "../build/tailwind.ts";
import { buildServesCss } from "../build/server-copies.ts";
import { denoExecutable, frameworkRoot, minDepAgeArgs } from "../build/bundle.ts";
import {
  configAnchorsResolution,
  ensureFrameworkNodeModules,
  readConfig,
  writeMergedModuleConfig,
} from "../build/module-config.ts";
import { loadEnv } from "../server/env.ts";
import { markBuildPhase } from "../server/phase.ts";
import { cliNpmModeArgs } from "../build/pnpm-workspace.ts";
import { VERSION } from "../version.ts";
import type { CommandContext, CommandSpec } from "./command.ts";
import { envTierFor, projectDir, SHUTDOWN_SIGNALS } from "./shared.ts";
import { firstNotice } from "./command-cache.ts";
import { acquireProjectLocks } from "../build/project-locks.ts";
import { isDenoVerb, shadowNotice } from "./deno-verbs.ts";
import { materializeCommand } from "./lazy-command.ts";

/** The CLI entrypoint's module URL (cli.ts), which every re-exec runs again. */
let entry: string | undefined;

/** The entrypoint URL {@linkcode runVerb} was given (set before any re-exec can happen). */
function entryUrl(): string {
  if (entry === undefined) throw new Error("denext: run-verb used before runVerb()");
  return entry;
}

/**
 * The `--allow-*` flags to give a re-exec child: mirror the parent's coarse
 * permission grants (a parent run with `-A` grants all → all pass through; a scoped
 * parent passes through only what it holds). Path-scoped grants can't be enumerated
 * by the Deno API, so they aren't reconstructed.
 */
async function childPermissionFlags(): Promise<string[]> {
  const names: Deno.PermissionName[] = ["read", "write", "net", "env", "run", "sys", "ffi"];
  const flags: string[] = [];
  for (const name of names) {
    try {
      if ((await Deno.permissions.query({ name })).state === "granted") {
        flags.push(`--allow-${name}`);
      }
    } catch { /* permission name unknown to this Deno version */ }
  }
  return flags;
}

/**
 * Deno cannot `import()` a `.css` module and offers no runtime loader hook, so when
 * a project uses CSS we generate a merged deno config (redirecting each `.css` to a
 * JS shim) and re-exec the CLI with `--config` so the module loader can resolve
 * those imports. A guard env var stops infinite re-exec. Returns `true` if it
 * re-exec'd (the caller should stop).
 */
async function maybeReexecForCss(dir: string, minify: boolean, heal = true): Promise<boolean> {
  if (Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  const paths = await resolveProject(dir);
  // Self-heal a previous run that was killed before it could restore the app's deno.json
  // (see the transient css-redirect injection below), so this build starts from the
  // committed config, not a leftover mutated one: from the backup when one survived, else
  // by splicing out any css→shim entries that were left with no backup at all (`doctor`
  // skips this so it can report them).
  await restoreAppConfig(paths.configPath, paths.outDir);
  if (heal) await healLeakedCssShims(paths.configPath);
  const css = await buildAppCss({
    projectDir: dir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify,
    tailwind: tailwindPaths(dir, paths.config?.tailwind),
    spa: paths.config?.mode === "spa",
  });
  if (!css) return false; // no CSS in the project — run normally

  if (isStandaloneBinary()) {
    warnStandaloneCss();
    return false;
  }
  // A manual-`node_modules` app (converted pnpm/yarn) re-execs under
  // `nodeModulesDir: "manual"`, which resolves EVERY npm specifier — the framework's
  // own build machinery (esbuild, …) included — from the node_modules beside the
  // css-config. The app's tree carries only the app's deps, so supply the framework
  // half here; the app's own deps still resolve via its own config.
  if ((await readConfig(paths.configPath)).nodeModulesDir === "manual") {
    await ensureFrameworkNodeModules(paths.outDir);
  }
  // A converted app resolves its modules' css imports via its OWN deno.json, so the
  // css→shim redirects have to live there for the build. Inject them TRANSIENTLY (a
  // backup is kept) and restore the committed deno.json once the build child exits, so
  // `deno task build/export` leaves the app's config byte-identical.
  if (css.appConfigRedirects) {
    await injectCssRedirectsTransiently(paths.configPath, paths.outDir, css.appConfigRedirects);
  }
  return await reexecWithConfig(
    css.configPath,
    "DENEXT_CSS_ACTIVE",
    () => restoreAppConfig(paths.configPath, paths.outDir),
  );
}

/** The residual standalone-binary path of {@linkcode maybeReexecForCss}: CSS imports cannot work. */
function warnStandaloneCss(): void {
  // A binary cannot re-exec ITSELF under a different `--config`: there is no module URL to
  // re-run. Reaching here at all means {@linkcode maybeReexecPinned} did not defer, which for
  // a module verb it always does — so this is the residual path (a verb that builds CSS
  // without loading modules). Running from JSR or a remote URL is fine: Deno runs remote
  // entrypoints, so we re-exec `entryUrl()`.
  console.error(
    "denext: WARNING — this project imports CSS, but a compiled (standalone) denext " +
      'binary cannot apply the CSS import map. `import "./x.css"` will fail at runtime; ' +
      "run the CLI with `denext deno run -A jsr:@denext/denext/cli` instead of the binary.",
  );
}

/**
 * Inject the css→shim redirects into the app's own deno.json for the build child, with a
 * backup and a restore guard (see {@linkcode maybeReexecForCss}).
 */
async function injectCssRedirectsTransiently(
  configPath: string,
  outDir: string,
  redirects: Parameters<typeof injectAppConfigRedirects>[2],
): Promise<void> {
  // A previous run killed mid-build (SIGKILL, power loss) skipped its restore and left the
  // redirects — and its backup — behind; put the committed config back before injecting
  // again, or the stale entries would be captured as the "original".
  await restoreAppConfig(configPath, outDir);
  // Restore on Ctrl-C / SIGTERM / a closed terminal / Deno.exit too — the normal restore
  // (the caller's, after reexecWithConfig) only runs once the child has exited. Before the child is spawned the guard
  // restores and exits; while it runs, the child is stopped (forwardShutdown already relays
  // SIGINT/SIGTERM) and this process exits with its code, as reexecWithConfig does.
  guardRestore(() => restoreAppConfigSync(configPath, outDir), {
    onSignal: (sig) => {
      if (!runningChild) Deno.exit(signalExitCode(sig));
      if (SHUTDOWN_SIGNALS.includes(sig)) return; // relayed by forwardShutdown
      try {
        runningChild.kill("SIGTERM");
      } catch { /* already exited */ }
    },
  });
  await injectAppConfigRedirects(configPath, outDir, redirects);
}

/** The re-exec child while it runs (its exit, not a signal, then ends this process). */
let runningChild: Deno.ChildProcess | null = null;

/**
 * Forward the shutdown signals this process receives to `child` (as SIGTERM on Unix; as a
 * plain termination on Windows, which has no signals), so `kill <pid>` / `docker stop` / Ctrl-C
 * reach a re-exec'd server instead of orphaning it, then resolve with the code the process
 * should exit with: the child's own, or — when the child died of a signal — `128 + signal`,
 * as a shell would report (Deno's `status.code` already carries that on Unix).
 */
async function forwardShutdown(child: Deno.ChildProcess): Promise<number> {
  const forward = () => {
    try {
      // Windows has no signal to forward: `kill()` terminates the child outright.
      if (Deno.build.os === "windows") child.kill();
      else child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, forward);
    } catch { /* unsupported */ }
  }
  const { code } = await child.status;
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.removeSignalListener(sig, forward);
    } catch { /* not installed */ }
  }
  return code;
}

/**
 * Run a CLI child — `deno run [flags] <cli> <this process's argv>` under `deno` with `env` added
 * — stdio inherited and shutdown signals forwarded; resolves the code to exit with. The one
 * spawn behind both whole-invocation re-execs: the pinned denext ({@linkcode maybeReexecPinned})
 * and denext's Deno toolchain ({@linkcode toolchainGate}).
 */
function spawnCliChild(
  deno: string,
  flags: string[],
  cli: string,
  env: Record<string, string>,
): Promise<number> {
  return forwardShutdown(
    new Deno.Command(deno, {
      args: ["run", ...flags, cli, ...Deno.args],
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn(),
  );
}

/**
 * A compiled binary defers a module verb to the denext the project pins — the decision is
 * {@linkcode reexecPinned} (src/cli/self-exec.ts, where it is testable); this wires it to the
 * process: the pinned CLI runs as a `deno run` child with stdio and shutdown signals forwarded,
 * and the process exits with the child's code. Returns whether the caller should stop.
 *
 * @param dir The project directory the verb targets.
 */
function maybeReexecPinned(dir: string): Promise<boolean> {
  return reexecPinned(dir, VERSION, Deno.args, {
    standalone: isStandaloneBinary,
    env: (name) => Deno.env.get(name),
    // In a pnpm workspace the CLI's npm imports stay off the pnpm tree (pnpm-workspace.ts).
    // `denoExecutable()` is denext's Deno toolchain once {@linkcode toolchainGate} chose it.
    spawn: (cli) =>
      spawnCliChild(
        denoExecutable(),
        [
          "-A",
          ...toolchainRuntimeFlags(
            childToolchainMarker((n) => Deno.env.get(n), Deno.version.deno),
          ),
          ...pinnedConfigArgs(dir),
          ...cliNpmModeArgs(dir),
          ...minDepAgeArgs(),
        ],
        cli,
        { DENEXT_PINNED_ACTIVE: "1" },
      ),
    exit: (code) => Deno.exit(code),
    warn: (message) => console.error(message),
  });
}

/**
 * The toolchain child's permission flags: `-A` when this process holds every coarse grant (it was
 * run with `-A`, which also allows remote imports from any host — a grant Deno's permission query
 * can't name), else the coarse grants it holds ({@linkcode childPermissionFlags}) plus a
 * `--deny-<name>` for each permission this process was denied (`--deny-net`, as `denext ui
 * --offline` starts its children): left out, the child would be asked instead of refused.
 */
async function toolchainPermissionFlags(): Promise<string[]> {
  const flags = await childPermissionFlags();
  if (flags.length === 7) return ["-A"];
  const names: Deno.PermissionName[] = ["read", "write", "net", "env", "run", "sys", "ffi"];
  for (const name of names) {
    const state = await Deno.permissions.query({ name }).then((s) => s.state, () => "prompt");
    if (state === "denied") flags.push(`--deny-${name}`);
  }
  return flags;
}

/** The pinned toolchain version, or `null` (none pinned, or an unreadable pin file override). */
function pinnedToolchainVersion(): string | null {
  try {
    return loadDenoToolchainPin().version;
  } catch {
    return null; // resolveDenoToolchain() reports a bad DENEXT_TOOLCHAIN_PIN_FILE
  }
}

/** The directory a verb's re-exec gates read the project from. */
function gateDir(command: CommandSpec, ctx: CommandContext): string {
  return command.moduleDir ? command.moduleDir(ctx) : projectDir(ctx);
}

/**
 * Run a verb that executes project code on denext's Deno toolchain — the decision is
 * {@linkcode maybeReexecToolchain} (src/cli/self-exec.ts); this wires it to the process: the same
 * invocation re-runs under the toolchain binary with this process's permission grants, stdio and
 * shutdown signals forwarded, and the process exits with the child's code. Returns whether the
 * caller should stop.
 */
function toolchainGate(command: CommandSpec, ctx: CommandContext): Promise<boolean> {
  const standalone = isStandaloneBinary();
  return maybeReexecToolchain(toolchainApplies(command, ctx.positionals[0], standalone), {
    env: (name) => Deno.env.get(name),
    setEnv: (name, value) => Deno.env.set(name, value),
    denoVersion: Deno.version.deno,
    pinnedVersion: pinnedToolchainVersion(),
    standalone: () => standalone,
    resolve: () => resolveDenoToolchain(),
    spawn: async (deno, marker) =>
      spawnCliChild(
        deno,
        [
          ...await toolchainPermissionFlags(),
          // The config and resolution flags this process resolved with: started on `jsr:` (a
          // `deno task`), it found the project's deno.json from the working directory, but the
          // child runs the https URL that resolved to, which discovers no config at all.
          ...mergeRunFlags(
            [
              ...toolchainRuntimeFlags(marker),
              ...cliNpmModeArgs(gateDir(command, ctx)),
              ...minDepAgeArgs(),
            ],
            await toolchainConfigArgs(entrypointArg(entryUrl())),
          ),
        ],
        entrypointArg(entryUrl()),
        { DENEXT_TOOLCHAIN_ACTIVE: marker },
      ),
    exit: (code) => Deno.exit(code),
    warn: (message) => console.error(message),
    pathEnv: (deno) => denoPathEnv(deno),
  });
}

/**
 * Re-exec this CLI with `--config configPath` and `activeEnv=1` set (the guard the
 * parent checks to avoid re-exec loops), forwarding stdio + shutdown signals, then
 * exit with the child's code. Never returns.
 *
 * Propagates the parent's actual permission grants instead of a blanket `-A`, so an
 * operator who scoped a command down doesn't get full permissions silently restored
 * by the re-exec. Coarse grants only — Deno exposes no way to enumerate path-scoped
 * grants.
 */
async function reexecWithConfig(
  configPath: string,
  activeEnv: string,
  cleanup?: () => Promise<void>,
): Promise<never> {
  const child = new Deno.Command(denoExecutable(), {
    args: [
      "run",
      // sloppy-imports so the re-exec'd process can load Next.js app route modules
      // that use extensionless imports at runtime (permissive fallback).
      "--unstable-sloppy-imports",
      ...toolchainRuntimeFlags(childToolchainMarker((n) => Deno.env.get(n), Deno.version.deno)),
      ...await childPermissionFlags(),
      // Deno's minimum-dependency-age policy applies to the child too and the parent can't
      // read the value it was started with: forward `DENEXT_MIN_DEP_AGE` (see minDepAgeArgs),
      // or a freshly published `@denext/*` dep (the icon compositor's photon, a codec) is
      // refused inside the build child while the parent resolved fine.
      ...minDepAgeArgs(),
      "--config",
      configPath,
      entrypointArg(entryUrl()),
      ...Deno.args,
    ],
    env: { [activeEnv]: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  runningChild = child;
  const code = await forwardShutdown(child);
  runningChild = null;
  // Restore any transiently-mutated app config now the build child is done (runs on a
  // clean exit AND after a forwarded shutdown signal — the child exits, status resolves).
  if (cleanup) await cleanup().catch(() => {});
  Deno.exit(code);
}

/**
 * Re-exec module commands with a merged framework+app config when the project has
 * its own `deno.json` that anchors module resolution to itself — a manual
 * `node_modules` or a `npm:` import (server-side npm deps like an ORM driver).
 *
 * Deno resolves a locally-run `cli.ts`'s imports against the framework's config, so
 * a bare `import "drizzle-orm"` in an app's server module would otherwise be "not a
 * dependency and not in import map". (A `jsr:`/compiled CLI already discovers the
 * app's config from the CWD, so this is a source-checkout/monorepo fix — hence the
 * `file://` guard.) CSS-using projects are handled by {@linkcode maybeReexecForCss}.
 */
async function maybeReexecForModules(dir: string): Promise<boolean> {
  if (Deno.env.get("DENEXT_MODULE_ACTIVE") || Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  if (!entryUrl().startsWith("file://")) return false;
  const paths = await resolveProject(dir);
  if (paths.configPath === join(frameworkRoot(), "deno.json")) return false;
  const appCfg = await readConfig(paths.configPath);
  if (!configAnchorsResolution(appCfg)) return false;
  const configPath = await writeMergedModuleConfig(
    paths.outDir,
    paths.configPath,
    join(frameworkRoot(), "deno.json"),
  );
  // Manual mode resolves the framework's own npm build deps (esbuild, …) from the
  // node_modules beside the merged config, which the app's tree does not carry;
  // supply the framework half. (A `npm:`-anchored app without a manual dir resolves
  // everything from Deno's global cache, so it needs nothing here.) The app's own
  // deps resolve via its own config regardless — see {@link ensureFrameworkNodeModules}.
  if (appCfg.nodeModulesDir === "manual") await ensureFrameworkNodeModules(paths.outDir);
  return await reexecWithConfig(configPath, "DENEXT_MODULE_ACTIVE");
}

/**
 * Whether `denext start` serves the project in `dir` without the CSS import map, and so without
 * {@linkcode maybeReexecForCss} — which rebuilds the stylesheets (Tailwind spawns its binary) and
 * spawns a second `deno`, neither of which a least-privilege `start` (no `--allow-run`) may do. A
 * SPA's server imports none of the app's modules; a native App Router build's server copies point
 * every stylesheet import at its shim (`buildServesCss`). Anything else (a next-compat or older
 * build, a moved project) keeps the re-exec.
 */
async function startServesCss(dir: string): Promise<boolean> {
  const paths = await resolveProject(dir);
  if (paths.config?.mode === "spa") return true;
  return await buildServesCss(paths.projectDir, paths.outDir);
}

/**
 * For a module-loading verb, load `.env` then apply the CSS/module re-exec gate.
 * Returns `true` if the process re-exec'd (the caller should stop). A no-op for
 * verbs that don't load user modules.
 */
async function moduleGate(command: CommandSpec, ctx: CommandContext): Promise<boolean> {
  if (!command.loadsModules) return false;
  // Before anything below imports denext.config.ts (the CSS gate does): building, not serving,
  // so config helpers don't refuse a runtime secret the build environment doesn't have.
  if (command.name === "build" || command.name === "export") markBuildPhase();
  const dir = gateDir(command, ctx);
  if (await maybeReexecPinned(dir)) return true;
  await loadEnv({ dir, mode: envTierFor(command) });
  // `dev` builds unminified CSS; the other module verbs minify (matching 1.x).
  // `doctor` reports leaked css-shim entries instead of silently healing them.
  const cssGate = command.name !== "start" || !(await startServesCss(dir));
  if (cssGate && await maybeReexecForCss(dir, command.name !== "dev", command.name !== "doctor")) {
    return true;
  }
  if (await maybeReexecForModules(dir)) return true;
  return false;
}

/**
 * Say once — by the process that runs the verb (after any re-exec), and once per state of the
 * project's config files — that a project verb shadows a Deno verb of the same name.
 */
async function noticeShadow(command: CommandSpec, dir: string): Promise<void> {
  if ((command.source ?? "core") === "core" || !isDenoVerb(command.name)) return;
  if (await firstNotice(dir, `shadow:${command.name}`)) console.error(shadowNotice(command.name));
}

/**
 * In a compiled binary, hand an invocation that discovers the PROJECT's verbs — `denext
 * commands`, a project verb's dispatch, completions — to the denext the project pins: a binary
 * resolves `denext.config.ts`'s imports through its own embedded import map, not the project's
 * `deno.json`, so a config importing a plugin package (`@denext/backend`) cannot load in it.
 * Nothing happens under `deno run`, in a directory without a denext config, or for a project that
 * pins no denext (its config then imports nothing a binary could resolve either way).
 *
 * @param entryModuleUrl cli.ts's module URL.
 * @param dir The project directory.
 * @param hasConfig Whether `dir` holds a denext config.
 * @returns Whether the process re-exec'd (it then exits with the child's code).
 */
export async function discoverInPinned(
  entryModuleUrl: string,
  dir: string,
  hasConfig: boolean,
): Promise<boolean> {
  entry ??= entryModuleUrl;
  if (!hasConfig || !isStandaloneBinary() || Deno.env.get("DENEXT_PINNED_ACTIVE")) return false;
  if (pinnedDenextCli(dir) === null) return false;
  // A binary has no Deno of its own: hand the toolchain to the child first, as a verb's run does.
  const discovery: CommandSpec = { name: "commands", summary: "", run: () => {} };
  await toolchainGate(discovery, {
    positionals: [],
    flags: {},
    global: { cwd: dir, json: false, verbose: false, quiet: false },
    rest: [],
  });
  return await maybeReexecPinned(dir);
}

/**
 * Run `command` as the CLI parsed it: the toolchain and module re-exec gates (each may re-run the
 * invocation in a child and end this process), then the verb under its build locks.
 *
 * @param entryModuleUrl cli.ts's module URL (what a re-exec runs).
 * @param parsed The parsed verb (a lazy first-party spec is loaded here).
 * @param ctx The parsed invocation.
 * @param cwd The `--cwd` directory (for the one-time notices).
 */
export async function runVerb(
  entryModuleUrl: string,
  parsed: CommandSpec,
  ctx: CommandContext,
  cwd: string,
): Promise<void> {
  entry = entryModuleUrl;
  const command = await materializeCommand(parsed);
  if (await toolchainGate(command, ctx)) return;
  if (await moduleGate(command, ctx)) return;
  await noticeShadow(command, cwd);
  // Cargo-style build locks, taken here — in the process that runs the verb, after any re-exec —
  // and held for the whole run (the OS drops them if the process exits or is killed).
  const lockRequest = command.locks?.(ctx);
  using _locks = lockRequest ? await acquireProjectLocks(lockRequest) : undefined;
  await command.run(ctx);
}
