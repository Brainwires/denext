// TOTP secrets at rest: the MFA layer seals a factor's secret (AES-256-GCM, a key HKDF-derived
// from the auth `secret`, the factor as associated data) before the adapter stores it. The raw
// sqlite row never holds the base32 secret; a legacy `MfaRecord` secret (sealed for the user, or
// a pre-sealing plaintext row) moves into a factor and is re-sealed for it after the first code
// it accepts; a rotated-out `secret` kept in the list still opens (and is re-sealed under the
// current one); a wrong key, a tampered ciphertext, another factor's ciphertext, an unknown
// version and garbage all fail CLOSED — no TOTP code verifies, the user stays enrolled, and no
// plaintext fallback is ever taken.

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import { DatabaseSync } from "node:sqlite";
import type { AuthAdapter, MfaFactorRecord } from "../packages/auth/src/adapter.ts";
import { factorAad } from "../packages/auth/src/factors.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import {
  confirmTotp,
  enrollTotp,
  mfaPendingFor,
  mfaStatus,
  verifySecondFactor,
} from "../packages/auth/src/mfa.ts";
import { sqliteAuthAdapter } from "../packages/auth/src/sqlite-adapter.ts";
import { generateTotpSecret } from "../packages/auth/src/totp.ts";
import {
  isSealedTotpSecret,
  openTotpSecret,
  sealTotpSecret,
} from "../packages/auth/src/totp-seal.ts";
import type { AuthConfig, AuthSession } from "../packages/auth/src/types.ts";
import { makeTempDirUntilExit } from "./helpers/temp.ts";

const KEY_A = "first-auth-secret-at-least-32-characters";
const KEY_B = "second-auth-secret-at-least-32-characters";
const EMAIL = "ada@x.test";

/** A fresh database file of our own. */
function tempDbPath(): string {
  return `${makeTempDirUntilExit("denext-totp-seal-")}/auth.db`;
}

/** The raw TOTP factor row, read with a connection of our own (not the adapter's). */
function rawFactorRow(path: string, userId: string): Record<string, unknown> | undefined {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare(
      "SELECT * FROM auth_mfa_factors WHERE user_id = ? AND factor_type = 'totp'",
    ).get(userId) as Record<string, unknown> | undefined;
  } finally {
    raw.close();
  }
}

/** The user's one TOTP factor, through the adapter. */
async function totpFactor(
  adapter: AuthAdapter,
  userId: string,
): Promise<MfaFactorRecord & { secret: string }> {
  const factors = (await adapter.listMfaFactors!(userId)).filter((f) => f.type === "totp");
  assertEquals(factors.length, 1);
  assert(factors[0].secret);
  return factors[0] as MfaFactorRecord & { secret: string };
}

/** `verifySecondFactor`'s answer, without the factor id. */
async function verify(config: AuthConfig, userId: string, code: string) {
  const { factorId: _id, ...rest } = await verifySecondFactor(config, { userId, code }) as {
    factorId?: string;
  };
  return rest;
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

// Every test runs on a pinned clock, 15 s into one 30 s step: a code computed for
// `nowStep() + k` must verify against the same current step it was computed from. On the
// wall clock the step could roll over between computing a code and verifying it, which put
// `nowStep() - 2` (the edge of the ±2 window) outside the window.
const PINNED_MS = Math.floor(Date.now() / 30_000) * 30_000 + 15_000;
const nowStep = (): number => Math.floor(Date.now() / 30_000);

/** `Deno.test` with `Date.now` pinned to {@linkcode PINNED_MS} for the test's duration. */
function test(name: string, fn: () => Promise<void>): void {
  Deno.test(name, async () => {
    const realNow = Date.now;
    Date.now = () => PINNED_MS;
    try {
      await fn();
    } finally {
      Date.now = realNow;
    }
  });
}

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

test("sqliteAuthAdapter: the raw factor row never holds the TOTP secret", async () => {
  const path = tempDbPath();
  const adapter = sqliteAuthAdapter({ path });
  try {
    const user = await adapter.createUser({ email: EMAIL });
    const config = configFor(adapter, KEY_A);
    const secret = await enroll(config, user.id);

    const stored = String(rawFactorRow(path, user.id)?.secret);
    assertNotEquals(stored, secret, "the row is not the plaintext secret");
    assertFalse(stored.toUpperCase().includes(secret), "nor contains it");
    assert(stored.startsWith("totp.v1."), "it is the versioned sealed form");
    assertEquals(stored.split(".").length, 4, "version, nonce and ciphertext travel together");
    const factor = await totpFactor(adapter, user.id);
    assertEquals((await openTotpSecret([KEY_A], user.id, stored)).ok, false, "bound to the factor");
    assertEquals((await openTotpSecret([KEY_A], factorAad(factor), stored)).ok, true);

    // …and the sealed factor still works end to end.
    const code = await totpAt(secret, nowStep() + 1);
    assertEquals(await verify(config, user.id, code), { ok: true, method: "totp" });
  } finally {
    adapter.close?.();
  }
});

test("seal / open round-trip; every seal draws a fresh nonce", async () => {
  const secret = generateTotpSecret();
  const one = await sealTotpSecret([KEY_A], "u1", secret);
  const two = await sealTotpSecret([KEY_A], "u1", secret);
  assertNotEquals(one, two, "same plaintext, different nonce → different ciphertext");
  assert(isSealedTotpSecret(one));
  assertEquals(await openTotpSecret([KEY_A], "u1", one), { ok: true, secret, stale: false });
  assertEquals(await openTotpSecret([KEY_A], "u1", two), { ok: true, secret, stale: false });
});

// ---- legacy MfaRecord secrets -----------------------------------------------------------

for (
  const [name, make] of [
    ["sqliteAuthAdapter", () => ({ adapter: sqliteAuthAdapter({ path: tempDbPath() }) })],
    ["inMemoryAuthAdapter", () => ({ adapter: inMemoryAuthAdapter() })],
  ] as const
) {
  for (const sealed of [false, true]) {
    test(`${name}: a legacy ${sealed ? "sealed" : "plaintext"} MfaRecord secret moves into a factor and is re-sealed for it`, async () => {
      const { adapter } = make();
      try {
        const user = await adapter.createUser({ email: EMAIL });
        const secret = generateTotpSecret();
        // A record as an earlier denext wrote it: sealed for the user, or the base32 itself.
        await adapter.setMfa!({
          userId: user.id,
          secret: sealed ? await sealTotpSecret([KEY_A], user.id, secret) : secret,
          backupCodeHashes: ["h1"],
          confirmedAt: Math.floor(Date.now() / 1000),
          lastStep: nowStep() - 5,
        });
        const config = configFor(adapter, KEY_A);
        const code = await totpAt(secret, nowStep());
        assertEquals(await verify(config, user.id, code), { ok: true, method: "totp" });

        const record = (await adapter.getMfa!(user.id))!;
        assertEquals(record.secret, "", "the record no longer holds the secret");
        assertEquals(record.backupCodeHashes, ["h1"], "the backup codes are untouched");
        const factor = await totpFactor(adapter, user.id);
        assertEquals(factor.status, "verified");
        assertEquals(factor.lastStep, nowStep(), "the step the code spent stays spent");
        assert(isSealedTotpSecret(factor.secret), "re-sealed");
        assertEquals(
          await openTotpSecret([KEY_A], factorAad(factor), factor.secret),
          { ok: true, secret, stale: false },
          "for the factor",
        );
        // Re-sealed or not, the replayed code is still refused.
        assertEquals(await verify(config, user.id, code), { ok: false, error: "invalid_code" });
      } finally {
        adapter.close?.();
      }
    });
  }
}

test("a legacy plaintext PENDING enrollment confirms, and the confirm seals it", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const secret = generateTotpSecret();
  await adapter.setMfa!({ userId: user.id, secret, backupCodeHashes: [] });
  const config = configFor(adapter, KEY_A);
  assertEquals((await mfaStatus(config, user.id)).pendingConfirmation, true);
  const confirmed = await confirmTotp(config, {
    user: { id: user.id, email: EMAIL },
    code: await totpAt(secret, nowStep()),
  });
  assert(confirmed.ok);
  const factor = await totpFactor(adapter, user.id);
  assertEquals(factor.status, "verified");
  assert(isSealedTotpSecret(factor.secret));
  assertEquals((await openTotpSecret([KEY_A], factorAad(factor), factor.secret)).ok, true);
});

test("a legacy secret no configured key opens still moves — the user stays enrolled until the key returns", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const secret = generateTotpSecret();
  await adapter.setMfa!({
    userId: user.id,
    secret: await sealTotpSecret([KEY_A], user.id, secret),
    backupCodeHashes: [],
    confirmedAt: 1,
  });
  const wrong = { ...configFor(adapter, KEY_B), logger: { warn: () => {} } };
  assertEquals(
    await mfaPendingFor(wrong, { id: user.id }),
    true,
    "fail closed: never read as unenrolled",
  );
  assertEquals(
    await verify(wrong, user.id, await totpAt(secret, nowStep())),
    { ok: false, error: "invalid_code" },
  );
  // The operator puts the old key back (as a retired one): the factor opens again.
  const fixed = configFor(adapter, [KEY_B, KEY_A]);
  assertEquals(
    await verify(fixed, user.id, await totpAt(secret, nowStep() + 1)),
    { ok: true, method: "totp" },
  );
  const factor = await totpFactor(adapter, user.id);
  assertEquals(
    await openTotpSecret([KEY_B], factorAad(factor), factor.secret),
    { ok: true, secret, stale: false },
    "re-sealed under the current key, for the factor",
  );
});

test("an adapter without replaceMfaSecret migrates through setMfa and keeps the backup codes", async () => {
  const full = inMemoryAuthAdapter();
  const { replaceMfaSecret: _swap, ...adapter } = full;
  const user = await adapter.createUser({ email: EMAIL });
  const secret = generateTotpSecret();
  await adapter.setMfa!({
    userId: user.id,
    secret,
    backupCodeHashes: ["h1"],
    confirmedAt: Math.floor(Date.now() / 1000),
  });
  const config = configFor(adapter as AuthAdapter, KEY_A);
  const code = await totpAt(secret, nowStep());
  assertEquals((await verifySecondFactor(config, { userId: user.id, code })).ok, true);
  const record = (await adapter.getMfa!(user.id))!;
  assertEquals([record.secret, record.backupCodeHashes], ["", ["h1"]]);
});

// ---- failing closed ------------------------------------------------------------------

test("a wrong key fails closed: no code verifies, the user stays enrolled, the row is untouched", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const secret = await enroll(configFor(adapter, KEY_A), user.id);
  const factor = await totpFactor(adapter, user.id);
  const sealed = factor.secret;

  const warnings: string[] = [];
  const wrong: AuthConfig = {
    ...configFor(adapter, KEY_B),
    logger: { warn: (message, meta) => void warnings.push(`${message} ${JSON.stringify(meta)}`) },
  };
  const code = await totpAt(secret, nowStep() + 1);
  assertEquals(await verify(wrong, user.id, code), { ok: false, error: "invalid_code" });
  assertEquals(
    await openTotpSecret([KEY_B], factorAad(factor), sealed),
    { ok: false },
    "no plaintext fallback",
  );
  assertEquals((await totpFactor(adapter, user.id)).secret, sealed, "nothing was rewritten");
  assertEquals(
    await mfaPendingFor(wrong, { id: user.id }),
    true,
    "an unopenable factor still owes a second factor — it never reads as unenrolled",
  );
  assertEquals((await mfaStatus(wrong, user.id)).enrolled, true);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], user.id);
  assertFalse(warnings.join("\n").includes(secret), "the warning never carries the secret");
  assertFalse(warnings.join("\n").includes(sealed), "nor the sealed value");
});

test("a tampered ciphertext, a swapped owner, an unknown version and garbage are all refused", async () => {
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

test("verifySecondFactor refuses a tampered factor and keeps the user enrolled", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const config = configFor(adapter, KEY_A);
  const secret = await enroll(config, user.id);
  const factor = await totpFactor(adapter, user.id);
  const [, , nonce, body] = factor.secret.split(".");
  const tampered = `totp.v1.${nonce}.${(body[0] === "A" ? "B" : "A") + body.slice(1)}`;
  await adapter.updateMfaFactor!(factor.id, { secret: tampered });
  const quiet = { ...config, logger: { warn: () => {} } };
  const code = await totpAt(secret, nowStep() + 1);
  assertEquals(await verify(quiet, user.id, code), { ok: false, error: "invalid_code" });
  assertEquals((await mfaStatus(quiet, user.id)).enrolled, true);
});

test("another factor's ciphertext does not open under this one (the AAD binds the factor)", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL });
  const config = configFor(adapter, KEY_A);
  const secret = await enroll(config, user.id);
  const factor = await totpFactor(adapter, user.id);
  // A second (unverified) factor for the same user carrying the first one's sealed secret.
  await adapter.createMfaFactor!({
    ...factor,
    id: crypto.randomUUID(),
    status: "verified",
    lastStep: undefined,
    createdAt: factor.createdAt + 1,
  });
  await adapter.deleteMfaFactor!(factor.id);
  const quiet = { ...config, logger: { warn: () => {} } };
  assertEquals(
    await verify(quiet, user.id, await totpAt(secret, nowStep() + 1)),
    { ok: false, error: "invalid_code" },
  );
});

// ---- rotation --------------------------------------------------------------------------

test("rotation: a secret sealed under a rotated-out key opens and is re-sealed under the current one", async () => {
  const path = tempDbPath();
  const adapter = sqliteAuthAdapter({ path });
  try {
    const user = await adapter.createUser({ email: EMAIL });
    const secret = await enroll(configFor(adapter, KEY_A), user.id);
    const underA = String(rawFactorRow(path, user.id)?.secret);
    const aad = factorAad(await totpFactor(adapter, user.id));

    // Rotate: B is current, A is kept to read what it sealed.
    const rotated = configFor(adapter, [KEY_B, KEY_A]);
    const code = await totpAt(secret, nowStep() + 1);
    assertEquals(await verify(rotated, user.id, code), { ok: true, method: "totp" });
    const underB = String(rawFactorRow(path, user.id)?.secret);
    assertNotEquals(underB, underA, "re-sealed");
    assertEquals(await openTotpSecret([KEY_B], aad, underB), { ok: true, secret, stale: false });
    assertEquals(await openTotpSecret([KEY_A], aad, underB), { ok: false });

    // Once A is dropped from the list, the factor still verifies under B alone.
    const later = await totpAt(secret, nowStep() + 2);
    assertEquals(await verify(configFor(adapter, KEY_B), user.id, later), {
      ok: true,
      method: "totp",
    });
  } finally {
    adapter.close?.();
  }
});
