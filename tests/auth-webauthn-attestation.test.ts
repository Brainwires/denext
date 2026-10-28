// The tpm, android-key, apple and fido-u2f attestation statement formats (WebAuthn L3 §8.3,
// §8.4, §8.6, §8.8), verified against real registrations: the published fixtures of the
// SimpleWebAuthn server library (MIT — tests/fixtures/webauthn-attestation/
// LICENSE-simplewebauthn.md), captured from TPMs, Android keystores, Apple devices, security
// keys and the FIDO conformance tools. Each verifies; a tampered byte in each statement is
// refused; and the per-format guards (the AAGUID extension, the key match, the challenge, the
// nonce) each refuse on their own.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeCbor } from "../packages/auth/src/cbor.ts";
import { type Cbor, cbor as encodeCbor } from "./helpers/soft-authenticator.ts";
import { base64UrlDecode, base64UrlEncode } from "../packages/auth/src/oauth.ts";
import { verifyRegistration, WebAuthnError } from "../packages/auth/src/webauthn.ts";
import fixture from "./fixtures/webauthn-attestation/simplewebauthn.json" with { type: "json" };

interface Vector {
  name: string;
  fmt: string;
  rpId: string;
  origin: string;
  /** `algorithm`: a credential key algorithm denext doesn't accept (RS1). */
  expect: "verify" | "reject" | "algorithm";
  attestationObject: string;
  clientDataJSON: string;
}

const vectors = fixture.vectors as Vector[];

function challengeOf(clientDataJSON: string): string {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(clientDataJSON))).challenge;
}

function verify(v: Vector, attestationObject = base64UrlDecode(v.attestationObject)) {
  return verifyRegistration(
    { clientDataJSON: base64UrlDecode(v.clientDataJSON), attestationObject },
    {
      challenge: challengeOf(v.clientDataJSON),
      origins: [v.origin],
      rpId: v.rpId,
      requireUserVerification: false,
      algorithms: [-7, -257, -8],
    },
  );
}

/** The attestation object with its statement edited. */
function withStatement(
  v: Vector,
  edit: (stmt: Map<string, unknown>) => void,
): Uint8Array {
  const att = decodeCbor(base64UrlDecode(v.attestationObject)) as Map<string, unknown>;
  const stmt = att.get("attStmt") as Map<string, unknown>;
  edit(stmt);
  return encodeCbor(att as Map<string, Cbor>);
}

/** A copy of `bytes` with one bit flipped at `at` (negative: from the end). */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const copy = bytes.slice();
  copy[at < 0 ? copy.length + at : at] ^= 0x01;
  return copy;
}

const supported = (v: Vector) => v.expect === "verify";

for (const v of vectors) {
  Deno.test(`attestation vector [${v.fmt}] ${v.name}`, async () => {
    if (v.expect !== "verify") {
      const error = await assertRejects(() => verify(v), WebAuthnError);
      assertEquals(error.code, v.expect === "reject" ? "attestation" : "algorithm");
      return;
    }
    const result = await verify(v);
    assertEquals(result.fmt, v.fmt);
    const expected = { tpm: "attca", apple: "anonca" }[v.fmt] ?? "basic";
    assertEquals(result.attestationType, expected);
    assert(result.attestationCertificates?.length, "the x5c is returned for the MDS check");
  });
}

Deno.test("every format has at least one real vector", () => {
  for (const fmt of ["tpm", "android-key", "apple", "fido-u2f"]) {
    assert(vectors.some((v) => v.fmt === fmt && supported(v)), fmt);
  }
});

Deno.test("a flipped signature is refused (tpm, android-key, fido-u2f)", async () => {
  for (const fmt of ["tpm", "android-key", "fido-u2f"]) {
    const v = vectors.find((x) => x.fmt === fmt && supported(x))!;
    const att = withStatement(v, (stmt) => {
      stmt.set("sig", flipped(stmt.get("sig") as Uint8Array, -1));
    });
    const error = await assertRejects(() => verify(v, att), WebAuthnError, undefined, fmt);
    assertEquals(error.code, "attestation", fmt);
  }
});

Deno.test("tpm: certInfo naming another key, or a changed pubArea, is refused", async () => {
  const v = vectors.find((x) => x.fmt === "tpm" && supported(x))!;
  // The certInfo extraData (the ceremony hash) altered: the signature no longer covers it.
  const info = withStatement(v, (stmt) => {
    stmt.set("certInfo", flipped(stmt.get("certInfo") as Uint8Array, 40));
  });
  await assertRejects(() => verify(v, info), WebAuthnError);
  // A pubArea that is not the credential key.
  const pub = withStatement(v, (stmt) => {
    stmt.set("pubArea", flipped(stmt.get("pubArea") as Uint8Array, -1));
  });
  await assertRejects(() => verify(v, pub), WebAuthnError, "pubArea");
  // Only TPM 2.0 statements.
  const ver = withStatement(v, (stmt) => stmt.set("ver", "1.2"));
  await assertRejects(() => verify(v, ver), WebAuthnError, "ver");
});

Deno.test("tpm: an AIK certificate whose AAGUID extension differs from the authenticator data is refused", async () => {
  const v = vectors.find((x) => x.fmt === "tpm" && x.expect === "reject")!;
  await assertRejects(() => verify(v), WebAuthnError, "AAGUID");
});

Deno.test("android-key: a key description for another challenge is refused", async () => {
  const v = vectors.find((x) => x.fmt === "android-key" && supported(x))!;
  // The same statement answering another ceremony: the client data (and its hash) change.
  const client = JSON.parse(new TextDecoder().decode(base64UrlDecode(v.clientDataJSON)));
  const other = {
    ...v,
    clientDataJSON: base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...client, extra: 1 })),
    ),
  };
  await assertRejects(() => verify(other), WebAuthnError);
});

Deno.test("apple: the nonce binds the statement to this ceremony", async () => {
  const v = vectors.find((x) => x.fmt === "apple")!;
  const client = JSON.parse(new TextDecoder().decode(base64UrlDecode(v.clientDataJSON)));
  const other = {
    ...v,
    clientDataJSON: base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...client, extra: 1 })),
    ),
  };
  await assertRejects(() => verify(other), WebAuthnError, "nonce");
});

Deno.test("an x5c whose leaf key is not the credential key is refused (android-key, apple)", async () => {
  const android = vectors.find((x) => x.fmt === "android-key" && supported(x))!;
  const apple = vectors.find((x) => x.fmt === "apple")!;
  const appleLeaf = decodeCbor(base64UrlDecode(apple.attestationObject)) as Map<string, unknown>;
  const foreign = (appleLeaf.get("attStmt") as Map<string, unknown>).get("x5c") as Uint8Array[];
  // Swapping in another device's certificate: the key (and its extension) no longer match.
  const att = withStatement(android, (stmt) => stmt.set("x5c", foreign));
  await assertRejects(() => verify(android, att), WebAuthnError);
});
