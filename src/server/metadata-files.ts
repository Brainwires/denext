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
import { escapeHtml } from "../jsx/render-to-string.ts";

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
}

/** A sitemap: the array a `sitemap.ts` default export returns. */
export type Sitemap = SitemapEntry[];

/** Serialize sitemap entries to an XML `urlset` document. */
export function serializeSitemap(entries: Sitemap): string {
  const urls = entries.map((e) => {
    let s = `<url><loc>${escapeHtml(e.url)}</loc>`;
    if (e.lastModified !== undefined) {
      const d = e.lastModified instanceof Date
        ? e.lastModified.toISOString()
        : String(e.lastModified);
      s += `<lastmod>${escapeHtml(d)}</lastmod>`;
    }
    if (e.changeFrequency) s += `<changefreq>${e.changeFrequency}</changefreq>`;
    if (typeof e.priority === "number") s += `<priority>${e.priority}</priority>`;
    return s + "</url>";
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
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

// ---- Dispatch --------------------------------------------------------------

/** The well-known URL each metadata file is served at. */
const ROUTES: Record<string, { path: string; contentType: string }> = {
  sitemap: { path: "/sitemap.xml", contentType: "application/xml; charset=utf-8" },
  robots: { path: "/robots.txt", contentType: "text/plain; charset=utf-8" },
  webManifest: {
    path: "/manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  },
  favicon: { path: "/favicon.ico", contentType: "image/x-icon" },
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

  if (pathname === ROUTES.sitemap.path && manifest.sitemap) {
    const mod = (await load(manifest.sitemap)) as { default: () => Sitemap | Promise<Sitemap> };
    const body = serializeSitemap(await mod.default());
    return new Response(body, { headers: { "content-type": ROUTES.sitemap.contentType } });
  }

  if (pathname === ROUTES.robots.path && manifest.robots) {
    const mod = (await load(manifest.robots)) as { default: () => Robots | Promise<Robots> };
    const body = serializeRobots(await mod.default());
    return new Response(body, { headers: { "content-type": ROUTES.robots.contentType } });
  }

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
