// Generate the in-site CLI reference from the live command registry.
// Reads the SAME `buildRegistry()` + `GLOBAL_FLAGS` the `denext` binary dispatches on,
// so the docs page (apps/web /docs/cli) can never drift from `denext --help`.
//
//   deno task docs:cli      # regenerate cli.json
//   deno task docs:build    # regenerate + export the site
//
// Shape notes:
//   - Sub-verbs (`desktop run|build|package`, `plugin add|remove|list`, `patch …`,
//     `generate …`) are NOT nested here, because the registry itself is flat: the
//     framework models one verb per `CommandSpec` and a sub-verb is that spec's first
//     positional (see `src/cli/commands/desktop.ts`). We mirror the registry, so those
//     verbs carry an `action` positional and spell their sub-verbs out in `description`
//     (the spec's multi-line `usage` block). No `subcommands` key is emitted.
//   - `usage` is a single synthesized invocation line (name + positionals + `[options]`);
//     `description` is the registry's own multi-line `usage` detail block, when it has one.
//   - Plugin-contributed verbs (openapi, graphql, content, htmx) are resolved lazily from
//     a project's config and are deliberately absent.

import { GLOBAL_FLAGS } from "../src/cli/command.ts";
import type { CommandSpec, FlagSpec, PositionalSpec } from "../src/cli/command.ts";
import { buildRegistry } from "../src/cli/register.ts";

const ROOT = new URL("../", import.meta.url).pathname;
/** Where the generated reference is committed (the docs page imports it). */
export const CLI_OUT = `${ROOT}apps/web/app/docs/cli/cli.json`;

/** A flag as the docs page renders it. */
export interface RefFlag {
  name: string;
  alias?: string;
  altNames?: string[];
  type: string;
  valueName?: string;
  default?: string | number | boolean;
  description: string;
}

/** A positional argument as the docs page renders it. */
export interface RefPositional {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}

/** One built-in verb. */
export interface RefCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  description?: string;
  flags: RefFlag[];
  positionals: RefPositional[];
}

/** The generated document. */
export interface CliReference {
  globalFlags: RefFlag[];
  commands: RefCommand[];
}

/** One flag, with a stable key order regardless of which optionals are present. */
function refFlag(f: FlagSpec): RefFlag {
  return {
    name: f.name,
    ...(f.alias ? { alias: f.alias } : {}),
    ...(f.altNames?.length ? { altNames: [...f.altNames] } : {}),
    type: f.type,
    ...(f.valueName ? { valueName: f.valueName } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
    description: f.help ?? "",
  };
}

function refPositional(p: PositionalSpec): RefPositional {
  return {
    name: p.name,
    required: p.required === true,
    variadic: p.variadic === true,
    description: p.help ?? "",
  };
}

/** `denext dev [dir] [options]` — the one-line invocation shown above the tables. */
function usageLine(spec: CommandSpec): string {
  const args = (spec.positionals ?? []).map((p) => {
    const tail = p.variadic ? "..." : "";
    return p.required ? `<${p.name}${tail}>` : `[${p.name}${tail}]`;
  });
  const parts = ["denext", spec.name, ...args];
  if ((spec.flags ?? []).length > 0) parts.push("[options]");
  if (spec.passthrough) parts.push("[-- <deno args>]");
  return parts.join(" ");
}

function refCommand(spec: CommandSpec): RefCommand {
  const aliases = spec.aliases?.length ? [...spec.aliases] : undefined;
  return {
    name: spec.name,
    ...(aliases ? { aliases } : {}),
    summary: spec.summary ?? "",
    usage: usageLine(spec),
    ...(spec.usage ? { description: spec.usage } : {}),
    flags: (spec.flags ?? []).map(refFlag),
    positionals: (spec.positionals ?? []).map(refPositional),
  };
}

/** Build the reference document from the live registry (sorted by verb name). */
export function cliReference(): CliReference {
  const commands = buildRegistry().list()
    .filter((c) => !c.hidden)
    .map(refCommand)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { globalFlags: GLOBAL_FLAGS.map(refFlag), commands };
}

/** The exact bytes committed at {@linkcode CLI_OUT} (the drift test compares against this). */
export function generateCliReference(): string {
  return JSON.stringify(cliReference(), null, 2) + "\n";
}

if (import.meta.main) {
  const json = generateCliReference();
  await Deno.mkdir(new URL(".", `file://${CLI_OUT}`).pathname, { recursive: true });
  await Deno.writeTextFile(CLI_OUT, json);
  const n = JSON.parse(json).commands.length;
  console.log(`cli reference: ${n} commands → ${CLI_OUT}`);
}
