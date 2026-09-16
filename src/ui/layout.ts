// The document shell every `denext ui` page is served in — the first view flipped to a component.
//
// It lives in its own module, not in `html.ts`, so the import graph stays one-way: `html.ts`
// (whose `panelResponder` renders full pages) imports this module, and this module imports only
// the view substrate (`view.ts`) — never `html.ts`. That is why the two asset paths the shell
// links to are declared here: `routes.ts` imports them from here to serve them.

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { Raw, type RawHtml } from "./view.ts";

/** The same-origin stylesheet path (also the route that serves it). */
export const UI_CSS_PATH = "/_ui/ui.css";

/** The same-origin client-module path (also the route that serves it). */
export const UI_JS_PATH = "/_ui/ui.js";

/** One item of the UI's top navigation. */
export interface NavItem {
  /** The path it links to. */
  readonly href: string;
  /** The label. */
  readonly label: string;
}

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
  /** `--read-only`: every write is refused. Shown in the sidebar, not just on Overview. */
  readonly readOnly?: boolean;
  /** `--offline`: nothing the UI starts reaches the network. */
  readonly offline?: boolean;
}

/**
 * The full HTML document every UI page is served as: one same-origin stylesheet, one
 * same-origin module, no inline script — clean under `script-src 'self'; style-src 'self'`.
 * Render it through `renderPage` (or `renderView`), which strips {@linkcode Raw}'s wrapper.
 *
 * @param options Title, navigation, body, CSRF token and the active nav entry.
 * @returns The document's element tree (the doctype included).
 */
export function layout(options: LayoutOptions): VNode {
  return h(
    Fragment,
    null,
    h(Raw, { html: "<!doctype html>" }),
    h(
      "html",
      { lang: "en" },
      h(
        "head",
        null,
        h("meta", { charset: "utf-8" }),
        h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
        h("meta", { name: "denext-csrf", content: options.csrf }),
        h("title", null, options.title, " · denext ui"),
        h("link", { rel: "stylesheet", href: UI_CSS_PATH }),
      ),
      h(
        "body",
        null,
        h(
          "aside",
          { class: "sidebar" },
          h("span", { class: "brand" }, "denext ui"),
          h("nav", null, options.nav.map((item) => navLink(item, options.active))),
          modeFooter(options),
        ),
        h("main", { id: "main" }, h(Raw, { html: options.body })),
        h("script", { type: "module", src: UI_JS_PATH }),
      ),
    ),
  );
}

/**
 * The modes that change what every panel will do, pinned to the bottom of the sidebar.
 *
 * `--read-only` was only ever announced on the Overview, so on any other panel a refused
 * write looked like a bug rather than the mode it is. A mode belongs in the shell. Nothing
 * renders when neither is on: the UI does not invent status it does not have.
 *
 * The badge spans are spelled out rather than imported from `components.ts`, because this
 * module deliberately imports only the view substrate (see the header) — two spans are a
 * smaller price than a new edge in that graph.
 *
 * @param options The layout inputs.
 * @returns The footer, or `null` when no mode is active.
 */
function modeFooter(options: LayoutOptions): VNode | null {
  const modes: VNode[] = [];
  if (options.readOnly) modes.push(h("span", { key: "ro", class: "badge warn" }, "read-only"));
  if (options.offline) modes.push(h("span", { key: "off", class: "badge info" }, "offline"));
  return modes.length === 0 ? null : h("p", { class: "mode" }, modes);
}

/** One navigation link, marked `aria-current="page"` when it is the active entry. */
function navLink(item: NavItem, active: string | undefined): VNode {
  const current = item.href === active ? "page" : undefined;
  return h("a", { key: item.href, href: item.href, "aria-current": current }, item.label);
}
