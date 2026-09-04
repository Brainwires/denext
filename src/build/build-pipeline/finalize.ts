// Production build, stage 4: public-env tree-shaking, self-hosted fonts, the build
// manifest, precompression, the atomic client swap, typed modules, and the size summary.

import { walk } from "@std/fs";
import { join } from "@std/path";
import { collectedFontEntries, resetFonts } from "../../compat/next/font/registry.ts";
import { extractPublicEnvRefs } from "../../runtime/public-env.ts";
import { defaultLoader } from "../../server/mod.ts";
import { type BundleChunk, bundleSummaryLines } from "../bundle-report.ts";
import { emitTypedModules } from "../emit-typed-modules.ts";
import { precompressDir } from "../precompress.ts";
import { FONTS_PUBLIC_PREFIX, selfHostFonts } from "../self-host-fonts.ts";
import { type BuildContext, log } from "./context.ts";

/**
 * Public-env tree-shaking: scan the built client bundles for the
 * `NEXT_PUBLIC_`/`DENEXT_PUBLIC_` vars they actually reference, so the page ships ONLY
 * those in its public-env island (not every prefixed var). A key accessed only via a
 * computed expression isn't seen here — force-include it via the `publicEnv` allowlist.
 */
async function collectPublicEnvKeys(clientDir: string): Promise<string[]> {
  const keys = new Set<string>();
  for await (const entry of walk(clientDir, { exts: [".js"] })) {
    for (const k of extractPublicEnvRefs(await Deno.readTextFile(entry.path))) keys.add(k);
  }
  return [...keys].sort();
}

/**
 * Self-host `next/font/google` fonts (Next parity): execute each page + layout module so
 * its top-level `googleFont()` declarations register, discover the Google stylesheet
 * URLs, and download them locally so the browser never requests fonts from Google. A
 * module that can't load at build (needs a request context, etc.) is skipped — its
 * fonts fall back to a runtime <link>, as does a font that can't be fetched (offline
 * build). Emitted into the staged client dir so the atomic swap brings the files in.
 */
async function selfHostPageFonts(ctx: BuildContext): Promise<Record<string, string>> {
  resetFonts();
  const fontModules = new Set<string>();
  for (const p of ctx.manifest.pages) {
    fontModules.add(p.filePath);
    for (const layout of p.layoutChain) fontModules.add(layout);
  }
  for (const fp of fontModules) {
    try {
      await defaultLoader(fp);
    } catch { /* module needs a request context / failed to load → skip its fonts */ }
  }
  const fontEntries = collectedFontEntries().map(([url, meta]) => ({ url, subsets: meta.subsets }));
  const fontManifest = fontEntries.length > 0
    ? await selfHostFonts(fontEntries, join(ctx.clientDir, "_fonts"), FONTS_PUBLIC_PREFIX)
    : {};
  resetFonts();
  return fontManifest;
}

/** The `manifest.json` document the prod server reads. */
function buildManifestFor(
  ctx: BuildContext,
  publicEnvKeys: string[],
  fonts: Record<string, string>,
) {
  return {
    version: 1,
    generatedRoutes: ctx.routes,
    flight: ctx.hasFlight,
    boundaryRoutes: ctx.boundaryRoutes.map((p) => p.routePath),
    // Routes that ship no client JS (pure server-rendered HTML). The prod server reads
    // this to skip both the hydration <script> and the missing-bundle check.
    staticRoutes: ctx.staticRoutes,
    pages: ctx.manifest.pages.map((p) => p.routePath),
    api: ctx.manifest.api.map((a) => a.routePath),
    // next-compat: routes rendered via react→denext server bundles, and the
    // source-module → server-bundle map (paths relative to outDir) the prod server
    // rebuilds the loader from.
    nextCompat: ctx.compat,
    compatServerModules: ctx.compatServerModules,
    // The public-env vars the client bundles reference — the prod server ships only
    // these (∪ the `publicEnv` config allowlist) in each page's env island.
    publicEnvKeys,
    // Self-hosted Google fonts: Google stylesheet URL → local `@font-face` CSS. The prod
    // server installs this so those fonts render from `/_denext/fonts`.
    fonts,
  };
}

/**
 * Precompress the staged client assets (so `denext start` serves gzip with no per-request
 * CPU), atomically swap staging into `client/` (a same-filesystem rename, so `denext
 * start` never observes a half-written directory), then write `manifest.json` via a temp
 * file + rename so a reader never sees a partial document.
 */
async function swapAndWriteManifest(ctx: BuildContext, manifest: unknown): Promise<void> {
  const gzCount = await precompressDir(ctx.clientDir);
  if (gzCount > 0) log(`precompressed ${gzCount} client asset(s) -> .gz`);
  await Deno.remove(ctx.finalClientDir, { recursive: true }).catch(() => {});
  await Deno.rename(ctx.clientDir, ctx.finalClientDir);
  const manifestPath = join(ctx.paths.outDir, "manifest.json");
  const manifestTmp = `${manifestPath}.tmp`;
  await Deno.writeTextFile(manifestTmp, JSON.stringify(manifest, null, 2));
  await Deno.rename(manifestTmp, manifestPath);
}

/** Size + gzip size of every `.js` in the final client dir (`.gz` siblings from precompress). */
async function clientChunks(finalClientDir: string): Promise<BundleChunk[]> {
  const chunks: BundleChunk[] = [];
  try {
    for await (const e of Deno.readDir(finalClientDir)) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const bytes = (await Deno.stat(join(finalClientDir, e.name))).size;
      let gzip: number | undefined;
      try {
        gzip = (await Deno.stat(join(finalClientDir, e.name + ".gz"))).size;
      } catch { /* no .gz (below the precompress floor) */ }
      chunks.push({ name: e.name, bytes, gzip });
    }
  } catch { /* no client dir → fully static */ }
  return chunks;
}

/** Bundle-size summary — the "0 KB by default / small bundles" story, made visible. */
async function summarizeBundles(ctx: BuildContext): Promise<void> {
  const chunks = await clientChunks(ctx.finalClientDir);
  for (
    const line of bundleSummaryLines(ctx.manifest.pages.length, ctx.staticRoutes.length, chunks)
  ) {
    log(line);
  }
}

/**
 * Finish the build: manifest inputs (public env, fonts), the atomic swap + manifest write,
 * typed modules (`<outDir>/routes.ts` + `api.ts`, best-effort), then plugin build steps
 * (after the swap so they can emit into the final output dir) and the size summary.
 */
export async function finalizeBuild(
  ctx: BuildContext,
  pluginBuildSteps: () => Promise<void>,
): Promise<void> {
  const publicEnvKeys = await collectPublicEnvKeys(ctx.clientDir);
  const fonts = await selfHostPageFonts(ctx);
  await swapAndWriteManifest(ctx, buildManifestFor(ctx, publicEnvKeys, fonts));
  await emitTypedModules(ctx.manifest, {
    outDir: ctx.paths.outDir,
    configPath: ctx.paths.configPath,
  });
  await pluginBuildSteps();
  await summarizeBundles(ctx);
}
