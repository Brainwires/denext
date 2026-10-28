// `next-auth/webauthn`'s `signIn` on denext's passkey client, against stubbed handlers and a
// stubbed `navigator.credentials`: a WebAuthn provider runs the ceremony Auth.js would (register
// when signed in, sign in otherwise, or the `action` asked for), answers Auth.js's
// `SignInResponse` with `redirect: false` and navigates otherwise; any other provider throws.

import { assertEquals, assertRejects } from "@std/assert";
import { signIn } from "../packages/auth/next-auth/webauthn.ts";

/** What one stubbed browser saw: the POSTs, by path. */
interface Seen {
  posts: string[];
}

/** Answer `url` (path) with `[status, body]`. */
type Routes = Record<string, [number, unknown]>;

const PROVIDERS: Routes = {
  "/api/auth/providers": [200, {
    passkey: { id: "passkey", type: "webauthn" },
    credentials: { id: "credentials", type: "credentials" },
  }],
};

/** Install fetch, `PublicKeyCredential`, `navigator.credentials` and `location` stubs. */
async function withBrowser(routes: Routes, run: (seen: Seen) => Promise<void>): Promise<void> {
  const seen: Seen = { posts: [] };
  const g = globalThis as Record<string, unknown>;
  const saved = {
    fetch: g.fetch,
    PublicKeyCredential: g.PublicKeyCredential,
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    credentials: Object.getOwnPropertyDescriptor(navigator, "credentials"),
  };
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://app.test").pathname;
    if (init?.method === "POST") seen.posts.push(path);
    const [status, body] = routes[path] ?? [404, {}];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  const credential = { toJSON: () => ({ id: "cred", type: "public-key", response: {} }) };
  g.PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, {
    parseCreationOptionsFromJSON: (json: unknown) => json,
    parseRequestOptionsFromJSON: (json: unknown) => json,
  });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: () => Promise.resolve(credential), get: () => Promise.resolve(credential) },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { href: "https://app.test/account", reload: () => {} },
  });
  try {
    await run(seen);
  } finally {
    g.fetch = saved.fetch;
    g.PublicKeyCredential = saved.PublicKeyCredential;
    if (saved.location) Object.defineProperty(globalThis, "location", saved.location);
    else delete g.location;
    if (saved.credentials) Object.defineProperty(navigator, "credentials", saved.credentials);
    else delete (navigator as unknown as Record<string, unknown>).credentials;
  }
}

Deno.test("next-auth/webauthn: signed out, signIn('passkey') signs in with a passkey", async () => {
  await withBrowser({
    ...PROVIDERS,
    "/api/auth/session": [200, {}],
    "/api/auth/passkey/authenticate/options": [200, { challenge: "c", ceremonyId: "x" }],
    "/api/auth/passkey/authenticate": [200, { url: "https://app.test/account" }],
  }, async (seen) => {
    const res = await signIn("passkey", { redirect: false, callbackUrl: "/home" });
    assertEquals(res, {
      error: undefined,
      code: undefined,
      status: 200,
      ok: true,
      url: "https://app.test/home",
    });
    assertEquals(seen.posts, [
      "/api/auth/passkey/authenticate/options",
      "/api/auth/passkey/authenticate",
    ]);
  });
});

Deno.test("next-auth/webauthn: signed in, signIn('passkey') registers one", async () => {
  await withBrowser({
    ...PROVIDERS,
    "/api/auth/session": [200, { user: { name: "Ada" }, expires: "2099-01-01" }],
    "/api/auth/passkey/register/options": [200, { challenge: "c", user: { id: "u" } }],
    "/api/auth/passkey/register": [200, { passkey: { id: "cred" } }],
  }, async (seen) => {
    assertEquals((await signIn("passkey", { redirect: false }))?.ok, true);
    assertEquals(seen.posts, ["/api/auth/passkey/register/options", "/api/auth/passkey/register"]);
  });
});

Deno.test("next-auth/webauthn: a refused ceremony answers Auth.js's error shape", async () => {
  await withBrowser({
    ...PROVIDERS,
    "/api/auth/passkey/register/options": [403, { error: "reauth_required" }],
  }, async () => {
    const res = await signIn("passkey", { action: "register", redirect: false });
    assertEquals(res, {
      error: "WebAuthnVerificationError",
      code: "reauth_required",
      status: 401,
      ok: false,
      url: null,
    });
    // Navigating calls log it and resolve nothing, as Auth.js's do.
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      assertEquals(await signIn("passkey", { action: "register" }), undefined);
    } finally {
      console.error = log;
    }
    assertEquals(errors.length, 1);
  });
});

Deno.test("next-auth/webauthn: success navigates to the same-origin callbackUrl", async () => {
  await withBrowser({
    ...PROVIDERS,
    "/api/auth/passkey/authenticate/options": [200, { challenge: "c" }],
    "/api/auth/passkey/authenticate": [200, {}],
  }, async () => {
    const res = await signIn("passkey", {
      action: "authenticate",
      callbackUrl: "https://evil.test/steal",
    });
    assertEquals(res, undefined);
    assertEquals(globalThis.location.href, "https://app.test/account", "kept to the origin");
  });
});

Deno.test("next-auth/webauthn: another provider throws; no providers goes to the error page", async () => {
  await withBrowser(PROVIDERS, async () => {
    await assertRejects(() => signIn("credentials"), TypeError, "not refer to a WebAuthn");
    await assertRejects(() => signIn(), TypeError, "WebAuthn");
  });
  await withBrowser({}, async () => {
    assertEquals(await signIn("passkey"), undefined);
    assertEquals(globalThis.location.href, "/api/auth/error");
  });
});
