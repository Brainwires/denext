/**
 * The `denext graphql` CLI verb, contributed by the {@linkcode graphql | graphql plugin}
 * through the plugin `addCommand` seam:
 *
 * - `denext graphql sdl [--out <file>]` — print the schema as SDL (sorted, so the output is
 *   stable and diffable), or write it — what a CI step commits or feeds to a codegen tool.
 * - `denext graphql diff <file>` — compare the current SDL to a committed one; exits 1 on
 *   any difference and prints the changed lines.
 *
 * @module
 */

import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import type { GraphQLSchema } from "graphql";
import { lexicographicSortSchema, printSchema } from "graphql";

// The denext CLI types this entrypoint's public API references (doc completeness).
export type {
  CommandContext,
  CommandSpec,
  FlagSpec,
  FlagType,
  GlobalFlags,
  PositionalSpec,
} from "@denext/denext/cli/command";

/**
 * How the command talks to the world — injectable so tests need no process or files.
 * Deliberately the same five-method shape as `@denext/openapi`'s command io (the two are
 * independently published packages, so they cannot share a module).
 */
// fallow-ignore-next-line code-duplication
export interface GraphqlCommandIo {
  /** Standard output. */
  log: (line: string) => void;
  /** Standard error. */
  error: (line: string) => void;
  /** Read a committed SDL file (for `diff`). */
  readFile: (path: string) => Promise<string>;
  /** Write the SDL (for `sdl --out`). */
  writeFile: (path: string, text: string) => Promise<void>;
  /** Terminate with a status (1 = differences). */
  exit: (code: number) => void;
}

const defaultIo: GraphqlCommandIo = {
  log: console.log,
  error: console.error,
  readFile: Deno.readTextFile,
  writeFile: Deno.writeTextFile,
  exit: Deno.exit,
};

/** The schema as sorted SDL — the same text for the same schema, whatever the build order. */
export function schemaSdl(schema: GraphQLSchema): string {
  return printSchema(lexicographicSortSchema(schema)).trimEnd() + "\n";
}

/** Lines only in `before` (`- `) and only in `after` (`+ `); empty when the texts are equal. */
export function diffSdl(before: string, after: string): string[] {
  if (before === after) return [];
  const a = before.split("\n"), b = after.split("\n");
  const inB = new Set(b), inA = new Set(a);
  return [
    ...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`),
    ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`),
  ];
}

/**
 * Build the `denext graphql` command over a schema getter (the plugin supplies one bound
 * to the project's schema).
 *
 * @param getSchema Resolves the current schema.
 * @param io Process I/O (defaults to the real console, filesystem and `Deno.exit`).
 */
export function createGraphqlCommand(
  getSchema: () => Promise<GraphQLSchema>,
  io: GraphqlCommandIo = defaultIo,
): CommandSpec {
  return {
    name: "graphql",
    summary: "Print or diff the app's GraphQL schema (SDL)",
    usage: [
      "Usage: denext graphql <action> [options]",
      "",
      "Actions:",
      "  sdl [--out <file>]   Print the schema as sorted SDL (default), or write it",
      "  diff <file>          Compare against a committed SDL; exit 1 on any change",
    ].join("\n"),
    positionals: [
      { name: "action", help: "sdl | diff" },
      { name: "file", help: "the committed SDL to diff against" },
    ],
    flags: [
      {
        name: "out",
        type: "string",
        help: "write the SDL here instead of stdout",
        valueName: "<file>",
      },
    ],
    run: (ctx) => runGraphql(ctx, getSchema, io),
  };
}

async function runGraphql(
  ctx: CommandContext,
  getSchema: () => Promise<GraphQLSchema>,
  io: GraphqlCommandIo,
): Promise<void> {
  const action = ctx.positionals[0] ?? "sdl";
  if (action === "sdl") {
    const sdl = schemaSdl(await getSchema());
    const out = ctx.flags.out;
    if (typeof out === "string" && out) {
      await io.writeFile(out, sdl);
      io.log(`Wrote ${out} (${sdl.split("\n").length - 1} lines)`);
    } else io.log(sdl.trimEnd());
    return;
  }
  if (action === "diff") {
    const file = ctx.positionals[1];
    if (!file) throw new Error("denext graphql diff needs the committed SDL's path");
    const changes = diffSdl(await io.readFile(file), schemaSdl(await getSchema()));
    if (!changes.length) {
      io.log(`graphql: ${file} is up to date`);
      return;
    }
    for (const line of changes) io.log(line);
    io.log(
      `${changes.length} changed line(s) since ${file} — regenerate with \`denext graphql sdl --out ${file}\``,
    );
    io.exit(1);
    return;
  }
  io.error(`Unknown action "${action}". Try: denext graphql sdl | diff <file>`);
  throw new Error(`unknown graphql action: ${action}`);
}
