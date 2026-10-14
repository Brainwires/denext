#!/usr/bin/env -S deno run -A
/**
 * The denext command-line interface.
 *
 * Run it directly (`deno run -A jsr:@denext/denext/cli dev .`), install it as a
 * global command (`deno install -A -g -n denext jsr:@denext/denext/cli`), or
 * compile a standalone binary (`deno compile -A --output denext cli.ts`).
 *
 * This entrypoint owns argv, `.env` loading, and the CSS/module re-exec (which is
 * intrinsic to the CLI's own module URL); the command framework
 * (`src/cli/command.ts`) owns parsing, help, suggestions, and dispatch, and each
 * verb lives in `src/cli/commands/*.ts`.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import {
  entrypointArg,
  isStandaloneBinary,
  maybeReexecPinned as reexecPinned,
  maybeReexecToolchain,
  mergeRunFlags,
  pinnedConfigArgs,
  toolchainApplies,
  toolchainConfigArgs,
} from "./src/cli/self-exec.ts";
import { loadDenoToolchainPin, resolveDenoToolchain } from "./src/build/deno-toolchain.ts";
import { runDenoPassthrough } from "./src/cli/commands/deno-toolchain.ts";
import { denoPathEnv } from "./src/cli/deno-path.ts";
import { resolveProject } from "./src/build/paths.ts";
import {
  buildAppCss,
  injectAppConfigRedirects,
  restoreAppConfig,
  restoreAppConfigSync,
} from "./src/build/css.ts";
import { guardRestore, healLeakedCssShims, signalExitCode } from "./src/build/css-config-guard.ts";
import { tailwindPaths } from "./src/build/tailwind.ts";
import { buildServesCss } from "./src/build/server-copies.ts";
import { denoExecutable, frameworkRoot, minDepAgeArgs } from "./src/build/bundle.ts";
import {
  configAnchorsResolution,
  ensureFrameworkNodeModules,
  readConfig,
  writeMergedModuleConfig,
} from "./src/build/module-config.ts";
import { loadEnv } from "./src/server/env.ts";
import { cliNpmModeArgs } from "./src/build/pnpm-workspace.ts";
import {
  COMMAND_DISPATCH_BUDGET_MS,
  discoveryShortfall,
  loadPluginCommands,
} from "./src/cli/plugin-commands.ts";
import { VERSION } from "./mod.ts";
import type { CommandContext, CommandSpec, ParseOutcome, ProjectVerb } from "./src/cli/command.ts";
import { type CommandRegistry, GLOBAL_FLAGS, verbIndex } from "./src/cli/command.ts";
import { buildRegistry } from "./src/cli/register.ts";
import { envTierFor, projectDir, SHUTDOWN_SIGNALS } from "./src/cli/shared.ts";
import { firstNotice, hasDenextConfig, readCommandCache } from "./src/cli/command-cache.ts";
import { acquireProjectLocks } from "./src/build/project-locks.ts";
import { denoForwardFor, denoVerbArgs, verbatimFrom } from "./src/cli/deno-forward.ts";
import {
  DENO_VERBS,
  forwardedDenoVerbs,
  isDenoVerb,
  shadowNotice,
  unlistedVerbHint,
} from "./src/cli/deno-verbs.ts";
import { routeUnknownVerb, type VerbRoute } from "./src/cli/verb-route.ts";

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
  // entrypoints, so we re-exec `import.meta.url`.
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
        ["-A", ...pinnedConfigArgs(dir), ...cliNpmModeArgs(dir), ...minDepAgeArgs()],
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
            [...cliNpmModeArgs(gateDir(command, ctx)), ...minDepAgeArgs()],
            await toolchainConfigArgs(entrypointArg(import.meta.url)),
          ),
        ],
        entrypointArg(import.meta.url),
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
      ...await childPermissionFlags(),
      // Deno's minimum-dependency-age policy applies to the child too and the parent can't
      // read the value it was started with: forward `DENEXT_MIN_DEP_AGE` (see minDepAgeArgs),
      // or a freshly published `@denext/*` dep (the icon compositor's photon, a codec) is
      // refused inside the build child while the parent resolved fine.
      ...minDepAgeArgs(),
      "--config",
      configPath,
      entrypointArg(import.meta.url),
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
  if (!import.meta.url.startsWith("file://")) return false;
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

/** The `--cwd` global from a raw argv (for plugin discovery before full parse). */
function cwdFromArgs(argv: string[]): string {
  const i = argv.indexOf("--cwd");
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith("--cwd="));
  if (eq) return resolve(eq.slice("--cwd=".length));
  return Deno.cwd();
}

/**
 * The directory whose denext config decides top-level help's project footer: the `--cwd`
 * global when given, else the first bare token that is not a verb (`denext --help ./app` —
 * on the help path the parser leaves such a token for this), else the process cwd. The
 * separate value of a valued global flag (`--config <path>`) is never taken as the dir.
 */
function helpDirFromArgs(argv: string[], isVerb: (name: string) => boolean): string {
  if (argv.some((a) => a === "--cwd" || a.startsWith("--cwd="))) return cwdFromArgs(argv);
  const valued = new Set(
    GLOBAL_FLAGS.filter((f) => f.type !== "boolean").map((f) => `--${f.name}`),
  );
  const dir = argv.find((a, i) => !a.startsWith("-") && !valued.has(argv[i - 1]) && !isVerb(a));
  return dir === undefined ? Deno.cwd() : resolve(dir);
}

/**
 * Whether this outcome has to list EVERY verb NAME, which means the project's own verbs
 * (config `commands:` + plugin `addCommand`) must be merged in before it is printed. Only the
 * shell-completion scripts do: a shell can only complete a name it was handed.
 *
 * `--help` deliberately does NOT. Discovering project verbs means importing the project's
 * `denext.config.ts` and running every plugin `setup()` — arbitrary user code, under whatever
 * permissions the CLI holds — which is far too much to ask of `denext --help`, and a `setup`
 * that leaks a handle would keep help from ever exiting. Help lists what the last
 * `denext commands` run recorded instead ({@linkcode projectHelp}), and points there when
 * there is no listing it can trust.
 */
function needsEveryCommand(outcome: ParseOutcome): boolean {
  return outcome.kind === "run" && outcome.command.name === "completions";
}

/** The footer `--help` prints when it has no listing it can trust. */
const PROJECT_HELP_NOTE =
  "Project verbs: run `denext commands` (they are also in shell completions).";

/** The footer `--help` prints under the verbs it listed, so their age is never a surprise. */
const PROJECT_LISTED_NOTE =
  "Project commands are what `denext commands` last found here; run it again after " +
  "changing a plugin.";

/** What top-level help says about the project's own verbs. */
interface ProjectHelp {
  /** The verbs to list (none when there is no listing to trust). */
  verbs: ProjectVerb[];
  /** The footer under the help text. */
  note: string;
}

/**
 * The project's own verbs for top-level help: the last discovery's listing, when the files it
 * read have not changed since. Never imports the project — a file probe and a JSON read.
 *
 * @param dir The directory help was asked about.
 * @returns The verbs and the footer, or null when it is not a denext project.
 */
async function projectHelp(dir: string): Promise<ProjectHelp | null> {
  if (!await hasDenextConfig(dir)) return null;
  const verbs = await readCommandCache(dir);
  return verbs === null || verbs.length === 0
    ? { verbs: [], note: PROJECT_HELP_NOTE }
    : { verbs, note: PROJECT_LISTED_NOTE };
}

/** Whether a token asks for help (`--help` / `-h`). */
function isHelpToken(token: string): boolean {
  return token === "--help" || token === "-h";
}

/** Every Deno verb name — offered as a did-you-mean for an unknown verb (`denext compil`). */
const DENO_VERB_NAMES: readonly string[] = DENO_VERBS.map((verb) => verb.name);

/**
 * The Deno invocation for an argv denext hands to Deno before parsing: `denext deno …` (every
 * token after `deno` verbatim — flags such as `--config`, `--quiet` and `--json` included, which
 * the parser would otherwise claim) and `denext task …` (Deno's `task`; a task's arguments are its
 * own), after any leading global flags (`denext --cwd app deno fmt --quiet`). A help or version
 * flag before the verb is denext's: `denext --help task` describes the verb and `denext --version
 * task` prints denext's version. Null for everything else.
 */
function denoBeforeParse(
  argv: string[],
): { args: string[]; cwd: string; forwarded: boolean } | null {
  const at = verbIndex(argv);
  if (at < 0 || (argv[at] !== "deno" && argv[at] !== "task")) return null;
  if (argv.slice(0, at).some((tok) => isHelpToken(tok) || isVersionToken(tok))) return null;
  if (argv[at] === "deno") return { ...denoVerbArgs(argv, at), forwarded: false };
  return { ...verbatimFrom(argv, at), forwarded: true };
}

/** Whether a token asks for the version (`--version` / `-v`). */
function isVersionToken(token: string): boolean {
  return token === "--version" || token === "-v";
}

/**
 * Parse the argv with denext's precedence: a built-in verb, else one the project contributes
 * (loaded on the first miss, so a plain project pays nothing), else a Deno verb or a script, which
 * runs on denext's Deno exactly as `denext deno <args…>` would (and never returns).
 *
 * The project's config is imported only for a name that can be a project verb
 * (`routeUnknownVerb`): a script never is, a reserved Deno verb (`run`, `x`, `compile`, …) never
 * is, and any other Deno verb is one only when the project's cached `denext commands` listing
 * names it — so `denext main.ts` or `denext bench` runs no project code before Deno does.
 *
 * Discovery here runs under the DISPATCH budget, not the listing one: the verb was asked for by
 * name, so a slow config import on a loaded machine must not make it "unknown". When discovery
 * still falls short, the unknown-command error says why instead of only that it is unknown.
 */
async function resolveOutcome(registry: CommandRegistry): Promise<ParseOutcome> {
  let outcome = registry.parse(Deno.args, DENO_VERB_NAMES);
  if (outcome.kind !== "error" || !outcome.unknownVerb) return outcome;
  const route = await routeUnknownVerb(Deno.args, outcome.unknownVerb);
  if (route.kind === "deno") return await runRouted(route);
  const loaded = await loadPluginCommands(registry, cwdFromArgs(Deno.args), {
    timeoutMs: COMMAND_DISPATCH_BUDGET_MS,
  });
  outcome = registry.parse(Deno.args, DENO_VERB_NAMES);
  if (outcome.kind !== "error" || !outcome.unknownVerb) return outcome;
  const forward = denoForwardFor(Deno.args, outcome.unknownVerb);
  if (forward) return await runDenoPassthrough(forward.args, forward.cwd, true);
  const shortfall = discoveryShortfall(loaded, COMMAND_DISPATCH_BUDGET_MS);
  return shortfall === null
    ? outcome
    : { ...outcome, message: `${outcome.message} (${shortfall})` };
}

/**
 * Run a script or Deno verb that `routeUnknownVerb` sent to Deno, after the one-time hint when a
 * project verb of that name could exist but is not listed yet.
 */
async function runRouted(route: Extract<VerbRoute, { kind: "deno" }>): Promise<never> {
  const { forward } = route;
  if (route.unlisted && await firstNotice(forward.cwd, `unlisted:${forward.args[0]}`)) {
    console.error(unlistedVerbHint(forward.args[0]));
  }
  return await runDenoPassthrough(forward.args, forward.cwd, true);
}

/**
 * Say once — by the process that runs the verb (after any re-exec), and once per state of the
 * project's config files — that a project verb shadows a Deno verb of the same name.
 */
async function noticeShadow(command: CommandSpec): Promise<void> {
  if ((command.source ?? "core") === "core" || !isDenoVerb(command.name)) return;
  if (await firstNotice(cwdFromArgs(Deno.args), `shadow:${command.name}`)) {
    console.error(shadowNotice(command.name));
  }
}

async function main(): Promise<void> {
  const early = denoBeforeParse(Deno.args);
  if (early) return await runDenoPassthrough(early.args, early.cwd, early.forwarded);
  const registry = buildRegistry();
  const outcome = await resolveOutcome(registry);
  // Completions enumerate the whole verb set, so they load project verbs up front — under a
  // time budget, since a plugin's `setup` is arbitrary user code (the verb then exits, so a
  // handle that `setup` leaked cannot keep the shell waiting).
  if (needsEveryCommand(outcome)) await loadPluginCommands(registry, cwdFromArgs(Deno.args));

  if (outcome.kind !== "run") {
    const isVerb = (name: string) => name === "help" || registry.get(name) !== undefined;
    const project = outcome.kind === "help" && outcome.command === undefined
      ? await projectHelp(helpDirFromArgs(Deno.args, isVerb))
      : null;
    return printOutcome(registry, outcome, project);
  }
  if (await toolchainGate(outcome.command, outcome.ctx)) return;
  if (await moduleGate(outcome.command, outcome.ctx)) return;
  await noticeShadow(outcome.command);
  // Cargo-style build locks, taken here — in the process that runs the verb, after any re-exec —
  // and held for the whole run (the OS drops them if the process exits or is killed).
  const lockRequest = outcome.command.locks?.(outcome.ctx);
  using _locks = lockRequest ? await acquireProjectLocks(lockRequest) : undefined;
  await outcome.command.run(outcome.ctx);
}

/**
 * Print a non-run outcome: the version, help, or a usage error (exit 1). `project` is the
 * target directory's own verbs and the footer under them — null when it is not a denext
 * project, and then help is the built-in table alone.
 */
function printOutcome(
  registry: CommandRegistry,
  outcome: Exclude<ParseOutcome, { kind: "run" }>,
  project: ProjectHelp | null = null,
): void {
  if (outcome.kind === "version") {
    console.log(`denext ${VERSION}${isStandaloneBinary() ? " (binary)" : ""}`);
  } else if (outcome.kind === "help") {
    const help = outcome.command
      ? registry.formatCommandHelp(outcome.command)
      : registry.formatHelp(
        VERSION,
        project?.verbs ?? [],
        forwardedDenoVerbs((name) => registry.get(name) !== undefined).map((verb) => verb.name),
      );
    console.log(project && !outcome.command ? `${help}\n\n${project.note}` : help);
  } else {
    console.error(
      `denext: ${outcome.message}` +
        (outcome.suggestion ? `\n  Did you mean \`${outcome.suggestion}\`?` : "") +
        `\n  Run \`denext --help\` for usage.`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Print known, expected failures cleanly (no stack trace); an unexpected error
    // still throws with its stack so real bugs stay debuggable.
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(error.message);
      Deno.exit(1);
    }
    // denext's own thrown errors (config load/validation, a failed build/export)
    // carry an already-formatted, user-facing message prefixed "denext:".
    if (error instanceof Error && error.message.startsWith("denext:")) {
      console.error(error.message);
      Deno.exit(1);
    }
    // A missing file / denied permission is a user/environment problem, not a bug.
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      console.error(`denext: ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }
}
