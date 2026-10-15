// Password hashing helpers: scrypt round-trip, the self-describing hash format,
// wrong-password / malformed-input rejection (never a throw), and the parameter caps.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  __observeScryptForTests,
  hashPassword,
  verifyPassword,
} from "../src/server/auth/password.ts";
import { scryptHasher } from "../src/server/auth/hasher.ts";

/**
 * The scrypt derivations `fn` completed, as `N=…,r=…,p=…` in order. Equal work is the same
 * derivation at the same work factor — asserted on the parameters, never on a wall clock that
 * a loaded machine skews.
 */
async function derivations(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const previous = __observeScryptForTests((p) => seen.push(`N=${p.N},r=${p.r},p=${p.p}`));
  try {
    await fn();
  } finally {
    __observeScryptForTests(previous);
  }
  return seen;
}

Deno.test("hashPassword → verifyPassword round-trips; a wrong password fails", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assertEquals(await verifyPassword("correct horse battery staple", stored), true);
  assertEquals(await verifyPassword("correct horse battery stapl", stored), false);
  assertEquals(await verifyPassword("", stored), false);
});

Deno.test("hashPassword emits a self-describing scrypt string with a fresh salt each time", async () => {
  const a = await hashPassword("pw");
  const b = await hashPassword("pw");
  assertStringIncludes(a, "scrypt$N=16384,r=8,p=1$");
  assertEquals(a.split("$").length, 4, "algo $ params $ salt $ hash");
  assertNotEquals(a, b, "a fresh random salt per hash — equal passwords never share a hash");
  assert(/^[A-Za-z0-9_-]+$/.test(a.split("$")[2]), "salt is base64url");
  assert(/^[A-Za-z0-9_-]+$/.test(a.split("$")[3]), "hash is base64url");
});

Deno.test("hashPassword honors custom cost parameters and verify reads them back", async () => {
  const stored = await hashPassword("pw", { cost: 4096, blockSize: 4, parallelization: 2 });
  assertStringIncludes(stored, "scrypt$N=4096,r=4,p=2$");
  assertEquals(await verifyPassword("pw", stored), true);
  assertEquals(await verifyPassword("PW", stored), false);
});

Deno.test("verifyPassword returns false (never throws) on malformed stored values", async () => {
  const good = await hashPassword("pw");
  const [, params, salt, hash] = good.split("$");
  const malformed: Record<string, string> = {
    "empty": "",
    "plaintext": "pw",
    "legacy salt:hash format": "abc:def",
    "wrong algo": `bcrypt$${params}$${salt}$${hash}`,
    "missing hash segment": `scrypt$${params}$${salt}`,
    "extra segment": `${good}$extra`,
    "non-numeric N": `scrypt$N=abc,r=8,p=1$${salt}$${hash}`,
    "unknown param": `scrypt$N=16384,r=8,p=1,x=1$${salt}$${hash}`,
    "missing p": `scrypt$N=16384,r=8$${salt}$${hash}`,
    "N not a power of two": `scrypt$N=1000,r=8,p=1$${salt}$${hash}`,
    "N over the sanity cap (self-DoS guard)": `scrypt$N=1073741824,r=8,p=1$${salt}$${hash}`,
    "r over the cap": `scrypt$N=16384,r=1024,p=1$${salt}$${hash}`,
    "undecodable salt": `scrypt$${params}$!!!$${hash}`,
    "empty salt": `scrypt$${params}$$${hash}`,
    "hash of the wrong length": `scrypt$${params}$${salt}$${hash.slice(0, 10)}`,
  };
  for (const [label, stored] of Object.entries(malformed)) {
    assertEquals(await verifyPassword("pw", stored), false, label);
  }
  // Non-string inputs (a missing form field reaches authorize as undefined).
  assertEquals(await verifyPassword(undefined as unknown as string, good), false);
  assertEquals(await verifyPassword("pw", undefined as unknown as string), false);
});

Deno.test("verifyPassword rejects a tampered hash (constant-time compare path)", async () => {
  const good = await hashPassword("pw");
  const [algo, params, salt, hash] = good.split("$");
  const flipped = (hash[0] === "A" ? "B" : "A") + hash.slice(1);
  assertEquals(await verifyPassword("pw", `${algo}$${params}$${salt}$${flipped}`), false);
  // A different salt with the same hash bytes can't verify either.
  const other = (await hashPassword("pw")).split("$")[2];
  assertEquals(await verifyPassword("pw", `${algo}$${params}$${other}$${hash}`), false);
});

Deno.test("verifyPassword: a missing/malformed stored hash still does full scrypt work (no timing oracle)", async () => {
  const stored = await hashPassword("pw");
  const rejected = (s: string) =>
    derivations(async () => assertEquals(await verifyPassword("wrong", s), false));
  const real = await rejected(stored);
  assertEquals(real, ["N=16384,r=8,p=1"], "a known hash is checked at its own cost");
  // The rejection derives a dummy key at the default cost: the same work as a real check.
  assertEquals(await rejected(""), real, "an empty stored value is rejected after equal work");
  assertEquals(await rejected("md5$nope"), real, "a malformed one is rejected after equal work");
});

Deno.test("verifyPassword: a stored hash demanding a huge scrypt working set is refused, not allocated", async () => {
  const [, , salt, hash] = (await hashPassword("pw")).split("$");
  // 128·N·r = 4 GiB — over the 256 MiB self-DoS bound even though each parameter is in range.
  assertEquals(await verifyPassword("pw", `scrypt$N=1048576,r=32,p=1$${salt}$${hash}`), false);
});

Deno.test("verifyPassword: the equal-work rejection burns the CONFIGURED cost, not the default", async () => {
  // An unknown account has no stored hash to read parameters from, so the dummy derivation
  // has to be told what this deployment hashes at. Burning the built-in default instead
  // made an unknown identifier reject several times faster than a known one — a
  // user-enumeration timing oracle that got WORSE the more you raised `cost`.
  const burned = (options: { cost: number }) =>
    derivations(async () => assertEquals(await verifyPassword("whatever", "", options), false));
  assertEquals(await burned({ cost: 2 }), ["N=2,r=8,p=1"]);
  assertEquals(
    await burned({ cost: 1 << 15 }),
    ["N=32768,r=8,p=1"],
    "a high configured cost is the cost burned even with no stored hash",
  );
});

Deno.test("scryptHasher: verify threads the hasher's own cost into both halves", async () => {
  const hasher = scryptHasher({ cost: 1 << 15 });
  const stored = await hasher.hash("correct horse");
  assertStringIncludes(stored, "scrypt$N=32768,r=8,p=1$");
  assertEquals(await hasher.verify("correct horse", stored), true);
  // Known-account and unknown-account rejections do the same work: one derivation each, at
  // the hasher's cost.
  const known = await derivations(async () =>
    assertEquals(await hasher.verify("wrong", stored), false)
  );
  const unknown = await derivations(async () =>
    assertEquals(await hasher.verify("wrong", ""), false)
  );
  assertEquals(known, ["N=32768,r=8,p=1"]);
  assertEquals(unknown, known, "no user-enumeration oracle: the unknown account burns the same");
});
