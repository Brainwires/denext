// Password hashing helpers: scrypt round-trip, the self-describing hash format,
// wrong-password / malformed-input rejection (never a throw), and the parameter caps.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { hashPassword, verifyPassword } from "../src/server/auth/password.ts";

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
