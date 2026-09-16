// The view layer of `denext ui` — and the contract every feature module implements.
//
// Shape: the UI is server-rendered HTML with no bundler, no client framework and no hydration
// (the `packages/openapi/docs-ui.ts` model). Every view is an `h()`-built component tree,
// rendered once, synchronously, on the server through `view.ts` into a pre-escaped
// {@linkcode RawHtml} fragment; the pieces the panels share live in `components.ts`. Every page
// render goes through the single {@linkcode renderPage} seam.
//
// This module also owns the handler contract ({@linkcode UiContext}, {@linkcode UiRoute}) and the
// navigation list, rather than `routes.ts`, so that `features/*.ts` can depend on it while
// `routes.ts` depends on the features — one direction, no import cycle. The graph below it is
// one-way too: `html.ts` → `layout.ts` → `view.ts`, and `html.ts` → `view.ts`.

import type { VNode } from "../jsx/types.ts";
import type { SseClients } from "../build/sse.ts";
import { layout, type NavItem } from "./layout.ts";
import { type RawHtml, renderView } from "./view.ts";

export type { RawHtml } from "./view.ts";

/**
 * Unwrap a fragment to its markup string.
 *
 * @param fragment The fragment.
 * @returns The markup.
 */
export function toHtml(fragment: RawHtml): string {
  return fragment.__html;
}

// ── the handler contract ─────────────────────────────────────────────────────

/** Everything a feature handler is told about the current request. */
export interface UiContext {
  /** Absolute path of the project the UI was opened on. */
  readonly dir: string;
  /** The parsed request URL. */
  readonly url: URL;
  /** The request method (already checked against the route). */
  readonly method: string;
  /** `--read-only`: every mutation is refused before it reaches a feature. */
  readonly readOnly: boolean;
  /** True when JSR discovery is off (`denext ui --offline`); read it as `ctx.offline === true`. */
  readonly offline?: boolean;
  /** The CSRF token this session's forms must carry. */
  readonly csrf: string;
  /** True for the `/api/*` twin of a feature route (answer with JSON). */
  readonly json: boolean;
  /** True when the client asked for `text/html-fragment` (swap one `<section>`). */
  readonly fragment: boolean;
  /** The decoded form body of a mutation, when the request carried one. */
  readonly form?: FormData;
  /** The decoded JSON body of a mutation, when the request carried one. */
  readonly body?: unknown;
  /** The `/_ui/events` subscribers, for pushing progress to every open page. */
  readonly events: SseClients;
  /**
   * The UI server's shutdown signal. Every child process a feature spawns is handed this (alone
   * or combined with a per-request deadline), so Ctrl+C takes the `deno task` and the wizard's
   * `denext dev` with it instead of leaving them running. Absent when a caller (a unit test)
   * built the context by hand.
   */
  readonly signal?: AbortSignal;
}

/** A feature route handler. */
export type UiHandler = (request: Request, ctx: UiContext) => Promise<Response>;

/** One entry of the UI route table. */
export interface UiRoute {
  /** The methods this route answers (anything else is a 405). */
  readonly methods: readonly string[];
  /** The handler. */
  readonly handle: UiHandler;
}

/** The broadcast channel path (also the route that serves it). */
export const UI_EVENTS_PATH = "/_ui/events";

/** The UI's top navigation, in order. */
export const UI_NAV: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/config", label: "Config" },
  { href: "/plugins", label: "Plugins" },
  { href: "/generate", label: "Generate" },
  { href: "/docker", label: "Docker" },
  { href: "/wizard", label: "Wizard" },
  { href: "/commands", label: "Commands" },
];

// ── the page seam ────────────────────────────────────────────────────────────

/** What a view may return: a component (VNode) tree, an already-rendered fragment, or markup. */
type ViewResult = string | RawHtml | VNode;

/**
 * The single indirection every page render goes through. A view returns a component tree
 * (rendered here through `renderView`, synchronously); an already-rendered fragment or a markup
 * string passes through untouched. A view that throws (or an async component) throws out of this
 * call, which the server answers with its hardened `500` before any byte of the page is written.
 *
 * @param view A view function.
 * @param props Its props.
 * @returns The rendered document.
 */
export function renderPage<P>(view: (props: P) => ViewResult, props: P): string {
  const result = view(props);
  if (typeof result === "string") return result;
  if (isRawHtml(result)) return result.__html;
  return renderView(result).__html;
}

/** Whether a view's result is an already-rendered fragment (a VNode has no markup field). */
function isRawHtml(result: RawHtml | VNode): result is RawHtml {
  return typeof (result as Partial<RawHtml>).__html === "string";
}

// ── responses ────────────────────────────────────────────────────────────────

/**
 * A JSON response (security headers are applied by the server, not here).
 *
 * @param body The payload.
 * @param status HTTP status (default 200).
 * @returns The response.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * An HTML response.
 *
 * @param markup The document (or fragment) source.
 * @param status HTTP status (default 200).
 * @returns The response.
 */
export function htmlResponse(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ── panels ──────────────────────────────────────────────────────────────────

/**
 * Build one feature module's panel responder: the answer to "a fragment, or the whole page?"
 * that every panel gives identically — the bare `<section id="panel">` when `ui.js` asked for
 * one to swap, the full document otherwise.
 *
 * @param title The panel's title (the document title, and its heading in the tab bar).
 * @param active The nav href to mark current — the panel's own HTML path.
 * @returns The `(ctx, body, status?) => Response` the module answers every HTML request with.
 */
export function panelResponder(
  title: string,
  active: string,
): (ctx: UiContext, body: RawHtml, status?: number) => Response {
  return (ctx: UiContext, body: RawHtml, status = 200): Response => {
    if (ctx.fragment) return htmlResponse(toHtml(body), status);
    return htmlResponse(
      renderPage(layout, { title, nav: UI_NAV, body, csrf: ctx.csrf, active }),
      status,
    );
  };
}
