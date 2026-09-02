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
  type BundleChunk,
  bundleRoleLines,
} from "../../build/bundle-report.ts";

/** Read the emitted `.js` chunks and their `.gz` sizes from a client output dir. */
async function readClientChunks(clientDir: string): Promise<BundleChunk[]> {
  const chunks: BundleChunk[] = [];
  try {
    for await (const e of Deno.readDir(clientDir)) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const bytes = (await Deno.stat(join(clientDir, e.name))).size;
      let gzip: number | undefined;
      try {
        gzip = (await Deno.stat(join(clientDir, e.name + ".gz"))).size;
      } catch { /* below the precompress floor — no .gz sibling */ }
      chunks.push({ name: e.name, bytes, gzip });
    }
  } catch { /* no client dir → fully static (0 KB JS) */ }
  return chunks;
}

export const analyzeCommand: CommandSpec = {
  name: "analyze",
  summary: "Build, then break down client bundle sizes by chunk",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    console.log(`\n  denext analyze  ▸  ${dir}\n`);
    const { outDir } = await build(dir);
    const chunks = await readClientChunks(join(outDir, "client"));
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
