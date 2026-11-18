// The scheme check for a URL the client is about to hand to `location`.
//
// `location.href = "javascript:…"` runs the script in the page, exactly as following an
// `<a href="javascript:…">` does. The render path already drops such an `href`
// (`refusesUrlAttr`); a programmatic navigation needs the same rule, because its URL is as
// often the request's (`router.push(searchParams.get("next"))`, a client `redirect(next)`, a
// `<Link href={next}>` whose click handler navigates even though its attribute was dropped).

import { refusesUrlAttr } from "../jsx/render-to-string.ts";

/**
 * Whether navigating to `url` would run script (`javascript:`, `vbscript:`, an executable
 * `data:`) rather than load a page: the rule an `href` attribute is held to, which ignores the
 * whitespace and control characters a browser ignores in a scheme. A relative URL never has one.
 *
 * @param url The navigation target, absolute or relative to the current page.
 * @returns Whether the navigation must be refused.
 */
export function isScriptUrl(url: string): boolean {
  return refusesUrlAttr(undefined, "href", url);
}
