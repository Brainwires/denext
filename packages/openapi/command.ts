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
 * - `denext openapi types [--out <file>]` — TypeScript types for ANOTHER project (a separate
 *   frontend): openapi-typescript-style `paths`/`components` plus denext's `ApiSchema`, so
 *   `createApiClient<ApiSchema>({ base })` from `jsr:@denext/denext` is a typed client there.
 *
 * @module
 */

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { diffSpecs, type OpenApiBuild, type OpenApiDocument, type OpenApiWarning } from "./spec.ts";
import { emitTypes } from "./types.ts";

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
    summary: "Emit, diff, lint or type the app's OpenAPI document",
    // Every action imports the route modules, so the CLI must apply its module gate first: an
    // app whose routes import an npm package resolves it only after the merged framework+app
    // config re-exec (the same gate `doctor`/`build` run under). Without this every such route
    // was a `load-failed` warning and the document had no operations.
    loadsModules: true,
    // The verb takes an action, not a directory: the project is the working directory (`--cwd`).
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    usage: [
      "Usage: denext openapi <action> [options]",
      "",
      "Actions:",
      "  emit [--out <file>]   Print the OpenAPI 3.1 document (default), or write it",
      "  diff <file>           Compare against a committed spec; exit 1 on any change",
      "  lint [--strict]       List what could not be described; --strict exits 1 if any",
      "  types [--out <file>]  TypeScript types (paths/components + a denext ApiSchema) for another project",
    ].join("\n"),
    positionals: [
      { name: "action", help: "emit | diff | lint | types" },
      { name: "file", help: "the committed spec to diff against" },
    ],
    flags: [
      {
        name: "out",
        type: "string",
        help: "emit/types: write the output here instead of stdout",
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
  if (action === "types") return types(await build(), ctx, io);
  io.error(`Unknown action "${action}". Try: denext openapi emit | diff <file> | lint | types`);
  throw new Error(`unknown openapi action: ${action}`);
}

async function emit(
  result: OpenApiBuild,
  ctx: CommandContext,
  io: OpenapiCommandIo,
): Promise<void> {
  const warnings = result.warnings.length;
  await output(
    JSON.stringify(result.document, null, 2) + "\n",
    result.document,
    ctx,
    io,
    (n) => `${n} operation${n === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
  );
  if (warnings) io.error(`${warnings} lint warning(s) — run \`denext openapi lint\``);
}

/** Write `text` to `--out` (logging a summary of the document) or print it. */
async function output(
  text: string,
  document: OpenApiDocument,
  ctx: CommandContext,
  io: OpenapiCommandIo,
  summary: (operations: number) => string,
): Promise<void> {
  const out = ctx.flags.out;
  if (typeof out === "string" && out) {
    await io.writeFile(out, text);
    io.log(`Wrote ${out} (${summary(operationCount(document))})`);
  } else {
    io.log(text.trimEnd());
  }
}

/** `types`: the TypeScript module for a consumer outside the app, to stdout or `--out`. */
async function types(
  result: OpenApiBuild,
  ctx: CommandContext,
  io: OpenapiCommandIo,
): Promise<void> {
  await output(
    emitTypes(result.document),
    result.document,
    ctx,
    io,
    (n) => `${n} operation${n === 1 ? "" : "s"}`,
  );
  const opaque = result.warnings.filter((w) => w.code === "opaque-schema").length;
  if (opaque) {
    io.error(
      `${opaque} opaque schema(s) emitted as \`unknown\` — run \`denext openapi lint\` for where`,
    );
  }
}

function operationCount(document: OpenApiDocument): number {
  return Object.values(document.paths).reduce((sum, item) => sum + Object.keys(item).length, 0);
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
