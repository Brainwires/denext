// The richer auth events: `apiTokenIssued` / `apiTokenRevoked` for every way a bearer token is
// minted or retired (the function, the `/tokens` endpoints, a password reset, the
// pre-account-hijacking eviction on a first proof of the mailbox) — never carrying the token or
// its hash — and `signInFailed.reason` as the closed `SignInFailedReason` union.

import { assert, assertEquals } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { issueApiToken, revokeApiToken } from "../src/server/auth/api-token.ts";
import { resetPassword } from "../src/server/auth/email.ts";
import { issueVerificationToken } from "../src/server/auth/verification.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { AuthConfig, AuthEvents, SignInFailedReason } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery staple";

/** Every event payload, by name, in order. */
type Log = Array<[string, Record<string, unknown>]>;

async function app(
  verified = true,
): Promise<{ config: AuthConfig; adapter: AuthAdapter; userId: string; log: Log }> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({
    email: EMAIL,
    ...(verified ? { emailVerified: 1 } : {}),
  });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const log: Log = [];
  const record = (name: string) => (payload: Record<string, unknown>) =>
    void log.push([name, payload]);
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    sendVerificationRequest: () => {},
    events: {
      apiTokenIssued: record("apiTokenIssued"),
      apiTokenRevoked: record("apiTokenRevoked"),
    } as AuthEvents,
  };
  return { config, adapter, userId: user.id, log };
}

Deno.test("events: issueApiToken fires apiTokenIssued — without the token or its hash", async () => {
  const a = await app();
  const issued = await issueApiToken(a.config, {
    userId: a.userId,
    name: "CI",
    scopes: ["read"],
    expiresInSeconds: 3600,
  });
  assertEquals(a.log.length, 1);
  const [name, payload] = a.log[0];
  assertEquals(name, "apiTokenIssued");
  assertEquals(payload, {
    userId: a.userId,
    tokenId: issued.record.id,
    name: "CI",
    scopes: ["read"],
    expiresAt: issued.record.expiresAt,
  });
  const serialized = JSON.stringify(payload);
  assert(!serialized.includes(issued.token), "never the token");
  assert(!serialized.includes(issued.record.tokenHash), "never its hash");
});

Deno.test("events: revokeApiToken fires apiTokenRevoked (reason revoked), with the owner when given", async () => {
  const a = await app();
  const one = await issueApiToken(a.config, { userId: a.userId });
  const two = await issueApiToken(a.config, { userId: a.userId });
  a.log.length = 0;
  await revokeApiToken(a.config, one.record.id);
  await revokeApiToken(a.config, two.record.id, { userId: a.userId });
  assertEquals(a.log, [
    ["apiTokenRevoked", { tokenId: one.record.id, reason: "revoked" }],
    ["apiTokenRevoked", { tokenId: two.record.id, userId: a.userId, reason: "revoked" }],
  ]);
});

Deno.test("events: DELETE /tokens/:id fires apiTokenRevoked with the caller as owner", async () => {
  const a = await app();
  const issued = await issueApiToken(a.config, { userId: a.userId });
  // Sign in with the password to get a cookie session.
  const signIn = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const ctx = createRequestContext(signIn);
  await runWithContext(ctx, () => handleAuthRequest(signIn, a.config));
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth="))!.split(";")[0];
  a.log.length = 0;
  const del = new Request(`${ORIGIN}/auth/tokens/${issued.record.id}`, {
    method: "DELETE",
    headers: { cookie, origin: ORIGIN, accept: "application/json" },
  });
  const res = await runWithContext(
    createRequestContext(del),
    () => handleAuthRequest(del, a.config),
  );
  assertEquals(res!.status, 200);
  assertEquals(a.log, [
    ["apiTokenRevoked", { tokenId: issued.record.id, userId: a.userId, reason: "revoked" }],
  ]);
});

Deno.test("events: a password reset revokes every token with reason password_reset", async () => {
  const a = await app(true);
  const t1 = await issueApiToken(a.config, { userId: a.userId });
  const t2 = await issueApiToken(a.config, { userId: a.userId });
  a.log.length = 0;
  const { token } = await issueVerificationToken(a.config, {
    identifier: EMAIL,
    purpose: "reset",
    ttl: 600,
  });
  const result = await resetPassword(a.config, {
    email: EMAIL,
    token,
    password: "a new password!",
  });
  assert(result.ok);
  assertEquals(
    a.log.map(([name, p]) => [name, p.tokenId, p.reason]).sort(),
    [
      ["apiTokenRevoked", t1.record.id, "password_reset"],
      ["apiTokenRevoked", t2.record.id, "password_reset"],
    ].sort(),
  );
});

Deno.test("events: the pre-account-hijacking eviction revokes with reason email_verified", async () => {
  const a = await app(false); // an account nobody proved the mailbox of
  const planted = await issueApiToken(a.config, { userId: a.userId });
  a.log.length = 0;
  const { token } = await issueVerificationToken(a.config, {
    identifier: EMAIL,
    purpose: "reset",
    ttl: 600,
  });
  assert((await resetPassword(a.config, { email: EMAIL, token, password: "a new password!" })).ok);
  assertEquals(a.log, [
    ["apiTokenRevoked", { tokenId: planted.record.id, userId: a.userId, reason: "email_verified" }],
  ]);
});

/** Compile-time: the union is closed, so a switch over it can be exhaustive. */
function describe(reason: SignInFailedReason): string {
  switch (reason) {
    case "invalid_credentials":
    case "invalid_mfa_code":
    case "invalid_passkey":
    case "invalid_nonce":
    case "invalid_token":
      return "bad secret";
    case "rate_limited":
      return "throttled";
    case "access_denied":
    case "account_not_linked":
      return "policy";
    case "adapter_error":
    case "config":
    case "oauth_failed":
    case "provider_error":
      return "upstream";
    case "invalid_state":
    case "invalid_request":
      return "protocol";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

Deno.test("events: signInFailed reports reasons from the closed union", async () => {
  const reasons: SignInFailedReason[] = [];
  const a = await app();
  a.config.events = { signInFailed: ({ reason }) => void reasons.push(reason) };
  const wrong = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: "wrong password" }),
  });
  await runWithContext(createRequestContext(wrong), () => handleAuthRequest(wrong, a.config));
  assertEquals(reasons, ["invalid_credentials"]);
  assertEquals(describe(reasons[0]), "bad secret");
});
