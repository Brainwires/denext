import type { DenextConfig } from "denext/server";
import { clerkCsp } from "./lib/clerk-csp.ts";

/** An env var, or undefined (unset, or no env permission — the packaged desktop app). */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A comma-separated env var as a list. */
function list(name: string): string[] {
  return (env(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export default {
  // A Next.js-style app on denext's compat pipeline: `@clerk/nextjs` (and its `next/*` and
  // `react` imports) run on denext unchanged.
  compatibilityMode: true,
  // denext's strict CSP plus what Clerk loads (lib/clerk-csp.ts).
  csp: clerkCsp(env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")),
  // Other devices on the tailnet: `denext dev --host 0.0.0.0` (deno task dev:lan) allows this
  // machine's own addresses; DENEXT_CLERK_DEV_HOST adds its MagicDNS name (README → Tailscale).
  allowedDevOrigins: list("DENEXT_CLERK_DEV_HOST"),
  // The Deno Desktop build (deno task desktop / desktop:package), under denext's pinned runtime.
  desktop: {
    // The window test launches the bundle itself: no installers.
    installers: { macos: [], linux: [], windows: [] },
    app: {
      name: "denext Clerk",
      // Keys the OS storage dirs and the keychain service.
      identifier: "dev.denext.clerk-example",
      // The page origin Clerk's Frontend API sees. Add it to the instance's allowed origins and
      // `denextclerk://app/` to its native redirect allowlist (README → Clerk dashboard).
      origin: "denextclerk://app",
      // Google / GitHub sign-in returns to denextclerk://app/ (on Windows and Linux as a deep link).
      deepLinks: ["denextclerk"],
      singleInstance: true,
    },
    // Installs the Clerk bridge before any page script (synchronously: see desktop/preload.ts).
    preload: "./desktop/preload.ts",
    window: { width: 1000, height: 780, title: "denext + Clerk" },
    capabilities: {
      // Clerk's client JWT, in the OS keychain: the session survives a relaunch.
      secureStore: true,
      // OAuth: ASWebAuthenticationSession on macOS, the system browser + Cancel overlay elsewhere.
      authSession: true,
      // Native passkeys for these relying parties only (DENEXT_CLERK_PASSKEY_RP_IDS, at package
      // time). A development instance's passkeys belong to Clerk's own domains, which a desktop
      // build cannot be entitled for: with none listed, a passkey sign-in continues in the
      // browser (Clerk's hosted pages). See README → Passkeys.
      passkeys: { rpIds: list("DENEXT_CLERK_PASSKEY_RP_IDS") },
      // The desktop e2e harness (e2e/desktop-test.ts): only when the runner evaluates the config.
      ...(env("DENEXT_CLERK_E2E") === "1" ? { extensions: ["./desktop/e2e.ts"] } : {}),
    },
  },
} satisfies DenextConfig;
