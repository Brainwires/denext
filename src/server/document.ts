// Assemble a full HTML document around rendered page content, including <head>
// metadata and the hydration bootstrap script.

import { escapeHtml } from "../jsx/render-to-string.ts";
import type { Metadata } from "./types.ts";
import type { RouteParams } from "../router/segments.ts";

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
}

/** Render the complete HTML document as a string. */
export function renderDocument(opts: DocumentOptions): string {
  const { bodyHtml, metadata } = opts;
  const lang = opts.lang ?? "en";

  const head = renderHead(metadata);
  const rootAttrs = opts.hydration ? ` data-route="${escapeHtml(opts.hydration.pathname)}"` : "";

  let scripts = "";
  if (opts.hydration && opts.clientEntry) {
    const json = JSON.stringify(opts.hydration).replace(/</g, "\\u003c");
    scripts += `<script id="__denext_data" type="application/json">${json}</script>`;
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
  if (metadata.meta) {
    for (const [name, content] of Object.entries(metadata.meta)) {
      head += `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
    }
  }
  if (metadata.head) head += metadata.head;
  return head;
}
