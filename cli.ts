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
import { entrypointArg, isStandaloneBinary } from "./src/cli/self-exec.ts";
import { CONFIG_FILES, resolveProject } from "./src/build/paths.ts";
import { buildAppCss, injectAppConfigRedirects, restoreAppConfig } from "./src/build/css.ts";
import { tailwindPaths } from "./src/build/tailwind.ts";
import { denoExecutable, frameworkRoot, minDepAgeArgs } from "./src/build/bundle.ts";
import {
  configAnchorsResolution,
  ensureFrameworkNodeModules,
  readConfig,
  writeMergedModuleConfig,
} from "./src/build/module-config.ts";
import { loadEnv } from "./src/server/env.ts";
import { loadPluginCommands } from "./src/cli/plugin-commands.ts";
import { VERSION } from "./mod.ts";
import type { CommandContext, CommandSpec, ParseOutcome } from "./src/cli/command.ts";
import { type CommandRegistry, GLOBAL_FLAGS } from "./src/cli/command.ts";
import { buildRegistry } from "./src/cli/register.ts";
import { projectDir, SHUTDOWN_SIGNALS } from "./src/cli/shared.ts";
import { type ProjectVerb, readCommandCache } from "./src/cli/command-cache.ts";

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
async function maybeReexecForCss(dir: string, minify: boolean): Promise<boolean> {
  if (Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  const paths = await resolveProject(dir);
  // Self-heal a previous run that was killed before it could restore the app's deno.json
  // (see the transient css-redirect injection below), so this build starts from the
  // committed config, not a leftover mutated one.
  await restoreAppConfig(paths.configPath, paths.outDir);
  const css = await buildAppCss({
    projectDir: dir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify,
    tailwind: tailwindPaths(dir, paths.config?.tailwind),
  });
  if (!css) return false; // no CSS in the project — run normally

  if (isStandaloneBinary()) {
    // Only a `deno compile`d binary cannot re-exec itself under a different `--config`
    // (there is no `deno` to spawn and no module URL to re-run). Running from JSR or a
    // remote URL is fine: Deno runs remote entrypoints, so we re-exec `import.meta.url`.
    console.error(
      "denext: WARNING — this project imports CSS, but a compiled (standalone) denext " +
        'binary cannot apply the CSS import map. `import "./x.css"` will fail at runtime; ' +
        "run the CLI with `deno run -A jsr:@denext/denext/cli` instead of the binary.",
    );
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
    // A previous run killed mid-build (SIGKILL, power loss) skipped its restore and left the
    // redirects — and its backup — behind; put the committed config back before injecting
    // again, or the stale entries would be captured as the "original".
    await restoreAppConfig(paths.configPath, paths.outDir);
    await injectAppConfigRedirects(paths.configPath, paths.outDir, css.appConfigRedirects);
  }
  return await reexecWithConfig(
    css.configPath,
    "DENEXT_CSS_ACTIVE",
    () => restoreAppConfig(paths.configPath, paths.outDir),
  );
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
  const forward = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, forward);
    } catch { /* unsupported */ }
  }
  const { code } = await child.status;
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
 * For a module-loading verb, load `.env` then apply the CSS/module re-exec gate.
 * Returns `true` if the process re-exec'd (the caller should stop). A no-op for
 * verbs that don't load user modules.
 */
async function moduleGate(command: CommandSpec, ctx: CommandContext): Promise<boolean> {
  if (!command.loadsModules) return false;
  const dir = command.moduleDir ? command.moduleDir(ctx) : projectDir(ctx);
  await loadEnv({ dir });
  // `dev` builds unminified CSS; the other module verbs minify (matching 1.x).
  if (await maybeReexecForCss(dir, command.name !== "dev")) return true;
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

/**
 * Whether `dir` holds a denext config — a file-existence probe, never an import, so
 * `denext --help` inside a project evaluates none of the project's code.
 */
async function hasDenextConfig(dir: string): Promise<boolean> {
  for (const name of CONFIG_FILES) {
    try {
      const stat = await Deno.stat(join(dir, name));
      if (stat.isFile) return true;
    } catch { /* not this name */ }
  }
  return false;
}

async function main(): Promise<void> {
  const registry = buildRegistry();
  let outcome = registry.parse(Deno.args);
  // An unknown verb may be one the project contributes — load them and retry.
  if (outcome.kind === "error" && outcome.message.startsWith("unknown command")) {
    await loadPluginCommands(registry, cwdFromArgs(Deno.args));
    outcome = registry.parse(Deno.args);
  }
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
  if (await moduleGate(outcome.command, outcome.ctx)) return;
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
    console.log(`denext ${VERSION}`);
  } else if (outcome.kind === "help") {
    const help = outcome.command
      ? registry.formatCommandHelp(outcome.command)
      : registry.formatHelp(VERSION, project?.verbs ?? []);
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
