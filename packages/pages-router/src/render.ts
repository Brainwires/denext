// SSR a Pages Router page: wrap it in `_app` (or a default that just renders the
// page), render to HTML, and assemble the document with a `__NEXT_DATA__` payload
// so the client can hydrate with the same props. Custom `_document` support layers
// on top of this via {@link renderWithDocument}.

import { h, renderToString } from "@denext/denext";
import type { HeadCollector } from "@denext/denext";
import type { Component } from "@denext/denext/server";
import { renderWithDocument } from "./document.ts";
import { createServerRouter, RouterProvider } from "../router.ts";

// A page/app/document module's component. Props are route-specific (the user's
// component types them); the default `Record<string, unknown>` props keep both the
// page (`pageProps`) and `_app` (`{ Component, pageProps }`) call shapes assignable.
export type PageComponent = Component;

/** The `__NEXT_DATA__` payload embedded for client hydration. */
export interface NextData {
  /** Props returned by data fetching (or `{}`). */
  props: { pageProps: Record<string, unknown> };
  /** The matched route pattern, e.g. `/blog/[slug]`. */
  page: string;
  /** Resolved dynamic route params + query (a catch-all param is an array). */
  query: Record<string, string | string[]>;
  /** The request pathname as served. */
  asPath: string;
  /** True when props came from `getServerSideProps` (vs static/none). */
  isServer?: boolean;
  /** The `basePath` the app is served under (so the client can resolve URLs). */
  basePath?: string;
}

/** Everything {@link renderPage} needs to produce a document. */
export interface RenderInput {
  /** The page component (default export of the matched module). */
  Page: PageComponent;
  /** Props passed to the page (from data fetching, or `{}`). */
  pageProps: Record<string, unknown>;
  /** Optional `_app` component wrapping the page. */
  App?: PageComponent | null;
  /** The `__NEXT_DATA__` payload for hydration. */
  nextData: NextData;
  /** Client entry URL (module script) for hydration, if any. */
  clientBundle?: string | null;
  /** Stylesheet URLs to link in `<head>`. */
  styles?: string[];
  /** Document language. */
  lang?: string;
  /** Optional custom `_document` component. */
  Document?: PageComponent | null;
}

const SEP_2028 = String.fromCharCode(0x2028);
const SEP_2029 = String.fromCharCode(0x2029);

/** Escape a JSON string for safe embedding in a `<script>` element. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(SEP_2028, "\\u2028")
    .replaceAll(SEP_2029, "\\u2029");
}

/** Escape text for an HTML element body (used for the hoisted `<title>`). */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Serialize a {@link HeadCollector} into head HTML (title + gathered tags). */
export function headHtmlFrom(head: HeadCollector): string {
  const title = head.title != null ? `<title>${escapeHtml(head.title)}</title>` : "";
  return title + head.tags.join("");
}

/** Render the page (wrapped in `_app`, under a router provider), hoisting `<head>`. */
export async function renderAppHtml(input: RenderInput, head: HeadCollector): Promise<string> {
  const { Page, pageProps, App } = input;
  const inner = App ? h(App as PageComponent, { Component: Page, pageProps }) : h(Page, pageProps);
  const router = createServerRouter({
    route: input.nextData.page,
    query: input.nextData.query,
    asPath: input.nextData.asPath,
  });
  const tree = h(RouterProvider, { router }, inner);
  return await renderToString(tree, { head });
}

/** The `<script>` tags injected at the end of `<body>` (data payload + bundle). */
export function scriptTags(input: RenderInput): string {
  const data = `<script id="__NEXT_DATA__" type="application/json">${
    safeJson(input.nextData)
  }</script>`;
  const bundle = input.clientBundle
    ? `<script type="module" src="${input.clientBundle}"></script>`
    : "";
  return data + bundle;
}

/** `<link>` tags for the route's stylesheets. */
export function styleTags(styles: string[] | undefined): string {
  return (styles ?? []).map((href) => `<link rel="stylesheet" href="${href}">`).join("");
}

/**
 * Render a Pages Router page to a full HTML document (default `_document`).
 * Custom-`_document` rendering is handled by {@link renderWithDocument}.
 */
export async function renderPage(input: RenderInput): Promise<string> {
  const head: HeadCollector = { tags: [] };
  const appHtml = await renderAppHtml(input, head);
  const lang = input.lang ?? "en";
  const baseMeta =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  const headHtml = baseMeta + headHtmlFrom(head) + styleTags(input.styles);
  const scriptsHtml = scriptTags(input);

  // Custom `_document`: render it and splice the fragments into its placeholders.
  if (input.Document) {
    return await renderWithDocument(
      input.Document,
      { appHtml, headHtml, scriptsHtml },
      (node) => renderToString(node),
    );
  }

  return `<!DOCTYPE html><html lang="${lang}"><head>` +
    headHtml +
    `</head><body><div id="__next">${appHtml}</div>` +
    scriptsHtml +
    `</body></html>`;
}
