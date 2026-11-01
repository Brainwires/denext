// A verb whose description is known up front and whose implementation is loaded on first use.
//
// `denext --version`, `--help`, `commands` and shell completions only need what a verb is called
// and which flags it takes; importing every verb's implementation to learn that loaded about a
// thousand modules (the dev server, the bundler, the desktop and mobile tooling) before the CLI
// could print a line. The CLI's registry is built from `command-table.generated.ts` instead: the
// data half of each first-party `CommandSpec`, plus an `import()` of the module that defines it.
// `materializeCommand` swaps a lazy spec for the real one before anything reads its functions.

import type { CommandRegistry, CommandSpec } from "./command.ts";

/** The data half of a {@linkcode CommandSpec} (everything but its functions and `source`). */
export type CommandMeta = Omit<
  CommandSpec,
  "run" | "moduleDir" | "inspectsOnly" | "locks" | "source"
>;

/** Load the full spec of a verb (bound to `registry` where the verb enumerates it). */
export type CommandLoader = (registry: CommandRegistry) => Promise<CommandSpec>;

/** The spec keys that are functions, filled in only by the loaded implementation. */
export const COMMAND_FUNCTION_KEYS: readonly string[] = [
  "run",
  "moduleDir",
  "inspectsOnly",
  "locks",
];

/** The spec keys the table carries, in the order it writes them. */
export const COMMAND_META_KEYS: readonly (keyof CommandMeta)[] = [
  "name",
  "summary",
  "usage",
  "aliases",
  "flags",
  "positionals",
  "loadsModules",
  "envTier",
  "passthrough",
  "hidden",
];

/**
 * Import a CLI module by its path relative to `src/cli/` — through a computed URL on purpose.
 * `deno run` builds the module graph through every *statically analyzable* `import()` before the
 * program starts, so a literal `import("./commands/serve.ts")` would cost the whole verb's graph
 * at every startup, used or not. A computed one is resolved only when called. A compiled binary
 * embeds these modules through `--include src/cli/lazy-modules.generated.ts`, which imports each
 * of them statically (`deno task compile`).
 *
 * @param path The module's path relative to `src/cli/` (`./commands/serve.ts`).
 * @returns The module's namespace.
 */
export function importCliModule(path: string): Promise<Record<string, unknown>> {
  return import(new URL(path, import.meta.url).href);
}

const LOADERS = new WeakMap<CommandSpec, () => Promise<CommandSpec>>();

/**
 * A spec with `meta`'s description whose implementation is loaded by `load` on first use. Its
 * `run` loads and delegates, so calling it directly works; the CLI calls
 * {@linkcode materializeCommand} first, because `moduleDir` and `locks` are read synchronously.
 *
 * @param meta The verb's description.
 * @param load Loads the full spec.
 * @param registry The registry the verb is registered in (passed to `load`).
 * @returns The lazy spec.
 */
export function lazyCommand(
  meta: CommandMeta,
  load: CommandLoader,
  registry: CommandRegistry,
): CommandSpec {
  let loaded: Promise<CommandSpec> | undefined;
  const spec: CommandSpec = {
    ...meta,
    run: async (ctx) => (await materializeCommand(spec)).run(ctx),
  };
  LOADERS.set(spec, () => loaded ??= load(registry));
  return spec;
}

/**
 * The full spec behind `spec`: the loaded implementation for a lazy one, `spec` itself otherwise
 * (a plugin's or the project's verb, or a spec built eagerly).
 *
 * @param spec A registered spec.
 * @returns The spec to read functions from and run.
 */
export function materializeCommand(spec: CommandSpec): Promise<CommandSpec> {
  const load = LOADERS.get(spec);
  return load ? load() : Promise.resolve(spec);
}
