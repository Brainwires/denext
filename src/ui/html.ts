// The view layer of `denext ui` — and the contract every feature module implements.
//
// Shape (decided in the 2.5 UI design): the UI is server-rendered HTML *strings*, the
// `packages/openapi/docs-ui.ts` model — no bundler, no TSX, no client framework. Every view is
// `(props) => string` behind the single {@linkcode renderPage} seam, so a later minor can flip
// the implementation to TSX + `renderToStringSync` without touching a route.
//
// This module also owns the handler contract ({@linkcode UiContext}, {@linkcode UiRoute}) and the
// navigation list, rather than `routes.ts`, so that `features/*.ts` can depend on it while
// `routes.ts` depends on the features — one direction, no import cycle.

/** A pre-escaped HTML fragment: interpolating it into {@linkcode html} inserts it verbatim. */
export interface RawHtml {
  /** The already-safe markup. */
  readonly __html: string;
}

/**
 * Mark a string as already-safe markup so {@linkcode html} interpolates it verbatim.
 *
 * @param value Markup the caller vouches for.
 * @returns The fragment wrapper.
 */
export function raw(value: string): RawHtml {
  return { __html: value };
}

/**
 * Escape a value for interpolation into HTML text or a double-quoted attribute.
 *
 * @param value Anything; stringified first.
 * @returns The escaped text.
 */
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Tagged template for HTML. Interpolated values are escaped unless they are {@linkcode RawHtml};
 * arrays are interpolated element-wise and joined; `null`/`undefined`/`false` render as nothing.
 *
 * @param strings The literal chunks.
 * @param values The interpolated values.
 * @returns The assembled fragment.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return { __html: out };
}

/** One interpolated value as markup (escaped unless raw). */
function interpolate(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(interpolate).join("");
  if (typeof value === "object" && "__html" in (value as RawHtml)) return (value as RawHtml).__html;
  return esc(value);
}

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

import type { SseClients } from "../build/sse.ts";

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

/** The same-origin stylesheet path (also the route that serves it). */
export const UI_CSS_PATH = "/_ui/ui.css";

/** The same-origin client-module path (also the route that serves it). */
export const UI_JS_PATH = "/_ui/ui.js";

/** The broadcast channel path (also the route that serves it). */
export const UI_EVENTS_PATH = "/_ui/events";

/** One item of the UI's top navigation. */
export interface NavItem {
  /** The path it links to. */
  readonly href: string;
  /** The label. */
  readonly label: string;
}

/** The UI's top navigation, in order. */
export const UI_NAV: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/config", label: "Config" },
  { href: "/config/next", label: "next.config" },
  { href: "/plugins", label: "Plugins" },
  { href: "/generate", label: "Generate" },
  { href: "/docker", label: "Docker" },
  { href: "/wizard", label: "Wizard" },
  { href: "/commands", label: "Commands" },
];

// ── the shell ────────────────────────────────────────────────────────────────

/** Inputs to {@linkcode layout}. */
export interface LayoutOptions {
  /** The document title (also the page heading). */
  readonly title: string;
  /** The navigation to render. */
  readonly nav: readonly NavItem[];
  /** The page body (already-safe markup). */
  readonly body: RawHtml;
  /** The session CSRF token, published to `ui.js` as a `<meta>`. */
  readonly csrf: string;
  /** The nav href to mark current. */
  readonly active?: string;
}

/**
 * The full HTML document every UI page is served as: one same-origin stylesheet, one
 * same-origin module, no inline script — clean under `script-src 'self'; style-src 'self'`.
 *
 * @param options Title, navigation, body, CSRF token and the active nav entry.
 * @returns The complete document source.
 */
export function layout(options: LayoutOptions): string {
  const nav = options.nav.map((item) =>
    html`
      <a href="${item.href}" ${item.href === options.active
        ? raw(' aria-current="page"')
        : ""}>${item.label}</a>
    `
  );
  return "<!doctype html>" + toHtml(html`
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="denext-csrf" content="${options.csrf}">
        <title>${options.title} · denext ui</title>
        <link rel="stylesheet" href="${UI_CSS_PATH}">
      </head>
      <body>
        <header class="topbar"><span class="brand">denext&nbsp;ui</span><nav>${nav}</nav></header>
        <main id="main">${options.body}</main>
        <script type="module" src="${UI_JS_PATH}"></script>
      </body>
    </html>
  `);
}

/**
 * The single indirection every page render goes through, so the rendering strategy is one
 * edit away from changing.
 *
 * @param view A view function.
 * @param props Its props.
 * @returns The rendered document.
 */
export function renderPage<P>(view: (props: P) => string, props: P): string {
  return view(props);
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

// ── feature stubs ────────────────────────────────────────────────────────────

/** What a not-yet-implemented feature panel announces. */
export interface StubSpec {
  /** Panel title. */
  readonly title: string;
  /** One sentence describing what the panel will do. */
  readonly lead: string;
  /** The job id that fills this panel in. */
  readonly job: string;
}

/**
 * Render one feature panel's `<section>`; the piece `ui.js` swaps on a fragment request.
 *
 * @param spec The panel description.
 * @returns The section markup.
 */
export function stubSection(spec: StubSpec): RawHtml {
  return html`
    <section id="panel" data-panel="${spec.title}">
      <h1>${spec.title}</h1>
      <p class="lead">${spec.lead}</p>
      <p class="note">Not implemented yet — this panel lands in ${spec.job}.</p>
    </section>
  `;
}

/**
 * Build the handler a not-yet-implemented feature module exports: a walkable placeholder page
 * on the HTML route, a `501` `{ ok: false, reason }` envelope on the `/api/*` twin.
 *
 * @param spec The panel description.
 * @returns The handler.
 */
export function stubHandler(spec: StubSpec): UiHandler {
  return (_request: Request, ctx: UiContext): Promise<Response> => {
    if (ctx.json) {
      return Promise.resolve(
        jsonResponse({ ok: false, reason: "not implemented", job: spec.job }, 501),
      );
    }
    const section = stubSection(spec);
    if (ctx.fragment) return Promise.resolve(htmlResponse(toHtml(section)));
    return Promise.resolve(htmlResponse(renderPage(layout, {
      title: spec.title,
      nav: UI_NAV,
      body: section,
      csrf: ctx.csrf,
      active: ctx.url.pathname,
    })));
  };
}
