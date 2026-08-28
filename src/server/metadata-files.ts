// Metadata file conventions (Next.js `app/sitemap.ts`, `robots.ts`, `manifest.ts`,
// `favicon.ico`). Each is a small module whose default export produces the file,
// served at a well-known URL:
//
//   app/sitemap.ts   -> GET /sitemap.xml            (application/xml)
//   app/robots.ts    -> GET /robots.txt             (text/plain)
//   app/manifest.ts  -> GET /manifest.webmanifest   (application/manifest+json)
//   app/favicon.ico  -> GET /favicon.ico            (image/x-icon)

import type { RouteManifest } from "../router/manifest.ts";
import type { ModuleLoader } from "./types.ts";
import type { VNode } from "../jsx/types.ts";
import { escapeHtml, renderToString } from "../jsx/render-to-string.ts";
import { contentType } from "@std/media-types";
import { extname } from "@std/path";

// ---- Sitemap ---------------------------------------------------------------

/** One entry in a sitemap (Next.js `MetadataRoute.Sitemap` element). */
export interface SitemapEntry {
  /** Absolute URL of the page. */
  url: string;
  /** Last modification time (Date or ISO string). */
  lastModified?: string | Date;
  /** How frequently the page changes. */
  changeFrequency?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  /** Priority relative to other URLs (0.0–1.0). */
  priority?: number;
  /**
   * Per-URL language alternates (`hreflang` → URL), emitted as `<xhtml:link>`
   * inside this `<url>` (Google's sitemap i18n convention). Pairs with the
   * automatic in-document hreflang so a sitemap can carry the same alternates.
   */
  alternates?: { languages: Record<string, string> };
}

/** A sitemap: the array a `sitemap.ts` default export returns. */
export type Sitemap = SitemapEntry[];

/** One entry in a sitemap index (a reference to a child sitemap). */
export interface SitemapIndexEntry {
  /** Absolute URL of the child sitemap (e.g. `https://x.com/sitemap/0.xml`). */
  url: string;
  /** Last modification time of the child sitemap. */
  lastModified?: string | Date;
}

/** The shape of a `sitemap.ts` module, optionally sharded via `generateSitemaps`. */
export interface SitemapModule {
  /** Produce the entries; receives `{ id }` for the matching shard when sharded. */
  default: (props?: { id: number | string }) => Sitemap | Promise<Sitemap>;
  /**
   * Next.js `generateSitemaps` — enumerate the shards. When present, `/sitemap.xml`
   * serves a sitemap *index* pointing at `/sitemap/{id}.xml`, and each shard calls
   * `default({ id })`.
   */
  generateSitemaps?: () =>
    | Array<{ id: number | string }>
    | Promise<Array<{ id: number | string }>>;
}

/** ISO-serialize a `lastModified` value. */
function lastmod(v: string | Date): string {
  return escapeHtml(v instanceof Date ? v.toISOString() : String(v));
}

/** Serialize sitemap entries to an XML `urlset` document. */
export function serializeSitemap(entries: Sitemap): string {
  let hasAlternates = false;
  const urls = entries.map((e) => {
    let s = `<url><loc>${escapeHtml(e.url)}</loc>`;
    if (e.lastModified !== undefined) s += `<lastmod>${lastmod(e.lastModified)}</lastmod>`;
    if (e.changeFrequency) s += `<changefreq>${e.changeFrequency}</changefreq>`;
    if (typeof e.priority === "number") s += `<priority>${e.priority}</priority>`;
    for (const [lang, href] of Object.entries(e.alternates?.languages ?? {})) {
      hasAlternates = true;
      s += `<xhtml:link rel="alternate" hreflang="${escapeHtml(lang)}" href="${
        escapeHtml(href)
      }"/>`;
    }
    return s + "</url>";
  }).join("");
  // Declare the xhtml namespace only when an entry actually uses it.
  const xhtmlNs = hasAlternates ? ` xmlns:xhtml="http://www.w3.org/1999/xhtml"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtmlNs}>${urls}</urlset>`;
}

/** Serialize a sitemap index (`<sitemapindex>`) pointing at child sitemaps. */
export function serializeSitemapIndex(items: SitemapIndexEntry[]): string {
  const entries = items.map((it) => {
    let s = `<sitemap><loc>${escapeHtml(it.url)}</loc>`;
    if (it.lastModified !== undefined) s += `<lastmod>${lastmod(it.lastModified)}</lastmod>`;
    return s + "</sitemap>";
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

// ---- Robots ----------------------------------------------------------------

/** A single robots rule group. */
export interface RobotsRule {
  /** User-agent(s) the rule applies to (defaults to `*`). */
  userAgent?: string | string[];
  /** Path(s) to allow. */
  allow?: string | string[];
  /** Path(s) to disallow. */
  disallow?: string | string[];
  /** Crawl delay in seconds. */
  crawlDelay?: number;
}

/** A robots config: the object a `robots.ts` default export returns. */
export interface Robots {
  /** One rule group, or several. */
  rules: RobotsRule | RobotsRule[];
  /** Sitemap URL(s) to advertise. */
  sitemap?: string | string[];
  /** Preferred host. */
  host?: string;
}

/** Serialize a robots config to `robots.txt` text. */
export function serializeRobots(robots: Robots): string {
  const lines: string[] = [];
  const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
  for (const rule of rules) {
    const agents = toArray(rule.userAgent ?? "*");
    for (const ua of agents) lines.push(`User-Agent: ${ua}`);
    for (const a of toArray(rule.allow)) lines.push(`Allow: ${a}`);
    for (const d of toArray(rule.disallow)) lines.push(`Disallow: ${d}`);
    if (typeof rule.crawlDelay === "number") lines.push(`Crawl-delay: ${rule.crawlDelay}`);
    lines.push("");
  }
  for (const s of toArray(robots.sitemap)) lines.push(`Sitemap: ${s}`);
  if (robots.host) lines.push(`Host: ${robots.host}`);
  return lines.join("\n").trimEnd() + "\n";
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// ---- Dynamic OG image ------------------------------------------------------

/**
 * What an `opengraph-image` module's default export may return:
 *
 * - a **VNode** (an `<svg>` tree) — serialized to `image/svg+xml` by the
 *   framework (no rasterizer dependency);
 * - a **`Uint8Array`** of raw image bytes (served as `image/png` by default —
 *   the bring-your-own-rasterizer escape hatch);
 * - a **`Response`** — returned verbatim, so the module controls status,
 *   `content-type`, and caching headers.
 */
export type OpenGraphImageResult = VNode | Uint8Array | Response;

/**
 * Serialize an SVG VNode to a standalone `image/svg+xml` document (XML prolog +
 * rendered markup). Rendered without the metadata head-collector so an in-SVG
 * `<title>` is preserved inline rather than hoisted.
 *
 * @param node The `<svg>` VNode to serialize.
 * @returns The SVG document text.
 */
export async function serializeSvg(node: VNode): Promise<string> {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${await renderToString(node)}`;
}

/** Build the HTTP response for an {@linkcode OpenGraphImageResult}. */
async function openGraphImageResponse(result: OpenGraphImageResult): Promise<Response> {
  if (result instanceof Response) return result;
  if (result instanceof Uint8Array) {
    // `Uint8Array<ArrayBufferLike>` narrows wider than `BodyInit`; the bytes are
    // a valid body, so assert the view type.
    return new Response(result as BodyInit, { headers: { "content-type": "image/png" } });
  }
  return new Response(await serializeSvg(result), {
    headers: { "content-type": ROUTES.openGraphImage.contentType },
  });
}

// ---- Dispatch --------------------------------------------------------------

/** The well-known URL the dynamic `opengraph-image` module is served at. */
export const OPENGRAPH_IMAGE_PATH = "/opengraph-image";
/** The well-known URL the `icon` convention is served at. */
export const ICON_PATH = "/icon";
/** The well-known URL the `apple-icon` convention is served at. */
export const APPLE_ICON_PATH = "/apple-icon";
/** The well-known URL the `twitter-image` convention is served at. */
export const TWITTER_IMAGE_PATH = "/twitter-image";

/** Serve a metadata image convention: a static file (bytes) or a dynamic module. */
async function serveImageConvention(
  filePath: string,
  load: ModuleLoader,
): Promise<Response | null> {
  // Dynamic module: load it and dispatch on its default export's result.
  if (/\.(tsx|ts|jsx|js)$/i.test(filePath)) {
    const mod = (await load(filePath)) as {
      default: () => OpenGraphImageResult | Promise<OpenGraphImageResult>;
    };
    return openGraphImageResponse(await mod.default());
  }
  // Static image file: serve the bytes with a content-type from its extension.
  try {
    const bytes = await Deno.readFile(filePath);
    const type = contentType(extname(filePath)) ?? "application/octet-stream";
    return new Response(bytes, { headers: { "content-type": type } });
  } catch {
    return null;
  }
}

/** Matches a sharded sitemap URL `/sitemap/{id}.xml`, capturing the id. */
const SITEMAP_SHARD_RE = /^\/sitemap\/([^/]+)\.xml$/;

/** The well-known URL each metadata file is served at. */
const ROUTES: Record<string, { path: string; contentType: string }> = {
  sitemap: { path: "/sitemap.xml", contentType: "application/xml; charset=utf-8" },
  robots: { path: "/robots.txt", contentType: "text/plain; charset=utf-8" },
  webManifest: {
    path: "/manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  },
  favicon: { path: "/favicon.ico", contentType: "image/x-icon" },
  openGraphImage: { path: OPENGRAPH_IMAGE_PATH, contentType: "image/svg+xml; charset=utf-8" },
};

/**
 * Serve a metadata file if `pathname` matches one of the conventions and the
 * corresponding file exists in the manifest; otherwise return null.
 *
 * @param manifest The scanned route manifest.
 * @param pathname The request pathname.
 * @param load The module loader (for the code-based conventions).
 * @returns A Response, or null when this request is not a metadata file.
 */
export async function serveMetadataFile(
  manifest: RouteManifest,
  pathname: string,
  load: ModuleLoader,
  origin?: string,
): Promise<Response | null> {
  if (pathname === ROUTES.favicon.path && manifest.favicon) {
    try {
      const bytes = await Deno.readFile(manifest.favicon);
      return new Response(bytes, {
        headers: { "content-type": ROUTES.favicon.contentType },
      });
    } catch {
      return null;
    }
  }

  // Sitemap — either the single `/sitemap.xml` or, when the module exports
  // `generateSitemaps`, a `/sitemap.xml` index over `/sitemap/{id}.xml` shards.
  const shard = pathname.match(SITEMAP_SHARD_RE);
  if (manifest.sitemap && (pathname === ROUTES.sitemap.path || shard)) {
    const sitemapXml = (body: string) =>
      new Response(body, { headers: { "content-type": ROUTES.sitemap.contentType } });
    const mod = (await load(manifest.sitemap)) as SitemapModule;
    if (typeof mod.generateSitemaps === "function") {
      const shards = await mod.generateSitemaps();
      if (pathname === ROUTES.sitemap.path) {
        // The index: one <sitemap> per shard, absolute when an origin is known.
        const base = origin ?? "";
        const items = shards.map((s) => ({ url: `${base}/sitemap/${s.id}.xml` }));
        return sitemapXml(serializeSitemapIndex(items));
      }
      // A shard: /sitemap/{id}.xml — only ids `generateSitemaps` enumerated.
      const match = shards.find((s) => String(s.id) === shard![1]);
      if (!match) return null;
      return sitemapXml(serializeSitemap(await mod.default({ id: match.id })));
    }
    // Not sharded: only the canonical /sitemap.xml serves; shard URLs 404.
    if (pathname === ROUTES.sitemap.path) {
      return sitemapXml(serializeSitemap(await mod.default()));
    }
    return null;
  }

  if (pathname === ROUTES.robots.path && manifest.robots) {
    const mod = (await load(manifest.robots)) as { default: () => Robots | Promise<Robots> };
    const body = serializeRobots(await mod.default());
    return new Response(body, { headers: { "content-type": ROUTES.robots.contentType } });
  }

  if (pathname === ROUTES.openGraphImage.path && manifest.openGraphImage) {
    const mod = (await load(manifest.openGraphImage)) as {
      default: () => OpenGraphImageResult | Promise<OpenGraphImageResult>;
    };
    return openGraphImageResponse(await mod.default());
  }

  if (pathname === ICON_PATH && manifest.icon) {
    return serveImageConvention(manifest.icon, load);
  }
  if (pathname === APPLE_ICON_PATH && manifest.appleIcon) {
    return serveImageConvention(manifest.appleIcon, load);
  }
  if (pathname === TWITTER_IMAGE_PATH && manifest.twitterImage) {
    return serveImageConvention(manifest.twitterImage, load);
  }

  // Nested (per-route) opengraph-image / twitter-image at their served URL paths.
  const nested = manifest.imageRoutes?.get(pathname);
  if (nested) return serveImageConvention(nested, load);

  if (pathname === ROUTES.webManifest.path && manifest.webManifest) {
    const mod = (await load(manifest.webManifest)) as {
      default: () => unknown | Promise<unknown>;
    };
    const body = JSON.stringify(await mod.default());
    return new Response(body, {
      headers: { "content-type": ROUTES.webManifest.contentType },
    });
  }

  return null;
}
