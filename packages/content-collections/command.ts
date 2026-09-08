/**
 * The `denext content` CLI verb, contributed by the {@linkcode contentCollections} plugin through
 * the `addCommand` seam:
 *
 * - `denext content build` — (re)build the store + generated types (what dev/build do automatically).
 * - `denext content list` — list every collection and its entry ids.
 * - `denext content validate` — build and exit 1 if any entry fails its schema (a CI gate).
 *
 * @module
 */

import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { join, resolve } from "@std/path";
import { buildContent, type ContentBuildReport } from "./build.ts";

/** How the command talks to the world — injectable so tests need no process. */
export interface ContentCommandIo {
  /** Standard output. */
  log: (line: string) => void;
  /** Standard error. */
  error: (line: string) => void;
  /** Terminate with a status (1 = validation findings / no config). */
  exit: (code: number) => void;
}

const defaultIo: ContentCommandIo = {
  log: (l) => console.log(l),
  error: (l) => console.error(l),
  exit: (c) => Deno.exit(c),
};

/** Build the `denext content` command spec. */
export function createContentCommand(io: ContentCommandIo = defaultIo): CommandSpec {
  return {
    name: "content",
    summary: "Build, list or validate content collections",
    usage: [
      "Usage: denext content <action>",
      "",
      "  build       Rebuild the content store + generated types",
      "  list        List every collection and its entry ids",
      "  validate    Build and exit 1 if any entry fails its schema (CI gate)",
    ].join("\n"),
    positionals: [{ name: "action", help: "build | list | validate" }],
    loadsModules: true,
    // The positional is the action, not the project dir — derive it from --cwd like `denext task`.
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    run: (ctx) => runContent(ctx, io),
  };
}

/** Print a build report's per-collection counts, or its validation diagnostics. */
function printReport(report: ContentBuildReport, io: ContentCommandIo): void {
  for (const [name, count] of Object.entries(report.counts)) {
    io.log(`  ${name}: ${count} ${count === 1 ? "entry" : "entries"}`);
  }
  for (const d of report.diagnostics) {
    io.error(
      `  ✗ ${d.collection}/${d.id}${d.filePath ? ` (${d.filePath})` : ""}: ${
        d.messages.join("; ")
      }`,
    );
  }
}

async function runContent(ctx: CommandContext, io: ContentCommandIo): Promise<void> {
  const projectRoot = resolve(ctx.global.cwd ?? ".");
  const outDir = join(projectRoot, ".denext");
  const action = ctx.positionals[0] ?? "build";
  const report = await buildContent({ projectRoot, outDir });
  if (!report.configured) {
    io.error("content: no content.config.ts found in this project");
    io.exit(1);
    return;
  }

  if (action === "list") {
    try {
      const store = JSON.parse(
        await Deno.readTextFile(join(outDir, "content-data.json")),
      ) as Record<
        string,
        Array<{ id: string }>
      >;
      for (const [name, entries] of Object.entries(store)) {
        io.log(`${name} (${entries.length}):`);
        for (const e of entries) io.log(`  ${e.id}`);
      }
    } catch {
      io.error("content: no built store — run `denext content build` first");
      io.exit(1);
    }
    return;
  }

  printReport(report, io);
  if (action === "validate" && report.diagnostics.length > 0) {
    io.error(
      `content: ${report.diagnostics.length} invalid entr${
        report.diagnostics.length === 1 ? "y" : "ies"
      }`,
    );
    io.exit(1);
  }
}
