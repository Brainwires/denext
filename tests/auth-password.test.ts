// Password hashing helpers: scrypt round-trip, the self-describing hash format,
// wrong-password / malformed-input rejection (never a throw), and the parameter caps.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { hashPassword, verifyPassword } from "../src/server/auth/password.ts";
import { scryptHasher } from "../src/server/auth/hasher.ts";

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
  const timed = async (s: string) => {
    const t = performance.now();
    assertEquals(await verifyPassword("wrong", s), false);
    return performance.now() - t;
  };
  const real = await timed(stored);
  const empty = await timed("");
  const garbage = await timed("md5$nope");
  // Same order of magnitude: the rejection derives a dummy key at the default cost.
  assert(empty > real / 4, `empty stored rejected too fast: ${empty}ms vs ${real}ms`);
  assert(garbage > real / 4, `malformed stored rejected too fast: ${garbage}ms vs ${real}ms`);
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
  const time = async (options: { cost: number }) => {
    const at = performance.now();
    await verifyPassword("whatever", "", options);
    return performance.now() - at;
  };
  await time({ cost: 2 }); // warm the gate + the scrypt binding
  const cheap = await time({ cost: 2 });
  const dear = await time({ cost: 1 << 15 });
  assert(
    dear > cheap + 20,
    `a high configured cost must cost time even with no stored hash (${cheap}ms vs ${dear}ms)`,
  );
});

Deno.test("scryptHasher: verify threads the hasher's own cost into both halves", async () => {
  const hasher = scryptHasher({ cost: 1 << 15 });
  const stored = await hasher.hash("correct horse");
  assertEquals(await hasher.verify("correct horse", stored), true);
  assertEquals(await hasher.verify("wrong", stored), false);
  // Known-account and unknown-account rejections now do comparable work.
  const at = (fn: () => Promise<unknown>) =>
    (async () => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    })();
  await hasher.verify("warm", stored);
  const known = await at(() => hasher.verify("wrong", stored));
  const unknown = await at(() => hasher.verify("wrong", ""));
  assert(
    unknown > known * 0.5,
    `no user-enumeration oracle: known ${known}ms vs unknown ${unknown}ms`,
  );
});
