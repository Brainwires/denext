// Assemble a full HTML document around rendered page content, including <head>
// metadata and the hydration bootstrap script.

import { escapeHtml } from "../jsx/render-to-string.ts";
import type { Metadata, RobotsMetadata, Viewport } from "./types.ts";
import type { RouteParams } from "../router/segments.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { type IslandPayload, serializeFlight } from "../jsx/render-to-html-flight.ts";
import type { Messages } from "../runtime/i18n-messages.ts";
import { PUBLIC_ENV_ID } from "../runtime/public-env.ts";
import { type ShellRender, SWAP_RUNTIME } from "../jsx/render-to-stream.ts";
import type { ResumedHole } from "../jsx/render-to-ppr.ts";

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
  /**
   * Lazy (`client:*`/resumable) islands of the new route — each island's own Flight
   * keyed by id — so a soft nav can render and wire them up (they ride the route
   * Flight only as empty foreign hosts). Omitted when the route has none.
   */
  islands?: IslandPayload[];
  /** Serialized signal state for the new route's islands. Omitted when none. */
  signalState?: Record<string, unknown>;
}

/**
 * The JSON envelope for an **isomorphic** (non-Flight) soft navigation. Such a route
 * re-renders from its own re-run bundle on a soft nav, so the server-rendered `<body>`
 * would be discarded — the client only needs the title, hydration data, the route's
 * stylesheet hrefs, and the entry module src. Sending just those (instead of the full
 * HTML document) is the isomorphic analogue of {@link FlightNavPayload}.
 */
export interface IsoNavPayload {
  /** The new document title, applied to `document.title` (omitted when unset). */
  title?: string;
  /** Hydration data for the new route (params/searchParams/messages/basePath). */
  data: HydrationData;
  /** The route's client entry module src, re-injected to re-render the new route. */
  entry: string;
  /** The new route's stylesheet hrefs, swapped in place of the old route's. */
  styles?: string[];
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
  /**
   * URL of an external same-origin script to inject before `</body>` (dev
   * live-reload). Preferred over {@link devScript} because an external
   * `<script src>` is covered by `script-src 'self'` — an inline script would trip
   * the strict CSP.
   */
  devScriptSrc?: string;
  /** Document language for the `<html lang>` attribute; defaults to "en". */
  lang?: string;
  /**
   * Flight payload for a route using the client/server boundary. Embedded as a
   * `#__denext_flight` JSON island the client entry reads to hydrate its islands.
   */
  flight?: FlightNode;
  /**
   * Lazy (`client:*`) islands, embedded as a `#__denext_islands` JSON island
   * (`{ [treePathId]: islandFlight }`). The client entry hydrates each on its
   * strategy instead of at load.
   */
  islands?: IslandPayload[];
  /**
   * Serialized signal state (`useId → value`), embedded as a `#__denext_state`
   * JSON island the client adopts before hydration (resumability).
   */
  signalState?: Record<string, unknown>;
  /**
   * Public (client-exposable) environment variables, embedded as a
   * `#__denext_public_env` JSON island the client `publicEnv()` reads. Only
   * public-prefixed variables are ever passed here; server-only vars never reach
   * the browser through this channel.
   */
  publicEnv?: Record<string, string>;
}

/** Render the complete HTML document as a string. */
/**
 * Render the `<head>` **inner** content (metadata + route stylesheet links). This
 * is the exact head {@link renderDocument} embeds; exposed so a PPR cache hit can
 * rebuild the head per request (its `generateMetadata` may read cookies/headers)
 * and swap it into the cached shell via {@link replaceDocumentHead}.
 */
export function renderHeadContent(
  metadata: Metadata,
  viewport?: Viewport,
  styles?: string[],
): string {
  let head = renderHead(metadata, viewport);
  for (const href of styles ?? []) {
    // `data-dnx-css` marks per-route stylesheets so an isomorphic soft nav can swap
    // them for the new route's (global stylesheets, unmarked, persist across navs).
    head += `<link rel="stylesheet" href="${escapeHtml(href)}" data-dnx-css>`;
  }
  return head;
}

/** Replace a document's `<head>…</head>` region with fresh inner content. */
export function replaceDocumentHead(doc: string, headContent: string): string {
  return doc.replace(/<head>[\s\S]*?<\/head>/, `<head>${headContent}</head>`);
}

/**
 * The trailing `<body>` scripts (public-env island, hydration data + Flight
 * island + client entry, dev script). Exposed so a streamed PPR response can emit
 * them AFTER the dynamic holes, so the client entry hydrates the complete document.
 */
export function renderBodyScripts(opts: DocumentOptions): string {
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
    // Lazy islands: their own Flight trees keyed by tree-path id, hydrated
    // per-island when each island's client:* strategy fires.
    if (opts.islands && opts.islands.length > 0) {
      const map: Record<string, unknown> = {};
      for (const island of opts.islands) map[island.id] = island.flight;
      scripts += `<script id="__denext_islands" type="application/json">${
        JSON.stringify(map).replace(/</g, "\\u003c")
      }</script>`;
    }
    // Signal state: `useId → value`, adopted by the client before hydration.
    if (opts.signalState && Object.keys(opts.signalState).length > 0) {
      scripts += `<script id="__denext_state" type="application/json">${
        JSON.stringify(opts.signalState).replace(/</g, "\\u003c")
      }</script>`;
    }
    scripts += `<script type="module" src="${escapeHtml(opts.clientEntry)}"></script>`;
  }
  // Prefer an external same-origin dev script (CSP-clean); fall back to inline.
  // Emit a CLASSIC script (not a module) so it runs during parse — before the
  // deferred hydration module — preserving the pre-hydration `__denextDev` marker.
  if (opts.devScriptSrc) {
    scripts += `<script src="${escapeHtml(opts.devScriptSrc)}"></script>`;
  } else if (opts.devScript) {
    scripts += `<script>${opts.devScript}</script>`;
  }
  return scripts;
}

/** The `data-route` attribute for the hydration root (empty when not hydrating). */
export function rootRouteAttr(opts: DocumentOptions): string {
  return opts.hydration ? ` data-route="${escapeHtml(opts.hydration.pathname)}"` : "";
}

/**
 * Render a complete HTML document string: `<!DOCTYPE>` + `<html>` with the head
 * content (metadata/viewport/styles), the hydration root wrapping `bodyHtml`, and
 * the body scripts. The non-streaming counterpart to {@linkcode streamPprDocument}.
 */
export function renderDocument(opts: DocumentOptions): string {
  const { bodyHtml, metadata } = opts;
  const lang = opts.lang ?? "en";

  // Extracted route stylesheets are linked after metadata so page CSS can override.
  const head = renderHeadContent(metadata, opts.viewport, opts.styles);
  const scripts = renderBodyScripts(opts);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(opts)}>${bodyHtml}</div>${scripts}</body>
</html>`;
}

/**
 * Stream a PPR document: flush the cached shell (its `<head>` rebuilt per request)
 * with each dynamic hole showing its fallback, then stream each hole's real content
 * as a `<template>` + `__dnxSwap` script as it resolves, and finally the hydration
 * scripts + client entry — emitted LAST so the client hydrates the COMPLETE
 * (holes-filled) document, exactly as the buffered path did.
 *
 * @param opts Document options; `bodyHtml` is the cached shell body (with
 *   `data-dnx-b` hole placeholders), `holes` are the per-request holes (each `html`
 *   may still be resolving), and `signal` aborts a disconnected stream.
 */
export function streamPprDocument(
  opts: DocumentOptions & { holes: ResumedHole[]; signal?: AbortSignal },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lang = opts.lang ?? "en";
  const head = renderHeadContent(opts.metadata, opts.viewport, opts.styles);
  const prefix = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(opts)}>${opts.bodyHtml}</div>${SWAP_RUNTIME}`;
  const tail = `${renderBodyScripts(opts)}</body>
</html>`;
  const holes = opts.holes;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(prefix));
        // Race the holes; stream each into its placeholder as it resolves. A hole
        // that FAILS must not tear down the whole document — it resolves to `ok:
        // false` and is skipped, leaving its shell fallback in place while every
        // other hole (and the tail) still streams.
        const active = new Set(
          holes.map((h) =>
            Promise.resolve(h.html)
              .then((html) => ({ id: h.id, html, ok: true }))
              .catch((err) => {
                console.error("denext: PPR hole failed to resume:", h.id, err);
                return { id: h.id, html: "", ok: false };
              })
          ),
        );
        while (active.size > 0) {
          if (opts.signal?.aborted) break;
          const settled = await Promise.race(
            [...active].map((p) => p.then((v) => ({ p, v }))),
          );
          active.delete(settled.p);
          const { id, html, ok } = settled.v;
          if (!ok) continue; // leave the shell fallback for this hole
          controller.enqueue(
            encoder.encode(
              `<template data-dnx-r="${id}">${html}</template>` +
                `<script>__dnxSwap('${id}')</script>`,
            ),
          );
        }
        controller.enqueue(encoder.encode(tail));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Stream a live (non-PPR) page document: flush `<head>` + the already-rendered
 * shell (its Suspense boundaries showing fallbacks), then stream each boundary's
 * real content as a `<template>` + `__dnxSwap` script as it resolves, then the
 * hydration scripts LAST so the client hydrates the complete document — the
 * incremental-streaming counterpart to {@linkcode renderDocument}.
 *
 * The shell is passed **already rendered** (via `renderShell`) so a control signal
 * thrown during it was handled by the caller before any bytes flush. Streamed
 * responses carry no framework CSP (the document isn't buffered) — callers gate
 * this to routes where no CSP applies.
 *
 * @param opts Document options (minus `bodyHtml`) plus the rendered `shell` and an
 *   optional abort `signal`. `metadata` should already include any in-tree
 *   `<title>`/head tags the shell hoisted.
 */
export function streamPageDocument(
  opts: Omit<DocumentOptions, "bodyHtml"> & {
    shell: ShellRender;
    signal?: AbortSignal;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lang = opts.lang ?? "en";
  const head = renderHeadContent(opts.metadata, opts.viewport, opts.styles);
  // rootRouteAttr/renderBodyScripts read only head/hydration/script fields, never
  // bodyHtml — cast to satisfy the shared DocumentOptions shape.
  const docOpts = opts as unknown as DocumentOptions;
  const prefix = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>${head}</head>
<body><div id="${ROOT_ID}"${rootRouteAttr(docOpts)}>${opts.shell.shell}</div>${SWAP_RUNTIME}`;
  const tail = `${renderBodyScripts(docOpts)}</body>
</html>`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(prefix));
        await opts.shell.drainHoles((id, html) => {
          controller.enqueue(
            encoder.encode(
              `<template data-dnx-r="${id}">${html}</template>` +
                `<script>__dnxSwap('${id}')</script>`,
            ),
          );
        });
        controller.enqueue(encoder.encode(tail));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
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
  const parts = [
    `width=${v.width ?? "device-width"}`,
    `initial-scale=${v.initialScale ?? 1}`,
  ];
  if (v.maximumScale !== undefined) {
    parts.push(`maximum-scale=${v.maximumScale}`);
  }
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
  const list = (
    v?: string | string[],
  ) => (v == null ? [] : Array.isArray(v) ? v : [v]);

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
  if (metadata.keywords?.length) {
    head += nameTag("keywords", metadata.keywords.join(", "));
  }
  if (metadata.robots !== undefined) {
    head += nameTag("robots", robotsContent(metadata.robots));
  }
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
  for (
    const [lang, url] of Object.entries(metadata.alternates?.languages ?? {})
  ) {
    head += `<link rel="alternate" hreflang="${escapeHtml(lang)}" href="${
      escapeHtml(resolveMetaUrl(url, base))
    }">`;
  }

  // Icons (shorthand + structured).
  head += link("icon", metadata.icon);
  for (const href of list(metadata.icons?.icon)) head += link("icon", href);
  for (const href of list(metadata.icons?.shortcut)) {
    head += link("shortcut icon", href);
  }
  for (const href of list(metadata.icons?.apple)) {
    head += link("apple-touch-icon", href);
  }

  // Open Graph.
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    head += propTag("og:title", og.title) +
      propTag("og:description", og.description) +
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
      nameTag("twitter:creator", t.creator) +
      nameTag("twitter:title", t.title) +
      nameTag("twitter:description", t.description);
    if (t.image) {
      head += nameTag("twitter:image", resolveMetaUrl(t.image, base));
    }
  }

  if (metadata.meta) {
    for (const [name, content] of Object.entries(metadata.meta)) {
      head += nameTag(name, content);
    }
  }
  if (metadata.head) {
    // L6: `metadata.head` is the one <head> sink injected verbatim (no escaping) —
    // an author-controlled escape hatch for raw tags. Warn in dev that untrusted
    // input here is an injection vector, mirroring warnDangerousHtml. Gated on
    // `__denextDev`, so production SSR pays nothing. De-duplicated by content: a
    // STATIC head (the common case — stylesheet/favicon links) warns once, while a
    // head interpolating changing data — the actually-risky case — keeps warning.
    if ((globalThis as { __denextDev?: boolean }).__denextDev === true) {
      warnRawHeadOnce(metadata.head);
    }
    head += metadata.head;
  }
  return head;
}

/** Distinct `metadata.head` bodies already warned about this process (dev only). */
const warnedHeads = new Set<string>();

/** Warn once per distinct raw-`<head>` body (see {@link renderHead}). */
function warnRawHeadOnce(headHtml: string): void {
  if (warnedHeads.has(headHtml)) return;
  // Bound the set so a per-request-varying head can't leak memory; it still re-warns
  // (that head is the risky one). 256 distinct bodies is far past any real app.
  if (warnedHeads.size >= 256) warnedHeads.clear();
  warnedHeads.add(headHtml);
  console.warn(
    "denext: metadata.head is injected into <head> as raw HTML — sanitize " +
      "any untrusted input to avoid injection. (dev-only warning)",
  );
}
