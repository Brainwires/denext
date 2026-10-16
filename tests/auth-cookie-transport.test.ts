// denextAuth's cookies follow the transport: `__Host-` (Secure) over https, plain names over
// plain http on a loopback host or outside production — a browser refuses `__Host-` over http,
// even on `localhost`, so `denext dev` could never hold a session — and `__Host-` again for
// production http on any other host (refused there, as before).

import { assertEquals } from "@std/assert";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { plainHttpCookies } from "../src/server/auth/options.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";

const SECRET = "auth-cookie-transport-secret-at-least-32";
const FORCE_PRODUCTION = Symbol.for("denext.testing.forceProduction");

function config(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    providers: [
      credentials({ authorize: ({ email }) => email === "a@b.co" ? { id: "u1", email } : null }),
    ],
    ...extra,
  };
}

/** The session cookie name a credentials sign-in at `origin` sets. */
async function sessionCookieAt(
  origin: string,
  cfg = config(),
  headers: Record<string, string> = {},
): Promise<string> {
  const request = new Request(`${origin}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin,
      host: new URL(origin).host,
      ...headers,
    },
    body: JSON.stringify({ email: "a@b.co", password: "x" }),
  });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, cfg));
  assertEquals(res?.status, 200);
  const line = ctx.outgoingHeaders.getSetCookie().find((c) => c.includes("denext_auth="))!;
  return line.split("=")[0];
}

/** `plainHttpCookies` for a request to `url`. */
function plainAt(url: string, cfg = config(), headers: Record<string, string> = {}): boolean {
  const request = new Request(url, { headers });
  return runWithContext(createRequestContext(request), () => plainHttpCookies(cfg));
}

Deno.test("auth cookies: __Host- over https, plain over http on localhost", async () => {
  assertEquals(await sessionCookieAt("https://app.test"), "__Host-denext_auth");
  assertEquals(await sessionCookieAt("http://localhost:3000"), "denext_auth");
  assertEquals(await sessionCookieAt("http://127.0.0.1:3000"), "denext_auth");
  // Behind a TLS-terminating proxy the scheme comes from x-forwarded-proto.
  assertEquals(
    await sessionCookieAt("http://localhost:3000", config(), { "x-forwarded-proto": "https" }),
    "__Host-denext_auth",
  );
});

Deno.test("auth cookies: the transport rule, case by case", () => {
  assertEquals(plainAt("https://app.test/"), false);
  assertEquals(plainAt("http://localhost:3000/"), true);
  assertEquals(plainAt("http://dev.localhost:3000/"), true);
  assertEquals(plainAt("http://[::1]:3000/"), true);
  assertEquals(plainAt("http://192.168.1.5:3000/"), true, "outside production, any host");
  // An https canonicalOrigin means the app is served over TLS: always prefixed.
  assertEquals(
    plainAt("http://localhost:3000/", config({ canonicalOrigin: "https://app.test" })),
    false,
  );
  // Outside a request there is no transport to read: prefixed.
  assertEquals(plainHttpCookies(config()), false);
});

Deno.test("auth cookies: in production, plain http keeps __Host- off loopback only", () => {
  const g = globalThis as Record<symbol, unknown>;
  g[FORCE_PRODUCTION] = true;
  try {
    assertEquals(plainAt("http://localhost:8000/"), true, "loopback: a local production run");
    assertEquals(plainAt("http://app.example.com/"), false, "never a session in clear text");
    assertEquals(plainAt("http://10.0.0.2/"), false);
  } finally {
    delete g[FORCE_PRODUCTION];
  }
});
