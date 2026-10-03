// Whether the Clerk keys are set. Read from the environment, which `denext dev` / `build` /
// `start` fill from `.env` and `.env.local` in this directory (both git-ignored); see
// `.env.example`. Never import a value from here into client code: the secret key stays on the
// server, and only `NEXT_PUBLIC_*` reaches the page.

/** An env var, or undefined (unset, empty, or no env permission). */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The publishable key's shape: `pk_test_…` (development) or `pk_live_…` (production). */
const PUBLISHABLE = /^pk_(?:test|live)_[A-Za-z0-9+/=_-]+$/;

/** Whether the publishable key (the one the page needs) is set and well-formed. */
export function hasPublishableKey(): boolean {
  return PUBLISHABLE.test(env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") ?? "");
}

/** Whether the server can verify sessions: the publishable key plus the secret key. */
export function hasServerKeys(): boolean {
  return hasPublishableKey() && /^sk_(?:test|live)_\S+$/.test(env("CLERK_SECRET_KEY") ?? "");
}

/**
 * Clerk's JWT public key (`CLERK_JWT_KEY`, the PEM from the dashboard's API keys page), when set:
 * the middleware then verifies session tokens networklessly instead of fetching the instance's
 * JWKS with the secret key.
 */
export function clerkJwtKey(): string | undefined {
  return env("CLERK_JWT_KEY");
}
