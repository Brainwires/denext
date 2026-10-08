// TOTP secrets at rest: the MFA layer seals the secret (AES-256-GCM, a key HKDF-derived from
// the auth `secret`) before the adapter stores it. The raw sqlite row never holds the base32
// secret; a pre-sealing plaintext row keeps verifying and is re-sealed on that read; a
// rotated-out `secret` kept in the list still opens (and is re-sealed under the current one);
// a wrong key, a tampered ciphertext, another user's ciphertext, an unknown version and
// garbage all fail CLOSED — no TOTP code verifies, the user stays enrolled, and no plaintext
// fallback is ever taken.

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import { DatabaseSync } from "node:sqlite";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import {
  confirmTotp,
  enrollTotp,
  mfaPendingFor,
  mfaStatus,
  verifySecondFactor,
} from "../src/server/auth/mfa.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import { generateTotpSecret } from "../src/server/auth/totp.ts";
import {
  isSealedTotpSecret,
  openTotpSecret,
  sealTotpSecret,
} from "../src/server/auth/totp-seal.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";

const KEY_A = "first-auth-secret-at-least-32-characters";
const KEY_B = "second-auth-secret-at-least-32-characters";
const EMAIL = "ada@x.test";

/** A fresh database file of our own. */
function tempDbPath(): string {
  return `${Deno.makeTempDirSync({ prefix: "denext-totp-seal-" })}/auth.db`;
}

/** The raw `auth_mfa` row, read with a connection of our own (not the adapter's). */
function rawMfaRow(path: string, userId: string): Record<string, unknown> | undefined {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare("SELECT * FROM auth_mfa WHERE user_id = ?").get(userId) as
      | Record<string, unknown>
      | undefined;
  } finally {
    raw.close();
  }
}

/** An auth config over `adapter` signing with `secret`. */
function configFor(adapter: AuthAdapter, secret: string | string[]): AuthConfig {
  return {
    secret,
    canonicalOrigin: "https://app.test",
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    mfa: { window: 2, backupCodes: 2 },
  };
}

/** The TOTP code for `step` (RFC 6238, SHA-1, 6 digits), computed independently. */
async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(decodeBase32(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const at = mac[mac.length - 1] & 15;
  const bin = ((mac[at] & 0x7f) << 24 | mac[at + 1] << 16 | mac[at + 2] << 8 | mac[at + 3]) >>> 0;
  return String(bin % 1_000_000).padStart(6, "0");
}

const nowStep = (): number => Math.floor(Date.now() / 30_000);

function freshSession(userId: string): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: { id: userId, email: EMAIL },
    provider: "credentials",
    expiresAt: now + 3600,
    authTime: now,
  };
}

/** Enroll + confirm `userId` under `config`; hand back the plaintext secret. */
async function enroll(config: AuthConfig, userId: string): Promise<string> {
  const enrollment = await enrollTotp(config, freshSession(userId));
  assert(enrollment.ok);
  const confirmed = await confirmTotp(config, {
    user: { id: userId, email: EMAIL },
    code: await totpAt(enrollment.secret, nowStep() - 2),
  });
  assert(confirmed.ok, "the enrollment confirms with a code from the plaintext secret");
  return enrollment.secret;
}

// ---- the at-rest form --------------------------------------------------------------

Deno.test("sqliteAuthAdapter: the raw auth_mfa row never holds the TOTP secret", async () => {
  const path = tempDbPath();
  const adapter = sqliteAuthAdapter({ path });
  try {
    const user = await adapter.createUser({ email: EMAIL });
    const config = configFor(adapter, KEY_A);
    const secret = await enroll(config, user.id);

    const stored = String(rawMfaRow(path, user.id)?.secret);
    assertNotEquals(stored, secret, "the row is not the plaintext secret");
    assertFalse(stored.toUpperCase().includes(secret), "nor contains it");
    assert(stored.startsWith("totp.v1."), "it is the versioned sealed form");
    assertEquals(stored.split(".").length, 4, "version, nonce and ciphertext travel together");

    // …and the sealed factor still works end to end.
    const code = await totpAt(secret, nowStep() + 1);
    assertEquals(await verifySecondFactor(config, { userId: user.id, code }), {
      ok: true,
      method: "totp",
    });
  } finally {
    adapter.close?.();
  }
});

Deno.test("seal / open round-trip; every seal draws a fresh nonce", async () => {
  const secret = generateTotpSecret();
  const one = await sealTotpSecret([KEY_A], "u1", secret);
  const two = await sealTotpSecret([KEY_A], "u1", secret);
  assertNotEquals(one, two, "same plaintext, different nonce → different ciphertext");
  assert(isSealedTotpSecret(one));
  assertEquals(await openTotpSecret([KEY_A], "u1", one), { ok: true, secret, stale: false });
  assertEquals(await openTotpSecret([KEY_A], "u1", two), { ok: true, secret, stale: false });
});

// ---- legacy plaintext rows -----------------------------------------------------------

for (
  const [name, make] of [
    ["sqliteAuthAdapter", () => ({ adapter: sqliteAuthAdapter({ path: tempDbPath() }) })],
    ["inMemoryAuthAdapter", () => ({ adapter: inMemoryAuthAdapter() })],
  ] as const
) {
  Deno.test(`${name}: a legacy plaintext row keeps verifying and is re-sealed on that read`, async () => {
    const { adapter } = make();
    try {
      const user = await adapter.createUser({ email: EMAIL });
      const secret = generateTotpSecret();
      // A row as denext wrote it before sealing: the base32 secret itself.
      await adapter.setMfa!({
        userId: user.id,
        secret,
        backupCodeHashes: ["h1"],
        confirmedAt: Math.floor(Date.now() / 1000),
      });
      const config = configFor(adapter, KEY_A);
      const code = await totpAt(secret, nowStep());
      assertEquals(await verifySecondFactor(config, { userId: user.id, code }), {
        ok: true,
        method: "totp",
      });

      const after = (await adapter.getMfa!(user.id))!;
      assert(isSealedTotpSecret(after.secret), "re-sealed in place");
      assertEquals(after.backupCodeHashes, ["h1"], "the backup codes are untouched");
      assertEquals(after.lastStep, nowStep(), "the step the code spent stays spent");
      assertEquals(
        await openTotpSecret([KEY_A], user.id, after.secret),
        { ok: true, secret, stale: false },
      );
      // Re-sealed or not, the replayed code is still refused.
      assertEquals(await verifySecondFactor(config, { userId: user.id, code }), {
        ok: false,
        error: "invalid_code",
      });
    } finally {
      adapter.close?.();
    }
  });
}

Deno.test("a legacy plaintext PENDING enrollment confirms, and the confirm seals it", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const secret = generateTotpSecret();
  await adapter.setMfa!({ userId: user.id, secret, backupCodeHashes: [] });
  const config = configFor(adapter, KEY_A);
  const confirmed = await confirmTotp(config, {
    user: { id: user.id, email: EMAIL },
    code: await totpAt(secret, nowStep()),
  });
  assert(confirmed.ok);
  const stored = (await adapter.getMfa!(user.id))!.secret;
  assert(isSealedTotpSecret(stored));
  assertEquals((await openTotpSecret([KEY_A], user.id, stored)).ok, true);
});

// ---- failing closed ------------------------------------------------------------------

Deno.test("a wrong key fails closed: no code verifies, the user stays enrolled, the row is untouched", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const secret = await enroll(configFor(adapter, KEY_A), user.id);
  const sealed = (await adapter.getMfa!(user.id))!.secret;

  const warnings: string[] = [];
  const wrong: AuthConfig = {
    ...configFor(adapter, KEY_B),
    logger: { warn: (message, meta) => void warnings.push(`${message} ${JSON.stringify(meta)}`) },
  };
  const code = await totpAt(secret, nowStep() + 1);
  assertEquals(await verifySecondFactor(wrong, { userId: user.id, code }), {
    ok: false,
    error: "invalid_code",
  });
  assertEquals(
    await openTotpSecret([KEY_B], user.id, sealed),
    { ok: false },
    "no plaintext fallback",
  );
  assertEquals((await adapter.getMfa!(user.id))!.secret, sealed, "nothing was rewritten");
  assertEquals(
    await mfaPendingFor(resolveAuthOptions(wrong), { id: user.id }),
    true,
    "an unopenable factor still owes a second factor — it never reads as unenrolled",
  );
  assertEquals((await mfaStatus(wrong, user.id)).enrolled, true);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], user.id);
  assertFalse(warnings.join("\n").includes(secret), "the warning never carries the secret");
  assertFalse(warnings.join("\n").includes(sealed), "nor the sealed value");
});

Deno.test("a tampered ciphertext, a swapped owner, an unknown version and garbage are all refused", async () => {
  const secret = generateTotpSecret();
  const sealed = await sealTotpSecret([KEY_A], "u1", secret);
  const [, , nonce, body] = sealed.split(".");
  // Flip one bit in the ciphertext body (the first character's low bit, still valid base64url).
  const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  const cases: Record<string, [string, string]> = {
    "a flipped ciphertext bit": ["u1", `totp.v1.${nonce}.${flip(body)}`],
    "a flipped nonce bit": ["u1", `totp.v1.${flip(nonce)}.${body}`],
    "a truncated tag": ["u1", `totp.v1.${nonce}.${body.slice(0, -4)}`],
    "another user's row (AAD binds the owner)": ["u2", sealed],
    "an unknown version": ["u1", `totp.v2.${nonce}.${body}`],
    "a missing part": ["u1", `totp.v1.${body}`],
    "not base64url": ["u1", `totp.v1.${nonce}.***`],
    "neither sealed nor base32": ["u1", "not a secret!"],
  };
  for (const [what, [userId, stored]] of Object.entries(cases)) {
    assertEquals(await openTotpSecret([KEY_A], userId, stored), { ok: false }, what);
  }
});

Deno.test("verifySecondFactor refuses a tampered row and keeps the user enrolled", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const config = configFor(adapter, KEY_A);
  const secret = await enroll(config, user.id);
  const record = (await adapter.getMfa!(user.id))!;
  const [, , nonce, body] = record.secret.split(".");
  const tampered = `totp.v1.${nonce}.${(body[0] === "A" ? "B" : "A") + body.slice(1)}`;
  await adapter.setMfa!({ ...record, secret: tampered });
  const code = await totpAt(secret, nowStep() + 1);
  assertEquals(await verifySecondFactor(config, { userId: user.id, code }), {
    ok: false,
    error: "invalid_code",
  });
  assertEquals((await mfaStatus(config, user.id)).enrolled, true);
});

// ---- rotation --------------------------------------------------------------------------

Deno.test("rotation: a secret sealed under a rotated-out key opens and is re-sealed under the current one", async () => {
  const path = tempDbPath();
  const adapter = sqliteAuthAdapter({ path });
  try {
    const user = await adapter.createUser({ email: EMAIL });
    const secret = await enroll(configFor(adapter, KEY_A), user.id);
    const underA = String(rawMfaRow(path, user.id)?.secret);

    // Rotate: B is current, A is kept to read what it sealed.
    const rotated = configFor(adapter, [KEY_B, KEY_A]);
    const code = await totpAt(secret, nowStep() + 1);
    assertEquals(await verifySecondFactor(rotated, { userId: user.id, code }), {
      ok: true,
      method: "totp",
    });
    const underB = String(rawMfaRow(path, user.id)?.secret);
    assertNotEquals(underB, underA, "re-sealed");
    assertEquals(await openTotpSecret([KEY_B], user.id, underB), {
      ok: true,
      secret,
      stale: false,
    });
    assertEquals(await openTotpSecret([KEY_A], user.id, underB), { ok: false });

    // Once A is dropped from the list, the factor still verifies under B alone.
    const later = await totpAt(secret, nowStep() + 2);
    assertEquals(
      await verifySecondFactor(configFor(adapter, KEY_B), { userId: user.id, code: later }),
      {
        ok: true,
        method: "totp",
      },
    );
  } finally {
    adapter.close?.();
  }
});

Deno.test("an adapter without replaceMfaSecret keeps a stale secret readable (no whole-record rewrite)", async () => {
  const full = inMemoryAuthAdapter();
  const { replaceMfaSecret: _swap, ...adapter } = full;
  const user = await adapter.createUser({ email: EMAIL });
  const secret = generateTotpSecret();
  await adapter.setMfa!({
    userId: user.id,
    secret,
    backupCodeHashes: [],
    confirmedAt: Math.floor(Date.now() / 1000),
  });
  const config = configFor(adapter as AuthAdapter, KEY_A);
  const code = await totpAt(secret, nowStep());
  assertEquals((await verifySecondFactor(config, { userId: user.id, code })).ok, true);
  assertEquals((await adapter.getMfa!(user.id))!.secret, secret, "left as it was");
});
