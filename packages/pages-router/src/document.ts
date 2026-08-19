// Custom `_document` support + the `next/document` primitives (Html/Head/Main/
// NextScript). A custom Document is rendered to a string with unique placeholder
// tokens where the app HTML, `<head>` extras, and scripts belong, then those tokens
// are substituted in. String substitution (rather than shared render state) keeps
// concurrent requests isolated.

import { Fragment, h } from "@denext/denext";
import type { PageComponent } from "./render.ts";

/** A rendered virtual node (denext `h(...)` output). */
type VNode = ReturnType<typeof h>;

const MAIN_TOKEN = "__DENEXT_PAGES_MAIN__";
const HEAD_TOKEN = "__DENEXT_PAGES_HEAD__";
const SCRIPTS_TOKEN = "__DENEXT_PAGES_SCRIPTS__";

/** `<Html>` — the document root. Renders `<html>` with its attributes. */
// deno-lint-ignore no-explicit-any
export function Html(props: any): VNode {
  const { children, ...rest } = props ?? {};
  return h("html", rest, children);
}

/** `<Head>` — document `<head>`; denext appends managed head tags after its children. */
// deno-lint-ignore no-explicit-any
export function Head(props: any): VNode {
  const { children, ...rest } = props ?? {};
  return h("head", rest, children, HEAD_TOKEN);
}

/** `<Main>` — where the rendered app HTML is spliced in. */
export function Main(): VNode {
  return h("div", { id: "__next", dangerouslySetInnerHTML: { __html: MAIN_TOKEN } });
}

/** `<NextScript>` — where the hydration data + client bundle scripts are spliced in. */
export function NextScript(): VNode {
  return h(Fragment, null, SCRIPTS_TOKEN);
}

/** The default `_document` used when the app doesn't provide one. */
export function DefaultDocument(): VNode {
  return h(Html, null, h(Head, null), h("body", null, h(Main, null), h(NextScript, null)));
}

/** Inputs for {@link renderWithDocument}. */
export interface DocumentParts {
  /** The rendered app HTML (goes inside `<div id="__next">`). */
  appHtml: string;
  /** Managed `<head>` HTML (charset/viewport + hoisted title/meta + styles). */
  headHtml: string;
  /** Script tags (`__NEXT_DATA__` + client bundle). */
  scriptsHtml: string;
}

/**
 * Render a (possibly custom) `_document` component to a full HTML document,
 * substituting the app HTML, head extras, and scripts into their placeholders.
 *
 * @param Document The `_document` default export, or a default is used.
 * @param parts The rendered fragments to splice in.
 * @param renderDoc Renderer for the document tree (denext `renderToString`).
 */
export async function renderWithDocument(
  Document: PageComponent | null | undefined,
  parts: DocumentParts,
  renderDoc: (node: VNode) => Promise<string>,
): Promise<string> {
  const Doc = (Document ?? DefaultDocument) as PageComponent;
  let html = await renderDoc(h(Doc, null));
  // Ensure managed head tags land inside <head> even if a custom Head omitted the
  // token (fallback: inject before </head>).
  if (html.includes(HEAD_TOKEN)) html = html.replace(HEAD_TOKEN, parts.headHtml);
  else html = html.replace("</head>", parts.headHtml + "</head>");
  html = html.replace(MAIN_TOKEN, parts.appHtml);
  if (html.includes(SCRIPTS_TOKEN)) html = html.replace(SCRIPTS_TOKEN, parts.scriptsHtml);
  else html = html.replace("</body>", parts.scriptsHtml + "</body>");
  return "<!DOCTYPE html>" + html;
}
