// A page module's request middleware: a function the page module exports under
// {@link PAGE_REQUEST_MIDDLEWARE_EXPORT} that wraps the whole page request — every stage
// `servePage` runs (the ISR cache, the prerendered shell, metadata, the render and the
// document or soft-navigation payload) — and resolves to the response. The React Router
// runtime (`denext/remix`) generates one for a route whose route chain exports `middleware`,
// so the chain's `next()` resolves to the rendered response, as React Router's does.

/** The page-module export the pipeline runs around the page request. Internal. */
export const PAGE_REQUEST_MIDDLEWARE_EXPORT = "__denextRequestMiddleware";

/** What a {@link PageRequestMiddleware} receives. */
export interface PageRequestMiddlewareArgs {
  /** The incoming request. */
  request: Request;
  /** The matched page's URL params (what its component receives as `params`). */
  params: Record<string, string | string[]>;
  /**
   * Serve the page and resolve to its response. It never rejects: an error that escapes the
   * render resolves to the error response (`onError`, else the 500 page), as {@link recover}
   * makes it. Call it at most once.
   */
  render: () => Promise<Response>;
  /** The app's response for an error (reported to instrumentation first). */
  recover: (error: unknown) => Promise<Response>;
}

/** A page request middleware: resolves to the page's response, or a response of its own. */
export type PageRequestMiddleware = (args: PageRequestMiddlewareArgs) => Promise<Response>;

/**
 * The request middleware `mod` exports, if it does.
 *
 * @param mod The loaded page module.
 * @returns The middleware, or `undefined`.
 */
export function pageRequestMiddlewareOf(mod: unknown): PageRequestMiddleware | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const fn = (mod as Record<string, unknown>)[PAGE_REQUEST_MIDDLEWARE_EXPORT];
  return typeof fn === "function" ? fn as PageRequestMiddleware : undefined;
}
