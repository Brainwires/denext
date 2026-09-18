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
import { layout, type NavItem, type NavSection, UI_TITLE_SUFFIX } from "./layout.ts";
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

/** The header a fragment response names its document title in (URI-encoded). */
export const UI_TITLE_HEADER = "x-ui-title";

/**
 * Where `ui.js` asks what a cron expression means as it is typed.
 *
 * Under `/_ui/` on purpose: it is part of the client's own machinery, not a panel anyone
 * navigates to, and it answers a bare block rather than a `<section id="panel">`.
 */
export const UI_CRON_PREVIEW_PATH = "/_ui/cron-preview";

/**
 * The UI's navigation, in order.
 *
 * Configuration is a section rather than one entry: its views are separate pages, each a real
 * route, so they belong in the sidebar beside each other instead of behind a strip of tabs on a
 * single destination. `next.config` is deliberately NOT here — it exists only for a compat app,
 * and deciding that per request would mean a subprocess check on every panel's render, so it
 * stays a link on the config pages themselves.
 */
export const UI_NAV_SECTIONS: readonly NavSection[] = [
  { items: [{ href: "/", label: "Overview" }] },
  {
    label: "Configuration",
    items: [
      { href: "/config/routing", label: "Routing" },
      { href: "/config/rendering", label: "Rendering" },
      { href: "/config/security", label: "Security" },
      { href: "/config/advanced", label: "Advanced" },
      { href: "/config/cron", label: "Cron" },
    ],
  },
  {
    items: [
      { href: "/plugins", label: "Plugins" },
      { href: "/generate", label: "Generate" },
      { href: "/docker", label: "Docker" },
      { href: "/desktop", label: "Desktop" },
      { href: "/wizard", label: "Wizard" },
      { href: "/dev", label: "Dev" },
      { href: "/commands", label: "Commands" },
    ],
  },
];

/** Every navigation destination, flattened — the sections' items in order. */
export const UI_NAV: readonly NavItem[] = UI_NAV_SECTIONS.flatMap((section) => section.items);

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
export function htmlResponse(
  markup: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
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
 * @returns The `(ctx, body, status?, viewTitle?) => Response` the module answers every HTML
 *   request with. A tabbed panel passes `viewTitle` to name the view it is actually showing
 *   (`Docker · Services`), so two of its tabs open side by side are told apart in the browser;
 *   panels with one view pass nothing and keep the bound title.
 */
export function panelResponder(
  title: string,
  active: string,
): (ctx: UiContext, body: RawHtml, status?: number, viewTitle?: string) => Response {
  return (ctx: UiContext, body: RawHtml, status = 200, viewTitle?: string): Response => {
    if (ctx.fragment) {
      // A fragment is the bare panel: it carries no <title>, and `ui.js` swaps it without a
      // navigation, so the tab would keep naming the panel the user just left. The title rides
      // along as a header instead of as markup, because the shell document is pinned byte-exact
      // by a golden test. URI-encoded: a header is a byte string, and a title is not always
      // latin-1.
      return htmlResponse(toHtml(body), status, {
        [UI_TITLE_HEADER]: encodeURIComponent((viewTitle ?? title) + UI_TITLE_SUFFIX),
      });
    }
    return htmlResponse(
      renderPage(layout, {
        title: viewTitle ?? title,
        nav: UI_NAV_SECTIONS,
        body,
        csrf: ctx.csrf,
        active,
        readOnly: ctx.readOnly,
        offline: ctx.offline,
      }),
      status,
    );
  };
}
