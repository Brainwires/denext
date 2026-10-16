// The `static` deploy preset: an export-only app on any static host (a CDN, an object store,
// GitHub Pages). It refuses an app with a route that needs a server — listing each one and why —
// then runs `denext export` and writes a `_headers` file (the Netlify / Cloudflare Pages format)
// into the export with the long cache content-hashed files deserve. There is no `denext deploy`
// step: upload the export with your host's own tool.

import { relative } from "@std/path";
import type { DeployAdapter, DeployContext } from "../adapter.ts";
import type { DeployManifest } from "../manifest.ts";
import { describeRoute, header, marker, serverRoutes } from "./shared.ts";

/** Options for {@linkcode staticHost}. */
export interface StaticPresetOptions {
  /** Write the `_headers` file into the export (default `true`). */
  headers?: boolean;
}

/**
 * Why a static host cannot serve this app, or `null` when it can: every route that needs a
 * server (ISR, dynamic rendering, route handlers, the middleware). Metadata routes are left out —
 * they are reported as warnings ({@linkcode staticWarnings}).
 *
 * @param manifest The deploy manifest.
 * @returns The refusal message, or `null`.
 */
export function staticRefusal(manifest: DeployManifest): string | null {
  const blocking = serverRoutes(manifest).filter((r) => !r.metadata);
  if (blocking.length === 0) return null;
  return `denext: the static preset is for export-only apps, and ${blocking.length} route(s) ` +
    `need a server:\n${blocking.map((r) => `    ${describeRoute(r)}`).join("\n")}\n` +
    "  Use a server preset (docker, fly, deno-deploy, generic-host), or make each route " +
    'static (remove the request APIs, add generateStaticParams, drop dynamic = "force-dynamic").';
}

/**
 * What still works differently on a static host: metadata routes the export does not write,
 * jobs and services that never run, and the image optimizer `<Image>` falls back from.
 *
 * @param manifest The deploy manifest.
 * @returns One line per finding.
 */
function staticWarnings(manifest: DeployManifest): string[] {
  const out: string[] = [];
  for (const r of manifest.routes.filter((r) => r.metadata)) {
    out.push(
      `static: ${r.path} (${r.source}) is served by the server; the export does not write it`,
    );
  }
  if (manifest.jobs.length) out.push("static: jobs/ never run on a static host");
  if (manifest.services.length) out.push("static: services/ never run on a static host");
  if (manifest.images.optimizer) {
    out.push("static: <Image> renders plain <img> with the raw src (no optimizer)");
  }
  return out;
}

/**
 * The `_headers` file for the export.
 *
 * @param manifest The deploy manifest.
 * @returns The file.
 */
function renderStaticHeaders(manifest: DeployManifest): string {
  const base = manifest.basePath;
  const immutable = manifest.assets.filter((a) => a.immutable).map((a) => a.urlPrefix);
  const prefixes = [...new Set(["/_denext/client/", "/_denext/fonts/", ...immutable])];
  const blocks = prefixes.map((p) =>
    `${base}${p}*\n  Cache-Control: public, max-age=31536000, immutable`
  );
  return `${header("static", "#")}
# Cache rules for hosts that read a _headers file (Netlify, Cloudflare Pages).
${blocks.join("\n")}
${base}/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;
}

/** Export, then write `_headers` into the export directory. */
async function exportWithHeaders(ctx: DeployContext, options: StaticPresetOptions): Promise<void> {
  if (ctx.dryRun) {
    ctx.log("would run denext export");
    return;
  }
  const outDir = await ctx.exportStatic();
  ctx.log(`exported to ${outDir}`);
  if (options.headers === false) return;
  const rel = relative(ctx.projectDir, outDir).replaceAll("\\", "/");
  await ctx.writeFile(`${rel}/_headers`, renderStaticHeaders(ctx.manifest), {
    in: "project",
    marker: marker("static"),
  });
}

/**
 * The static-host preset: refuse an app that needs a server, else export it with cache headers.
 *
 * @param options The preset options.
 * @returns The adapter.
 */
export function staticHost(options: StaticPresetOptions = {}): DeployAdapter {
  return {
    name: "static",
    prepare: async (ctx) => {
      const refusal = staticRefusal(ctx.manifest);
      if (refusal) throw new Error(refusal);
      for (const warning of staticWarnings(ctx.manifest)) ctx.warn(warning);
      await exportWithHeaders(ctx, options);
    },
  };
}
