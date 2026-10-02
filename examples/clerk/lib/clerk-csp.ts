/**
 * The Content-Security-Policy sources Clerk needs on top of denext's strict default
 * (https://clerk.com/docs/guides/secure/best-practices/csp-headers): the Frontend API host
 * (clerk-js and its UI load from it), Cloudflare's bot protection, Clerk's abuse protection,
 * avatars, the telemetry endpoint, and inline styles for its CSS-in-JS components.
 */

/** The Frontend API host a publishable key encodes (`pk_test_<base64("host$")>`), or null. */
export function frontendApiHost(publishableKey: string | undefined): string | null {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey ?? "");
  if (!m) return null;
  try {
    const decoded = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : "";
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** The `csp` opt-ins for `denext.config.ts`. */
export function clerkCsp(publishableKey: string | undefined) {
  const host = frontendApiHost(publishableKey);
  // A development instance's Frontend API is `<slug>.clerk.accounts.dev`; a production one is
  // your own `clerk.<domain>` (named by the key).
  const fapi = ["https://*.clerk.accounts.dev", ...(host ? [`https://${host}`] : [])];
  return {
    scriptSrc: [...fapi, "https://challenges.cloudflare.com", "https://*.protect.clerk.com"],
    connectSrc: [
      ...fapi,
      "https://*.protect.clerk.com:*",
      "https://clerk-telemetry.com",
      "https://*.clerk-telemetry.com",
    ],
    imgSrc: ["https://img.clerk.com"],
    styleSrc: ["'unsafe-inline'"],
    frameSrc: ["https://challenges.cloudflare.com", "https://*.protect.clerk.com"],
    workerSrc: ["blob:"],
  };
}
