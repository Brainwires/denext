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
import type { ApiModule } from "../../server/types.ts";
import { type ExportContext, exportFileSegments, skip } from "./context.ts";

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
  const segments = exportFileSegments(pathname);
  if (!segments || segments.length === 0) {
    skip(ctx, pathname, "not a file path");
    return false;
  }
  const file = join(ctx.outDir, ...segments);
  await ensureDir(dirname(file));
  await Deno.writeFile(file, body);
  console.log(`  ${pathname} -> ${segments.join("/")}`);
  return true;
}

/** How long one exported response (its module import, its handler and its body) may take. */
const DEFAULT_RESPONSE_DEADLINE_MS = 30_000;

/**
 * The per-response deadline: `DENEXT_EXPORT_RESPONSE_TIMEOUT_MS` when it is a positive number,
 * else 30 s.
 */
function responseDeadlineMs(): number {
  const raw = Number(Deno.env.get("DENEXT_EXPORT_RESPONSE_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESPONSE_DEADLINE_MS;
}

/** Thrown when an exported response misses its deadline. */
class ExportDeadlineError extends Error {
  constructor(ms: number) {
    super(`did not finish within ${ms} ms`);
  }
}

/**
 * Run `work` under the response deadline: `signal` aborts when it passes, and the returned
 * promise rejects with an `ExportDeadlineError` even if `work` ignores the signal.
 */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ms = responseDeadlineMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ExportDeadlineError(ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render `pathname` through `respond` (in a request context, under the response deadline) and
 * write a 2xx body to it. A stream (`text/event-stream`) is never a file: it is skipped.
 */
async function exportResponse(
  ctx: ExportContext,
  pathname: string,
  target: string,
  respond: (request: Request) => Promise<Response | null>,
): Promise<void> {
  const body = await withDeadline(async (signal) => {
    const request = new Request(`http://localhost${pathname}`, { signal });
    const res = await runWithContext(createRequestContext(request), () => respond(request));
    if (!res) return null;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      skip(ctx, pathname, `answered ${res.status}`);
      return null;
    }
    if (/^text\/event-stream\b/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      skip(ctx, pathname, "answered an event stream");
      return null;
    }
    signal.addEventListener("abort", () => res.body?.cancel().catch(() => {}), { once: true });
    return new Uint8Array(await res.arrayBuffer());
  });
  if (body) await writeAt(ctx, target, body);
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

/**
 * A `generateImageMetadata` / `generateSitemaps` id as the one URL segment it names, or `null`
 * when it can't be one: empty, a dot segment, or holding a path separator of either kind, a
 * percent sign or a NUL (each would make the exported file name differ from the id, on some OS
 * name another folder). Such an id is skipped and listed.
 *
 * @param id The id the app returned.
 * @returns The segment, or `null`.
 */
export function metadataIdSegment(id: unknown): string | null {
  const s = String(id);
  return s === "" || s === "." || s === ".." || /[/\\%\0]/.test(s) ? null : s;
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
  const out: string[] = [];
  for (const e of entries) {
    const id = metadataIdSegment(e.id);
    if (id === null) skip(ctx, `${path}/${String(e.id)}`, "an id that is not one path segment");
    else out.push(`${path}/${id}`);
  }
  return out;
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
      for (const s of await mod.generateSitemaps()) {
        const id = metadataIdSegment(s.id);
        if (id === null) {
          skip(ctx, `/sitemap/${String(s.id)}.xml`, "an id that is not one path segment");
        } else paths.push(`/sitemap/${id}.xml`);
      }
    }
  }
  for (const path of paths) {
    await exportResponse(ctx, path, path, () => serveMetadataFile(manifest, path, ctx.load));
  }
}

/**
 * Pre-render each static route handler's GET to the file at its URL, as Next's `output:
 * "export"` does (`app/feed.xml/route.ts` → `feed.xml`, `app/api/hello/route.ts` →
 * `api/hello`): only GET can be answered by a static host, and only a handler marked static —
 * `export const dynamic = "force-static"`, or an `export const revalidate` of `false` or a
 * positive number — is pre-rendered (Next requires the same and fails the build otherwise).
 *
 * A route with no GET is left out without being imported. Everything else that can't be
 * exported is skipped and listed (where Next fails the build), never aborting the export: a
 * GET that isn't marked static (its module isn't even imported when its source declares no
 * `dynamic` / `revalidate`), `dynamic = "force-dynamic"`, a module that fails to import, a
 * dynamic segment without `generateStaticParams` or one that throws, and a GET that throws,
 * answers a non-2xx status or an event stream, or misses the response deadline (30 s,
 * `DENEXT_EXPORT_RESPONSE_TIMEOUT_MS`).
 */
export async function writeRouteHandlers(ctx: ExportContext): Promise<void> {
  for (const route of ctx.manifest.api) {
    const mod = await loadStaticHandler(ctx, route);
    if (!mod) continue;
    let params: RouteParams[] | null;
    try {
      params = await withDeadline(() => handlerParamSets(route, mod));
    } catch (err) {
      skip(ctx, route.routePath, `generateStaticParams failed: ${errorText(err)}`);
      continue;
    }
    if (!params) {
      skip(ctx, route.routePath, "dynamic route handler without generateStaticParams");
      continue;
    }
    for (const p of params) await writeHandler(ctx, route, p);
  }
}

type HandlerModule = ApiModule & {
  generateStaticParams?: () => RouteParams[] | Promise<RouteParams[]>;
  dynamic?: unknown;
  revalidate?: unknown;
};

const NOT_STATIC = 'not marked static (export const dynamic = "force-static")';

/**
 * The route module when it exports a GET marked static; else null, after listing it as skipped
 * when it has a GET (or might: its source names one) that can't be exported.
 */
async function loadStaticHandler(
  ctx: ExportContext,
  route: ApiRoute,
): Promise<HandlerModule | null> {
  // The source decides what is worth importing: a module whose text has no `GET` has no GET
  // handler, and one that never names `dynamic` / `revalidate` can't be marked static. Neither
  // is imported, so a POST-only route whose imports need the server's environment never runs.
  const source = await Deno.readTextFile(route.filePath).catch(() => null);
  if (source !== null && !/\bGET\b/.test(source)) return null;
  if (source !== null && !/\b(dynamic|revalidate)\b/.test(source)) {
    skip(ctx, route.routePath, NOT_STATIC);
    return null;
  }
  let mod: HandlerModule;
  try {
    mod = (await withDeadline(() => ctx.load(route.filePath))) as HandlerModule;
  } catch (err) {
    skip(ctx, route.routePath, `module failed to load: ${errorText(err)}`);
    return null;
  }
  if (typeof mod.GET !== "function") return null;
  if (mod.dynamic === "force-dynamic") {
    skip(ctx, route.routePath, 'export const dynamic = "force-dynamic"');
    return null;
  }
  if (!isStaticHandler(mod)) {
    skip(ctx, route.routePath, NOT_STATIC);
    return null;
  }
  return mod;
}

/** Whether a route module marks its GET static, as Next's static export requires. */
function isStaticHandler(mod: HandlerModule): boolean {
  if (mod.dynamic === "force-static") return true;
  return mod.revalidate === false || (typeof mod.revalidate === "number" && mod.revalidate > 0);
}

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

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
  console.log(`  GET ${pathname} (${route.routePath})`);
  try {
    await exportResponse(
      ctx,
      pathname,
      pathname,
      (request) => handleApi({ route, params }, request, ctx.load),
    );
  } catch (err) {
    const why = err instanceof ExportDeadlineError ? "GET" : "GET threw:";
    skip(ctx, pathname, `${why} ${errorText(err)}`);
  }
}
