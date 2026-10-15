#!/usr/bin/env -S deno run -A
/**
 * The denext command-line interface.
 *
 * Run it directly (`deno run -A jsr:@denext/denext/cli dev .`), install it as a
 * global command (`deno install -A -g -n denext jsr:@denext/denext/cli`), or
 * compile a standalone binary (`deno task compile`: `deno compile -A --include
 * src/cli/lazy-modules.generated.ts --output denext cli.ts` — the include embeds the verbs, which
 * load on demand).
 *
 * This entrypoint owns argv and the module URL every re-exec runs again; the command framework
 * (`src/cli/command.ts`) owns parsing, help, suggestions, and dispatch; `src/cli/run-verb.ts`
 * owns `.env` loading, the toolchain / CSS / module re-execs and the build locks; and each verb
 * lives in `src/cli/commands/*.ts`, listed in `src/cli/command-table.generated.ts` and loaded
 * only when it runs.
 *
 * @module
 */

import { resolve } from "@std/path";
import { VERSION } from "./src/version.ts";
import type { CommandContext, ParseOutcome, ProjectVerb } from "./src/cli/command.ts";
import { type CommandRegistry, GLOBAL_FLAGS, verbIndex } from "./src/cli/command.ts";
import { buildLazyRegistry } from "./src/cli/lazy-registry.ts";
import { importCliModule, materializeCommand } from "./src/cli/lazy-command.ts";
import { firstNotice, hasDenextConfig, readCommandCache } from "./src/cli/command-cache.ts";
import { denoForwardFor, denoVerbArgs, verbatimFrom } from "./src/cli/deno-forward.ts";
import { DENO_VERBS, forwardedDenoVerbs, unlistedVerbHint } from "./src/cli/deno-verbs.ts";
import { routeUnknownVerb, type VerbRoute } from "./src/cli/verb-route.ts";
import type { LoadCommandsOptions, LoadCommandsResult } from "./src/cli/plugin-commands.ts";

/** The run half of the entrypoint, imported when a verb runs (src/cli/run-verb.ts). */
type RunVerbModule = typeof import("./src/cli/run-verb.ts");
/** Project-verb discovery (src/cli/plugin-commands.ts). */
type PluginCommandsModule = typeof import("./src/cli/plugin-commands.ts");

/** A module cli.ts loads on demand, by its path under src/cli (see `importCliModule`). */
function lazy<T>(path: string): Promise<T> {
  return importCliModule(path) as Promise<T>;
}

// Everything a verb needs to RUN — the re-exec gates, the bundler and CSS tooling, project
// discovery, the verbs' own implementations — is imported on demand below, so `denext
// --version`, `--help`, `commands` and completions load a small fraction of the CLI
// (tests/cli-startup-graph.test.ts holds the line).

/** Run `deno <args>` on denext's Deno (a Deno verb, a script, `denext deno …`); never returns. */
async function runDenoPassthrough(args: string[], cwd: string, forwarded: boolean): Promise<never> {
  const { runDenoPassthrough: run } = await lazy<
    typeof import("./src/cli/commands/deno-toolchain.ts")
  >("./commands/deno-toolchain.ts");
  return await run(args, cwd, forwarded);
}

/**
 * Merge the project's own verbs into `registry` ({@linkcode loadPluginCommands}) — after a
 * compiled binary has handed the invocation to the denext the project pins, when it must
 * (`discoverInPinned` in src/cli/run-verb.ts; the process then ends with the child's code).
 */
async function loadProjectVerbs(
  registry: CommandRegistry,
  dir: string,
  options?: LoadCommandsOptions,
): Promise<LoadCommandsResult> {
  await deferDiscoveryToPinned(dir);
  const { loadPluginCommands } = await lazy<PluginCommandsModule>("./plugin-commands.ts");
  return await inProjectDir(dir, () => loadPluginCommands(registry, dir, options));
}

/**
 * Run `work` — project-verb discovery, which imports the project's config and runs its plugins'
 * `setup` — with the working directory set to the project, then put it back. A project's relative
 * paths (a sqlite file named `auth.db`) mean the project directory: `denext commands --cwd app`
 * run from elsewhere, or `denext ui`'s discovery child, wrote such a file into the caller's
 * directory. Only this entrypoint does it (the process is the CLI's alone); the library's
 * `loadPluginCommands` never changes the directory of the process that calls it.
 */
async function inProjectDir<T>(dir: string, work: () => Promise<T>): Promise<T> {
  let previous: string | undefined;
  try {
    previous = Deno.cwd();
    Deno.chdir(dir);
  } catch {
    previous = undefined; // no such directory, or no read permission: discover from here
  }
  try {
    return await work();
  } finally {
    if (previous !== undefined) {
      try {
        Deno.chdir(previous);
      } catch { /* the caller's directory is gone */ }
    }
  }
}

/** In a compiled binary, re-run an invocation that discovers project verbs on the pinned denext. */
async function deferDiscoveryToPinned(dir: string): Promise<void> {
  if (!isStandalone()) return;
  const { discoverInPinned } = await lazy<RunVerbModule>("./run-verb.ts");
  await discoverInPinned(import.meta.url, dir, await hasDenextConfig(dir));
}

/** Whether this process is a `deno compile`d denext. */
function isStandalone(): boolean {
  return (Deno.build as { standalone?: boolean }).standalone === true;
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
  const { COMMAND_DISPATCH_BUDGET_MS, discoveryShortfall } = await lazy<PluginCommandsModule>(
    "./plugin-commands.ts",
  );
  const loaded = await loadProjectVerbs(registry, cwdFromArgs(Deno.args), {
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

async function main(): Promise<void> {
  const early = denoBeforeParse(Deno.args);
  if (early) return await runDenoPassthrough(early.args, early.cwd, early.forwarded);
  const registry = buildLazyRegistry();
  const outcome = await resolveOutcome(registry);
  // Completions enumerate the whole verb set, so they load project verbs up front — under a
  // time budget, since a plugin's `setup` is arbitrary user code (the verb then exits, so a
  // handle that `setup` leaked cannot keep the shell waiting).
  if (needsEveryCommand(outcome)) await loadProjectVerbs(registry, cwdFromArgs(Deno.args));

  if (outcome.kind !== "run") {
    const isVerb = (name: string) => name === "help" || registry.get(name) !== undefined;
    const project = outcome.kind === "help" && outcome.command === undefined
      ? await projectHelp(helpDirFromArgs(Deno.args, isVerb))
      : null;
    return printOutcome(registry, outcome, project);
  }
  if (outcome.command.name === "commands") {
    // `denext commands` imports the project's config: in a binary, on the denext it pins; and
    // from the project's directory. Like completions it runs on whatever Deno started the CLI,
    // loads no app modules and takes no locks, so it skips the run gates (and their imports).
    const dir = commandsDir(outcome.ctx);
    await deferDiscoveryToPinned(dir);
    const ctx = { ...outcome.ctx, global: { ...outcome.ctx.global, cwd: dir } };
    const command = await materializeCommand(outcome.command);
    return await inProjectDir(dir, async () => await command.run(ctx));
  }
  if (outcome.command.name === "completions") {
    return await (await materializeCommand(outcome.command)).run(outcome.ctx);
  }
  const { runVerb } = await lazy<RunVerbModule>("./run-verb.ts");
  await runVerb(import.meta.url, outcome.command, outcome.ctx, cwdFromArgs(Deno.args));
}

/** The directory `denext commands` lists (its `projectDir`: `--cwd`, else the first positional). */
function commandsDir(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ctx.positionals[0] ?? ".");
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
    console.log(`denext ${VERSION}${isStandalone() ? " (binary)" : ""}`);
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
