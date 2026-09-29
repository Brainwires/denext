// The two opt-in native refresh policies: `native.refreshTokenMaxAge` (an absolute family
// lifetime from the original sign-in — past it the refresh is refused as expired and the family
// revoked) and
// `native.refreshReuseInterval` (the grace window in which the IMMEDIATELY previous refresh
// token gets the pair its rotation issued, byte for byte, instead of revoking the family).
// Defaults leave both off — the strict behaviour tests/auth-native.test.ts pins.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import {
  type NativeTokens,
  refreshNativeSession,
  type ResolvedNative,
  resolveNative,
  startNativeSession,
  verifyNativeAccessToken,
} from "../src/server/auth/native.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import type { AuthConfig, AuthNativeConfig } from "../src/server/auth/types.ts";

const SECRET = "test-secret-value-at-least-32-chars-long";
const REDIRECT = "com.example.app://auth/callback";
/** A fixed epoch (ms) the fake clock starts at. */
const T0 = 1_900_000_000_000;

interface Harness {
  config: AuthConfig;
  native: ResolvedNative;
  adapter: AuthAdapter;
  userId: string;
}

async function setup(
  native: Partial<AuthNativeConfig> = {},
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<Harness> {
  const user = await adapter.createUser({ email: "ada@x.test", name: "Ada" });
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: "https://app.test",
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    native: { redirectUris: [REDIRECT], ...native },
  };
  return { config, native: resolveNative(config)!, adapter, userId: user.id };
}

/** Run `fn` with `Date.now` frozen at a controllable instant (`clock.ms`). */
async function withClock<T>(fn: (clock: { ms: number }) => Promise<T>): Promise<T> {
  const clock = { ms: T0 };
  const realNow = Date.now;
  Date.now = () => clock.ms;
  try {
    return await fn(clock);
  } finally {
    Date.now = realNow;
  }
}

function start(h: Harness): Promise<NativeTokens> {
  return startNativeSession(h.config, h.native, {
    user: { id: h.userId },
    provider: "credentials",
    amr: ["pwd"],
    authTime: Math.floor(Date.now() / 1000),
  });
}

async function rotate(h: Harness, token: string): Promise<NativeTokens> {
  const outcome = await refreshNativeSession(h.config, h.native, token);
  assert(outcome.ok, `refresh refused: ${outcome.ok ? "" : outcome.reason}`);
  return outcome.tokens;
}

async function refusal(h: Harness, token: string): Promise<string> {
  const outcome = await refreshNativeSession(h.config, h.native, token);
  assert(!outcome.ok, "refresh unexpectedly succeeded");
  return outcome.reason;
}

/** The family id a refresh token names. */
function familyOf(token: string): string {
  return token.slice(4).split(".")[0];
}

async function revoked(h: Harness, token: string): Promise<boolean> {
  return (await h.adapter.getNativeSession!(familyOf(token)))?.revokedAt !== undefined;
}

// ---- defaults + config ---------------------------------------------------------------------

Deno.test("defaults: no absolute cap and no reuse interval; values are clamped", async () => {
  const plain = await setup();
  assertEquals([plain.native.refreshMaxAge, plain.native.reuseInterval], [null, 0]);
  const clamped = await setup({ refreshTokenMaxAge: 10, refreshReuseInterval: 999 });
  assertEquals([clamped.native.refreshMaxAge, clamped.native.reuseInterval], [3600, 60]);
  const negative = await setup({ refreshReuseInterval: -5 });
  assertEquals(negative.native.reuseInterval, 0);
});

Deno.test("default strict mode: an immediate re-presentation of the previous token revokes", async () => {
  await withClock(async () => {
    const h = await setup();
    const first = await start(h);
    await rotate(h, first.refresh_token);
    assertEquals(await refusal(h, first.refresh_token), "reuse");
    assert(await revoked(h, first.refresh_token));
  });
});

// ---- refreshTokenMaxAge ---------------------------------------------------------------------

Deno.test("refreshTokenMaxAge: sliding refresh stops at the cap, then the family is revoked", async () => {
  await withClock(async (clock) => {
    const h = await setup({ refreshTokenTtl: 3600, refreshTokenMaxAge: 7200 });
    const first = await start(h);
    assertEquals(first.refresh_expires_in, 3600);
    clock.ms = T0 + 3000_000;
    const second = await rotate(h, first.refresh_token);
    assertEquals(second.refresh_expires_in, 3600, "still sliding (6600 < 7200)");
    clock.ms = T0 + 6000_000;
    const third = await rotate(h, second.refresh_token);
    assertEquals(third.refresh_expires_in, 1200, "the expiry never slides past the cap");
    assert(await verifyNativeAccessToken(h.config, third.access_token));
    clock.ms = T0 + 7200_000;
    assertEquals(await refusal(h, third.refresh_token), "expired");
    assert(await revoked(h, third.refresh_token), "past the cap the family is revoked");
    assertEquals(await verifyNativeAccessToken(h.config, third.access_token), null);
  });
});

Deno.test("refreshTokenMaxAge: an active app is signed out at the cap even with a long ttl", async () => {
  await withClock(async (clock) => {
    const h = await setup({ refreshTokenTtl: 365 * 86_400, refreshTokenMaxAge: 86_400 });
    let tokens = await start(h);
    for (let hour = 1; hour < 24; hour++) {
      clock.ms = T0 + hour * 3600_000;
      tokens = await rotate(h, tokens.refresh_token);
    }
    clock.ms = T0 + 86_400_000 + 1000;
    assertEquals(await refusal(h, tokens.refresh_token), "expired");
    assert(await revoked(h, tokens.refresh_token));
  });
});

// ---- refreshReuseInterval -------------------------------------------------------------------

Deno.test("refreshReuseInterval: two concurrent refreshes both succeed with the same pair", async () => {
  await withClock(async () => {
    const h = await setup({ refreshReuseInterval: 10 });
    const first = await start(h);
    const outcomes = await Promise.all([
      refreshNativeSession(h.config, h.native, first.refresh_token),
      refreshNativeSession(h.config, h.native, first.refresh_token),
    ]);
    assert(outcomes[0].ok && outcomes[1].ok, "both racers succeed");
    assertEquals(outcomes[0].tokens, outcomes[1].tokens, "idempotent: byte-identical pair");
    assertNotEquals(outcomes[0].tokens.refresh_token, first.refresh_token);
    assert(!(await revoked(h, first.refresh_token)), "the family is intact");
    const family = await h.adapter.getNativeSession!(familyOf(first.refresh_token));
    assertEquals(family?.generation, 1, "one rotation, not two");
    assert(await verifyNativeAccessToken(h.config, outcomes[1].tokens.access_token));
    // The shared next token keeps rotating normally.
    const third = await rotate(h, outcomes[0].tokens.refresh_token);
    assert(await verifyNativeAccessToken(h.config, third.access_token));
  });
});

Deno.test("refreshReuseInterval: a late re-presentation inside the window gets the same pair", async () => {
  await withClock(async (clock) => {
    const h = await setup({ refreshReuseInterval: 10 });
    const first = await start(h);
    const second = await rotate(h, first.refresh_token);
    clock.ms = T0 + 10_000; // exactly at the window's edge: still inside
    assertEquals(await rotate(h, first.refresh_token), second);
    assert(!(await revoked(h, first.refresh_token)));
  });
});

Deno.test("refreshReuseInterval: just outside the window the previous token is a replay", async () => {
  await withClock(async (clock) => {
    const h = await setup({ refreshReuseInterval: 10 });
    const first = await start(h);
    const second = await rotate(h, first.refresh_token);
    clock.ms = T0 + 11_000;
    assertEquals(await refusal(h, first.refresh_token), "reuse");
    assert(await revoked(h, first.refresh_token));
    assertEquals(await refusal(h, second.refresh_token), "revoked");
    assertEquals(await verifyNativeAccessToken(h.config, second.access_token), null);
  });
});

Deno.test("refreshReuseInterval: an older-than-previous generation inside the window revokes", async () => {
  await withClock(async () => {
    const h = await setup({ refreshReuseInterval: 30 });
    const first = await start(h);
    const second = await rotate(h, first.refresh_token);
    const third = await rotate(h, second.refresh_token);
    assertEquals(await refusal(h, first.refresh_token), "reuse", "generation 0 vs current 2");
    assert(await revoked(h, first.refresh_token));
    assertEquals(await refusal(h, third.refresh_token), "revoked");
  });
});

Deno.test("refreshReuseInterval: never revives a revoked family, a deleted user or a capped one", async () => {
  await withClock(async (clock) => {
    const signedOut = await setup({ refreshReuseInterval: 10 });
    const a = await start(signedOut);
    await rotate(signedOut, a.refresh_token);
    await signedOut.adapter.revokeNativeSession!(familyOf(a.refresh_token));
    assertEquals(await refusal(signedOut, a.refresh_token), "revoked");

    const gone = await setup({ refreshReuseInterval: 10 });
    const b = await start(gone);
    await rotate(gone, b.refresh_token);
    await gone.adapter.deleteUser!(gone.userId);
    assert(["invalid", "user_gone"].includes(await refusal(gone, b.refresh_token)));

    const capped = await setup({ refreshReuseInterval: 60, refreshTokenMaxAge: 3600 });
    const c = await start(capped);
    clock.ms = T0 + 3590_000;
    await rotate(capped, c.refresh_token);
    clock.ms = T0 + 3600_000;
    assertEquals(await refusal(capped, c.refresh_token), "expired");
    assert(await revoked(capped, c.refresh_token));
  });
});

// ---- the SQLite adapter: migration + the same policies ------------------------------------

Deno.test("sqliteAuthAdapter: an earlier auth_native_sessions table gains rotated_at in place", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/auth.db`;
  try {
    // The table as it first shipped, with one live family.
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE auth_native_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, " +
        "generation INTEGER NOT NULL, salt TEXT NOT NULL, session TEXT NOT NULL, " +
        "created_at INTEGER, expires_at INTEGER, revoked_at INTEGER)",
    );
    old.prepare("INSERT INTO auth_native_sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("old", "u1", 3, "salt", "{}", 1, 4_000_000_000);
    old.close();
    const adapter = sqliteAuthAdapter({ path });
    try {
      const legacy = await adapter.getNativeSession!("old");
      assertEquals(legacy?.generation, 3);
      assertEquals(legacy?.rotatedAt, undefined);
      assert(await adapter.rotateNativeSession!("old", 3, 4_000_000_100, { rotatedAt: 500 }));
      assertEquals((await adapter.getNativeSession!("old"))?.rotatedAt, 500);
    } finally {
      await adapter.close?.();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sqliteAuthAdapter: concurrent refresh grace and the absolute cap", async () => {
  const adapter = sqliteAuthAdapter({ path: ":memory:" });
  try {
    await withClock(async (clock) => {
      const h = await setup(
        { refreshReuseInterval: 5, refreshTokenTtl: 3600, refreshTokenMaxAge: 7200 },
        adapter,
      );
      const first = await start(h);
      const [x, y] = await Promise.all([
        refreshNativeSession(h.config, h.native, first.refresh_token),
        refreshNativeSession(h.config, h.native, first.refresh_token),
      ]);
      assert(x.ok && y.ok);
      assertEquals(x.tokens, y.tokens);
      clock.ms = T0 + 7200_000;
      assertEquals(await refusal(h, x.tokens.refresh_token), "expired");
      assert(await revoked(h, first.refresh_token));
    });
  } finally {
    await adapter.close?.();
  }
});
