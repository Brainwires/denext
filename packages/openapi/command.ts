/**
 * The `denext openapi` CLI verb, contributed by the {@linkcode openapi | openapi plugin}
 * through the plugin `addCommand` seam:
 *
 * - `denext openapi emit [--out <file>]` — print the spec (or write it) — what a CI step
 *   commits, or feeds to a client generator.
 * - `denext openapi diff <file>` — compare the current spec to a committed one; exits 1
 *   when an operation or shared schema was added, removed or changed.
 * - `denext openapi lint [--strict]` — list what could not be described (opaque schemas,
 *   plain handlers, missing summaries); `--strict` exits 1 when there is anything.
 *
 * @module
 */

import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { diffSpecs, type OpenApiBuild, type OpenApiDocument, type OpenApiWarning } from "./spec.ts";

// The denext CLI types this entrypoint's public API references (doc completeness).
export type {
  CommandContext,
  CommandSpec,
  FlagSpec,
  FlagType,
  GlobalFlags,
  PositionalSpec,
} from "@denext/denext/cli/command";

/** How the command talks to the world — injectable so tests need no process or files. */
export interface OpenapiCommandIo {
  /** Standard output. */
  log: (line: string) => void;
  /** Standard error. */
  error: (line: string) => void;
  /** Read a committed spec (for `diff`). */
  readFile: (path: string) => Promise<string>;
  /** Write the spec (for `emit --out`). */
  writeFile: (path: string, text: string) => Promise<void>;
  /** Terminate with a status (1 = findings). */
  exit: (code: number) => void;
}

const defaultIo: OpenapiCommandIo = {
  log: console.log,
  error: console.error,
  readFile: Deno.readTextFile,
  writeFile: Deno.writeTextFile,
  exit: Deno.exit,
};

/** One warning as a `route method: message` line. */
export function formatWarning(w: OpenApiWarning): string {
  const where = `${w.method ? w.method + " " : ""}${w.routePath}${w.part ? ` (${w.part})` : ""}`;
  return `${w.code.padEnd(17)} ${where}: ${w.message}`;
}

/**
 * Build the `denext openapi` command over a spec builder (the plugin supplies one bound
 * to the project's routes and options).
 *
 * @param build Produces the current document + lint warnings.
 * @param io Process I/O (defaults to the real console, filesystem and `Deno.exit`).
 */
export function createOpenapiCommand(
  build: () => Promise<OpenApiBuild>,
  io: OpenapiCommandIo = defaultIo,
): CommandSpec {
  return {
    name: "openapi",
    summary: "Emit, diff or lint the app's OpenAPI document",
    usage: [
      "Usage: denext openapi <action> [options]",
      "",
      "Actions:",
      "  emit [--out <file>]   Print the OpenAPI 3.1 document (default), or write it",
      "  diff <file>           Compare against a committed spec; exit 1 on any change",
      "  lint [--strict]       List what could not be described; --strict exits 1 if any",
    ].join("\n"),
    positionals: [
      { name: "action", help: "emit | diff | lint" },
      { name: "file", help: "the committed spec to diff against" },
    ],
    flags: [
      {
        name: "out",
        type: "string",
        help: "write the document here instead of stdout",
        valueName: "<file>",
      },
      { name: "strict", type: "boolean", help: "lint: exit 1 when there are findings" },
    ],
    run: (ctx) => runOpenapi(ctx, build, io),
  };
}

async function runOpenapi(
  ctx: CommandContext,
  build: () => Promise<OpenApiBuild>,
  io: OpenapiCommandIo,
): Promise<void> {
  const action = ctx.positionals[0] ?? "emit";
  if (action === "emit") return emit(await build(), ctx, io);
  if (action === "lint") return lint(await build(), ctx, io);
  if (action === "diff") return diff(await build(), ctx, io);
  io.error(`Unknown action "${action}". Try: denext openapi emit | diff <file> | lint`);
  throw new Error(`unknown openapi action: ${action}`);
}

async function emit(
  result: OpenApiBuild,
  ctx: CommandContext,
  io: OpenapiCommandIo,
): Promise<void> {
  const text = JSON.stringify(result.document, null, 2) + "\n";
  const out = ctx.flags.out;
  if (typeof out === "string" && out) {
    await io.writeFile(out, text);
    const n = Object.values(result.document.paths).reduce(
      (sum, item) => sum + Object.keys(item).length,
      0,
    );
    io.log(
      `Wrote ${out} (${n} operation${n === 1 ? "" : "s"}, ${result.warnings.length} warning${
        result.warnings.length === 1 ? "" : "s"
      })`,
    );
  } else {
    io.log(text.trimEnd());
  }
  if (result.warnings.length) {
    io.error(`${result.warnings.length} lint warning(s) — run \`denext openapi lint\``);
  }
}

function lint(result: OpenApiBuild, ctx: CommandContext, io: OpenapiCommandIo): void {
  if (!result.warnings.length) {
    io.log("openapi: every operation is fully described");
    return;
  }
  for (const w of result.warnings) io.log(formatWarning(w));
  io.log(`${result.warnings.length} finding(s)`);
  if (ctx.flags.strict === true) io.exit(1);
}

async function diff(
  result: OpenApiBuild,
  ctx: CommandContext,
  io: OpenapiCommandIo,
): Promise<void> {
  const file = ctx.positionals[1];
  if (!file) throw new Error("denext openapi diff needs the committed spec's path");
  const before = JSON.parse(await io.readFile(file)) as OpenApiDocument;
  const changes = diffSpecs(before, result.document);
  if (!changes.length) {
    io.log(`openapi: ${file} is up to date`);
    return;
  }
  for (const c of changes) io.log(`${c.kind.padEnd(7)} ${c.subject}`);
  io.log(
    `${changes.length} change(s) since ${file} — regenerate with \`denext openapi emit --out ${file}\``,
  );
  io.exit(1);
}
