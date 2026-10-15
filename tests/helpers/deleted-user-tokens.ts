// A deleted user's credentials are dead at every use, even where the deletion left a session
// behind (an adapter that doesn't cascade, a row deleted out of band): native access tokens and
// `/auth/v1` access tokens with or without a `session_id`. Each case gets an adapter and a
// `forget(id)` that deletes the user's row ONLY, leaving its sessions as they were. Run against
// the in-memory adapter (tests/auth-deleted-user-tokens.test.ts) and Postgres
// (tests/helpers/postgres-suites.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { AuthAdapter } from "../../src/server/auth/adapter.ts";
import {
  resolveNative,
  startNativeSession,
  verifyNativeAccessToken,
} from "../../src/server/auth/native.ts";
import { verifyAccessTokenSession } from "../../src/server/auth/gotrue/access.ts";
import {
  generateSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
  SupabaseKeyError,
  type SupabaseKeys,
} from "../../src/server/auth/gotrue/keys.ts";
import type { AuthConfig } from "../../src/server/auth/types.ts";

/** What a case gets: the adapter, and a way to delete a user's row alone. */
interface DeletedUserFixture {
  adapter: AuthAdapter;
  forget(id: string): Promise<void>;
}

type Case = (f: DeletedUserFixture) => Promise<void>;

const now = () => Math.floor(Date.now() / 1000);

function configOf(adapter: AuthAdapter): AuthConfig {
  return {
    secret: "deleted-user-secret-at-least-32-characters",
    canonicalOrigin: "https://app.test",
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    native: { redirectUris: ["com.example.app://auth/callback"] },
  };
}

async function keys(): Promise<SupabaseKeys> {
  const g = await generateSupabaseKeys({});
  return await resolveSupabaseKeys({
    publishableKey: g.publishableKey,
    secretKey: g.secretKey,
    signingKeys: g.signingKey,
  });
}

/** A live `/auth/v1` session family of `userId`. */
async function gotrueFamily(adapter: AuthAdapter, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await adapter.createNativeSession!({
    id,
    userId,
    generation: 0,
    salt: "salt",
    session: JSON.stringify({
      gotrue: 1,
      user: { id: userId },
      provider: "email",
      amr: [{ method: "password", timestamp: now() }],
      aal: "aal1",
    }),
    createdAt: now(),
    expiresAt: now() + 3600,
  });
  return id;
}

function accessToken(k: SupabaseKeys, sub: string, extra: Record<string, unknown> = {}) {
  return signSupabaseJwt(k, {
    sub,
    role: "authenticated",
    aud: "authenticated",
    iat: now(),
    exp: now() + 600,
    ...extra,
  });
}

/** The cases, by name. */
export const DELETED_USER_CASES: Record<string, Case> = {
  "deleted user: a native access token is refused, its family left live": async (f) => {
    const config = configOf(f.adapter);
    const user = await f.adapter.createUser({ email: `${crypto.randomUUID()}@x.test` });
    const pair = await startNativeSession(config, resolveNative(config)!, {
      user: { id: user.id },
      provider: "credentials",
      amr: ["pwd"],
      authTime: now(),
    });
    assert(await verifyNativeAccessToken(config, pair.access_token), "live before");
    await f.forget(user.id);
    assertEquals(await verifyNativeAccessToken(config, pair.access_token), null);
  },
  "deleted user: an /auth/v1 access token is refused, with or without a session_id": async (f) => {
    const config = configOf(f.adapter);
    const k = await keys();
    const user = await f.adapter.createUser({ email: `${crypto.randomUUID()}@x.test` });
    const withFamily = await accessToken(k, user.id, {
      session_id: await gotrueFamily(f.adapter, user.id),
    });
    const bare = await accessToken(k, user.id);
    for (const token of [withFamily, bare]) {
      assertEquals((await verifyAccessTokenSession(k, token, config)).user?.id, user.id);
    }
    await f.forget(user.id);
    for (const token of [withFamily, bare]) {
      await assertRejects(
        () => verifyAccessTokenSession(k, token, config),
        SupabaseKeyError,
        "session not found",
      );
    }
  },
  "banned user: an /auth/v1 access token with no session_id is refused": async (f) => {
    const config = configOf(f.adapter);
    const k = await keys();
    const user = await f.adapter.createUser({ email: `${crypto.randomUUID()}@x.test` });
    const bare = await accessToken(k, user.id);
    await f.adapter.updateUser({ id: user.id, bannedUntil: now() + 3600 });
    await assertRejects(
      () => verifyAccessTokenSession(k, bare, config),
      SupabaseKeyError,
      "banned",
    );
  },
};
