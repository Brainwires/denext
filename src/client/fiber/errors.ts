// The client reconciler's own errors, by code. A production bundle throws the short form —
// the code and the component it names — and the full texts (error-texts.ts) are installed
// with the dev warnings (`installDevtools`), and by `denext/testing`, so they never ship in a
// production bundle. The codes are listed on the docs site's Troubleshooting page.

import type { Fiber } from "./fiber.ts";

/** A component rendered more hooks than in its previous render (Rules of Hooks). */
export const ERR_MORE_HOOKS = 1;
/** A component keeps scheduling an update during render ("Maximum update depth exceeded"). */
export const ERR_UPDATE_DEPTH = 2;
/** A component returned a Promise on the client (async components are server-only). */
export const ERR_ASYNC_COMPONENT = 3;
// Code 4 (`memo()` of a class component) is retired: memo(Class) renders, as in React.
/** A class component rendered with the class runtime off (or after it failed to load). */
export const ERR_CLASS_DISABLED = 5;
/**
 * A function-valued `action` / `formAction` rendered in a build whose scan of the app's sources
 * found none, so the form-action runtime was left out (the `__DENEXT_FORM_ACTIONS__` gate).
 */
export const ERR_FORM_ACTIONS_OFF = 6;
/**
 * Preact's `useErrorBoundary` called in a build whose scan of the app's sources found no use, so
 * the reconciler's hook-boundary seam was left out (the `__DENEXT_HOOK_BOUNDARIES__` gate).
 */
export const ERR_HOOK_BOUNDARIES_OFF = 7;
/**
 * A route-pattern href (`{ pathname: "/blog/[slug]", params }`) in a build whose scan of the app's
 * sources found none, so the pattern filling was left out (the `__DENEXT_HREF_PARAMS__` gate).
 */
export const ERR_HREF_PARAMS_OFF = 8;
/**
 * A server-rendered blur placeholder in a build whose scan of the app's sources found none, so
 * its clearing was left out (the `__DENEXT_IMAGE_BLUR__` gate).
 */
export const ERR_IMAGE_BLUR_OFF = 9;

/** A full error text: the named component (may be empty) and the fiber it was raised at. */
export type ErrorText = (name: string, fiber?: Fiber | null) => string;

let texts: Record<number, ErrorText> | null = null;

/** Install (or clear, with `null`) the full error texts, keyed by code. */
export function setErrorTexts(table: Record<number, ErrorText> | null): void {
  texts = table;
}

/**
 * The reconciler error `code`, naming the component `name` when given: its full text once
 * installed (dev, `denext/testing`), else `denext: error <code> in <name>` with a pointer to
 * the dev build.
 */
export function reconcilerError(code: number, name = "", fiber?: Fiber | null): Error {
  return new Error(
    texts
      ? texts[code](name, fiber)
      : `denext: error ${code}${name && ` in <${name}>`} (a dev build has the full message)`,
  );
}
