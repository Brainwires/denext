// The android-safetynet attestation statement format (WebAuthn L3 §8.5): a compact JWS from
// Google's SafetyNet Attestation API whose `x5c` must chain to Google's root with a leaf issued
// for attest.android.com, whose signature must verify, and whose payload must carry this
// ceremony's nonce, `ctsProfileMatch: true` and a current `timestampMs`.
//
// Two real SafetyNet registrations from the SimpleWebAuthn server library's tests (MIT —
// tests/fixtures/webauthn-attestation/simplewebauthn-safetynet.json and
// LICENSE-simplewebauthn.md): one chains through GTS CA 1D4 to GTS Root R1, the root denext
// pins, and verifies on the production path at its own `timestampMs`; the other chains to the
// expired GlobalSign Root CA - R2, so it verifies only with that root handed in. The refusal
// cases use JWS responses built and really signed at test time by the throwaway CA of
// tests/_x509-test-ca.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeCbor } from "../packages/auth/src/cbor.ts";
import { base64UrlDecode, base64UrlEncode } from "../packages/auth/src/oauth.ts";
import {
  type AttestationInput,
  SAFETYNET_SKEW_MS,
  verifyAndroidSafetyNet,
} from "../packages/auth/src/webauthn-attestation.ts";
import { verifyRegistration, WebAuthnError } from "../packages/auth/src/webauthn.ts";
import { leafOf, TEST_NOW, type TestKeyPair, testPki } from "./_x509-test-ca.ts";
import fixture from "./fixtures/webauthn-attestation/simplewebauthn-safetynet.json" with {
  type: "json",
};

const NOW = TEST_NOW;
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const der = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/** The format's input from a real registration. */
async function inputOf(v: (typeof fixture.vectors)[number]): Promise<AttestationInput> {
  const att = decodeCbor(base64UrlDecode(v.attestationObject)) as Map<string, unknown>;
  const authData = att.get("authData") as Uint8Array;
  return {
    stmt: att.get("attStmt") as Map<string, unknown>,
    authData,
    clientDataHash: await sha256(base64UrlDecode(v.clientDataJSON)),
    credentialPublicKey: new Uint8Array(),
    credentialId: new Uint8Array(),
    aaguid: authData.subarray(37, 53),
    rpIdHash: authData.subarray(0, 32),
  };
}

const [gsr2Vector, gtsVector] = fixture.vectors;

async function refused(promise: () => Promise<unknown>, message: string) {
  const error = await assertRejects(promise, WebAuthnError, message);
  assertEquals(error.code, "attestation");
}

// ---- real responses -------------------------------------------------------------------------

Deno.test("android-safetynet: a real response chaining to GTS Root R1 verifies against the pinned root", async () => {
  const result = await verifyAndroidSafetyNet(await inputOf(gtsVector), {
    now: gtsVector.timestampMs,
  });
  assertEquals(result.type, "basic");
  assertEquals(result.x5c?.length, 3);
});

Deno.test("android-safetynet: a real response chaining to the expired GlobalSign R2 needs that root", async () => {
  const input = await inputOf(gsr2Vector);
  const now = gsr2Vector.timestampMs;
  await refused(() => verifyAndroidSafetyNet(input, { now }), "Google's root");
  const result = await verifyAndroidSafetyNet(input, {
    now,
    roots: [der(fixture.globalSignRootR2.der)],
  });
  assertEquals(result.type, "basic");
});

Deno.test("android-safetynet: a real response a minute and more past its timestamp is refused", async () => {
  const input = await inputOf(gtsVector);
  await verifyAndroidSafetyNet(input, { now: gtsVector.timestampMs + SAFETYNET_SKEW_MS });
  await refused(
    () => verifyAndroidSafetyNet(input, { now: gtsVector.timestampMs + SAFETYNET_SKEW_MS + 1 }),
    "not current",
  );
});

Deno.test("android-safetynet: a real response with a flipped signature bit is refused", async () => {
  const input = await inputOf(gtsVector);
  const jws = new TextDecoder().decode(input.stmt.get("response") as Uint8Array).split(".");
  const sig = base64UrlDecode(jws[2]);
  sig[10] ^= 1;
  input.stmt.set("response", utf8(`${jws[0]}.${jws[1]}.${base64UrlEncode(sig)}`));
  await refused(
    () => verifyAndroidSafetyNet(input, { now: gtsVector.timestampMs }),
    "signature does not verify",
  );
});

Deno.test("android-safetynet: registration verifies the format instead of refusing it as unsupported", async () => {
  // On the wall clock the 2021 response is long stale: it reaches the format's own checks and is
  // refused there — even with unverifiable formats accepted as unattested, since it is verifiable.
  for (const acceptUnverifiedFormats of [false, true]) {
    const error = await assertRejects(
      () =>
        verifyRegistration(
          {
            clientDataJSON: base64UrlDecode(gtsVector.clientDataJSON),
            attestationObject: base64UrlDecode(gtsVector.attestationObject),
          },
          {
            challenge: JSON.parse(
              new TextDecoder().decode(base64UrlDecode(gtsVector.clientDataJSON)),
            ).challenge,
            origins: [gtsVector.origin],
            rpId: gtsVector.rpId,
            requireUserVerification: false,
            algorithms: [-7, -257, -8],
            acceptUnverifiedFormats,
          },
        ),
      WebAuthnError,
    );
    assertEquals(error.code, "attestation");
    assert(!/unsupported/.test(error.message), error.message);
  }
});

// ---- built responses ------------------------------------------------------------------------

interface Built {
  roots: Uint8Array[];
  input: AttestationInput;
}

/** A SafetyNet statement signed by a test-CA leaf, with `payload` / `leaf` overrides. */
async function built(
  o: {
    payload?: Record<string, unknown>;
    /** The leaf's SAN dNSName; `null`: no SAN, the host as its CN. */
    host?: string | null;
    signWith?: TestKeyPair;
    alg?: string;
    ver?: unknown;
  } = {},
): Promise<Built> {
  const pki = await testPki();
  const { key, cert } = await leafOf(
    pki,
    o.host === null ? { subject: "attest.android.com" } : { dns: [o.host ?? "attest.android.com"] },
  );
  const authData = crypto.getRandomValues(new Uint8Array(64));
  const clientDataHash = crypto.getRandomValues(new Uint8Array(32));
  const nonce = b64(await sha256(new Uint8Array([...authData, ...clientDataHash])));
  const header = { alg: o.alg ?? "ES256", x5c: [b64(cert), b64(pki.intermediate)] };
  const payload = { nonce, timestampMs: NOW, ctsProfileMatch: true, ...o.payload };
  const signing = `${base64UrlEncode(utf8(JSON.stringify(header)))}.${
    base64UrlEncode(utf8(JSON.stringify(payload)))
  }`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      (o.signWith ?? key).privateKey,
      utf8(signing) as BufferSource,
    ),
  );
  const stmt = new Map<string, unknown>([
    ["ver", o.ver ?? "200616037"],
    ["response", utf8(`${signing}.${base64UrlEncode(sig)}`)],
  ]);
  return {
    roots: [pki.root],
    input: {
      stmt,
      authData,
      clientDataHash,
      credentialPublicKey: new Uint8Array(),
      credentialId: new Uint8Array(),
      aaguid: new Uint8Array(16),
      rpIdHash: authData.subarray(0, 32),
    },
  };
}

const run = (b: Built, now = NOW) => verifyAndroidSafetyNet(b.input, { roots: b.roots, now });

Deno.test("android-safetynet: a well-formed response under the test root verifies", async () => {
  const b = await built();
  const result = await run(b);
  assertEquals(result.type, "basic");
  assertEquals(result.x5c?.length, 2);
  // The production root does not trust it.
  await refused(() => verifyAndroidSafetyNet(b.input, { now: NOW }), "Google's root");
});

Deno.test("android-safetynet: each payload check refuses on its own", async () => {
  await refused(async () => run(await built({ payload: { nonce: "AAAA" } })), "nonce");
  await refused(
    async () => run(await built({ payload: { ctsProfileMatch: false } })),
    "CTS profile",
  );
  await refused(
    async () => run(await built({ payload: { ctsProfileMatch: undefined } })),
    "CTS profile",
  );
  await refused(
    async () => run(await built({ payload: { timestampMs: NOW + SAFETYNET_SKEW_MS + 1 } })),
    "not current",
  );
  await refused(
    async () => run(await built({ payload: { timestampMs: String(NOW) } })),
    "not current",
  );
});

Deno.test("android-safetynet: a signer with no SAN is named by its CN", async () => {
  assertEquals((await run(await built({ host: null }))).type, "basic");
});

Deno.test("android-safetynet: a signer not issued for attest.android.com, or a wrong key, is refused", async () => {
  await refused(async () => run(await built({ host: "evil.example" })), "attest.android.com");
  const other = await testPki();
  await refused(
    async () => run(await built({ signWith: other.intermediateKey })),
    "signature does not verify",
  );
  await refused(async () => run(await built({ alg: "none" })), "signature does not verify");
});

Deno.test("android-safetynet: a malformed statement is refused", async () => {
  await refused(async () => run(await built({ ver: "" })), "ver");
  const b = await built();
  b.input.stmt.set("response", utf8("not-a-jws"));
  await refused(() => run(b), "compact JWS");
  b.input.stmt.set("response", "text");
  await refused(() => run(b), "response");
  b.input.stmt.set("response", utf8(`${base64UrlEncode(utf8("[]"))}.e30.c2ln`));
  await refused(() => run(b), "header is not a JSON object");
  b.input.stmt.set("response", utf8(`${base64UrlEncode(utf8('{"alg":"ES256"}'))}.e30.c2ln`));
  await refused(() => run(b), "no alg / x5c");
  b.input.stmt.set(
    "response",
    utf8(`${base64UrlEncode(utf8('{"alg":"ES256","x5c":["!!"]}'))}.e30.c2ln`),
  );
  await refused(() => run(b), "Google's root");
  // Base64 that is no certificate.
  b.input.stmt.set(
    "response",
    utf8(`${base64UrlEncode(utf8('{"alg":"ES256","x5c":["AA=="]}'))}.e30.c2ln`),
  );
  await refused(() => run(b), "truncated");
  b.input.stmt.set("response", utf8(`${base64UrlEncode(utf8("{"))}.e30.c2ln`));
  await refused(() => run(b), "header is not a JSON object");
});
