// The runtime's streaming `HTMLRewriter` (lol_html), opt-in.
//
// denext's Deno from runtime 3.0.0-denext.3 has Cloudflare Workers' `HTMLRewriter` as a global
// behind `--unstable-html-rewriter` (or `"unstable": ["html-rewriter"]` in deno.json). With
// `DENEXT_HTML_REWRITER=1` set as well, the response-time HTML injections stream through it
// instead of being rebuilt as a string; both paths write the same bytes for the same document.
//
// The string path is the default, even where the runtime has the rewriter: measured on runtime
// 3.0.0-denext.17, the rewriter is far slower for a shell already held in memory. A 600-byte
// shell stamps in 8 µs as a string and 1.7 ms through the rewriter (first chunk at 1.4 ms); a
// 17 KB shell with 22 scripts in 48 µs against 6.5 ms; a rewriter that changes nothing costs
// about 0.7 ms per transform. So the first bytes go out later, not sooner. The streaming path is
// kept for runtimes where a transform is cheap.

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

/** `DENEXT_HTML_REWRITER=1` puts the injections on the rewriter (where the runtime has one). */
const HTML_REWRITER_ENV = "DENEXT_HTML_REWRITER";

/** Whether the environment opts in to the rewriter (unreadable env: not). */
function optedIn(): boolean {
  try {
    return Deno.env.get(HTML_REWRITER_ENV) === "1";
  } catch {
    return false;
  }
}

/**
 * A new `HTMLRewriter` when `DENEXT_HTML_REWRITER=1` is set and the runtime has one, else `null`:
 * the caller then takes its string path (the default).
 *
 * @returns The rewriter, or `null`.
 */
export function newHtmlRewriter(): HtmlRewriter | null {
  const ctor = (globalThis as { HTMLRewriter?: new () => HtmlRewriter }).HTMLRewriter;
  if (typeof ctor !== "function" || !optedIn()) return null;
  return new ctor();
}
