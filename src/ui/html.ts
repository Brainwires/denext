// The view layer of `denext ui` — and the contract every feature module implements.
//
// Shape: the UI is server-rendered HTML with no bundler, no client framework and no hydration
// (the `packages/openapi/docs-ui.ts` model). A view is either an `html` tagged template (a
// pre-escaped {@linkcode RawHtml} fragment) or an `h()`-built component tree rendered once, synchronously, on the server
// through `view.ts` — the two nest inside each other (`renderView` / `<Raw>`) while the views
// flip over one at a time. Every page render goes through the single {@linkcode renderPage} seam.
//
// This module also owns the handler contract ({@linkcode UiContext}, {@linkcode UiRoute}) and the
// navigation list, rather than `routes.ts`, so that `features/*.ts` can depend on it while
// `routes.ts` depends on the features — one direction, no import cycle. The graph below it is
// one-way too: `html.ts` → `layout.ts` → `view.ts`, and `html.ts` → `view.ts` (shared pieces in `components.ts`).

import type { VNode } from "../jsx/types.ts";
import type { SseClients } from "../build/sse.ts";
import { layout, type NavItem } from "./layout.ts";
import { UI_CSRF_FIELD } from "./security.ts";
import { type RawHtml, renderView } from "./view.ts";

export type { RawHtml } from "./view.ts";

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
  { href: "/config/next", label: "next.config" },
  { href: "/plugins", label: "Plugins" },
  { href: "/generate", label: "Generate" },
  { href: "/docker", label: "Docker" },
  { href: "/wizard", label: "Wizard" },
  { href: "/commands", label: "Commands" },
];

// ── the page seam ────────────────────────────────────────────────────────────

/** What a view may return: a markup string, an `html` fragment, or a component (VNode) tree. */
type ViewResult = string | RawHtml | VNode;

/**
 * The single indirection every page render goes through. A view may still return a string or
 * an `html` fragment, or return a component tree (rendered here through `renderView`, synchronously) — so a
 * view flips from one to the other without touching a route. A view that throws (or an async
 * component) throws out of this call, which the server answers with its hardened `500`
 * before any byte of the page is written.
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

/** Whether a view's result is an `html` fragment (a VNode never carries `__html`). */
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

/** What one {@linkcode opForm} posts. */
export interface OpFormOptions {
  /** The form action (the panel's own path unless the operation posts elsewhere). */
  readonly action: string;
  /** The submit button's label. */
  readonly label: string;
  /** Hidden fields carried with the operation (`op`, a row name, `confirm`, …). */
  readonly fields?: Readonly<Record<string, string>>;
  /** Extra markup inside the form, after the hidden fields. */
  readonly extra?: RawHtml;
  /** A class on the `<form>` itself. */
  readonly className?: string;
  /** Disable the button (what `--read-only` does to every write). */
  readonly disabled?: boolean;
}

/**
 * One operation as a real `<form method="post">` — the CSRF token, the operation's hidden
 * fields and a submit button. Works with JavaScript disabled; `ui.js` upgrades the same form to
 * fetch + panel swap.
 *
 * @param csrf The session CSRF token.
 * @param options Action, label, hidden fields and whether the button is disabled.
 * @returns The form markup.
 */
export function opForm(csrf: string, options: OpFormOptions): RawHtml {
  const parts = [hiddenField(UI_CSRF_FIELD, csrf)];
  for (const [name, value] of Object.entries(options.fields ?? {})) {
    parts.push(hiddenField(name, value));
  }
  if (options.extra) parts.push(toHtml(options.extra));
  const className = options.className ? ` class="${esc(options.className)}"` : "";
  const disabled = options.disabled ? " disabled" : "";
  parts.push(`<button type="submit"${disabled}>${esc(options.label)}</button>`);
  const open = `<form method="post" action="${esc(options.action)}"${className}>`;
  return raw([open, ...parts, "</form>"].join("\n"));
}

/** One hidden input, escaped. */
function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

/**
 * A unified diff as the panels' ordinary `<pre class="out">` block, with each added, removed
 * and hunk-header line wrapped in a class the stylesheet colours (no inline style, no script —
 * the CSP holds).
 *
 * @param diff The unified diff text.
 * @returns The rendered block.
 */
export function diffHtml(diff: string): RawHtml {
  const lines = diff.split("\n").map((line) => {
    const kind = diffClass(line);
    return kind === "" ? html`${line}` : html`<span class="${kind}">${line}</span>`;
  });
  return html`<pre class="out"><code class="diff">${joinLines(lines)}</code></pre>`;
}

/** The class one diff line gets: an addition, a removal, a hunk header, or nothing. */
function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/** Join rendered lines back with the newlines `split` removed. */
function joinLines(lines: readonly RawHtml[]): RawHtml {
  return raw(lines.map(toHtml).join("\n"));
}
