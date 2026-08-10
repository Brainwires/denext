/**
 * React 19 resource-preloading APIs (`react-dom`): `preload`, `preinit`,
 * `preconnect`, `prefetchDNS`. On the **client** they inject the corresponding
 * `<link>`/`<script>` into `document.head`, deduplicated by rel+href (the esbuild
 * parallel to what React emits). During **SSR** there is no document, so they are
 * no-ops — denext does not currently hoist imperative resource hints into the
 * server-rendered `<head>` (a documented limitation; use `<link>` in a layout for
 * SSR-time hints).
 *
 * @module
 */

/** Options for {@link preload}. */
export interface PreloadOptions {
  /** Resource kind: `script`, `style`, `font`, `image`, `fetch`, etc. */
  as?: string;
  /** CORS mode for the fetch. */
  crossOrigin?: string;
  /** Subresource integrity hash. */
  integrity?: string;
  /** MIME type hint. */
  type?: string;
  /** `fetchpriority` hint. */
  fetchPriority?: "high" | "low" | "auto";
  /** Nonce for CSP. */
  nonce?: string;
}

/** Options for {@link preinit}. */
export interface PreinitOptions {
  /** `script` eagerly loads+executes; `style` inserts a stylesheet. */
  as: "script" | "style";
  /** CORS mode. */
  crossOrigin?: string;
  /** Subresource integrity hash. */
  integrity?: string;
  /** `fetchpriority` hint. */
  fetchPriority?: "high" | "low" | "auto";
  /** Nonce for CSP. */
  nonce?: string;
  /** Stylesheet precedence (React ordering hint; recorded as a data attribute). */
  precedence?: string;
}

/** Options for {@link preconnect}. */
export interface PreconnectOptions {
  /** CORS mode for the connection. */
  crossOrigin?: string;
}

function head(): { doc: Document } | null {
  const d = (globalThis as { document?: Document }).document;
  return d && d.head ? { doc: d } : null;
}

function upsertLink(rel: string, href: string, attrs: Record<string, string | undefined>): void {
  const h = head();
  if (!h) return; // SSR: no-op
  const selector = `link[rel="${rel}"][href="${CSS_escape(href)}"]`;
  if (h.doc.head.querySelector(selector)) return; // dedupe
  const link = h.doc.createElement("link");
  link.setAttribute("rel", rel);
  link.setAttribute("href", href);
  for (const key in attrs) {
    const v = attrs[key];
    if (v != null) link.setAttribute(key, v);
  }
  h.doc.head.appendChild(link);
}

/** Escape a value for a CSS attribute selector (minimal — quotes/backslashes). */
function CSS_escape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Hint the browser to download a resource it will need soon (`<link rel="preload">`).
 *
 * @param href The resource URL.
 * @param options At minimum `as` (the resource kind).
 */
export function preload(href: string, options: PreloadOptions = {}): void {
  upsertLink("preload", href, {
    as: options.as,
    crossorigin: options.crossOrigin,
    integrity: options.integrity,
    type: options.type,
    fetchpriority: options.fetchPriority,
    nonce: options.nonce,
  });
}

/**
 * Eagerly load **and evaluate** a resource: a stylesheet (`as: "style"`) or a
 * script (`as: "script"`, inserted as `<script async>`).
 *
 * @param href The resource URL.
 * @param options Must include `as`.
 */
export function preinit(href: string, options: PreinitOptions): void {
  if (options.as === "style") {
    upsertLink("stylesheet", href, {
      crossorigin: options.crossOrigin,
      integrity: options.integrity,
      nonce: options.nonce,
      "data-precedence": options.precedence,
    });
    return;
  }
  const h = head();
  if (!h) return; // SSR: no-op
  if (h.doc.head.querySelector(`script[src="${CSS_escape(href)}"]`)) return;
  const script = h.doc.createElement("script");
  script.setAttribute("src", href);
  script.setAttribute("async", "");
  if (options.crossOrigin != null) script.setAttribute("crossorigin", options.crossOrigin);
  if (options.integrity != null) script.setAttribute("integrity", options.integrity);
  if (options.fetchPriority != null) script.setAttribute("fetchpriority", options.fetchPriority);
  if (options.nonce != null) script.setAttribute("nonce", options.nonce);
  h.doc.head.appendChild(script);
}

/**
 * Warm up a connection to an origin (`<link rel="preconnect">`).
 *
 * @param href The origin to connect to.
 * @param options CORS mode, if the eventual fetch is cross-origin.
 */
export function preconnect(href: string, options: PreconnectOptions = {}): void {
  upsertLink("preconnect", href, { crossorigin: options.crossOrigin });
}

/**
 * Resolve an origin's DNS ahead of time (`<link rel="dns-prefetch">`).
 *
 * @param href The origin whose DNS to resolve.
 */
export function prefetchDNS(href: string): void {
  upsertLink("dns-prefetch", href, {});
}
