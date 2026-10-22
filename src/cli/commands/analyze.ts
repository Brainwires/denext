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
  bundleIslandLines,
  type BundleMetafile,
  bundleReportMarkdown,
  bundleRoleLines,
  readClientChunks,
} from "../../build/bundle-report.ts";
import { frameworkRoot } from "../../build/bundle.ts";
import { nativeAnalyzeMeta } from "../../build/sourcemap-attribution.ts";

/**
 * The per-module attribution `denext analyze --md` asked the build for: the esbuild metafile the
 * compat/SPA bundles wrote, merged with what the native `deno bundle` runs recorded from their
 * source maps (see sourcemap-attribution.ts). Undefined when neither has any.
 */
async function readAnalyzeMeta(
  outDir: string,
  projectDir: string,
): Promise<BundleMetafile | undefined> {
  let esbuild: BundleMetafile | undefined;
  try {
    esbuild = JSON.parse(await Deno.readTextFile(join(outDir, "analyze-meta.json")));
  } catch {
    esbuild = undefined; // the native `deno bundle` path writes none
  }
  const native = await nativeAnalyzeMeta(join(outDir, "client"), projectDir, frameworkRoot());
  if (!esbuild || !native) return esbuild ?? native;
  return { outputs: { ...native.outputs, ...esbuild.outputs } };
}

/**
 * Build the app. Under --md, keep stdout clean for `> report.md`: the build's progress logs go to
 * stderr, so only the markdown report lands on stdout.
 */
async function buildForAnalyze(dir: string, md: boolean): Promise<string> {
  const origLog = console.log;
  const priorAnalyzeEnv = Deno.env.get("DENEXT_ANALYZE");
  if (md) {
    // Ask the esbuild (compat/SPA) build to emit a metafile; read the prior value first so the
    // finally below restores the caller's environment, not this "1".
    Deno.env.set("DENEXT_ANALYZE", "1");
    console.log = (...args: unknown[]) => console.error(...args);
  }
  try {
    return (await build(dir)).outDir;
  } finally {
    if (md) {
      console.log = origLog;
      // Restore the env so a programmatic caller running build() again in-process doesn't
      // keep capturing metafiles (the metafile capture is gated on DENEXT_ANALYZE).
      if (priorAnalyzeEnv === undefined) Deno.env.delete("DENEXT_ANALYZE");
      else Deno.env.set("DENEXT_ANALYZE", priorAnalyzeEnv);
    }
  }
}

export const analyzeCommand: CommandSpec = {
  name: "analyze",
  summary: "Build, then break down client bundle sizes by chunk",
  loadsModules: true,
  // analyze runs a full build into `.denext/` (Cargo's `check` likewise locks the build dir).
  locks: (ctx) => ({ projectDir: projectDir(ctx), buildDir: "exclusive" }),
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "md",
    type: "boolean",
    help: "Print a markdown bundle report (with each chunk's top modules); pipe to a file",
  }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const md = ctx.flags.md === true;
    // For --md, clear any stale metafile so this run only accumulates its own outputs.
    if (md) {
      try {
        await Deno.remove(join(dir, ".denext", "analyze-meta.json"));
      } catch { /* none to clear */ }
    } else {
      console.log(`\n  denext analyze  ▸  ${dir}\n`);
    }
    const outDir = await buildForAnalyze(dir, md);
    const chunks = await readClientChunks(join(outDir, "client"));
    if (md) {
      console.log(bundleReportMarkdown(chunks, await readAnalyzeMeta(outDir, dir)).join("\n"));
      return;
    }
    if (ctx.global.json) {
      console.log(JSON.stringify(chunks, null, 2));
      return;
    }
    console.log();
    for (const line of bundleAnalysisLines(chunks)) console.log(`  ${line}`);
    for (const section of [bundleRoleLines(chunks), bundleIslandLines(chunks)]) {
      if (section.length === 0) continue;
      console.log();
      for (const line of section) console.log(`  ${line}`);
    }
    console.log();
  },
};
