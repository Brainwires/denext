/**
 * React 19 resource-preloading APIs (`react-dom`): `preload`, `preinit`,
 * `preconnect`, `prefetchDNS`. On the **client** they inject the corresponding
 * `<link>`/`<script>` into `document.head`, deduplicated by rel+href (the esbuild
 * parallel to what React emits). During **SSR** they serialize the same tag and hand
 * it to the injected {@link setSsrHintSink hint sink} (the server routes it into the
 * request's `<head>`); with no sink installed (e.g. a unit test) they are a no-op.
 *
 * @module
 */

/**
 * SSR sink for a serialized resource-hint tag. The server installs one (routing to
 * the current request's head) via {@link setSsrHintSink}; kept as an injection so
 * this client-shippable module never imports server-only code (`node:async_hooks`).
 */
let ssrHintSink: ((tag: string) => void) | null = null;

/** Install (or clear) the SSR resource-hint sink. Called once by the server runtime. */
export function setSsrHintSink(sink: ((tag: string) => void) | null): void {
  ssrHintSink = sink;
}

/** Serialize a `<link rel …>` tag from an attribute bag (skipping empty values). */
function serializeLink(
  rel: string,
  href: string,
  attrs: Record<string, string | undefined>,
): string {
  let out = `<link rel="${rel}" href="${escapeAttr(href)}"`;
  for (const key in attrs) {
    const v = attrs[key];
    if (v != null) out += ` ${key}="${escapeAttr(v)}"`;
  }
  return out + ">";
}

/** Minimal double-quote/`&`/`<` escaping for an attribute value. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

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
  /** Responsive candidate set for `as="image"` (serialized as `imagesrcset`). */
  imageSrcSet?: string;
  /** Sizes for a responsive image preload (serialized as `imagesizes`). */
  imageSizes?: string;
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
  if (!h) {
    // SSR: hand the serialized tag to the sink so it lands in the server `<head>`.
    ssrHintSink?.(serializeLink(rel, href, attrs));
    return;
  }
  // Dedupe by rel+href, and also by `as` for preloads (React treats different `as`
  // as distinct resources). Guard querySelector: a malformed href can make the
  // attribute selector invalid — skip dedupe rather than throw in the caller.
  let selector = `link[rel="${rel}"][href="${cssEscape(href)}"]`;
  if (attrs.as != null) selector += `[as="${cssEscape(attrs.as)}"]`;
  try {
    if (h.doc.head.querySelector(selector)) return;
  } catch { /* invalid selector from an exotic href — fall through and append */ }
  const link = h.doc.createElement("link");
  link.setAttribute("rel", rel);
  link.setAttribute("href", href);
  for (const key in attrs) {
    const v = attrs[key];
    if (v != null) link.setAttribute(key, v);
  }
  h.doc.head.appendChild(link);
}

/** Escape a value for a CSS attribute selector (quotes, backslashes, newlines). */
function cssEscape(value: string): string {
  return value.replace(/["\\\n\r\f]/g, "\\$&");
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
    imagesrcset: options.imageSrcSet,
    imagesizes: options.imageSizes,
  });
}

/**
 * Eagerly load **and evaluate** a resource: a stylesheet (`as: "style"`) or a
 * script (`as: "script"`, inserted as `<script async>`).
 *
 * @param href The resource URL.
 * @param options Must include `as`.
 */
export function preinit(href: string, options: PreinitOptions = { as: "script" }): void {
  if (options.as === "style") {
    upsertLink("stylesheet", href, {
      crossorigin: options.crossOrigin,
      integrity: options.integrity,
      nonce: options.nonce,
      "data-precedence": options.precedence,
    });
    return;
  }
  ensureScript(`script[src="${cssEscape(href)}"]`, [
    ["src", href],
    ["async", ""],
    ["crossorigin", options.crossOrigin],
    ["integrity", options.integrity],
    ["fetchpriority", options.fetchPriority],
    ["nonce", options.nonce],
  ]);
}

/** Attribute pairs in emission order; an undefined value is omitted, "" is a bare attribute. */
type ScriptAttrs = Array<[string, string | undefined]>;

/**
 * Inject a `<script>` once: during SSR serialize it to the hint sink; in the browser
 * append it to `<head>` unless a matching script (by `selector`) is already there.
 */
function ensureScript(selector: string, attrs: ScriptAttrs): void {
  const h = head();
  if (!h) {
    let tag = "<script";
    for (const [name, value] of attrs) {
      if (value === undefined) continue;
      tag += value === "" ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`;
    }
    ssrHintSink?.(tag + "></script>");
    return;
  }
  try {
    if (h.doc.head.querySelector(selector)) return;
  } catch { /* invalid selector — fall through and append */ }
  const script = h.doc.createElement("script");
  for (const [name, value] of attrs) {
    if (value !== undefined) script.setAttribute(name, value);
  }
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

/** Options for {@link preloadModule}/{@link preinitModule}. */
export interface PreloadModuleOptions {
  /** Module kind (`script` is the default/only meaningful value). */
  as?: string;
  /** CORS mode. */
  crossOrigin?: string;
  /** Subresource integrity hash. */
  integrity?: string;
  /** Nonce for CSP. */
  nonce?: string;
}

/**
 * Preload an ES module the app will import soon (`<link rel="modulepreload">`) — the
 * module counterpart of {@link preload}.
 *
 * @param href The module URL.
 * @param options Module options (`crossOrigin`/`integrity`/`nonce`).
 */
export function preloadModule(href: string, options: PreloadModuleOptions = {}): void {
  upsertLink("modulepreload", href, {
    as: options.as,
    crossorigin: options.crossOrigin,
    integrity: options.integrity,
    nonce: options.nonce,
  });
}

/**
 * Eagerly load **and evaluate** an ES module (`<script type="module">`) — the module
 * counterpart of {@link preinit}.
 *
 * @param href The module URL.
 * @param options Module options (`crossOrigin`/`integrity`/`nonce`).
 */
export function preinitModule(href: string, options: PreloadModuleOptions = {}): void {
  ensureScript(`script[type="module"][src="${cssEscape(href)}"]`, [
    ["type", "module"],
    ["src", href],
    ["crossorigin", options.crossOrigin],
    ["integrity", options.integrity],
    ["nonce", options.nonce],
  ]);
}

/**
 * `ReactDOM.requestFormReset` — schedule a native reset of `form`, mirroring what React
 * does after a successful action submit. denext resets the form directly (best-effort;
 * a no-op if the element has no `reset`).
 *
 * @param form The form element to reset.
 */
export function requestFormReset(form: HTMLFormElement): void {
  try {
    form?.reset?.();
  } catch { /* detached/invalid form — nothing to reset */ }
}

/**
 * Resolve an origin's DNS ahead of time (`<link rel="dns-prefetch">`).
 *
 * @param href The origin whose DNS to resolve.
 */
export function prefetchDNS(href: string): void {
  upsertLink("dns-prefetch", href, {});
}
