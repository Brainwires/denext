// Assemble a full HTML document around rendered page content, including <head>
// metadata and the hydration bootstrap script.

import { escapeHtml } from "../jsx/render-to-string.ts";
import type { Metadata } from "./types.ts";
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

  const head = renderHead(metadata);
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

function renderHead(metadata: Metadata): string {
  let head =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  if (metadata.title !== undefined) {
    head += `<title>${escapeHtml(metadata.title)}</title>`;
  }
  if (metadata.description !== undefined) {
    head += `<meta name="description" content="${escapeHtml(metadata.description)}">`;
  }
  if (metadata.keywords && metadata.keywords.length > 0) {
    head += `<meta name="keywords" content="${escapeHtml(metadata.keywords.join(", "))}">`;
  }
  if (metadata.robots !== undefined) {
    head += `<meta name="robots" content="${escapeHtml(metadata.robots)}">`;
  }
  if (metadata.canonical !== undefined) {
    head += `<link rel="canonical" href="${escapeHtml(metadata.canonical)}">`;
  }
  if (metadata.icon !== undefined) {
    head += `<link rel="icon" href="${escapeHtml(metadata.icon)}">`;
  }
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    const tag = (property: string, content?: string) =>
      content === undefined
        ? ""
        : `<meta property="og:${property}" content="${escapeHtml(content)}">`;
    head += tag("title", og.title) + tag("description", og.description) +
      tag("type", og.type) + tag("url", og.url) + tag("image", og.image) +
      tag("site_name", og.siteName);
  }
  if (metadata.meta) {
    for (const [name, content] of Object.entries(metadata.meta)) {
      head += `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
    }
  }
  if (metadata.head) head += metadata.head;
  return head;
}
