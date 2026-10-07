// The browser helpers for passkeys (`denext/client`): `registerPasskey` / `signInWithPasskey`
// turn the server's JSON options into WebAuthn's ArrayBuffers, run the ceremony, and post the
// credential back as base64url JSON — on a browser without `PublicKeyCredential.parse*FromJSON`
// / `toJSON()` as well as with them. A cancelled ceremony, a refused answer and a missing API
// each resolve to a typed `{ ok: false, error }`; nothing throws.

import { assert, assertEquals } from "@std/assert";
import { passkeysSupported, registerPasskey, signInWithPasskey } from "denext/client";

const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const buf = (...bytes: number[]) => Uint8Array.from(bytes).buffer;

/** What one stubbed exchange saw. */
interface Seen {
  posts: Array<{ url: string; body: Record<string, unknown> }>;
  created?: PublicKeyCredentialCreationOptions;
  requested?: PublicKeyCredentialRequestOptions;
  navigated?: string;
}

/** Install fetch, navigator.credentials, PublicKeyCredential and location stubs. */
async function withBrowser(
  answers: Record<string, [number, unknown]>,
  ceremony: { create?: () => unknown; get?: () => unknown },
  run: (seen: Seen) => Promise<void>,
): Promise<void> {
  const seen: Seen = { posts: [] };
  const g = globalThis as Record<string, unknown>;
  const saved = {
    fetch: g.fetch,
    PublicKeyCredential: g.PublicKeyCredential,
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    credentials: Object.getOwnPropertyDescriptor(navigator, "credentials"),
  };
  g.fetch = (url: string, init: RequestInit) => {
    seen.posts.push({ url, body: JSON.parse(String(init.body)) });
    const [status, body] = answers[url] ?? [404, {}];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  g.PublicKeyCredential = function PublicKeyCredential() {};
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      create: ({ publicKey }: { publicKey: PublicKeyCredentialCreationOptions }) => {
        seen.created = publicKey;
        return Promise.resolve(ceremony.create?.());
      },
      get: ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) => {
        seen.requested = publicKey;
        return Promise.resolve(ceremony.get?.());
      },
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { assign: (url: string) => void (seen.navigated = url) },
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

/** A credential as a browser without `toJSON()` returns it. */
function attestationCredential() {
  return {
    id: "AQID",
    rawId: buf(1, 2, 3),
    type: "public-key",
    response: {
      clientDataJSON: buf(9, 9),
      attestationObject: buf(7),
      getTransports: () => ["internal"],
    },
    getClientExtensionResults: () => ({}),
  };
}

Deno.test("registerPasskey: options decoded, credential encoded, label sent", async () => {
  const options = {
    challenge: b64u(Uint8Array.of(1, 2, 3, 4)),
    rp: { id: "app.test", name: "app.test" },
    user: { id: b64u(new TextEncoder().encode("u1")), name: "ada", displayName: "Ada" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ type: "public-key", id: b64u(Uint8Array.of(5, 6)) }],
  };
  await withBrowser(
    {
      "/auth/passkey/register/options": [200, options],
      "/auth/passkey/register": [200, {
        ok: true,
        passkey: { id: "AQID", createdAt: 1, backedUp: false },
      }],
    },
    { create: attestationCredential },
    async (seen) => {
      const result = await registerPasskey({ name: "Laptop" });
      assertEquals(result, { ok: true, passkey: { id: "AQID", createdAt: 1, backedUp: false } });
      assertEquals(
        new Uint8Array(seen.created!.challenge as ArrayBuffer),
        Uint8Array.of(1, 2, 3, 4),
      );
      assertEquals(new TextDecoder().decode(seen.created!.user.id as ArrayBuffer), "u1");
      assertEquals(
        new Uint8Array(seen.created!.excludeCredentials![0].id as ArrayBuffer),
        Uint8Array.of(5, 6),
      );
      assertEquals(seen.posts[1].body, {
        credential: {
          id: "AQID",
          rawId: "AQID",
          type: "public-key",
          response: { clientDataJSON: "CQk", attestationObject: "Bw", transports: ["internal"] },
          clientExtensionResults: {},
        },
        name: "Laptop",
      });
    },
  );
});

Deno.test("signInWithPasskey: an assertion is encoded and the server's vetted URL is followed", async () => {
  await withBrowser(
    {
      "/auth/passkey/authenticate/options": [200, {
        challenge: "AAAA",
        rpId: "app.test",
        allowCredentials: [],
      }],
      "/auth/passkey/authenticate": [200, { ok: true, url: "/dashboard" }],
    },
    {
      get: () => ({
        id: "AQID",
        rawId: buf(1, 2, 3),
        type: "public-key",
        response: {
          clientDataJSON: buf(1),
          authenticatorData: buf(2),
          signature: buf(3),
          userHandle: buf(117, 49),
        },
      }),
    },
    async (seen) => {
      assertEquals(await signInWithPasskey({ callbackUrl: "https://evil.test" }), { ok: true });
      assertEquals(
        seen.navigated,
        "/dashboard",
        "the server's coerced URL, not the raw callbackUrl",
      );
      const sent = seen.posts[1].body as { credential: { response: Record<string, string> } };
      assertEquals(sent.credential.response, {
        clientDataJSON: "AQ",
        authenticatorData: "Ag",
        signature: "Aw",
        userHandle: "dTE",
      });
    },
  );
});

Deno.test("signInWithPasskey: a pending second factor is reported, not navigated", async () => {
  await withBrowser(
    {
      "/auth/passkey/authenticate/options": [200, { challenge: "AAAA", rpId: "app.test" }],
      "/auth/passkey/authenticate": [200, { ok: true, mfa: "required" }],
    },
    {
      get: () => ({
        id: "AQ",
        rawId: buf(1),
        type: "public-key",
        response: { clientDataJSON: buf(1), authenticatorData: buf(1), signature: buf(1) },
      }),
    },
    async (seen) => {
      assertEquals(await signInWithPasskey(), { ok: true, mfa: "required" });
      assertEquals(seen.navigated, undefined);
    },
  );
});

Deno.test("passkey helpers: cancel, refusal, re-auth and a missing API are typed results", async () => {
  const cancel = () => {
    throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
  };
  await withBrowser(
    { "/auth/passkey/authenticate/options": [200, { challenge: "AAAA", rpId: "app.test" }] },
    { get: cancel },
    async () => assertEquals(await signInWithPasskey(), { ok: false, error: "cancelled" }),
  );
  await withBrowser(
    {
      "/auth/passkey/authenticate/options": [200, { challenge: "AAAA", rpId: "app.test" }],
      "/auth/passkey/authenticate": [401, { error: "invalid passkey" }],
    },
    {
      get: () => ({
        id: "AQ",
        rawId: buf(1),
        type: "public-key",
        response: { clientDataJSON: buf(1), authenticatorData: buf(1), signature: buf(1) },
      }),
    },
    async () => assertEquals(await signInWithPasskey(), { ok: false, error: "invalid" }),
  );
  await withBrowser(
    { "/auth/passkey/register/options": [403, { error: "reauth_required" }] },
    {},
    async () => assertEquals(await registerPasskey(), { ok: false, error: "reauth_required" }),
  );
  await withBrowser(
    { "/x/passkey/authenticate/options": [429, {}] },
    {},
    async () =>
      assertEquals(await signInWithPasskey({ basePath: "/x" }), {
        ok: false,
        error: "rate_limited",
      }),
  );
  // An authenticator that already holds an excluded credential throws InvalidStateError.
  await withBrowser(
    {
      "/auth/passkey/register/options": [200, {
        challenge: "AAAA",
        rp: { id: "app.test", name: "app.test" },
        user: { id: "AQ", name: "ada", displayName: "Ada" },
        pubKeyCredParams: [],
        excludeCredentials: [{ type: "public-key", id: "AQ" }],
      }],
    },
    {
      create: () => {
        throw Object.assign(new Error("excluded"), { name: "InvalidStateError" });
      },
    },
    async () => assertEquals(await registerPasskey(), { ok: false, error: "exists" }),
  );
  // The server's typed refusals: an unverified address, a step-up that needs a code.
  await withBrowser(
    { "/auth/passkey/register/options": [403, { error: "email_unverified" }] },
    {},
    async () => assertEquals(await registerPasskey(), { ok: false, error: "email_unverified" }),
  );
  await withBrowser(
    { "/auth/passkey/authenticate/options": [403, { error: "code_required" }] },
    {},
    async () => assertEquals(await signInWithPasskey(), { ok: false, error: "code_required" }),
  );
  // No WebAuthn at all (a server, an old WebView).
  assert(!passkeysSupported());
  assertEquals(await registerPasskey(), { ok: false, error: "unsupported" });
});
