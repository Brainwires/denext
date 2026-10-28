// The compound attestation statement format (WebAuthn L3 §8.9): an array of at least two
// `{ fmt, attStmt }` statements over one ceremony, none itself compound, each verified by its
// own format; any failure refuses. No public compound registrations exist yet, so these are
// built at test time: a real P-256 credential and authenticator data, a packed self-attestation
// signed with the credential key, and packed `x5c` statements whose certificates the throwaway
// CA of tests/_x509-test-ca.ts issues and really signs. Under `passkeys.attestation.mds` every
// certificate statement's chain must reach the authenticator's metadata roots.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Cbor, cbor } from "./helpers/soft-authenticator.ts";
import { verifyRegistration, WebAuthnError } from "../packages/auth/src/webauthn.ts";
import {
  checkMdsAttestation,
  type ResolvedMds,
  resolveMds,
} from "../packages/auth/src/fido-mds.ts";
import {
  b64,
  leafOf,
  makeCert,
  nameWith,
  signBlob,
  signDer,
  TEST_NOW,
  testKey,
  testPki,
} from "./_x509-test-ca.ts";

const RP_ID = "example.test";
const ORIGIN = "https://example.test";
const CHALLENGE = "compound-challenge";
const AAGUID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const utf8 = (s: string) => new TextEncoder().encode(s);
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

/** One registration's ceremony: a P-256 credential, its authenticator data and client data. */
async function ceremony() {
  const credential = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", credential.publicKey);
  const fromB64u = (s: string) =>
    Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const cose = cbor(
    new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x!)], [
      -3,
      fromB64u(jwk.y!),
    ]]),
  );
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const authData = join(
    await sha256(utf8(RP_ID)),
    Uint8Array.of(0x45, 0, 0, 0, 0), // UP + UV + AT, counter 0
    AAGUID,
    Uint8Array.of(0, credentialId.length),
    credentialId,
    cose,
  );
  const clientDataJSON = utf8(
    JSON.stringify({ type: "webauthn.create", challenge: CHALLENGE, origin: ORIGIN }),
  );
  const signed = join(authData, await sha256(clientDataJSON));
  return { credential, authData, clientDataJSON, signed };
}

type Ceremony = Awaited<ReturnType<typeof ceremony>>;

/** A packed self-attestation statement. */
async function packedSelf(c: Ceremony): Promise<Map<string, Cbor>> {
  return new Map<string, Cbor>([
    ["alg", -7],
    ["sig", await signDer(c.credential.privateKey, c.signed)],
  ]);
}

/** A packed `x5c` statement: a §8.2.1 leaf from `pki` (or a fresh one), signing the ceremony. */
async function packedX5c(c: Ceremony, pki?: Awaited<ReturnType<typeof testPki>>) {
  const ca = pki ?? await testPki();
  const { key, cert } = await leafOf(ca, {
    subjectName: nameWith([
      ["2.5.4.6", "US"],
      ["2.5.4.10", "Test Vendor"],
      ["2.5.4.11", "Authenticator Attestation"],
      ["2.5.4.3", "Test Attestation"],
    ]),
  });
  return {
    pki: ca,
    stmt: new Map<string, Cbor>([
      ["alg", -7],
      ["sig", await signDer(key.privateKey, c.signed)],
      ["x5c", [cert, ca.intermediate]],
    ]),
  };
}

const entry = (fmt: string, attStmt: Cbor) =>
  new Map<string, Cbor>([["fmt", fmt], ["attStmt", attStmt]]);

function register(
  c: Ceremony,
  fmt: string,
  attStmt: Cbor,
  acceptUnverifiedFormats = false,
) {
  const attestationObject = cbor(
    new Map<string, Cbor>([["fmt", fmt], ["attStmt", attStmt], ["authData", c.authData]]),
  );
  return verifyRegistration(
    { clientDataJSON: c.clientDataJSON, attestationObject },
    {
      challenge: CHALLENGE,
      origins: [ORIGIN],
      rpId: RP_ID,
      requireUserVerification: false,
      acceptUnverifiedFormats,
    },
  );
}

async function refused(promise: () => Promise<unknown>, code = "attestation") {
  const error = await assertRejects(promise, WebAuthnError);
  assertEquals(error.code, code, error.message);
  return error;
}

Deno.test("compound: every statement verifies; the first certificate statement types it", async () => {
  const c = await ceremony();
  const x5c = await packedX5c(c);
  const result = await register(c, "compound", [
    entry("packed", await packedSelf(c)),
    entry("packed", x5c.stmt),
  ]);
  assertEquals(result.fmt, "compound");
  assertEquals(result.attestationType, "basic");
  assertEquals(result.attestationCertificates?.length, 2);
  assertEquals(
    result.attestationStatements?.map((s) => [s.fmt, s.attestationType]),
    [["packed", "self"], ["packed", "basic"]],
  );
  // Without a certificate statement it is self attestation; with only `none`s, none.
  const self = await register(c, "compound", [
    entry("none", new Map()),
    entry("packed", await packedSelf(c)),
  ]);
  assertEquals([self.attestationType, self.attestationCertificates], ["self", undefined]);
  const none = await register(c, "compound", [entry("none", new Map()), entry("none", new Map())]);
  assertEquals(none.attestationType, "none");
});

Deno.test("compound: one statement that fails refuses the whole registration", async () => {
  const c = await ceremony();
  const x5c = await packedX5c(c);
  const bad = new Map(x5c.stmt);
  const sig = (bad.get("sig") as Uint8Array).slice();
  sig[sig.length - 1] ^= 1;
  bad.set("sig", sig);
  const self = await packedSelf(c);
  await refused(() => register(c, "compound", [entry("packed", self), entry("packed", bad)]));
  // A statement that signs another ceremony.
  const other = await ceremony();
  await refused(async () =>
    register(c, "compound", [
      entry("packed", await packedSelf(c)),
      entry("packed", await packedSelf(other)),
    ])
  );
});

Deno.test("compound: its shape is enforced — 2 to 8 entries, no nesting, { fmt, attStmt } maps", async () => {
  const c = await ceremony();
  const self = await packedSelf(c);
  await refused(() => register(c, "compound", [entry("packed", self)]));
  await refused(() =>
    register(c, "compound", Array.from({ length: 9 }, () => entry("packed", self)))
  );
  await refused(() =>
    register(c, "compound", [entry("packed", self), entry("compound", [entry("packed", self)])])
  );
  await refused(() => register(c, "compound", [entry("packed", self), "packed"]));
  await refused(() => register(c, "compound", [entry("packed", self), entry("packed", "x")]));
  // An array statement is only compound's.
  await refused(() => register(c, "packed", [entry("packed", self)]), "malformed");
});

Deno.test("compound: an unverifiable member refuses — or, accepted unverified, registers as none", async () => {
  const c = await ceremony();
  const members = [entry("packed", await packedSelf(c)), entry("future-format", new Map())];
  const error = await refused(() => register(c, "compound", members));
  assert(/unsupported/.test(error.message));
  const lax = await register(c, "compound", members, true);
  assertEquals([lax.fmt, lax.attestationType], ["none", "none"]);
});

Deno.test("compound under the FIDO Metadata Service: every certificate statement must chain", async () => {
  const c = await ceremony();
  const pki = await testPki();
  const first = await packedX5c(c, pki);
  const sameRoot = await packedX5c(c, pki);
  const otherRoot = await packedX5c(c);
  const signer = await testKey();
  const blobLeaf = await makeCert({
    subject: "MDS Signer",
    key: signer,
    issuer: { cn: "Test Root Intermediate", key: pki.intermediateKey },
    dns: ["mds.fidoalliance.org"],
  });
  const hex = Array.from(AAGUID, (b) => b.toString(16).padStart(2, "0")).join("");
  const jwt = await signBlob(
    {
      no: 1,
      nextUpdate: new Date(TEST_NOW + 10 * 86_400_000).toISOString().slice(0, 10),
      entries: [{
        aaguid: hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
        metadataStatement: { attestationRootCertificates: [b64(pki.root)] },
        statusReports: [],
      }],
    },
    signer,
    [blobLeaf, pki.intermediate],
  );
  const mds: ResolvedMds = { ...resolveMds({ blob: jwt })!, roots: [pki.root] };
  const ok = await register(c, "compound", [
    entry("packed", first.stmt),
    entry("packed", sameRoot.stmt),
  ]);
  await checkMdsAttestation(mds, ok, TEST_NOW);
  const mixed = await register(c, "compound", [
    entry("packed", first.stmt),
    entry("packed", otherRoot.stmt),
  ]);
  await assertRejects(
    () => checkMdsAttestation(mds, mixed, TEST_NOW),
    WebAuthnError,
    "does not chain",
  );
  assertEquals(mixed.attestationStatements?.length, 2);
});
