// `denext auth reseal` / `resealTotpFactors`: every TOTP factor a retired auth `secret` (or a
// pre-sealing plaintext row, or a pre-4.0 record's user binding) still holds moves onto the
// current secret without waiting for a code — written through `updateMfaFactor`, idempotently
// and resumably — so the retired secret can be dropped once the report says zero remaining.
// A dry run counts and writes nothing; a factor no configured secret opens is never written;
// `/auth/v1`'s factors (the same store, sealed the same way) are covered; no secret is printed.

import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import type { CommandContext } from "../src/cli/command.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { type AuthCommandIo, createAuthCommand } from "../src/server/auth/command.ts";
import { factorAad } from "../src/server/auth/factors.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { confirmTotp, enrollTotp, verifySecondFactor } from "../src/server/auth/mfa.ts";
import { resealTotpFactors } from "../src/server/auth/reseal.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import { generateTotpSecret } from "../src/server/auth/totp.ts";
import { openTotpSecret, sealTotpSecret } from "../src/server/auth/totp-seal.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";

const KEY_A = "first-auth-secret-at-least-32-characters";
const KEY_B = "second-auth-secret-at-least-32-characters";
const KEY_X = "unrelated-auth-secret-at-least-32-chars!";

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

function freshSession(userId: string, email: string): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: { id: userId, email },
    provider: "credentials",
    expiresAt: now + 3600,
    authTime: now,
  };
}

/** Enroll + confirm a user under `config`; hand back the plaintext secret. */
async function enroll(config: AuthConfig, userId: string, email: string): Promise<string> {
  const enrollment = await enrollTotp(config, freshSession(userId, email));
  assert(enrollment.ok);
  const confirmed = await confirmTotp(config, {
    user: { id: userId, email },
    code: await totpAt(enrollment.secret, nowStep() - 2),
  });
  assert(confirmed.ok);
  return enrollment.secret;
}

/** A factor written straight into the store, as `/auth/v1`'s `factors` route seals one. */
async function goTrueFactor(
  adapter: AuthAdapter,
  userId: string,
  keys: string[],
): Promise<{ id: string; secret: string }> {
  const id = crypto.randomUUID();
  const secret = generateTotpSecret();
  const at = Math.floor(Date.now() / 1000);
  await adapter.createMfaFactor!({
    id,
    userId,
    type: "totp",
    status: "verified",
    friendlyName: "phone app",
    secret: await sealTotpSecret(keys, `${userId}:${id}`, secret),
    createdAt: at,
    updatedAt: at,
  });
  return { id, secret };
}

/** The stored (sealed) value of every TOTP factor of a user. */
async function storedSecrets(adapter: AuthAdapter, userId: string): Promise<string[]> {
  return (await adapter.listMfaFactors!(userId)).filter((f) => f.type === "totp").map((f) =>
    String(f.secret)
  );
}

/** A mixed population: current, retired-key, `/auth/v1`, plaintext legacy and unopenable. */
async function population(adapter: AuthAdapter) {
  const underA = configFor(adapter, KEY_A);
  const current = await adapter.createUser({ email: "cur@x.test" });
  const retired = await adapter.createUser({ email: "old@x.test" });
  const gotrue = await adapter.createUser({ email: "api@x.test" });
  const legacy = await adapter.createUser({ email: "legacy@x.test" });
  const lost = await adapter.createUser({ email: "lost@x.test" });
  await adapter.createUser({ email: "none@x.test" }); // no factor at all
  const retiredSecret = await enroll(underA, retired.id, "old@x.test");
  const currentSecret = await enroll(configFor(adapter, [KEY_B, KEY_A]), current.id, "cur@x.test");
  const api = await goTrueFactor(adapter, gotrue.id, [KEY_A]);
  const legacySecret = generateTotpSecret();
  await adapter.setMfa!({
    userId: legacy.id,
    secret: legacySecret,
    confirmedAt: 1,
    backupCodeHashes: [],
  });
  await goTrueFactor(adapter, lost.id, [KEY_X]);
  return {
    current,
    retired,
    gotrue,
    legacy,
    lost,
    retiredSecret,
    currentSecret,
    api,
    legacySecret,
  };
}

Deno.test("dry run: counts every stale factor (a legacy record included) and writes nothing", async () => {
  const adapter = inMemoryAuthAdapter();
  const p = await population(adapter);
  const before = await storedSecrets(adapter, p.retired.id);
  const report = await resealTotpFactors(configFor(adapter, [KEY_B, KEY_A]), { dryRun: true });
  assertEquals(report, {
    dryRun: true,
    users: 6,
    factors: 5,
    current: 1,
    resealed: 0,
    remaining: 3,
    unopenable: 1,
  });
  assertEquals(await storedSecrets(adapter, p.retired.id), before);
  assertEquals((await adapter.getMfa!(p.legacy.id))?.secret, p.legacySecret, "record untouched");
});

Deno.test("a run re-seals every stale factor; afterwards the retired secret can go", async () => {
  const adapter = inMemoryAuthAdapter();
  const p = await population(adapter);
  const rotated = configFor(adapter, [KEY_B, KEY_A]);
  const lostBefore = await storedSecrets(adapter, p.lost.id);
  const report = await resealTotpFactors(rotated);
  assertEquals(report, {
    dryRun: false,
    users: 6,
    factors: 5,
    current: 4,
    resealed: 3,
    remaining: 0,
    unopenable: 1,
  });
  // Every stale factor now opens under KEY_B alone, bound to its own factor.
  for (
    const [user, secret] of [[p.retired, p.retiredSecret], [p.legacy, p.legacySecret]] as const
  ) {
    const [factor] = (await adapter.listMfaFactors!(user.id)).filter((f) => f.type === "totp");
    assertEquals(await openTotpSecret([KEY_B], factorAad(factor), factor.secret!), {
      ok: true,
      secret,
      stale: false,
    });
  }
  const [apiFactor] = await adapter.listMfaFactors!(p.gotrue.id);
  assertEquals(
    await openTotpSecret([KEY_B], `${p.gotrue.id}:${p.api.id}`, apiFactor.secret!),
    { ok: true, secret: p.api.secret, stale: false },
    "the /auth/v1 factor is covered",
  );
  // The factor nothing opens is never written.
  assertEquals(await storedSecrets(adapter, p.lost.id), lostBefore);
  // With KEY_A removed, the users who held it still pass a TOTP code.
  const onlyB = configFor(adapter, KEY_B);
  const code = await totpAt(p.retiredSecret, nowStep() + 1);
  assertEquals(
    (await verifySecondFactor(onlyB, { userId: p.retired.id, code })).ok,
    true,
  );
});

Deno.test("idempotent: a second run re-seals nothing and changes no row", async () => {
  const adapter = inMemoryAuthAdapter();
  const p = await population(adapter);
  const rotated = configFor(adapter, [KEY_B, KEY_A]);
  await resealTotpFactors(rotated);
  const after = await storedSecrets(adapter, p.retired.id);
  const again = await resealTotpFactors(rotated);
  assertEquals(again.resealed, 0);
  assertEquals(again.remaining, 0);
  assertEquals(await storedSecrets(adapter, p.retired.id), after, "no fresh nonce, no write");
});

Deno.test("resumable: a run interrupted mid-way keeps its writes, and the next one finishes", async () => {
  const inner = inMemoryAuthAdapter();
  const p = await population(inner);
  let writes = 0;
  const flaky: AuthAdapter = {
    ...inner,
    updateMfaFactor(id, patch) {
      if (++writes === 2) throw new Error("connection lost");
      return inner.updateMfaFactor!(id, patch);
    },
  };
  const rotated = configFor(flaky, [KEY_B, KEY_A]);
  await assertRejects(() => resealTotpFactors(rotated), Error, "connection lost");
  const partial = await resealTotpFactors(configFor(inner, [KEY_B, KEY_A]), { dryRun: true });
  assertEquals(partial.remaining, 2, "the first write stuck");
  const finished = await resealTotpFactors(configFor(inner, [KEY_B, KEY_A]));
  assertEquals(finished.resealed, 2);
  assertEquals(finished.remaining, 0);
  assert(p.retired.id);
});

Deno.test("paging: users beyond one page are covered", async () => {
  const adapter = inMemoryAuthAdapter();
  const underA = configFor(adapter, KEY_A);
  for (let i = 0; i < 5; i++) {
    const user = await adapter.createUser({ email: `u${i}@x.test` });
    await enroll(underA, user.id, `u${i}@x.test`);
  }
  const report = await resealTotpFactors(configFor(adapter, [KEY_B, KEY_A]), { pageSize: 2 });
  assertEquals([report.users, report.resealed, report.remaining], [5, 5, 0]);
});

Deno.test("sqliteAuthAdapter: the re-sealed row is written through updateMfaFactor", async () => {
  const path = `${Deno.makeTempDirSync({ prefix: "denext-reseal-" })}/auth.db`;
  const adapter = sqliteAuthAdapter({ path });
  try {
    const user = await adapter.createUser({ email: "sql@x.test" });
    const secret = await enroll(configFor(adapter, KEY_A), user.id, "sql@x.test");
    const report = await resealTotpFactors(configFor(adapter, [KEY_B, KEY_A]));
    assertEquals([report.resealed, report.remaining], [1, 0]);
    const [factor] = await adapter.listMfaFactors!(user.id);
    assertEquals(
      (await openTotpSecret([KEY_B], factorAad(factor), factor.secret!)).ok,
      true,
    );
    assertFalse(String(factor.secret).includes(secret));
  } finally {
    adapter.close?.();
  }
});

Deno.test("an adapter without listUsers is refused with a clear error", async () => {
  const { listUsers: _drop, ...adapter } = inMemoryAuthAdapter();
  await assertRejects(
    () => resealTotpFactors(configFor(adapter as AuthAdapter, [KEY_B, KEY_A])),
    Error,
    "listUsers",
  );
});

// ---- the CLI verb --------------------------------------------------------------------------

function ioCapture(): AuthCommandIo & { out: string[]; err: string[]; codes: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  return {
    out,
    err,
    codes,
    log: (line) => void out.push(line),
    error: (line) => void err.push(line),
    exit: (code) => void codes.push(code),
  };
}

function cliContext(
  positionals: string[],
  flags: Record<string, boolean | number> = {},
  json = false,
) {
  return {
    positionals,
    flags,
    global: { json, verbose: false, quiet: false },
    rest: [],
  } as CommandContext;
}

Deno.test("denext auth reseal --dry-run prints counts, never a secret", async () => {
  const adapter = inMemoryAuthAdapter();
  const p = await population(adapter);
  const io = ioCapture();
  const command = createAuthCommand(configFor(adapter, [KEY_B, KEY_A]), io);
  assertEquals(command.name, "auth");
  await command.run(cliContext(["reseal"], { "dry-run": true }));
  const text = io.out.join("\n");
  assert(text.includes("remaining:          3"), text);
  assert(text.includes("dry run"));
  for (
    const secret of [p.retiredSecret, p.currentSecret, p.api.secret, p.legacySecret, KEY_A, KEY_B]
  ) {
    assertFalse(text.includes(secret), "no secret in the output");
  }
  assertEquals(io.codes, []);
});

Deno.test("denext auth reseal --json reports the run; a bad action exits 2", async () => {
  const adapter = inMemoryAuthAdapter();
  await population(adapter);
  const io = ioCapture();
  const command = createAuthCommand(configFor(adapter, [KEY_B, KEY_A]), io);
  await command.run(cliContext(["reseal"], {}, true));
  const report = JSON.parse(io.out[0]);
  assertEquals([report.resealed, report.remaining, report.unopenable], [3, 0, 1]);
  assertEquals(io.codes, []);
  await command.run(cliContext(["nope"]));
  assertEquals(io.codes, [2]);
  assertThrows(
    () => {
      throw new Error(io.err.join("\n"));
    },
    Error,
    "unknown action",
  );
});
