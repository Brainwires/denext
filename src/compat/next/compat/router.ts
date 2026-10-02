/**
 * `next/compat/router` compat: the Pages Router's router where one is mounted, else `null`.
 * Libraries that support both Next routers (`@clerk/nextjs`) call it to tell them apart; a denext
 * App Router app has no Pages Router, so it is always `null` — what Next itself returns under
 * the App Router.
 *
 * @module
 */

/**
 * The mounted Pages Router, or `null` (always `null` on denext's App Router).
 *
 * @returns `null`.
 */
export function useRouter(): null {
  return null;
}
