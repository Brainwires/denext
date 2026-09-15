// `denext commands` — list every verb this project can run: the built-ins denext ships, plus
// the verbs the PROJECT itself contributes (`commands:` in denext.config.ts and a plugin's
// `addCommand` seam).
//
// This verb is the ONE place project-verb discovery legitimately runs in-process: it imports
// the project's `denext.config.ts` and runs every plugin `setup()`, exactly as `denext dev`
// already does, in a short-lived CLI process the user started on purpose. The two callers that
// used to do that work themselves no longer do:
//
//   * `denext --help` imports nothing: it lists what THIS verb last found, from the cache
//     it writes, and points here when there is no listing to trust.
//   * `denext ui` shells out to THIS verb as a `deno` subprocess, so project code never runs
//     inside the UI's privileged server (see `src/ui/features/commands.ts`).
//
// Because a plugin `setup()` is arbitrary user code that may leave a timer, a watcher or a
// listener open, the verb ALWAYS `Deno.exit`s once it has printed: a leaked handle can neither
// delay the listing nor keep the process alive. Discovery is budgeted for the same reason, and
// a budget or a broken config degrades into `timedOut` / `error` — data, not a failure — so the
// listing (and the exit code) is the same shape for every caller.

import type {
  CommandContext,
  CommandRegistry,
  CommandSpec,
  FlagSpec,
  PositionalSpec,
} from "../command.ts";
import { writeCommandCache } from "../command-cache.ts";
import { COMMAND_LOAD_BUDGET_MS, loadPluginCommands } from "../plugin-commands.ts";
import { projectDir } from "../shared.ts";

/** One verb, as `denext commands --json` describes it. */
export interface CommandInfo {
  /** The verb, as in `denext <name>`. */
  readonly name: string;
  /** Which seam contributed it: a built-in, a plugin's `addCommand`, or config `commands:`. */
  readonly source: "core" | "plugin" | "project";
  /** One-line summary. */
  readonly summary: string;
  /** Multi-line detail, when the verb declares one. */
  readonly usage?: string;
  /** Declared flags (the CLI's flag model has no "required" notion). */
  readonly flags: readonly FlagSpec[];
  /** Declared positionals. */
  readonly positionals: readonly PositionalSpec[];
  /**
   * Whether a non-interactive caller can run it with no arguments at all: a project or
   * plugin verb that declares no required positional. `denext ui` uses this to decide which
   * verbs get a Run button; a built-in is never runnable from anywhere but a terminal.
   */
  readonly runnable: boolean;
}

/** The whole `denext commands --json` document. */
export interface CommandListing {
  /** The verbs denext itself ships, in registration order. */
  readonly core: readonly CommandInfo[];
  /** The verbs this project contributes, config shorthand first. */
  readonly project: readonly CommandInfo[];
  /** True when the discovery budget elapsed — `project` is empty and incomplete. */
  readonly timedOut: boolean;
  /** The failure message when the project's config could not be read. */
  readonly error?: string;
}

/** Describe one registered spec the way the listing (and `denext ui`) reads it. */
function describe(spec: CommandSpec): CommandInfo {
  const positionals = spec.positionals ?? [];
  const source = spec.source ?? "core";
  return {
    name: spec.name,
    source,
    summary: spec.summary,
    ...(spec.usage === undefined ? {} : { usage: spec.usage }),
    flags: spec.flags ?? [],
    positionals,
    runnable: source !== "core" && positionals.every((p) => p.required !== true),
  };
}

/**
 * Discover the project's own verbs and split the registry into built-ins and project verbs.
 *
 * `registry` is merged into (core verbs always win a name collision — that rule lives in
 * {@linkcode loadPluginCommands}), so hand it a registry the caller is done with.
 *
 * @param registry The assembled CLI registry, seeded with the built-ins.
 * @param dir The project directory to discover verbs from.
 * @param timeoutMs Wall-clock budget for discovery (plugin `setup` is arbitrary user code).
 * @returns The built-in and project verb lists, plus how discovery degraded (if it did).
 */
export async function listAllCommands(
  registry: CommandRegistry,
  dir: string,
  timeoutMs: number = COMMAND_LOAD_BUDGET_MS,
): Promise<CommandListing> {
  const result = await loadPluginCommands(registry, dir, { timeoutMs });
  const visible = registry.list().filter((spec) => spec.hidden !== true).map(describe);
  return {
    core: visible.filter((info) => info.source === "core"),
    project: visible.filter((info) => info.source !== "core"),
    timedOut: result.timedOut,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/** Where a project verb was declared, in the words the human listing uses. */
function origin(info: CommandInfo): string {
  return info.source === "project" ? "denext.config.ts" : "plugin";
}

/** Whatever cut discovery short, said plainly — never an empty listing with no explanation. */
function printNotices(listing: CommandListing, timeoutMs: number): void {
  if (listing.timedOut) {
    console.log(
      `  project verbs not listed: plugin setup exceeded ${(timeoutMs / 1000).toFixed(1)} s`,
    );
  }
  if (listing.error !== undefined) {
    console.log(`  project verbs not listed: denext.config could not be read — ${listing.error}`);
  }
}

/** The project half of the human listing: one padded row per verb, with where it came from. */
function printProject(listing: CommandListing): void {
  if (listing.project.length === 0) {
    console.log("\nProject commands: none — see https://denext.dev/docs/plugins#project-commands");
    return;
  }
  const width = Math.max(...listing.project.map((info) => info.name.length)) + 3;
  console.log(`\nProject commands (${listing.project.length}):`);
  for (const info of listing.project) {
    console.log(`  denext ${info.name.padEnd(width)}${info.summary}  [${origin(info)}]`);
  }
}

/** Render the listing for a human: the project's verbs in full, the built-ins as a name list. */
function printHuman(listing: CommandListing, dir: string, timeoutMs: number): void {
  console.log(`\ndenext commands  ▸  ${dir}`);
  printNotices(listing, timeoutMs);
  printProject(listing);
  console.log(
    `\nBuilt-in commands (${listing.core.length}): ${
      listing.core.map((info) => info.name).sort().join(", ")
    }`,
  );
  console.log("\nRun `denext <command> --help` for a command's options.\n");
}

/** The discovery budget for this invocation: `--timeout`, else the CLI default. */
function budgetOf(ctx: CommandContext): number {
  const raw = ctx.flags.timeout;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : COMMAND_LOAD_BUDGET_MS;
}

/**
 * Build the `commands` verb bound to `reg` — the same registry the CLI dispatches from, so the
 * built-in half of the listing is the real verb set and a project verb can never shadow one.
 *
 * @param reg The assembled CLI registry (merged into when the verb runs).
 * @returns The `commands` {@linkcode CommandSpec}.
 */
export function makeCommandsCommand(reg: CommandRegistry): CommandSpec {
  return {
    name: "commands",
    summary: "List this project's own CLI verbs (config commands: + plugin addCommand)",
    usage: "  denext commands [--json] [--timeout <ms>] [--cwd <dir>]\n\n" +
      "  Imports denext.config.ts and runs every plugin setup() to discover the verbs the\n" +
      "  project contributes, then exits. A plugin that hangs or throws degrades to a notice\n" +
      "  (--json: `timedOut` / `error`); the exit code stays 0 either way.",
    flags: [{
      name: "timeout",
      type: "number",
      valueName: "<ms>",
      default: COMMAND_LOAD_BUDGET_MS,
      help: "Budget for plugin discovery",
    }],
    run: async (ctx: CommandContext): Promise<void> => {
      const dir = projectDir(ctx);
      const timeoutMs = budgetOf(ctx);
      const listing = await listAllCommands(reg, dir, timeoutMs);
      // A complete listing is what `denext --help` prints; a degraded one is not recorded.
      if (!listing.timedOut && listing.error === undefined) {
        await writeCommandCache(
          dir,
          listing.project.map(({ name, summary }) => ({
            name,
            summary,
          })),
        );
      }
      if (ctx.global.json) console.log(JSON.stringify(listing, null, 2));
      else printHuman(listing, dir, timeoutMs);
      // A plugin `setup()` that left a timer, a watcher or a listener open would otherwise
      // keep this process alive forever; the listing is printed, so nothing is lost.
      Deno.exit(0);
    },
  };
}
