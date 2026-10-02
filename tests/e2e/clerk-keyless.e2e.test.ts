// examples/clerk without a Clerk account: the server-side session check (`clerkMiddleware` +
// `auth()` from `@clerk/nextjs`, running on denext) against session tokens signed with a key
// pair generated here. `CLERK_JWT_KEY` (the PEM public key) makes Clerk verify networklessly, so
// no request leaves the machine: a valid token passes, and a missing, expired, tampered or
// foreign-signed one is refused. The keyed flows are tests/e2e/clerk.e2e.test.ts.
//
// Opt-in + NETWORK-REQUIRED (npm install of the example): `deno task test:e2e`.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64, encodeBase64Url } from "@std/encoding";
import { fromFileUrl } from "@std/path";
import { assert } from "@std/assert";
import { runDeno, startCliServer } from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/clerk", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));
/** A made-up development instance (never contacted: the key is local). */
const FAPI = "denext-keyless-e2e.clerk.accounts.dev";

/** An RS256 key pair, and its public half as the PEM `CLERK_JWT_KEY` takes. */
async function keyPair(): Promise<{ privateKey: CryptoKey; pem: string }> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const body = encodeBase64(spki).match(/.{1,64}/g)!.join("\n");
  return { privateKey, pem: `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----` };
}

/** A Clerk-shaped session token (RS256 JWT) signed with `key`. */
async function sessionToken(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", typ: "JWT", kid: "ins_denext_e2e" });
  const payload = enc({
    iss: `https://${FAPI}`,
    sub: "user_denext_e2e",
    sid: "sess_denext_e2e",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 60,
    v: 2,
    sts: "active",
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${payload}`),
  );
  return `${head}.${payload}.${encodeBase64Url(new Uint8Array(sig))}`;
}

Deno.test({
  name: "e2e: examples/clerk refuses missing, expired, tampered and foreign session tokens",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const { privateKey, pem } = await keyPair();
  const other = await keyPair();
  const env: Record<string, string> = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa(`${FAPI}$`),
    CLERK_SECRET_KEY: "sk_test_denext_keyless_e2e",
    CLERK_JWT_KEY: pem,
  };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v); // the CLI children inherit them
  const installed = await runDeno(["install"], EXAMPLE, 600_000);
  assert(installed.ok, "deno install failed:\n" + installed.out);
  const built = await runDeno(
    ["run", "-A", "--node-modules-dir=none", CLI, "build", "."],
    EXAMPLE,
    600_000,
  );
  assert(built.ok, "denext build failed:\n" + built.out);
  const server = await startCliServer(EXAMPLE, 90_000);
  const me = async (token?: string) => {
    const res = await fetch(server.origin + "/api/me", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    // Clerk's verdict travels in response headers (why a token was refused).
    const why =
      `${res.headers.get("x-clerk-auth-status")}: ${res.headers.get("x-clerk-auth-reason")}` +
      ` ${res.headers.get("x-clerk-auth-message") ?? ""}`;
    return { status: res.status, body: `${await res.text()} [${why}]` };
  };
  try {
    await t.step("a valid session token: the route reads the verified user id", async () => {
      const ok = await me(await sessionToken(privateKey, {}));
      assertEquals(ok.status, 200, ok.body);
      assertEquals(JSON.parse(ok.body.replace(/ \[.*\]$/, "")), {
        userId: "user_denext_e2e",
        sessionId: "sess_denext_e2e",
      });
    });
    await t.step("no token: 401", async () => {
      assertEquals((await me()).status, 401);
    });
    await t.step("an expired token: 401", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = await sessionToken(privateKey, {
        iat: now - 600,
        nbf: now - 600,
        exp: now - 300,
      });
      const res = await me(expired);
      assertEquals(res.status, 401);
      assertStringIncludes(res.body, "expired"); // refused for its age, not by accident
    });
    await t.step("a tampered token (another user id, the old signature): 401", async () => {
      const [h, , s] = (await sessionToken(privateKey, {})).split(".");
      const forged = encodeBase64Url(
        new TextEncoder().encode(JSON.stringify({ sub: "user_attacker", sid: "sess_x" })),
      );
      assertEquals((await me(`${h}.${forged}.${s}`)).status, 401);
    });
    await t.step("a token signed by another key: 401", async () => {
      assertEquals((await me(await sessionToken(other.privateKey, {}))).status, 401);
    });
    await t.step("not a JWT: 401", async () => {
      assertEquals((await me("definitely-not-a-jwt")).status, 401);
    });
  } finally {
    await server.close();
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
