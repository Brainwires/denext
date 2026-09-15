// A provider's `?error=` on the OAuth callback. Anyone can craft that URL, so only a
// protocol-shaped code reaches the sign-in page's `?error=` and `signInFailed.reason`.

import { assertEquals } from "@std/assert";
import { github } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";

/** GET the GitHub callback with `query`; answer the redirect's path + search. */
async function callbackLands(config: AuthConfig, query: string): Promise<string> {
  const request = new Request(`${ORIGIN}/auth/callback/github?${query}`);
  const ctx = createRequestContext(request);
  const res = (await runWithContext(ctx, () => handleAuthRequest(request, config)))!;
  const url = new URL(res.headers.get("location") ?? "", ORIGIN);
  return url.pathname + url.search;
}

Deno.test("OAuth callback: a protocol-shaped ?error= passes through; free text reads oauth_failed", async () => {
  const reasons: string[] = [];
  const warnings: unknown[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [github({ clientId: "id", clientSecret: "secret" })],
    pages: { signIn: "/login" },
    events: { signInFailed: ({ reason }) => void reasons.push(reason) },
    logger: { warn: (_message, data) => void warnings.push(data) },
  };
  assertEquals(await callbackLands(config, "error=access_denied"), "/login?error=access_denied");
  const spoof = encodeURIComponent("Your account is locked. Call +1 555 0100");
  assertEquals(await callbackLands(config, `error=${spoof}`), "/login?error=oauth_failed");
  assertEquals(reasons, ["access_denied", "oauth_failed"]);
  assertEquals(warnings.length, 1, "the raw text is logged, not reflected");
});
