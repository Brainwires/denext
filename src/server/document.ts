// Assemble a full HTML document around rendered page content, including <head>
// metadata and the hydration bootstrap script.

import { escapeHtml } from "../jsx/render-to-string.ts";
import type { Metadata, RobotsMetadata, Viewport } from "./types.ts";
import type { RouteParams } from "../router/segments.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { serializeFlight } from "../jsx/render-to-html-flight.ts";
import type { Messages } from "../runtime/i18n-messages.ts";
import { PUBLIC_ENV_ID } from "../runtime/public-env.ts";

/** The element id that wraps server-rendered page content for hydration. */
export const ROOT_ID = "__denext";

/** Data serialized into the page for the client runtime to hydrate with. */
export interface HydrationData {
  /** Dynamic route parameters extracted from the request path. */
  params: RouteParams;
  /** Serialized search params as a query string (without leading "?"). */
  searchParams: string;
  /** The request pathname the page was rendered for. */
  pathname: string;
  /** The active locale's message catalog, when i18n messages are configured. */
  messages?: Messages;
  /** The app's basePath (from denext.config), so client `<Link>` can prefix URLs. */
  basePath?: string;
}

/**
 * The JSON envelope for a Flight **soft navigation** response. When a client
 * navigation (`x-denext-nav`) targets a Flight route, the server sends this
 * instead of a full HTML document: the client reconstructs the tree from
 * `flight` (via the app-wide client registry), updates `document.title`, and
 * refreshes the `#__denext_data` island from `data` so route hooks re-read.
 */
export interface FlightNavPayload {
  /** The route's Flight tree, reconstructed client-side via `parseFlight`. */
  flight: FlightNode;
  /** The new document title, applied to `document.title` (omitted when unset). */
  title?: string;
  /** Hydration data for the new route (params/searchParams/messages/basePath). */
  data: HydrationData;
}

/**
 * Serialize a {@link FlightNavPayload} to JSON, escaping `<` so the payload is
 * safe to embed and consistent with {@linkcode serializeFlight}'s island form.
 */
export function serializeFlightNav(payload: FlightNavPayload): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

/** Inputs to {@linkcode renderDocument} for assembling the full HTML page. */
export interface DocumentOptions {
  /** Rendered page HTML placed inside the hydration root element. */
  bodyHtml: string;
  /** Metadata used to build the document `<head>`. */
  metadata: Metadata;
  /** Hydration payload; when present (with `clientEntry`) the page hydrates. */
  hydration?: HydrationData;
  /** URL of the client runtime entry script. */
  clientEntry?: string;
  /** Viewport/theme metadata; replaces the default `<meta name="viewport">`. */
  viewport?: Viewport;
  /** Stylesheet URLs to link in `<head>` (extracted CSS for the route). */
  styles?: string[];
  /** Extra script injected before </body> (e.g. dev live-reload). */
  devScript?: string;
  /** Document language for the `<html lang>` attribute; defaults to "en". */
  lang?: string;
  /**
   * Flight payload for a route using the client/server boundary. Embedded as a
   * `#__denext_flight` JSON island the client entry reads to hydrate its islands.
   */
  flight?: FlightNode;
  /**
   * Public (client-exposable) environment variables, embedded as a
   * `#__denext_public_env` JSON island the client `publicEnv()` reads. Only
   * public-prefixed variables are ever passed here; server-only vars never reach
   * the browser through this channel.
   */
  publicEnv?: Record<string, string>;
}

/** Render the complete HTML document as a string. */
export function renderDocument(opts: DocumentOptions): string {
  const { bodyHtml, metadata } = opts;
  const lang = opts.lang ?? "en";

  let head = renderHead(metadata, opts.viewport);
  // Extracted route stylesheets, linked after metadata so page CSS can override.
  for (const href of opts.styles ?? []) {
    head += `<link rel="stylesheet" href="${escapeHtml(href)}">`;
  }
  const rootAttrs = opts.hydration ? ` data-route="${escapeHtml(opts.hydration.pathname)}"` : "";

  let scripts = "";
  // Public env island: available to any client code, so emitted independently of
  // hydration. Only public-prefixed variables are ever present here.
  if (opts.publicEnv && Object.keys(opts.publicEnv).length > 0) {
    const envJson = JSON.stringify(opts.publicEnv).replace(/</g, "\\u003c");
    scripts += `<script id="${PUBLIC_ENV_ID}" type="application/json">${envJson}</script>`;
  }
  if (opts.hydration && opts.clientEntry) {
    const json = JSON.stringify(opts.hydration).replace(/</g, "\\u003c");
    scripts += `<script id="__denext_data" type="application/json">${json}</script>`;
    // Flight island: the reconstructed tree the client entry hydrates from.
    if (opts.flight !== undefined) {
      scripts += `<script id="__denext_flight" type="application/json">${
        serializeFlight(opts.flight)
      }</script>`;
    }
    scripts += `<script type="module" src="${escapeHtml(opts.clientEntry)}"></script>`;
  }
  if (opts.devScript) {
    scripts += `<script>${opts.devScript}</script>`;
  }

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootAttrs}>${bodyHtml}</div>${scripts}</body>
</html>`;
}

/** Resolve a possibly-relative URL against `metadataBase`. */
function resolveMetaUrl(url: string, base?: string): string {
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Serialize a robots directive (string passthrough or structured object). */
function robotsContent(robots: string | RobotsMetadata): string {
  if (typeof robots === "string") return robots;
  const parts = [
    robots.index === false ? "noindex" : "index",
    robots.follow === false ? "nofollow" : "follow",
  ];
  if (robots.noarchive) parts.push("noarchive");
  return parts.join(", ");
}

/** Build the `<meta name="viewport">` content string. */
function viewportContent(v?: Viewport): string {
  if (!v) return "width=device-width, initial-scale=1";
  const parts = [`width=${v.width ?? "device-width"}`, `initial-scale=${v.initialScale ?? 1}`];
  if (v.maximumScale !== undefined) parts.push(`maximum-scale=${v.maximumScale}`);
  if (v.userScalable === false) parts.push("user-scalable=no");
  return parts.join(", ");
}

function renderHead(metadata: Metadata, viewport?: Viewport): string {
  const base = metadata.metadataBase;
  const nameTag = (name: string, content?: string) =>
    content == null ? "" : `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
  const propTag = (property: string, content?: string) =>
    content == null
      ? ""
      : `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
  const link = (rel: string, href?: string) =>
    href == null ? "" : `<link rel="${escapeHtml(rel)}" href="${escapeHtml(href)}">`;
  const list = (v?: string | string[]) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  let head = `<meta charset="utf-8">`;
  head += `<meta name="viewport" content="${escapeHtml(viewportContent(viewport))}">`;
  head += nameTag("theme-color", viewport?.themeColor);
  head += nameTag("color-scheme", viewport?.colorScheme);

  // `title` is resolved to a string by mergeMetadata; handle the object form
  // defensively in case a title reaches here unmerged.
  const titleStr = typeof metadata.title === "string"
    ? metadata.title
    : metadata.title?.absolute ?? metadata.title?.default;
  if (titleStr !== undefined) head += `<title>${escapeHtml(titleStr)}</title>`;
  head += nameTag("description", metadata.description);
  if (metadata.keywords?.length) head += nameTag("keywords", metadata.keywords.join(", "));
  if (metadata.robots !== undefined) head += nameTag("robots", robotsContent(metadata.robots));
  if (typeof metadata.robots === "object" && metadata.robots.googleBot) {
    head += nameTag("googlebot", metadata.robots.googleBot);
  }

  // Authors.
  const authors = metadata.authors
    ? (Array.isArray(metadata.authors) ? metadata.authors : [metadata.authors])
    : [];
  for (const a of authors) {
    head += nameTag("author", a.name);
    head += link("author", a.url);
  }

  // Site verification (e.g. `google` → `google-site-verification`).
  for (const [k, v] of Object.entries(metadata.verification ?? {})) {
    head += nameTag(`${k}-site-verification`, v);
  }

  // Canonical + language alternates.
  const canonical = metadata.alternates?.canonical ?? metadata.canonical;
  if (canonical) head += link("canonical", resolveMetaUrl(canonical, base));
  for (const [lang, url] of Object.entries(metadata.alternates?.languages ?? {})) {
    head += `<link rel="alternate" hreflang="${escapeHtml(lang)}" href="${
      escapeHtml(resolveMetaUrl(url, base))
    }">`;
  }

  // Icons (shorthand + structured).
  head += link("icon", metadata.icon);
  for (const href of list(metadata.icons?.icon)) head += link("icon", href);
  for (const href of list(metadata.icons?.shortcut)) head += link("shortcut icon", href);
  for (const href of list(metadata.icons?.apple)) head += link("apple-touch-icon", href);

  // Open Graph.
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    head += propTag("og:title", og.title) + propTag("og:description", og.description) +
      propTag("og:type", og.type) + propTag("og:url", og.url) +
      propTag("og:site_name", og.siteName);
    const images = og.image === undefined ? [] : Array.isArray(og.image) ? og.image : [og.image];
    for (const img of images) {
      if (typeof img === "string") {
        head += propTag("og:image", resolveMetaUrl(img, base));
      } else {
        head += propTag("og:image", resolveMetaUrl(img.url, base));
        head += propTag("og:image:width", img.width?.toString());
        head += propTag("og:image:height", img.height?.toString());
        head += propTag("og:image:alt", img.alt);
      }
    }
  }

  // Twitter Card.
  if (metadata.twitter) {
    const t = metadata.twitter;
    head += nameTag("twitter:card", t.card) + nameTag("twitter:site", t.site) +
      nameTag("twitter:creator", t.creator) + nameTag("twitter:title", t.title) +
      nameTag("twitter:description", t.description);
    if (t.image) head += nameTag("twitter:image", resolveMetaUrl(t.image, base));
  }

  if (metadata.meta) {
    for (const [name, content] of Object.entries(metadata.meta)) head += nameTag(name, content);
  }
  if (metadata.head) {
    // L6: `metadata.head` is the one <head> sink injected verbatim (no escaping) —
    // an author-controlled escape hatch for raw tags. Warn in dev that untrusted
    // input here is an injection vector, mirroring warnDangerousHtml. Gated on
    // `__denextDev`, so production SSR pays nothing.
    if ((globalThis as { __denextDev?: boolean }).__denextDev === true) {
      console.warn(
        "denext: metadata.head is injected into <head> as raw HTML — sanitize " +
          "any untrusted input to avoid injection. (dev-only warning)",
      );
    }
    head += metadata.head;
  }
  return head;
}
