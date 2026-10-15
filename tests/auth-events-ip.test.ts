// `ip` on every auth event: each payload names the client address of the request that caused
// it — the socket peer, or a trusted proxy's last `x-forwarded-for` hop — the way `clientIp()`
// reads it. A forged `x-forwarded-for` is never believed without proxy trust, and an event
// raised outside any request carries none.

import { assertEquals } from "@std/assert";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { emitAuthEvent } from "../src/server/auth/events.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

type Seen = { name: string; ip?: string };

function config(seen: Seen[], extra: Partial<AuthConfig> = {}): AuthConfig {
  const record = (name: string) => (p: { ip?: string }) => void seen.push({ name, ip: p.ip });
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: ({ email, password }) =>
          email === "a@b.co" && password === "pw" ? { id: "u1", email } : null,
      }),
    ],
    events: {
      signIn: record("signIn"),
      signOut: record("signOut"),
      signInFailed: record("signInFailed"),
      sessionRevoked: record("sessionRevoked"),
    },
    ...extra,
  };
}

function call(
  cfg: AuthConfig,
  path: string,
  init: { body?: unknown; peer?: string; xff?: string; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: ORIGIN,
    "content-type": "application/json",
  };
  if (init.xff) headers["x-forwarded-for"] = init.xff;
  if (init.cookie) headers.cookie = init.cookie;
  const request = new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (init.peer) {
    setRemoteAddr(request, { transport: "tcp", hostname: init.peer, port: 4000 });
  }
  return runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, cfg),
  ) as Promise<Response>;
}

function sessionCookie(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

Deno.test("auth events: signIn and signOut carry the socket peer as `ip`", async () => {
  const seen: Seen[] = [];
  const cfg = config(seen);
  const ok = await call(cfg, "/auth/callback/credentials", {
    body: { email: "a@b.co", password: "pw" },
    peer: "203.0.113.7",
  });
  assertEquals(ok.status, 200);
  await call(cfg, "/auth/signout", { peer: "203.0.113.8", cookie: sessionCookie(ok) });
  assertEquals(seen, [
    { name: "signIn", ip: "203.0.113.7" },
    { name: "signOut", ip: "203.0.113.8" },
  ]);
});

Deno.test("auth events: a forged x-forwarded-for is ignored without proxy trust", async () => {
  const seen: Seen[] = [];
  const cfg = config(seen, { trustForwardedHeaders: false });
  await call(cfg, "/auth/callback/credentials", {
    body: { email: "a@b.co", password: "pw" },
    peer: "198.51.100.1",
    xff: "1.2.3.4",
  });
  assertEquals(seen, [{ name: "signIn", ip: "198.51.100.1" }]);
});

Deno.test("auth events: behind a trusted proxy `ip` is the proxy's last forwarded hop", async () => {
  const seen: Seen[] = [];
  const cfg = config(seen, { trustForwardedHeaders: true });
  await call(cfg, "/auth/callback/credentials", {
    body: { email: "a@b.co", password: "pw" },
    peer: "10.0.0.2",
    xff: "6.6.6.6, 192.0.2.44",
  });
  assertEquals(seen, [{ name: "signIn", ip: "192.0.2.44" }]);
});

Deno.test("auth events: an event raised outside any request carries no `ip`", async () => {
  const seen: Seen[] = [];
  // What `revokeAllSessions(userId)` raises when a job calls it: no request in sight.
  await emitAuthEvent(resolveAuthOptions(config(seen)), "sessionRevoked", { userId: "u1" });
  assertEquals(seen, [{ name: "sessionRevoked", ip: undefined }]);
});
