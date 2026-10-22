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
  handsToolchainToChildren,
  isStandaloneBinary,
  legacyAbortActive,
  maybeReexecPinned as reexecPinned,
  maybeReexecToolchain,
  mergeRunFlags,
  pinnedConfigArgs,
  pinnedDenextCli,
  servesInProcess,
  toolchainApplies,
  toolchainConfigArgs,
  toolchainRuntimeFlags,
} from "./self-exec.ts";
import { loadDenoToolchainPin, resolveDenoToolchain } from "../build/deno-toolchain.ts";
import { currentDenoIdentity } from "../build/deno-version.ts";
import { applyNativeCheckEngine } from "../ts/engine.ts";
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
  type DenoConfigView,
  ensureFrameworkNodeModules,
  readConfig,
  resolvesInThisProcess,
  unresolvedImportKeys,
  writeMergedModuleConfig,
} from "../build/module-config.ts";
import { loadEnv } from "../server/env.ts";
import { markBuildPhase } from "../server/phase.ts";
import { cliNpmModeArgs } from "../build/pnpm-workspace.ts";
import { VERSION } from "../version.ts";
import type { CommandContext, CommandSpec } from "./command.ts";
import { envTierFor, projectDir } from "./shared.ts";
import { SHUTDOWN_SIGNALS } from "./shutdown.ts";
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
  return [...flags, ...await directionalNetFlags(flags.includes("--allow-net"))];
}

/**
 * The parent's direction-split network grants (denext's Deno from 3.0.0-rc.2: `--allow-net-connect`
 * / `--allow-net-listen`, `--deny-net-connect` / `--deny-net-listen`), each one held unscoped, for
 * a re-exec child. Only when the parent runs in that model: there `net` reads `prompt`, and the two
 * models may not be mixed on one command line. Elsewhere (`--allow-net`, `--deny-net`, a Deno
 * without the split) none.
 *
 * @param legacyGranted Whether the parent holds the legacy `net` grant.
 * @param query The permission query (a test seam).
 * @returns The flags.
 */
export async function directionalNetFlags(
  legacyGranted: boolean,
  query: (name: string) => Promise<Deno.PermissionState> = (name) =>
    Deno.permissions.query({ name } as unknown as Deno.PermissionDescriptor).then((s) => s.state),
): Promise<string[]> {
  if (legacyGranted) return [];
  try {
    if (await query("net") !== "prompt") return [];
    const flags: string[] = [];
    for (const direction of ["connect", "listen"]) {
      const state = await query(`net-${direction}`);
      if (state === "granted") flags.push(`--allow-net-${direction}`);
      else if (state === "denied") flags.push(`--deny-net-${direction}`);
    }
    return flags;
  } catch {
    return []; // a Deno without the split refuses the directional names
  }
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
 * What this process does with a shutdown signal while `child` runs: on Unix, relay it as
 * SIGTERM, so `kill <pid>` / `docker stop` reach a re-exec'd server instead of orphaning it. On
 * Windows, a console event (Ctrl-C, Ctrl-Break, a closed window, logoff, shutdown — what a service
 * wrapper sends too) reaches every process on the console, the child included, which is already
 * draining: killing it here would be `TerminateProcess` mid-drain. So the first one is left to the
 * child, and only a second one stops it outright, as a second Ctrl-C ends a foreground server.
 *
 * @param child The re-exec child.
 * @param os The platform (tests).
 * @returns The signal listener.
 */
export function shutdownForwarder(
  child: Pick<Deno.ChildProcess, "kill">,
  os: typeof Deno.build.os = Deno.build.os,
): () => void {
  let signals = 0;
  return () => {
    signals++;
    try {
      if (os !== "windows") child.kill("SIGTERM");
      else if (signals > 1) child.kill();
    } catch { /* already exited */ }
  };
}

/**
 * Forward the shutdown signals this process receives to `child` ({@linkcode shutdownForwarder}),
 * then resolve with the code the process should exit with: the child's own, or — when the child
 * died of a signal — `128 + signal`, as a shell would report (Deno's `status.code` already carries
 * that on Unix).
 */
async function forwardShutdown(child: Deno.ChildProcess): Promise<number> {
  const forward = shutdownForwarder(child);
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
            childToolchainMarker((n) => Deno.env.get(n), currentDenoIdentity()),
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
  // Every coarse grant: the seven legacy kinds (a directional net flag is no part of `-A`).
  if (flags.filter((f) => !f.startsWith("--allow-net-") && !f.startsWith("--deny-")).length === 7) {
    return ["-A"];
  }
  const names: Deno.PermissionName[] = ["read", "write", "net", "env", "run", "sys", "ffi"];
  for (const name of names) {
    const state = await Deno.permissions.query({ name }).then((s) => s.state, () => "prompt");
    if (state === "denied") flags.push(`--deny-${name}`);
  }
  return flags;
}

/**
 * Whether this process may start its own Deno binary again without asking: a least-privilege
 * `start` (no `--allow-run`) keeps serving in-process rather than prompt or fail.
 */
function mayRespawnSelf(): boolean {
  try {
    return Deno.permissions.querySync({ name: "run", command: Deno.execPath() }).state ===
      "granted";
  } catch {
    return false;
  }
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
  const { denext } = currentDenoIdentity();
  return maybeReexecToolchain(toolchainApplies(command, ctx.positionals[0], standalone), {
    env: (name) => Deno.env.get(name),
    setEnv: (name, value) => Deno.env.set(name, value),
    denoVersion: Deno.version.deno,
    ...(denext ? { denext } : {}),
    pinnedVersion: pinnedToolchainVersion(),
    standalone: () => standalone,
    resolve: () => resolveDenoToolchain(),
    spawn: async (deno, marker, env = {}) =>
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
        { ...env, DENEXT_TOOLCHAIN_ACTIVE: marker },
      ),
    exit: (code) => Deno.exit(code),
    warn: (message) => console.error(message),
    pathEnv: (deno) => denoPathEnv(deno),
    // Already on the toolchain but started without its runtime flags (`toolchain link`'s `deno`,
    // a `deno task` step): a serving verb re-runs once with them.
    legacyAbort: !standalone && servesInProcess(command) && mayRespawnSelf()
      ? legacyAbortActive
      : undefined,
    execPath: Deno.execPath(),
    pids: { pid: Deno.pid, ppid: Deno.ppid },
    // A verb that runs no project code still hands the toolchain to the `deno` it spawns.
    handOff: handsToolchainToChildren(command, ctx.positionals[0], standalone),
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
      ...toolchainRuntimeFlags(childToolchainMarker((n) => Deno.env.get(n), currentDenoIdentity())),
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
 * `node_modules`, a `npm:` import (server-side npm deps like an ORM driver), or an import-map
 * entry the framework's config does not resolve (an app-only `"@gleam/"` prefix).
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
  const frameworkConfig = join(frameworkRoot(), "deno.json");
  if (!configAnchorsResolution(appCfg, resolvesInThisProcess)) return false;
  await assertMayReexec(appCfg);
  const configPath = await writeMergedModuleConfig(paths.outDir, paths.configPath, frameworkConfig);
  // Manual mode resolves the framework's own npm build deps (esbuild, …) from the
  // node_modules beside the merged config, which the app's tree does not carry;
  // supply the framework half. (A `npm:`-anchored app without a manual dir resolves
  // everything from Deno's global cache, so it needs nothing here.) The app's own
  // deps resolve via its own config regardless — see {@link ensureFrameworkNodeModules}.
  if (appCfg.nodeModulesDir === "manual") await ensureFrameworkNodeModules(paths.outDir);
  return await reexecWithConfig(configPath, "DENEXT_MODULE_ACTIVE");
}

/**
 * Refuse, with the way out, a module re-exec this process may not spawn: a least-privilege run
 * (no `--allow-run`) of a source checkout's CLI whose app maps keys the CLI's config cannot
 * resolve would otherwise die on an opaque `NotCapable` from `Deno.Command`.
 */
async function assertMayReexec(appCfg: DenoConfigView): Promise<void> {
  const run = await Deno.permissions.query({ name: "run", command: denoExecutable() })
    .then((s) => s.state, () => "denied");
  // At a terminal Deno asks for an ungranted permission; only a refusal it cannot ask about is ours.
  if (run === "granted" || (run === "prompt" && Deno.stdin.isTerminal())) return;
  const keys = unresolvedImportKeys(appCfg, resolvesInThisProcess);
  const why = appCfg.nodeModulesDir === "manual"
    ? 'its `nodeModulesDir: "manual"`'
    : keys.length > 0
    ? `import-map keys this CLI's config does not resolve (${keys.join(", ")})`
    : "`npm:` imports";
  throw new Error(
    `denext: this project's deno.json needs a merged framework+app config for ${why}, which ` +
      "this source checkout's CLI applies by re-running itself, but it has no --allow-run. " +
      "Pass the app's config to the CLI (`deno run --config <app>/deno.json … cli.ts`), grant " +
      `--allow-run=${denoExecutable()}, or run the published CLI (jsr:@denext/denext/cli).`,
  );
}

/**
 * Whether `denext start` serves the project in `dir` without the CSS import map, and so without
 * {@linkcode maybeReexecForCss} — which rebuilds the stylesheets (Tailwind spawns its binary) and
 * spawns a second `deno`, neither of which a least-privilege `start` (no `--allow-run`) may do. A
 * SPA's server imports none of the app's modules; a native App Router build's server copies and a
 * next-compat build's server bundle point every stylesheet import at its shim (`buildServesCss`).
 * Anything else (an older build, a moved project) keeps the re-exec.
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
  // On the toolchain now: its type checking runs natively unless the compiler is unverified or the
  // project opts out (src/ts/engine.ts) — decided before the verb starts any Deno.
  const standalone = isStandaloneBinary();
  if (toolchainApplies(command, ctx.positionals[0], standalone)) {
    // A compiled executable's children run the toolchain it handed them (its marker, which only
    // denext sets, to the toolchain it resolved).
    const handed = standalone ? Deno.env.get("DENEXT_TOOLCHAIN_ACTIVE") : undefined;
    const running = handed ? { deno: handed, denext: handed } : currentDenoIdentity();
    await applyNativeCheckEngine({ running }).catch(() => {});
  }
  if (await moduleGate(command, ctx)) return;
  await noticeShadow(command, cwd);
  // Cargo-style build locks, taken here — in the process that runs the verb, after any re-exec —
  // and held for the whole run (the OS drops them if the process exits or is killed).
  const lockRequest = command.locks?.(ctx);
  using _locks = lockRequest ? await acquireProjectLocks(lockRequest) : undefined;
  await command.run(ctx);
}
