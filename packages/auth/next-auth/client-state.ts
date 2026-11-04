"use client";
/**
 * The browser state `next-auth/react` and `next-auth/webauthn` share: the handlers' base path
 * (the most recently mounted `SessionProvider`'s), every mounted provider's session refetch, and
 * the same-origin rule for a `callbackUrl`. One module, so the compat build's code splitting
 * hands both entry points the same instance.
 *
 * @module
 */

/** The endpoint prefix `NextAuth()`'s handlers are mounted on unless `basePath` says otherwise. */
export const DEFAULT_BASE_PATH = "/api/auth";

/** The prefix the most recently mounted provider uses (what the standalone functions call). */
export const clientState: { basePath: string } = { basePath: DEFAULT_BASE_PATH };

/** Every mounted provider's refetch, so a sign-in / sign-out updates them all. */
export const refetchers: Set<() => void> = new Set();

/**
 * Refetch the session in every mounted provider.
 *
 * @returns Once every refetch has started.
 */
export function refreshProviders(): Promise<void> {
  for (const refetch of refetchers) refetch();
  return Promise.resolve();
}

/**
 * The current page (`/` outside a browser).
 *
 * @returns Its URL.
 */
export function currentHref(): string {
  return typeof location === "undefined" ? "/" : location.href;
}

/**
 * `requested` as a URL on this page's origin, else this page — a `callbackUrl` read out of the
 * address bar is attacker-influenced, and the callers navigate to it.
 *
 * @param requested The requested URL.
 * @returns A same-origin http(s) URL.
 */
export function sameOrigin(requested: unknown): string {
  const here = new URL(currentHref(), "http://localhost");
  if (typeof requested !== "string" || !requested) return here.href;
  try {
    const url = new URL(requested, here);
    const web = url.protocol === "http:" || url.protocol === "https:";
    return url.origin === here.origin && web ? url.href : here.href;
  } catch {
    return here.href;
  }
}

/**
 * Follow `url` (reloading when only the hash changes).
 *
 * @param url Where to go.
 */
export function navigate(url: string): void {
  if (typeof location === "undefined") return;
  location.href = url;
  if (url.includes("#")) location.reload();
}
