// The runtime's streaming `HTMLRewriter` (lol_html), feature-probed.
//
// denext's Deno from runtime 3.0.0-denext.3 has Cloudflare Workers' `HTMLRewriter` as a global
// behind `--unstable-html-rewriter` (or `"unstable": ["html-rewriter"]` in deno.json). Where it is
// present, the response-time HTML injections stream through it: the rewritten bytes go out as
// the input is parsed, instead of after the whole document has been rebuilt as a string. Where it
// is not (stock Deno, an older runtime, the flag off), or `DENEXT_HTML_REWRITER=0` is set, each
// injection keeps its string path, which produces the same bytes for the same document.

/** The part of an end tag (`onEndTag`'s argument) the injections use. */
export interface RewriterEndTag {
  before(content: string, options?: { html?: boolean }): void;
}

/** The part of an `HTMLRewriter` element handler argument the injections use. */
export interface RewriterElement {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): RewriterElement;
  onEndTag(fn: (tag: RewriterEndTag) => void): void;
}

/** The part of the runtime's `HTMLRewriter` the injections use. */
export interface HtmlRewriter {
  on(selector: string, handlers: { element?: (el: RewriterElement) => void }): HtmlRewriter;
  transform(input: Response): Response;
}

/** `DENEXT_HTML_REWRITER=0` keeps every injection on its string path. */
const HTML_REWRITER_ENV = "DENEXT_HTML_REWRITER";

/** Whether the environment turns the rewriter off (unreadable env: left on). */
function optedOut(): boolean {
  try {
    return Deno.env.get(HTML_REWRITER_ENV) === "0";
  } catch {
    return false;
  }
}

/**
 * A new `HTMLRewriter`, or `null` where the runtime has none (or `DENEXT_HTML_REWRITER=0`): the
 * caller then takes its string path.
 *
 * @returns The rewriter, or `null`.
 */
export function newHtmlRewriter(): HtmlRewriter | null {
  const ctor = (globalThis as { HTMLRewriter?: new () => HtmlRewriter }).HTMLRewriter;
  if (typeof ctor !== "function" || optedOut()) return null;
  return new ctor();
}
