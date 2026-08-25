// The element id that wraps server-rendered page content for hydration.
//
// Extracted to its own leaf module (no imports) so the client — which needs this id
// for soft-nav container lookup — can import it WITHOUT pulling in `document.ts`,
// whose server-only transitive deps (request context, cache, prerender) import
// `node:async_hooks` and would poison the client bundle under a strict CSP.
export const ROOT_ID = "__denext";
