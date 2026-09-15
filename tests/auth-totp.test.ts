// TOTP (RFC 6238) + MFA backup codes: the RFC Appendix B SHA-1 vectors, base32 secret
// handling (RFC 4648 vectors, unpadded), the ±window, malformed input (never a throw),
// the otpauth:// URI encoding, and backup-code generation / matching through the Hasher seam.

import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import {
  generateTotpSecret,
  totpAuthUri,
  type TotpVerifyResult,
  verifyTotp,
} from "../src/server/auth/totp.ts";
import {
  backupCodeMatcher,
  generateBackupCodes,
  isBackupCodeShaped,
} from "../src/server/auth/backup-codes.ts";
import { type Hasher, scryptHasher } from "../src/server/auth/hasher.ts";

/** RFC 6238 Appendix B: the ASCII seed "12345678901234567890", base32. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
/** RFC 6238 Appendix B SHA-1 rows: [T seconds, 8-digit TOTP]. */
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];
/** RFC 4648 §10 base32 vectors, unpadded (the form TOTP secrets use). */
const BASE32_VECTORS: [string, string][] = [
  ["", ""],
  ["f", "MY"],
  ["fo", "MZXQ"],
  ["foo", "MZXW6"],
  ["foob", "MZXW6YQ"],
  ["fooba", "MZXW6YTB"],
  ["foobar", "MZXW6YTBOI"],
];

/** An independent TOTP reference (byte arithmetic, no DataView) to cross-check against. */
async function referenceCode(
  key: Uint8Array<ArrayBuffer>,
  ms: number,
  digits = 6,
): Promise<string> {
  const counter = new Uint8Array(8);
  let c = Math.floor(ms / 30_000);
  for (let i = 7; i >= 0; i--, c = Math.floor(c / 256)) counter[i] = c % 256;
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, counter));
  const o = h[h.length - 1] & 15;
  const n = (h[o] & 0x7f) * 2 ** 24 + h[o + 1] * 2 ** 16 + h[o + 2] * 2 ** 8 + h[o + 3];
  return (n % 10 ** digits).toString().padStart(digits, "0");
}

/** A Hasher test double that records every `hash` input. */
function spyHasher(): Hasher & { hashed: string[]; verified: number } {
  const spy = {
    hashed: [] as string[],
    verified: 0,
    hash: (plain: string) => {
      spy.hashed.push(plain);
      return Promise.resolve(`h:${plain}`);
    },
    verify: (plain: string, stored: string) => {
      spy.verified++;
      return Promise.resolve(stored === `h:${plain}`);
    },
  };
  return spy;
}

const T0 = 1_700_000_000_000; // a fixed "now" (ms), mid-step

Deno.test("verifyTotp matches every RFC 6238 Appendix B SHA-1 vector (8 digits)", async () => {
  for (const [seconds, code] of RFC_VECTORS) {
    const result = await verifyTotp(RFC_SECRET, code, {
      now: seconds * 1000,
      digits: 8,
      window: 0,
    });
    assertEquals(result, { ok: true, step: Math.floor(seconds / 30) }, `T=${seconds}`);
  }
});

Deno.test("verifyTotp: the 6-digit code is the low six digits of the RFC vector", async () => {
  for (const [seconds, code] of RFC_VECTORS) {
    const result = await verifyTotp(RFC_SECRET, code.slice(2), { now: seconds * 1000, window: 0 });
    assert(result.ok, `T=${seconds}`);
    const wrong = String((Number(code.slice(2)) + 1) % 1e6).padStart(6, "0");
    assertEquals(await verifyTotp(RFC_SECRET, wrong, { now: seconds * 1000 }), { ok: false });
  }
});

Deno.test("base32 encode: RFC 4648 vectors, unpadded (the form generateTotpSecret emits)", () => {
  const enc = new TextEncoder();
  for (const [plain, b32] of BASE32_VECTORS) {
    assertEquals(encodeBase32(enc.encode(plain)).replace(/=+$/, ""), b32, plain);
  }
});

Deno.test("base32 decode: verifyTotp keys on the RFC 4648 vectors, unpadded", async () => {
  const enc = new TextEncoder();
  for (const [plain, b32] of BASE32_VECTORS.slice(1)) {
    const code = await referenceCode(enc.encode(plain), T0);
    assertEquals(await verifyTotp(b32, code, { now: T0, window: 0 }), {
      ok: true,
      step: Math.floor(T0 / 30_000),
    }, b32);
  }
  // The empty secret is no key at all.
  assertEquals(await verifyTotp("", "000000", { now: T0 }), { ok: false });
});

Deno.test("verifyTotp tolerates padding, lowercase and spaces in the secret", async () => {
  const [seconds, code] = RFC_VECTORS[1];
  const spaced = RFC_SECRET.replace(/(.{4})/g, "$1 ");
  for (const secret of [RFC_SECRET.toLowerCase(), spaced, `${RFC_SECRET}\n`]) {
    assertEquals(
      await verifyTotp(secret, code, { now: seconds * 1000, digits: 8, window: 0 }),
      { ok: true, step: Math.floor(seconds / 30) },
      secret,
    );
  }
  const foobar = await referenceCode(new TextEncoder().encode("foobar"), T0);
  assert((await verifyTotp("MZXW6YTBOI======", foobar, { now: T0 })).ok, "padded secret");
});

Deno.test("verifyTotp window:1 accepts ±1 step and rejects ±2", async () => {
  const key = decodeBase32(RFC_SECRET);
  const step = Math.floor(T0 / 30_000);
  for (const offset of [-2, -1, 0, 1, 2]) {
    const code = await referenceCode(key, T0 + offset * 30_000);
    const result = await verifyTotp(RFC_SECRET, code, { now: T0 });
    const expected: TotpVerifyResult = Math.abs(offset) <= 1
      ? { ok: true, step: step + offset }
      : { ok: false };
    assertEquals(result, expected, `offset ${offset}`);
  }
});

Deno.test("verifyTotp window:0 accepts only the current step", async () => {
  const key = decodeBase32(RFC_SECRET);
  for (const offset of [-1, 0, 1]) {
    const code = await referenceCode(key, T0 + offset * 30_000);
    const result = await verifyTotp(RFC_SECRET, code, { now: T0, window: 0 });
    assertEquals(result.ok, offset === 0, `offset ${offset}`);
  }
});

Deno.test("verifyTotp returns step = floor(now / 30000) and strips whitespace in the code", async () => {
  const now = 1_234_567_899_999;
  const code = await referenceCode(decodeBase32(RFC_SECRET), now);
  const spaced = ` ${code.slice(0, 3)} ${code.slice(3)}\t`;
  assertEquals(await verifyTotp(RFC_SECRET, spaced, { now, window: 0 }), {
    ok: true,
    step: Math.floor(now / 30_000),
  });
});

Deno.test("verifyTotp: a malformed code is { ok: false }, never a throw", async () => {
  const code = await referenceCode(decodeBase32(RFC_SECRET), T0);
  const malformed: unknown[] = [
    "",
    code.slice(1),
    `${code}0`,
    `${code.slice(0, 5)}a`,
    `${code.slice(0, 3)}-${code.slice(3)}`,
    "１２３４５６", // full-width digits
    "9".repeat(10_000),
    null,
    undefined,
    123456,
  ];
  for (const bad of malformed) {
    assertEquals(
      await verifyTotp(RFC_SECRET, bad as string, { now: T0 }),
      { ok: false },
      String(bad),
    );
  }
});

Deno.test("verifyTotp: a malformed secret is { ok: false }, never a throw", async () => {
  for (
    const bad of [
      "",
      "   ",
      "A",
      "MZX",
      "GEZDGNBV0",
      "M1======",
      "!!!!!!!!",
      null as unknown as string,
    ]
  ) {
    assertEquals(await verifyTotp(bad, "123456", { now: T0 }), { ok: false }, String(bad));
  }
});

Deno.test("verifyTotp range-checks its options", async () => {
  for (
    const options of [
      { window: -1 },
      { window: 11 },
      { window: 1.5 },
      { digits: 5 },
      { digits: 9 },
      {
        period: 0,
      },
      { now: Number.NaN },
    ]
  ) {
    let threw: unknown;
    await verifyTotp(RFC_SECRET, "123456", options).catch((err) => threw = err);
    assert(threw instanceof RangeError, JSON.stringify(options));
  }
});

Deno.test("totpAuthUri percent-encodes the label parts and the query values", () => {
  const uri = totpAuthUri({
    secret: "jbsw y3dp ehpk 3pxp",
    account: "ada+mfa@example.com",
    issuer: "Acme: Labs",
  });
  assertEquals(
    uri,
    "otpauth://totp/Acme%3A%20Labs:ada%2Bmfa%40example.com" +
      "?secret=JBSWY3DPEHPK3PXP&issuer=Acme%3A%20Labs&algorithm=SHA1&digits=6&period=30",
  );
  // The literal `:` appears once in the label — the separator; the issuer's own is encoded.
  assertEquals(new URL(uri).pathname.split(":").length, 2);
});

Deno.test("totpAuthUri honours digits/period, omits an empty issuer, rejects bad parameters", () => {
  assertEquals(
    totpAuthUri({ secret: "JBSWY3DPEHPK3PXP", account: "ada", issuer: "", digits: 8, period: 60 }),
    "otpauth://totp/ada?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=8&period=60",
  );
  assertThrows(
    () => totpAuthUri({ secret: "A", account: "a", issuer: "i", digits: 4 }),
    RangeError,
  );
  assertThrows(
    () => totpAuthUri({ secret: "A", account: "a", issuer: "i", period: -30 }),
    RangeError,
  );
});

Deno.test("generateTotpSecret: ≥ 160-bit unpadded uppercase base32, fresh each call, verifies", async () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assertMatch(a, /^[A-Z2-7]{32}$/);
  assertNotEquals(a, b);
  assertEquals(decodeBase32(a).length, 20);
  const longer = generateTotpSecret(21); // 168 bits → 34 chars, padding stripped
  assertMatch(longer, /^[A-Z2-7]{34}$/);
  assertEquals(decodeBase32(longer.padEnd(40, "=")).length, 21);
  const code = await referenceCode(decodeBase32(a), T0);
  assert((await verifyTotp(a, code, { now: T0 })).ok);
});

Deno.test("generateTotpSecret refuses secrets under 20 bytes", () => {
  for (const bytes of [10, 19, 20.5, Number.NaN]) {
    assertThrows(() => generateTotpSecret(bytes), RangeError, undefined, String(bytes));
  }
});

Deno.test("generateBackupCodes: 10 unique xxxxx-xxxxx codes, each hashed once in normalised form", async () => {
  const hasher = spyHasher();
  const { codes, hashes } = await generateBackupCodes(hasher);
  assertEquals(codes.length, 10);
  assertEquals(new Set(codes).size, 10);
  for (const code of codes) assertMatch(code, /^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
  assertEquals(hasher.hashed, codes.map((c) => c.replace("-", "")));
  assertEquals(hashes, hasher.hashed.map((p) => `h:${p}`));
  const many = await generateBackupCodes(spyHasher(), 20);
  assertEquals(new Set(many.codes).size, 20);
});

Deno.test("generateBackupCodes clamps count to 0–20", async () => {
  const cases: [number, number][] = [[-1, 0], [0, 0], [3.7, 3], [25, 20], [Infinity, 20], [
    Number.NaN,
    0,
  ]];
  for (const [count, expected] of cases) {
    const hasher = spyHasher();
    const { codes, hashes } = await generateBackupCodes(hasher, count);
    assertEquals([codes.length, hashes.length, hasher.hashed.length], [
      expected,
      expected,
      expected,
    ], String(count));
  }
});

Deno.test("backupCodeMatcher matches its own hash across hyphen/case/space variations only", async () => {
  const hasher = spyHasher();
  const { codes, hashes } = await generateBackupCodes(hasher, 2);
  const [code] = codes;
  for (
    const typed of [
      code,
      code.replace("-", ""),
      code.toUpperCase(),
      ` ${code.slice(0, 5)} ${code.slice(6)} `,
    ]
  ) {
    const matches = backupCodeMatcher(hasher, typed);
    assertEquals(await matches(hashes[0]), true, typed);
    assertEquals(await matches(hashes[1]), false, typed);
  }
});

Deno.test("backupCodeMatcher: malformed input matches nothing but still runs one verify per hash", async () => {
  const hasher = spyHasher();
  const { hashes } = await generateBackupCodes(hasher, 3);
  for (
    const bad of [
      "",
      "short",
      "0000000000",
      "abcde-fghij-k",
      "x".repeat(100),
      null as unknown as string,
    ]
  ) {
    hasher.verified = 0;
    const matches = backupCodeMatcher(hasher, bad);
    for (const hash of [...hashes, "h:"]) assertEquals(await matches(hash), false, String(bad));
    assertEquals(hasher.verified, 4, "equal work: one verify per stored hash");
  }
});

Deno.test("backup codes round-trip through the real scrypt Hasher", async () => {
  const hasher = scryptHasher({ cost: 1024 });
  const { codes, hashes } = await generateBackupCodes(hasher, 2);
  assert(hashes.every((h) => h.startsWith("scrypt$")));
  assertEquals(await backupCodeMatcher(hasher, codes[1].toUpperCase())(hashes[1]), true);
  assertEquals(await backupCodeMatcher(hasher, codes[1])(hashes[0]), false);
});

Deno.test("isBackupCodeShaped: only 10 code-alphabet characters qualify, so a TOTP code skips the walk", () => {
  assertEquals(isBackupCodeShaped("abcde-fghjk"), true);
  assertEquals(isBackupCodeShaped(" ABCDE FGHJK "), true, "normalised first");
  assertEquals(isBackupCodeShaped("123456"), false, "a 6-digit TOTP code");
  assertEquals(isBackupCodeShaped("abcde-fghj1"), false, "1 is not in the alphabet");
  assertEquals(isBackupCodeShaped(""), false);
});
