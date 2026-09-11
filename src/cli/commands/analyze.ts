// `denext analyze` — build the app, then break down the client bundle by chunk
// (sizes + proportion bars, a terminal stand-in for a treemap) so "why is my JS this
// big" is answerable at a glance. Reuses the production build and the emitted
// `.denext/client` chunks + their `.gz` siblings (same data the build summary uses).

import { join } from "@std/path";
import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { build } from "../../build/build.ts";
import {
  bundleAnalysisLines,
  type BundleMetafile,
  bundleReportMarkdown,
  bundleRoleLines,
  readClientChunks,
} from "../../build/bundle-report.ts";

/** Read the esbuild metafile `denext analyze --md` asked the build to emit, if any. */
async function readAnalyzeMeta(outDir: string): Promise<BundleMetafile | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(join(outDir, "analyze-meta.json"))) as BundleMetafile;
  } catch {
    return undefined; // native `deno bundle` path emits none, or --md wasn't set
  }
}

export const analyzeCommand: CommandSpec = {
  name: "analyze",
  summary: "Build, then break down client bundle sizes by chunk",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "md",
    type: "boolean",
    help:
      "Print a markdown bundle report (per-module breakdown on the esbuild path); pipe to a file",
  }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const md = ctx.flags.md === true;
    // For --md, ask the esbuild (compat/SPA) build to emit a metafile, and clear any stale one
    // so this run only accumulates its own outputs.
    if (md) {
      Deno.env.set("DENEXT_ANALYZE", "1");
      try {
        await Deno.remove(join(dir, ".denext", "analyze-meta.json"));
      } catch { /* none to clear */ }
    } else {
      console.log(`\n  denext analyze  ▸  ${dir}\n`);
    }
    // Under --md, keep stdout clean for `> report.md`: route the build's progress logs to
    // stderr, so only the markdown report lands on stdout.
    const origLog = console.log;
    const priorAnalyzeEnv = Deno.env.get("DENEXT_ANALYZE");
    if (md) console.log = (...args: unknown[]) => console.error(...args);
    let outDir: string;
    try {
      ({ outDir } = await build(dir));
    } finally {
      if (md) {
        console.log = origLog;
        // Restore the env so a programmatic caller running build() again in-process doesn't
        // keep capturing metafiles (the metafile capture is gated on DENEXT_ANALYZE).
        if (priorAnalyzeEnv === undefined) Deno.env.delete("DENEXT_ANALYZE");
        else Deno.env.set("DENEXT_ANALYZE", priorAnalyzeEnv);
      }
    }
    const chunks = await readClientChunks(join(outDir, "client"));
    if (md) {
      console.log(bundleReportMarkdown(chunks, await readAnalyzeMeta(outDir)).join("\n"));
      return;
    }
    if (ctx.global.json) {
      console.log(JSON.stringify(chunks, null, 2));
      return;
    }
    console.log();
    for (const line of bundleAnalysisLines(chunks)) console.log(`  ${line}`);
    const roleLines = bundleRoleLines(chunks);
    if (roleLines.length > 0) {
      console.log();
      for (const line of roleLines) console.log(`  ${line}`);
    }
    console.log();
  },
};
