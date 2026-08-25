/**
 * Type surface for {@link https://htmx.org | htmx} attributes, for typed authoring
 * with the {@linkcode hx} spread helper. denext already renders any `hx-*`
 * attribute verbatim (its attribute model is a denylist, not an allowlist), so
 * these types are a **DX convenience** — autocomplete and typo-checking — never a
 * gate: writing raw `hx-post="/x"` on any element type-checks and works unchanged.
 *
 * @module
 */

/**
 * How htmx swaps the returned HTML into the DOM
 * ({@link https://htmx.org/attributes/hx-swap/ | `hx-swap`}). The `string` arm
 * keeps modifier syntax (`"innerHTML swap:200ms"`, `"beforeend show:top"`) open.
 */
export type HtmxSwap =
  | "innerHTML"
  | "outerHTML"
  | "textContent"
  | "beforebegin"
  | "afterbegin"
  | "beforeend"
  | "afterend"
  | "delete"
  | "none"
  // `string & Record<never, never>` keeps literal autocomplete while still
  // admitting htmx's modifier syntax (`"innerHTML swap:200ms"`, `"beforeend show:top"`).
  | (string & Record<never, never>);

/**
 * The htmx attributes, in the ergonomic un-prefixed form the {@linkcode hx} helper
 * accepts (`post` → `hx-post`, `on` with a key → `hx-on:*`). Every field is
 * optional; unknown htmx extensions fall through the string index. See the
 * {@link https://htmx.org/reference/#attributes | htmx attribute reference}.
 */
export interface HtmxAttributes {
  /** Issue a GET to this URL and swap the response ({@link https://htmx.org/attributes/hx-get/ | `hx-get`}). */
  get?: string;
  /** Issue a POST to this URL ({@link https://htmx.org/attributes/hx-post/ | `hx-post`}). */
  post?: string;
  /** Issue a PUT to this URL (`hx-put`). */
  put?: string;
  /** Issue a PATCH to this URL (`hx-patch`). */
  patch?: string;
  /** Issue a DELETE to this URL (`hx-delete`). */
  delete?: string;
  /** How to swap the response into the DOM ({@link https://htmx.org/attributes/hx-swap/ | `hx-swap`}). */
  swap?: HtmxSwap;
  /** Swap the response into a different element, out of band (`hx-swap-oob`). */
  swapOob?: string | boolean;
  /** CSS selector of the element to swap into ({@link https://htmx.org/attributes/hx-target/ | `hx-target`}). */
  target?: string;
  /** The event(s) that trigger the request ({@link https://htmx.org/attributes/hx-trigger/ | `hx-trigger`}). */
  trigger?: string;
  /** Include extra parameters with the request (`hx-params`, `hx-vals`, or `hx-include`). */
  include?: string;
  /** Serialize extra values as JSON with the request (`hx-vals`). */
  vals?: string;
  /** Filter which parameters are submitted (`hx-params`). */
  params?: string;
  /** Show a confirm() dialog before issuing the request ({@link https://htmx.org/attributes/hx-confirm/ | `hx-confirm`}). */
  confirm?: string;
  /** Prompt for a value before the request, sent as `HX-Prompt` (`hx-prompt`). */
  prompt?: string;
  /** Push (or replace) the URL into browser history ({@link https://htmx.org/attributes/hx-push-url/ | `hx-push-url`}). */
  pushUrl?: string | boolean;
  /** Replace the current URL in history without a new entry (`hx-replace-url`). */
  replaceUrl?: string | boolean;
  /** Progressively enhance links/forms to use ajax ({@link https://htmx.org/attributes/hx-boost/ | `hx-boost`}). */
  boost?: boolean;
  /** Select a subset of the response to swap in ({@link https://htmx.org/attributes/hx-select/ | `hx-select`}). */
  select?: string;
  /** Select a subset of an out-of-band response (`hx-select-oob`). */
  selectOob?: string;
  /** Element whose content is shown while the request is in flight (`hx-indicator`). */
  indicator?: string;
  /** Synchronize requests across elements (`hx-sync`). */
  sync?: string;
  /** Disable htmx processing for this element and its children (`hx-disable`). */
  disable?: boolean;
  /** Disable named elements during the request (`hx-disabled-elt`). */
  disabledElt?: string;
  /** The encoding for the request, e.g. `"multipart/form-data"` (`hx-encoding`). */
  encoding?: string;
  /** Add request headers, as a JSON string (`hx-headers`). */
  headers?: string;
  /** Preserve this element across a swap, keyed by id (`hx-preserve`). */
  preserve?: boolean;
  /** Extensions to enable on this element and its children (`hx-ext`). */
  ext?: string;
  /**
   * Inline event handlers, keyed by event name → script
   * ({@link https://htmx.org/attributes/hx-on/ | `hx-on:*`}). `{ "click": "…",
   * "htmx:afterRequest": "…" }` renders as `hx-on:click` / `hx-on:htmx:afterRequest`.
   */
  on?: Record<string, string>;
  /** Any other `hx-*` attribute (rendered verbatim). */
  [attr: string]: unknown;
}
