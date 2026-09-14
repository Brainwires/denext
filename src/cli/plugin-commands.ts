// Discovery of a PROJECT's own CLI verbs — the two ways an app extends `denext <verb>`:
//
//   1. `commands: [...]` in `denext.config.ts` (a {@link DenextCommand} literal — no
//      plugin, no `setup`; the shorthand), stamped `source: "project"`.
//   2. A plugin's `addCommand` seam, stamped `source: "plugin"` by the plugin layer.
//
// Both are merged into the CLI's registry by {@linkcode loadPluginCommands}. It lives
// apart from `cli.ts` so the `ui` verb, help, and completions can enumerate project
// verbs without importing the entrypoint — and so the work is BUDGETED: a plugin's
// `setup` is arbitrary user code (it may hit the network or hang), and `denext --help`
// must still answer promptly.

import { resolveProject } from "../build/paths.ts";
import { applyPlugins, getPluginCommands, pluginGeneration } from "../plugin/mod.ts";
import { defaultLoader } from "../server/mod.ts";
import type { CommandRegistry, CommandSpec } from "./command.ts";

/** Default wall-clock budget for discovering a project's verbs (ms). */
export const COMMAND_LOAD_BUDGET_MS = 1500;

/** Options for {@linkcode loadPluginCommands}. */
export interface LoadCommandsOptions {
  /** Wall-clock budget for the whole discovery, in ms (default 1500). */
  timeoutMs?: number;
}

/** What {@linkcode loadPluginCommands} did — enough to explain a short help listing. */
export interface LoadCommandsResult {
  /** How many verbs were actually registered (collisions with core verbs excluded). */
  loaded: number;
  /** True when the budget elapsed first; the registry was left untouched. */
  timedOut: boolean;
  /** The failure message when discovery threw (a bad config, a plugin that errored). */
  error?: string;
}

/** The sentinel the budget race resolves with (never a legitimate result). */
const TIMED_OUT = Symbol("denext.command-load-timeout");

/**
 * Resolve `work`, or {@linkcode TIMED_OUT} when `ms` elapses first. The losing work
 * keeps running (it cannot be cancelled — a plugin's `setup` owns its own effects),
 * but its result is ignored, so the registry never changes after the budget.
 */
async function withBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Every verb the project at `dir` contributes, config shorthand first. Resolving the
 * project is the only cost for an app with neither `commands:` nor `plugins` — one
 * config read, no plugin setup.
 */
async function collectProjectCommands(dir: string): Promise<CommandSpec[]> {
  const startedUnder = pluginGeneration();
  const paths = await resolveProject(dir);
  // A later resetPlugins() (the next discovery) supersedes this run: importing the config may
  // outlive the caller's budget, and a stale run must not mark plugins the next one will skip.
  if (pluginGeneration() !== startedUnder) return [];
  const config = paths.config;
  if (!config) return [];
  const specs: CommandSpec[] = (config.commands ?? []).map((command) => ({
    ...command,
    source: "project" as const,
  }));
  if (!config.plugins?.length) return specs;
  await applyPlugins({
    projectRoot: dir,
    appDir: paths.appDir,
    config,
    mode: "build",
    load: defaultLoader,
  });
  // Already stamped `source: "plugin"` where the plugin layer stored them.
  return [...specs, ...getPluginCommands()];
}

/**
 * Register `specs` that don't collide with anything already in `registry` — core
 * verbs always win, and an earlier project verb wins over a later duplicate (of its
 * name OR one of its aliases), so registration can never throw.
 */
function registerNew(registry: CommandRegistry, specs: readonly CommandSpec[]): number {
  let loaded = 0;
  for (const spec of specs) {
    const names = [spec.name, ...(spec.aliases ?? [])];
    if (names.some((name) => registry.get(name))) continue;
    registry.register(spec);
    loaded++;
  }
  return loaded;
}

/**
 * Merge the target project's own CLI verbs — `denext.config.ts` `commands:` entries
 * and plugin `addCommand` contributions — into `registry`.
 *
 * Called lazily when the first parse hit an unknown verb (so a plain project or a typo
 * pays a single config read, not a plugin setup) and eagerly when the CLI has to
 * enumerate every verb (`denext --help`, `denext completions <shell>`). Project verbs
 * never override a built-in: core wins. Everything is collected BEFORE anything is
 * registered, so a timeout or a failure leaves the registry exactly as it was and the
 * caller's original outcome (the "unknown command" error, the built-in help table)
 * still stands.
 *
 * @param registry The CLI registry to merge into (mutated on success).
 * @param dir The project directory to discover verbs from.
 * @param options Discovery options — currently the time budget.
 * @returns How many verbs were registered, and whether the budget or an error cut it short.
 */
export async function loadPluginCommands(
  registry: CommandRegistry,
  dir: string,
  options: LoadCommandsOptions = {},
): Promise<LoadCommandsResult> {
  const timeoutMs = options.timeoutMs ?? COMMAND_LOAD_BUDGET_MS;
  let collected: CommandSpec[] | typeof TIMED_OUT;
  try {
    collected = await withBudget(collectProjectCommands(dir), timeoutMs);
  } catch (error) {
    return {
      loaded: 0,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (collected === TIMED_OUT) return { loaded: 0, timedOut: true };
  return { loaded: registerNew(registry, collected), timedOut: false };
}
