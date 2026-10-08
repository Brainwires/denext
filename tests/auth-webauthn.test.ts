// WebAuthn relying-party verification (src/server/auth/webauthn.ts) against the W3C WebAuthn
// Level 3 §16 test vectors (tests/fixtures/webauthn-l3-vectors.json, copied from the spec):
// every supported registration + authentication verifies — ES256 with `none`, packed self and
// packed x5c attestation, a 1023-byte credential ID, RS256, Ed25519 — and the unsupported
// algorithms (ES384, ES512, Ed448) are refused. Then the negative cases, each one mutation of a
// valid vector: wrong origin, RP ID, challenge and ceremony type, a cross-origin call, missing
// UP / UV, a tampered signature / attestation / authenticator data, a BE change, a counter that
// went backwards (a cloned authenticator), and malformed DER and authenticator data.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import vectors from "./fixtures/webauthn-l3-vectors.json" with { type: "json" };
import {
  type AuthenticationExpectations,
  derToRawEcdsa,
  parseAuthenticatorData,
  parseClientData,
  type RegistrationExpectations,
  type RegistrationResult,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type WebAuthnErrorCode,
} from "../src/server/auth/webauthn.ts";

/** Hex → bytes. */
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

type VectorName = keyof typeof vectors.vectors;
const V = vectors.vectors as Record<
  VectorName,
  {
    section: string;
    registration: Record<
      "challenge" | "credential_id" | "clientDataJSON" | "attestationObject",
      string
    >;
    authentication: Record<
      "challenge" | "authenticatorData" | "clientDataJSON" | "signature",
      string
    >;
  }
>;

const RP: Omit<RegistrationExpectations, "challenge"> = {
  origins: ["https://example.org"],
  rpId: "example.org",
  requireUserVerification: false,
};

/** base64url of the hex challenge, as `clientDataJSON` carries it. */
function b64u(hexString: string): string {
  return btoa(String.fromCharCode(...hex(hexString)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Verify a vector's registration (optionally overriding expectations / inputs). */
function register(
  name: VectorName,
  over: Partial<RegistrationExpectations> = {},
  mutate: { clientDataJSON?: Uint8Array; attestationObject?: Uint8Array } = {},
): Promise<RegistrationResult> {
  const r = V[name].registration;
  return verifyRegistration(
    {
      clientDataJSON: mutate.clientDataJSON ?? hex(r.clientDataJSON),
      attestationObject: mutate.attestationObject ?? hex(r.attestationObject),
    },
    { ...RP, challenge: b64u(r.challenge), ...over },
  );
}

/** Verify a vector's authentication against its (verified) registration. */
async function authenticate(
  name: VectorName,
  over: Partial<AuthenticationExpectations> = {},
  mutate: {
    clientDataJSON?: Uint8Array;
    authenticatorData?: Uint8Array;
    signature?: Uint8Array;
    signCount?: number;
    backupEligible?: boolean;
  } = {},
) {
  const reg = await register(name, { topOrigins: over.topOrigins });
  const a = V[name].authentication;
  return await verifyAuthentication(
    {
      clientDataJSON: mutate.clientDataJSON ?? hex(a.clientDataJSON),
      authenticatorData: mutate.authenticatorData ?? hex(a.authenticatorData),
      signature: mutate.signature ?? hex(a.signature),
    },
    {
      publicKey: reg.publicKey,
      signCount: mutate.signCount ?? reg.signCount,
      backupEligible: mutate.backupEligible ?? reg.backupEligible,
    },
    { ...RP, challenge: b64u(a.challenge), ...over },
  );
}

/** Assert a promise rejects with a WebAuthnError of `code`. */
async function refused(promise: Promise<unknown>, code: WebAuthnErrorCode): Promise<void> {
  const error = await assertRejects(() => promise, WebAuthnError);
  assertEquals((error as WebAuthnError).code, code, (error as Error).message);
}

/** A copy of `bytes` with byte `at` XOR `mask`. */
function flip(bytes: Uint8Array, at: number, mask = 0x01): Uint8Array {
  const copy = bytes.slice();
  copy[at] ^= mask;
  return copy;
}

/** The index of the first occurrence of `needle` in `bytes`, or −1. */
function indexOfBytes(bytes: Uint8Array, needle: number[]): number {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (needle.every((b, k) => bytes[i + k] === b)) return i;
  }
  return -1;
}

/** `clientDataJSON` with one field replaced. */
function withClientData(name: VectorName, which: "registration" | "authentication", patch: object) {
  const data = JSON.parse(new TextDecoder().decode(hex(V[name][which].clientDataJSON)));
  return new TextEncoder().encode(JSON.stringify({ ...data, ...patch }));
}

// ---- the spec vectors verify --------------------------------------------------------

const SUPPORTED: Array<[VectorName, number, string, string]> = [
  ["none-es256", -7, "none", "none"],
  ["packed-self-es256", -7, "packed", "self"],
  ["none-es256-long-credential-id", -7, "none", "none"],
  ["packed-es256", -7, "packed", "basic"],
  ["packed-rs256", -257, "packed", "basic"],
  ["packed-eddsa", -8, "packed", "basic"],
];

for (const [name, alg, fmt, attestationType] of SUPPORTED) {
  Deno.test(`webauthn ${V[name].section}: registration and authentication verify`, async () => {
    const reg = await register(name);
    assertEquals(reg.alg, alg);
    assertEquals(reg.fmt, fmt);
    assertEquals(reg.attestationType, attestationType);
    assertEquals(reg.credentialId, hex(V[name].registration.credential_id));
    const auth = await authenticate(name);
    assertEquals(auth.signCount, 0);
  });
}

Deno.test("webauthn §16.6: a 1023-byte credential ID is accepted (the §5.8.3 maximum)", async () => {
  assertEquals((await register("none-es256-long-credential-id")).credentialId.length, 1023);
});

Deno.test("webauthn §16.8/16.9/16.12: ES384, ES512 and Ed448 credentials are refused", async () => {
  for (const name of ["packed-es384", "packed-es512", "packed-ed448"] as const) {
    await refused(register(name), "algorithm");
  }
});

Deno.test("webauthn: the algorithm must have been offered (§7.1 step 17)", async () => {
  await refused(register("packed-rs256", { algorithms: [-7] }), "algorithm");
  await refused(register("packed-eddsa", { algorithms: [-7, -257] }), "algorithm");
});

// ---- client data -----------------------------------------------------------------------

Deno.test("webauthn: a wrong origin is refused, at registration and authentication", async () => {
  await refused(register("none-es256", { origins: ["https://example.com"] }), "origin");
  await refused(authenticate("none-es256", { origins: ["https://evil.example.org"] }), "origin");
  // An exact match: no scheme, port or trailing-slash leniency.
  await refused(register("none-es256", { origins: ["http://example.org"] }), "origin");
  await refused(register("none-es256", { origins: ["https://example.org/"] }), "origin");
});

Deno.test("webauthn: a challenge this ceremony didn't issue is refused (replay across ceremonies)", async () => {
  // The registration's challenge presented as if it were the authentication's, and vice versa.
  await refused(
    register("none-es256", { challenge: b64u(V["none-es256"].authentication.challenge) }),
    "challenge",
  );
  await refused(
    authenticate("none-es256", { challenge: b64u(V["packed-es256"].authentication.challenge) }),
    "challenge",
  );
});

Deno.test("webauthn: the ceremony type is checked — a create response can't authenticate", async () => {
  const createData = hex(V["none-es256"].registration.clientDataJSON);
  await refused(
    authenticate("none-es256", { challenge: b64u(V["none-es256"].registration.challenge) }, {
      clientDataJSON: createData,
    }),
    "type",
  );
  await refused(
    register("none-es256", {}, {
      clientDataJSON: withClientData("none-es256", "registration", { type: "webauthn.get" }),
    }),
    "type",
  );
});

Deno.test("webauthn §16.4/16.5: a cross-origin ceremony is refused unless its topOrigin is allowed", async () => {
  // crossOrigin: true with no topOrigin — refused, whatever is allowed.
  await refused(register("none-es256-crossOrigin"), "cross_origin");
  await refused(
    register("none-es256-crossOrigin", { topOrigins: ["https://example.com"] }),
    "cross_origin",
  );
  // crossOrigin: true, topOrigin https://example.com — refused by default, accepted when listed.
  await refused(register("none-es256-topOrigin"), "cross_origin");
  await register("none-es256-topOrigin", { topOrigins: ["https://example.com"] });
  await authenticate("none-es256-topOrigin", { topOrigins: ["https://example.com"] });
  await refused(
    authenticate("none-es256-topOrigin", { topOrigins: ["https://example.net"] }),
    "cross_origin",
  );
});

Deno.test("webauthn: malformed client data is refused", () => {
  assertThrows(() => parseClientData(new TextEncoder().encode("[]")), WebAuthnError);
  assertThrows(() => parseClientData(new TextEncoder().encode('{"type":1}')), WebAuthnError);
  assertThrows(() => parseClientData(Uint8Array.of(0xff, 0xfe)), WebAuthnError);
});

// ---- authenticator data ---------------------------------------------------------------

Deno.test("webauthn: a credential for another RP ID is refused (§7.1 step 13 / §7.2 step 15)", async () => {
  await refused(register("none-es256", { rpId: "example.com" }), "rp_id");
  await refused(register("none-es256", { rpId: "sub.example.org" }), "rp_id");
  await refused(authenticate("none-es256", { rpId: "evil.org" }), "rp_id");
});

Deno.test("webauthn: user verification is enforced when required", async () => {
  // §16.2's registration and authentication have UV clear; §16.7's have it set.
  await refused(register("none-es256", { requireUserVerification: true }), "user_verification");
  await refused(authenticate("none-es256", { requireUserVerification: true }), "user_verification");
  assertEquals(
    (await authenticate("packed-es256", { requireUserVerification: true })).userVerified,
    true,
  );
});

Deno.test("webauthn: an assertion without User Present is refused, before the signature", async () => {
  const data = hex(V["none-es256"].authentication.authenticatorData);
  await refused(
    authenticate("none-es256", {}, { authenticatorData: flip(data, 32, 0x01) }),
    "user_presence",
  );
});

Deno.test("webauthn: a changed backup-eligibility flag is refused (§7.2 step 18)", async () => {
  // §16.2 registered with BE set; claim the stored record said otherwise.
  await refused(authenticate("none-es256", {}, { backupEligible: false }), "backup_state");
  // BS without BE is malformed authenticator data (§6.1). §16.5's assertion has BE clear.
  const data = hex(V["none-es256-topOrigin"].authentication.authenticatorData);
  assertEquals(data[32] & 0x18, 0, "BE and BS clear in the vector");
  assertThrows(() => parseAuthenticatorData(flip(data, 32, 0x10)), WebAuthnError, "BS");
});

Deno.test("webauthn: a tampered signature or signed byte is refused", async () => {
  for (const name of ["none-es256", "packed-rs256", "packed-eddsa"] as const) {
    const sig = hex(V[name].authentication.signature);
    await refused(authenticate(name, {}, { signature: flip(sig, sig.length - 1) }), "signature");
    // One byte of the signed authenticator data (the counter): the signature no longer covers it.
    const data = hex(V[name].authentication.authenticatorData);
    await refused(authenticate(name, {}, { authenticatorData: flip(data, 36) }), "signature");
  }
  // clientDataJSON is signed through its hash.
  await refused(
    authenticate("none-es256", {}, {
      clientDataJSON: withClientData("none-es256", "authentication", { extra: "x" }),
    }),
    "signature",
  );
});

Deno.test("webauthn: a counter that doesn't increase is refused — a cloned authenticator (§6.1.1)", async () => {
  // The vector's assertion carries counter 0; a stored counter of 5 means it went backwards.
  await refused(authenticate("none-es256", {}, { signCount: 5 }), "counter");
  // Both zero: an authenticator without a counter (a synced passkey) is allowed.
  assertEquals((await authenticate("none-es256", {}, { signCount: 0 })).signCount, 0);
});

Deno.test("webauthn: a tampered attestation is refused", async () => {
  // Flip one byte inside the packed statement's signature (after the `sig` header).
  const ao = hex(V["packed-es256"].registration.attestationObject);
  const sigAt = ao.indexOf(0x58, 20) + 10;
  await refused(
    register("packed-es256", {}, { attestationObject: flip(ao, sigAt) }),
    "attestation",
  );
  const self = hex(V["packed-self-es256"].registration.attestationObject);
  await refused(
    register("packed-self-es256", {}, {
      attestationObject: flip(self, self.indexOf(0x58, 20) + 10),
    }),
    "attestation",
  );
  // A `none` statement that isn't empty: rewrite `attStmt: {}` (a0) to `{1: 1}` would change
  // the length; instead swap the format name to an unsupported one ("none" → "nonx").
  const none = hex(V["none-es256"].registration.attestationObject);
  const fmtAt = indexOfBytes(none, [0x64, 0x6e, 0x6f, 0x6e, 0x65]) + 1; // text(4) "none"
  await refused(
    register("none-es256", {}, { attestationObject: flip(none, fmtAt + 3, 0x1d) }),
    "attestation",
  );
});

Deno.test("webauthn: authenticator data must be exactly what its flags announce", () => {
  const auth = hex(V["none-es256"].authentication.authenticatorData);
  assertThrows(() => parseAuthenticatorData(auth.subarray(0, 36)), WebAuthnError, "short");
  const trailing = new Uint8Array([...auth, 0]);
  assertThrows(() => parseAuthenticatorData(trailing), WebAuthnError, "trailing");
  // AT set with no attested data behind it.
  assertThrows(() => parseAuthenticatorData(flip(auth, 32, 0x40)), WebAuthnError);
  // ED set with no extensions behind it.
  assertThrows(() => parseAuthenticatorData(flip(auth, 32, 0x80)), WebAuthnError);
});

Deno.test("webauthn: DER ECDSA signatures are parsed strictly", () => {
  const good = hex(V["none-es256"].authentication.signature);
  const raw = derToRawEcdsa(good);
  assert(raw && raw.length === 64);
  assertEquals(derToRawEcdsa(good.subarray(0, good.length - 1)), null, "truncated");
  assertEquals(derToRawEcdsa(new Uint8Array([...good, 0])), null, "trailing");
  assertEquals(
    derToRawEcdsa(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01)),
    null,
    "negative r",
  );
  assertEquals(
    derToRawEcdsa(Uint8Array.of(0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01)),
    null,
    "padded r",
  );
  assertEquals(
    derToRawEcdsa(Uint8Array.of(0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
    null,
    "not a SEQUENCE",
  );
});
