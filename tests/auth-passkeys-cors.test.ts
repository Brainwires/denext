// Passkey endpoints called from another origin (`passkeys.corsOrigins`): an exact allowlist,
// credentialed CORS (preflight and actual answers), and the ceremony bound to the origin that
// started it — a ceremony started cross-origin completes only from that origin with client data
// naming it, a same-origin one only same-origin — on top of the per-tab ceremony id.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { resolvePasskeys } from "../src/server/auth/passkeys.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { Authenticator } from "./helpers/soft-authenticator.ts";

const AUTH = "https://auth.app.test"; // the server
const WEB = "https://www.app.test"; // the front end, allowed cross-origin
const OTHER = "https://other.app.test"; // a ceremony origin NOT allowed to call cross-origin
const EVIL = "https://evil.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@app.test";
const PASSWORD = "correct horse battery staple";

interface App {
  config: AuthConfig;
  adapter: AuthAdapter;
}

async function app(): Promise<App> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({
    email: EMAIL,
    emailVerified: Math.floor(Date.now() / 1000),
  });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  return {
    adapter,
    config: {
      secret: SECRET,
      canonicalOrigin: AUTH,
      providers: [{ id: "credentials", type: "credentials" }],
      adapter,
      rateLimit: false,
      passkeys: { rpId: "app.test", origins: [AUTH, WEB, OTHER], corsOrigins: [WEB] },
      logger: { warn: () => {}, error: () => {}, debug: () => {} },
    },
  };
}

/** A browser holding the auth server's cookies; each call names the page origin it runs on. */
class Browser {
  jar = new Map<string, string>();
  ceremonyId: string | undefined;
  constructor(private readonly a: App) {}

  async send(
    origin: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", origin, ...extra };
    if (body) headers["content-type"] = "application/json";
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const verifying = path === "/passkey/register" || path === "/passkey/authenticate";
    const payload = verifying && body && !("ceremonyId" in body)
      ? { ...body, ceremonyId: this.ceremonyId }
      : body;
    const request = new Request(`${AUTH}/auth${path}`, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const ctx = createRequestContext(request);
    const res = await runWithContext(ctx, () => handleAuthRequest(request, this.a.config));
    for (const line of ctx.outgoingHeaders.getSetCookie()) {
      const pair = line.split(";")[0];
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
    assert(res, `${method} ${path} fell through`);
    if (method === "POST" && path.endsWith("/options") && res.ok) {
      this.ceremonyId = (await res.clone().json()).ceremonyId;
    }
    return res;
  }

  signIn(): Promise<Response> {
    return this.send(AUTH, "POST", "/callback/credentials", { email: EMAIL, password: PASSWORD });
  }
}

/** A passkey registered for the user (same-origin), and a fresh browser to sign in with. */
async function registered(a: App): Promise<{ auth: Authenticator; b: Browser }> {
  const auth = await Authenticator.create();
  const owner = new Browser(a);
  assertEquals((await owner.signIn()).status, 200);
  const options = await (await owner.send(AUTH, "POST", "/passkey/register/options", {})).json();
  const res = await owner.send(AUTH, "POST", "/passkey/register", {
    credential: await auth.register(options, { origin: AUTH }),
  });
  assertEquals(res.status, 200, await res.clone().text());
  return { auth, b: new Browser(a) };
}

function corsOf(res: Response) {
  return {
    origin: res.headers.get("access-control-allow-origin"),
    credentials: res.headers.get("access-control-allow-credentials"),
    vary: res.headers.get("vary") ?? "",
  };
}

// ---- CORS ---------------------------------------------------------------------------------------

Deno.test("passkeys cors: a preflight from a listed origin is approved, credentialed", async () => {
  const a = await app();
  const b = new Browser(a);
  const ok = await b.send(WEB, "OPTIONS", "/passkey/authenticate/options", undefined, {
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type, x-denext-auth",
  });
  assertEquals(ok.status, 204);
  assertEquals(corsOf(ok).origin, WEB);
  assertEquals(corsOf(ok).credentials, "true");
  for (const origin of [OTHER, EVIL]) {
    const refused = await b.send(origin, "OPTIONS", "/passkey/authenticate", undefined, {
      "access-control-request-method": "POST",
    });
    assertEquals(corsOf(refused).origin, null, origin);
  }
});

Deno.test("passkeys cors: a usernameless sign-in from the listed origin, with CORS headers", async () => {
  const a = await app();
  const { auth, b } = await registered(a);
  const optionsRes = await b.send(WEB, "POST", "/passkey/authenticate/options", {});
  assertEquals(optionsRes.status, 200);
  assertEquals(corsOf(optionsRes).origin, WEB);
  assert(corsOf(optionsRes).vary.includes("Origin"));
  const options = await optionsRes.json();
  const res = await b.send(WEB, "POST", "/passkey/authenticate", {
    credential: await auth.assert(options, { origin: WEB }),
  });
  assertEquals(res.status, 200, await res.clone().text());
  assertEquals(corsOf(res).origin, WEB);
  assertEquals(corsOf(res).credentials, "true");
  assertEquals((await res.json()).ok, true);
});

Deno.test("passkeys cors: an origin not in corsOrigins is refused (same as before: same-origin only)", async () => {
  const a = await app();
  const b = new Browser(a);
  for (const origin of [OTHER, EVIL]) {
    const res = await b.send(origin, "POST", "/passkey/authenticate/options", {});
    assertEquals(res.status, 403, origin);
    assertEquals(corsOf(res).origin, null);
  }
});

Deno.test("passkeys cors: registration from the listed origin carries the session cookie", async () => {
  const a = await app();
  const b = new Browser(a);
  await b.signIn();
  const auth = await Authenticator.create();
  const options = await (await b.send(WEB, "POST", "/passkey/register/options", {})).json();
  const res = await b.send(WEB, "POST", "/passkey/register", {
    credential: await auth.register(options, { origin: WEB }),
  });
  assertEquals(res.status, 200, await res.clone().text());
  assertEquals(corsOf(res).origin, WEB);
});

// ---- the ceremony binding -----------------------------------------------------------------------

Deno.test("passkeys cors: a cross-origin ceremony completes only from its origin, naming it", async () => {
  const a = await app();
  const { auth, b } = await registered(a);
  // Started from WEB, finished by a same-origin request (client data still WEB): refused.
  const one = await (await b.send(WEB, "POST", "/passkey/authenticate/options", {})).json();
  const sameOriginFinish = await b.send(AUTH, "POST", "/passkey/authenticate", {
    credential: await auth.assert(one, { origin: WEB }),
  });
  assertEquals(sameOriginFinish.status, 401);
  // Started and finished from WEB, but the client data names another accepted origin: refused.
  const two = await (await b.send(WEB, "POST", "/passkey/authenticate/options", {})).json();
  const otherClientData = await b.send(WEB, "POST", "/passkey/authenticate", {
    credential: await auth.assert(two, { origin: AUTH }),
  });
  assertEquals(otherClientData.status, 401);
  // Started same-origin, finished from WEB: refused.
  const three = await (await b.send(AUTH, "POST", "/passkey/authenticate/options", {})).json();
  const crossFinish = await b.send(WEB, "POST", "/passkey/authenticate", {
    credential: await auth.assert(three, { origin: WEB }),
  });
  assertEquals(crossFinish.status, 401);
});

Deno.test("passkeys cors: the per-tab ceremony id is still required cross-origin", async () => {
  const a = await app();
  const { auth, b } = await registered(a);
  const options = await (await b.send(WEB, "POST", "/passkey/authenticate/options", {})).json();
  const res = await b.send(WEB, "POST", "/passkey/authenticate", {
    credential: await auth.assert(options, { origin: WEB }),
    ceremonyId: "not-the-one",
  });
  assertEquals(res.status, 401);
});

Deno.test("passkeys cors: same-origin ceremonies are unchanged", async () => {
  const a = await app();
  const { auth, b } = await registered(a);
  const options = await (await b.send(AUTH, "POST", "/passkey/authenticate/options", {})).json();
  const res = await b.send(AUTH, "POST", "/passkey/authenticate", {
    credential: await auth.assert(options, { origin: AUTH }),
  });
  assertEquals(res.status, 200);
  assertEquals(corsOf(res).origin, null);
});

Deno.test("passkeys cors: every corsOrigins entry must be a listed ceremony origin", async () => {
  const a = await app();
  const config = (passkeys: AuthConfig["passkeys"]): AuthConfig => ({ ...a.config, passkeys });
  assertThrows(
    () => resolvePasskeys(config({ rpId: "app.test", origins: [AUTH], corsOrigins: [WEB] })),
    Error,
    "corsOrigins",
  );
  assertThrows(
    () =>
      resolvePasskeys(
        config({ rpId: "app.test", origins: [AUTH, WEB], corsOrigins: ["https://www.app.test/x"] }),
      ),
    Error,
  );
  assertEquals(
    resolvePasskeys(config({ rpId: "app.test", origins: [AUTH, WEB], corsOrigins: [WEB] }))?.cors
      ?.credentials,
    true,
  );
});
