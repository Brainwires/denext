// A ban refuses a user's tokens at every use while it lasts — bearer API tokens and native
// access / refresh tokens — not only through the revocation the admin API performs when it bans.
// Each test bans in the store alone (nothing revoked), as a missed revocation would leave it.

import { assert, assertEquals } from "@std/assert";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { issueApiToken, verifyApiToken } from "../packages/auth/src/api-token.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import {
  refreshNativeSession,
  resolveNative,
  startNativeSession,
  verifyNativeAccessToken,
} from "../packages/auth/src/native.ts";
import type { AuthConfig } from "../packages/auth/src/types.ts";

const SECRET = "test-secret-value-at-least-32-chars-long";

async function setup(): Promise<{ config: AuthConfig; adapter: AuthAdapter; userId: string }> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: "ban@x.test" });
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: "https://app.test",
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    native: { redirectUris: ["com.example.app://auth/callback"] },
  };
  return { config, adapter, userId: user.id };
}

/** Set (or, with a negative duration, lift) a ban in the store only. */
async function ban(adapter: AuthAdapter, id: string, seconds = 3600): Promise<void> {
  await adapter.updateUser({ id, bannedUntil: Math.floor(Date.now() / 1000) + seconds });
}

Deno.test("a banned user's bearer API token verifies as nothing until the ban ends", async () => {
  const { config, adapter, userId } = await setup();
  const { token } = await issueApiToken(config, { userId, name: "ci" });
  assert(await verifyApiToken(config, token));
  await ban(adapter, userId);
  assertEquals(await verifyApiToken(config, token), null);
  await ban(adapter, userId, -1);
  assertEquals((await verifyApiToken(config, token))?.userId, userId);
});

Deno.test("a banned user's native access and refresh tokens are refused, the family kept", async () => {
  const { config, adapter, userId } = await setup();
  const native = resolveNative(config)!;
  const tokens = await startNativeSession(config, native, {
    user: { id: userId },
    provider: "credentials",
    amr: ["pwd"],
    authTime: Math.floor(Date.now() / 1000),
  });
  assert(await verifyNativeAccessToken(config, tokens.access_token));
  await ban(adapter, userId);
  assertEquals(await verifyNativeAccessToken(config, tokens.access_token), null);
  const refused = await refreshNativeSession(config, native, tokens.refresh_token);
  assertEquals(refused.ok ? "ok" : refused.reason, "banned");
  // A ban is temporary: the family is refused, not revoked, and works again once it ends.
  await ban(adapter, userId, -1);
  assert(await verifyNativeAccessToken(config, tokens.access_token));
  assert((await refreshNativeSession(config, native, tokens.refresh_token)).ok);
});
