// Every first-party verb's description (its name, summary, usage text, flags and positionals),
// read from the packed table scripts/gen-command-table.ts writes (command-meta.packed.ts).
//
// The readable text lives in src/cli/commands/meta/<module>.ts, which is not published: the
// generator packs it, and each verb's spec spreads `commandMeta("<verb>")` beside its `run`, so
// the help text ships once, compressed. Edit a verb's help there, then run
// `deno task gen:command-table` (or `deno task regen`).

import { lazyPack } from "../build/packed-text.ts";
import { CLI_COMMANDS_BROTLI_BASE64 } from "./command-meta.packed.ts";
import type { CommandMeta } from "./lazy-command.ts";

const pack = lazyPack(CLI_COMMANDS_BROTLI_BASE64);

let byName: Map<string, CommandMeta> | undefined;

/**
 * Every first-party verb's description, in registry order (decoded on the first call).
 *
 * @returns The descriptions.
 */
export function commandMetas(): readonly CommandMeta[] {
  return pack().COMMANDS as readonly CommandMeta[];
}

/**
 * The description of the first-party verb `name`: what its spec spreads beside its functions.
 * A verb the packed table does not list yet (one added since `deno task gen:command-table` last
 * ran) gets its name alone; the table's drift test fails until it is regenerated.
 *
 * @param name The verb.
 * @returns Its description.
 */
export function commandMeta(name: string): CommandMeta {
  byName ??= new Map(commandMetas().map((meta) => [meta.name, meta]));
  return byName.get(name) ?? { name, summary: "" };
}
