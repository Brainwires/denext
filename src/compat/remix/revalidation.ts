// Shared, ISOMORPHIC pieces of the Remix `shouldRevalidate` optimization (no server-only
// imports — safe in the client bundle). On a client revalidation (a soft nav or a
// `router.refresh()`), the client sends — for each route it currently has data for and whose
// data fits a size budget — that route's prior loader data + params, plus the URL it is coming
// from. The server evaluates each route's `shouldRevalidate`; when it returns `false` the server
// SKIPS that loader's WORK (the DB query) and renders the route with the client's echoed prior
// data instead. Always-revalidate stays the default (no header, `shouldRevalidate` returning
// true, or data too large to echo) — which is never stale.

/** csv of the route ids the client is offering to keep (present ⇒ this is a revalidation). */
export const REVALIDATE_HEADER = "x-denext-revalidate";
/** JSON `{ [routeId]: data }` — the client's prior loader data for the ids that fit the budget. */
export const LOADER_DATA_HEADER = "x-denext-loader-data";
/** The pathname+search the client is navigating FROM (the `currentUrl` for shouldRevalidate). */
export const FROM_HEADER = "x-denext-from";
/** JSON `{ [routeId]: params }` — the client's prior per-route params (`currentParams`). */
export const PARAMS_HEADER = "x-denext-params";
/** The submitting form's method, when a revalidation follows a submission. */
export const FORM_METHOD_HEADER = "x-denext-form-method";
/** The submitting form's action, when a revalidation follows a submission. */
export const FORM_ACTION_HEADER = "x-denext-form-action";

/**
 * Max UTF-16 length of the echoed prior-data JSON. A route whose data would push the payload
 * past this is simply not offered for keeping (the server revalidates it) — so the optimization
 * never risks an over-large request header. Generous for the typical ancestor/nav data it targets.
 */
export const MAX_KEPT_DATA_CHARS = 6144;

/** The argument Remix passes to a route's `shouldRevalidate` (the subset denext threads). */
export interface ShouldRevalidateArgs {
  currentUrl: URL;
  nextUrl: URL;
  currentParams: Record<string, string>;
  nextParams: Record<string, string>;
  formMethod?: string;
  formAction?: string;
  actionResult?: unknown;
  defaultShouldRevalidate: boolean;
}

/** A route's `shouldRevalidate` — returns `true` to re-run the loader, `false` to keep prior data. */
export type ShouldRevalidateFunction = (args: ShouldRevalidateArgs) => boolean;
