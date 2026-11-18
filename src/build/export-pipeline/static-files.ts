// Static export: the non-page outputs Next's `output: "export"` writes beside the pages — each
// route handler's GET response (`app/feed.xml/route.ts` → `feed.xml`) and the metadata file
// conventions (`sitemap.xml`, `robots.txt`, `favicon.ico`, `manifest.webmanifest`, the icon /
// Open Graph / Twitter images). Each is rendered by the same code the server answers the URL
// with, then written at that URL's path.

import { ensureDir } from "@std/fs";
import { dirname, extname, join } from "@std/path";
import type { ApiRoute, RouteManifest } from "../../router/manifest.ts";
import { fillPattern, type RouteParams } from "../../router/segments.ts";
import { handleApi } from "../../server/api.ts";
import {
  APPLE_ICON_PATH,
  ICON_PATH,
  OPENGRAPH_IMAGE_PATH,
  serveMetadataFile,
  TWITTER_IMAGE_PATH,
} from "../../server/metadata-files.ts";
import { createRequestContext, runWithContext } from "../../server/request-context.ts";
import { readSegmentConfig } from "../../server/segment-config.ts";
import type { ApiModule } from "../../server/types.ts";
import { type ExportContext, skip } from "./context.ts";

/** A code module (a generated file) vs a static convention file (copied bytes). */
const isCodeModule = (file: string): boolean => /\.(tsx|ts|jsx|js)$/i.test(file);

/**
 * The path an image convention is exported at. A static image file keeps its extension, as
 * Next writes it (`app/icon.png` → `/icon.png`), so a static host serves it with its type; a
 * generated image keeps the URL the server answers (`/opengraph-image`). The pages link the
 * same path (render.ts passes this to the metadata augmentation).
 *
 * @param manifest The route manifest.
 * @param path A served image convention URL (`/icon`, `/blog/opengraph-image`).
 * @returns The exported URL path.
 */
export function exportedImagePath(manifest: RouteManifest, path: string): string {
  const file = imageFileFor(manifest, path);
  return file && !isCodeModule(file) ? path + extname(file) : path;
}

/** The convention file behind a served image URL (root or nested), if any. */
function imageFileFor(manifest: RouteManifest, path: string): string | null | undefined {
  const roots: Record<string, string | null | undefined> = {
    [OPENGRAPH_IMAGE_PATH]: manifest.openGraphImage,
    [ICON_PATH]: manifest.icon,
    [APPLE_ICON_PATH]: manifest.appleIcon,
    [TWITTER_IMAGE_PATH]: manifest.twitterImage,
  };
  return path in roots ? roots[path] : manifest.imageRoutes?.get(path);
}

/** Write `body` to the export at URL path `pathname`, unless it would leave the export dir. */
async function writeAt(ctx: ExportContext, pathname: string, body: Uint8Array): Promise<boolean> {
  const segments = pathname.split("/").slice(1);
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    skip(ctx, pathname, "not a file path");
    return false;
  }
  const file = join(ctx.outDir, ...segments);
  await ensureDir(dirname(file));
  await Deno.writeFile(file, body);
  console.log(`  ${pathname} -> ${segments.join("/")}`);
  return true;
}

/** Render `pathname` through `respond` (in a request context) and write a 2xx body to it. */
async function exportResponse(
  ctx: ExportContext,
  pathname: string,
  target: string,
  respond: (request: Request) => Promise<Response | null>,
): Promise<void> {
  const request = new Request(`http://localhost${pathname}`);
  const res = await runWithContext(createRequestContext(request), () => respond(request));
  if (!res) return;
  if (!res.ok) {
    await res.body?.cancel();
    return skip(ctx, pathname, `answered ${res.status}`);
  }
  await writeAt(ctx, target, new Uint8Array(await res.arrayBuffer()));
}

/**
 * Pre-render every metadata file convention the app has to its file: `sitemap.xml` (and its
 * shards with `generateSitemaps`), `robots.txt`, `favicon.ico`, `manifest.webmanifest`, and the
 * icon / apple-icon / Open Graph / Twitter images (each `generateImageMetadata` variant at
 * `<path>/<id>`), root and nested. A nested image under a dynamic segment is skipped (its
 * param sets are the page's, which the export does not enumerate for images).
 */
export async function writeMetadataFiles(ctx: ExportContext): Promise<void> {
  const { manifest } = ctx;
  const serve = (path: string) => () => serveMetadataFile(manifest, path, ctx.load);
  if (manifest.sitemap) await writeSitemap(ctx);
  if (manifest.robots) {
    await exportResponse(ctx, "/robots.txt", "/robots.txt", serve("/robots.txt"));
  }
  if (manifest.favicon) {
    await exportResponse(ctx, "/favicon.ico", "/favicon.ico", serve("/favicon.ico"));
  }
  if (manifest.webManifest) {
    const path = "/manifest.webmanifest";
    await exportResponse(ctx, path, path, serve(path));
  }
  const images = [OPENGRAPH_IMAGE_PATH, ICON_PATH, APPLE_ICON_PATH, TWITTER_IMAGE_PATH]
    .filter((p) => imageFileFor(manifest, p))
    .concat([...(manifest.imageRoutes?.keys() ?? [])]);
  for (const path of images) {
    if (path.includes("[")) {
      skip(ctx, path, "an image under a dynamic segment");
      continue;
    }
    for (const variant of await imageVariants(ctx, path)) {
      const target = variant === path ? exportedImagePath(manifest, path) : variant;
      await exportResponse(ctx, variant, target, serve(variant));
    }
  }
}

/** A generated image's `generateImageMetadata` variant URLs, else just `path`. */
async function imageVariants(ctx: ExportContext, path: string): Promise<string[]> {
  const file = imageFileFor(ctx.manifest, path);
  if (!file || !isCodeModule(file)) return [path];
  const mod = (await ctx.load(file)) as {
    generateImageMetadata?: (p: { params: RouteParams }) => Promise<Array<{ id: unknown }>>;
  };
  if (typeof mod.generateImageMetadata !== "function") return [path];
  const entries = await mod.generateImageMetadata({ params: {} });
  return entries.map((e) => `${path}/${String(e.id)}`);
}

/** `sitemap.xml`, plus one `sitemap/<id>.xml` per `generateSitemaps` shard. */
async function writeSitemap(ctx: ExportContext): Promise<void> {
  const { manifest } = ctx;
  const paths = ["/sitemap.xml"];
  if (manifest.sitemap && isCodeModule(manifest.sitemap)) {
    const mod = (await ctx.load(manifest.sitemap)) as {
      generateSitemaps?: () => Promise<Array<{ id: unknown }>> | Array<{ id: unknown }>;
    };
    if (typeof mod.generateSitemaps === "function") {
      for (const s of await mod.generateSitemaps()) paths.push(`/sitemap/${String(s.id)}.xml`);
    }
  }
  for (const path of paths) {
    await exportResponse(ctx, path, path, () => serveMetadataFile(manifest, path, ctx.load));
  }
}

/**
 * Pre-render each route handler's GET to the file at its URL, as Next's `output: "export"`
 * does (`app/feed.xml/route.ts` → `feed.xml`, `app/api/hello/route.ts` → `api/hello`): only
 * GET can be answered by a static host. A route with no GET is left out; one marked
 * `dynamic = "force-dynamic"`, one under a dynamic segment without `generateStaticParams`, and
 * one whose GET fails or answers a non-2xx status are skipped (Next fails the build there; the
 * export skips them as it does such pages, and lists them).
 */
export async function writeRouteHandlers(ctx: ExportContext): Promise<void> {
  for (const route of ctx.manifest.api) {
    const mod = (await ctx.load(route.filePath)) as ApiModule & {
      generateStaticParams?: () => RouteParams[] | Promise<RouteParams[]>;
    };
    if (typeof mod.GET !== "function") continue;
    if (readSegmentConfig(mod).dynamic === "force-dynamic") {
      skip(ctx, route.routePath, 'export const dynamic = "force-dynamic"');
      continue;
    }
    const params = await handlerParamSets(route, mod);
    if (!params) {
      skip(ctx, route.routePath, "dynamic route handler without generateStaticParams");
      continue;
    }
    for (const p of params) await writeHandler(ctx, route, p);
  }
}

/** The param sets to render a route handler for, or null when it can't be enumerated. */
async function handlerParamSets(
  route: ApiRoute,
  mod: { generateStaticParams?: () => RouteParams[] | Promise<RouteParams[]> },
): Promise<RouteParams[] | null> {
  if (!route.pattern.some((s) => s.kind !== "static")) return [{}];
  if (typeof mod.generateStaticParams !== "function") return null;
  return await mod.generateStaticParams();
}

/** Render one route handler's GET for `params` to its file; a thrown error skips it. */
async function writeHandler(ctx: ExportContext, route: ApiRoute, params: RouteParams) {
  const pathname = fillPattern(route.pattern, params);
  if (pathname === "/") return skip(ctx, route.routePath, "a route handler at the root");
  try {
    await exportResponse(
      ctx,
      pathname,
      pathname,
      (request) => handleApi({ route, params }, request, ctx.load),
    );
  } catch (err) {
    skip(ctx, pathname, `GET threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
