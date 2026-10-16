// FIDO Metadata Service (MDS3) checks for passkey registration, and the X.509 path validation
// under them. Certificates are built and really signed at test time (tests/_x509-test-ca.ts); the
// test BLOBs chain to a throwaway root handed in as `roots` — the production setting always pins
// the FIDO root, which these tests also show refuses them. The attestation cases run the W3C
// WebAuthn L3 test vectors' packed `x5c` registration, whose chain ends at the vectors' CA.

import { assert, assertEquals, assertRejects } from "@std/assert";
import vectors from "./fixtures/webauthn-l3-vectors.json" with { type: "json" };
import {
  checkMdsAttestation,
  currentMdsBlob,
  type ResolvedMds,
  resolveMds,
  verifyMdsBlob,
} from "../src/server/auth/fido-mds.ts";
import { CertificateChainError, verifyCertificateChain } from "../src/server/auth/x509-chain.ts";
import {
  type RegistrationResult,
  verifyRegistration,
  WebAuthnError,
} from "../src/server/auth/webauthn.ts";
import { resolvePasskeys } from "../src/server/auth/passkeys.ts";
import { creationOptions, verifyNewPasskey } from "../src/server/auth/passkey-ceremony.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import {
  b64,
  type BlobPayload,
  day,
  leafOf,
  makeCert,
  signBlob,
  TEST_NOW,
  testKey,
  testPki,
} from "./_x509-test-ca.ts";

/** Every check runs on the injected clock, never the wall clock (see TEST_NOW). */
const NOW = TEST_NOW;
const DAY = 86_400_000;
const hexBytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const b64u = (bytes: Uint8Array) =>
  b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

async function chainRefused(chain: Uint8Array[], anchors: Uint8Array[], now = NOW) {
  await assertRejects(() => verifyCertificateChain(chain, anchors, now), CertificateChainError);
}

// ---- X.509 path validation ------------------------------------------------------------

Deno.test("x509 chain: leaf → intermediate → anchor validates, in any intermediate order", async () => {
  const pki = await testPki();
  const { cert } = await leafOf(pki);
  const leaf = await verifyCertificateChain([cert, pki.intermediate], [pki.root], NOW);
  assertEquals(leaf.der, cert);
  // The leaf itself as an anchor is trusted byte for byte.
  await verifyCertificateChain([cert], [cert], NOW);
});

Deno.test("x509 chain: an unknown anchor, or a missing intermediate, is refused", async () => {
  const pki = await testPki();
  const other = await testPki("Other Root");
  const { cert } = await leafOf(pki);
  await chainRefused([cert, pki.intermediate], [other.root]);
  await chainRefused([cert], [pki.root]);
  // A carried copy of the root is not trust.
  await chainRefused([cert, pki.intermediate, pki.root], [other.root]);
});

Deno.test("x509 chain: a forged signature under the right issuer name is refused", async () => {
  const pki = await testPki();
  const impostor = await testKey();
  const cert = await makeCert({
    subject: "Forged Leaf",
    key: await testKey(),
    issuer: { cn: "Test Root Intermediate", key: impostor },
  });
  await chainRefused([cert, pki.intermediate], [pki.root]);
});

Deno.test("x509 chain: an intermediate must be a CA allowed to sign certificates", async () => {
  const pki = await testPki();
  for (const over of [{ ca: false }, { ca: undefined }, { keyUsage: 0x80 }]) {
    const key = await testKey();
    const intermediate = await makeCert({
      subject: "Weak CA",
      key,
      issuer: { cn: "Test Root", key: pki.rootKey },
      ca: true,
      keyUsage: 0x06,
      ...over,
    });
    const leaf = await makeCert({
      subject: "Leaf",
      key: await testKey(),
      issuer: { cn: "Weak CA", key },
    });
    await chainRefused([leaf, intermediate], [pki.root]);
  }
});

Deno.test("x509 chain: pathLenConstraint, validity and unknown critical extensions", async () => {
  const pki = await testPki();
  // pathLen 0 on the intermediate: no CA may sit below it.
  const subKey = await testKey();
  const sub = await makeCert({
    subject: "Sub CA",
    key: subKey,
    issuer: { cn: "Test Root Intermediate", key: pki.intermediateKey },
    ca: true,
    keyUsage: 0x06,
  });
  const deep = await makeCert({
    subject: "Deep Leaf",
    key: await testKey(),
    issuer: { cn: "Sub CA", key: subKey },
  });
  await chainRefused([deep, sub, pki.intermediate], [pki.root]);
  // An expired leaf, and a leaf not valid yet.
  const expired = await leafOf(pki, { notBefore: NOW - 3 * DAY, notAfter: NOW - DAY });
  await chainRefused([expired.cert, pki.intermediate], [pki.root]);
  const early = await leafOf(pki, { notBefore: NOW + DAY, notAfter: NOW + 3 * DAY });
  await chainRefused([early.cert, pki.intermediate], [pki.root]);
  // An expired anchor.
  const oldRootKey = await testKey();
  const oldRoot = await makeCert({
    subject: "Old Root",
    key: oldRootKey,
    ca: true,
    notBefore: NOW - 3 * DAY,
    notAfter: NOW - DAY,
  });
  const child = await makeCert({
    subject: "Child",
    key: await testKey(),
    issuer: { cn: "Old Root", key: oldRootKey },
  });
  await chainRefused([child], [oldRoot]);
  // A critical extension nobody here understands.
  const odd = await leafOf(pki, { unknownCritical: "1.2.3.4.5" });
  await chainRefused([odd.cert, pki.intermediate], [pki.root]);
});

// ---- the metadata BLOB ----------------------------------------------------------------

const MDS_HOST = "mds.fidoalliance.org";

/** A BLOB signer: a leaf for the MDS host under `pki`. */
async function blobSigner(pki: Awaited<ReturnType<typeof testPki>>, dns = [MDS_HOST]) {
  return await leafOf(pki, { subject: "Metadata Signer", dns });
}

function payload(over: Partial<BlobPayload> = {}): BlobPayload {
  return { no: 10, nextUpdate: day(NOW + 7 * DAY), entries: [], ...over };
}

Deno.test("mds blob: a BLOB signed under the given roots verifies and parses", async () => {
  const pki = await testPki();
  const signer = await blobSigner(pki);
  const jwt = await signBlob(
    payload({ entries: [{ aaguid: "AAAAAAAA-0000-0000-0000-000000000001", statusReports: [] }] }),
    signer.key,
    [signer.cert, pki.intermediate],
  );
  const blob = await verifyMdsBlob(jwt, [pki.root], NOW);
  assertEquals(blob.no, 10);
  assert(blob.entries.has("aaaaaaaa-0000-0000-0000-000000000001"));
});

Deno.test("mds blob: a forged signature, another root, or another signer host is refused", async () => {
  const pki = await testPki();
  const signer = await blobSigner(pki);
  const jwt = await signBlob(payload(), signer.key, [signer.cert, pki.intermediate]);
  // The payload changed after signing.
  const [h, , s] = jwt.split(".");
  const forged = `${h}.${b64u(new TextEncoder().encode(JSON.stringify(payload({ no: 99 }))))}.${s}`;
  await assertRejects(() => verifyMdsBlob(forged, [pki.root], NOW), WebAuthnError);
  // Signed by a key that isn't the x5c leaf's.
  const wrongKey = await signBlob(payload(), await testKey(), [signer.cert, pki.intermediate]);
  await assertRejects(() => verifyMdsBlob(wrongKey, [pki.root], NOW), WebAuthnError);
  // Chained to a root that isn't trusted — and the production setting pins the FIDO root.
  const other = await testPki("Other Root");
  await assertRejects(() => verifyMdsBlob(jwt, [other.root], NOW), CertificateChainError);
  await assertRejects(() => verifyMdsBlob(jwt, resolveMds({})!.roots, NOW), CertificateChainError);
  // A certificate the root issued for another host.
  const elsewhere = await blobSigner(pki, ["example.com"]);
  const foreign = await signBlob(payload(), elsewhere.key, [elsewhere.cert, pki.intermediate]);
  await assertRejects(() => verifyMdsBlob(foreign, [pki.root], NOW), WebAuthnError);
  // Not a JWS at all.
  await assertRejects(() => verifyMdsBlob("not.a-jws", [pki.root], NOW), WebAuthnError);
});

/** A ResolvedMds over a BLOB loader, trusting `root` (tests only — the option can't). */
function mdsWith(
  root: Uint8Array,
  blob: () => Promise<string>,
  over: Partial<ResolvedMds> = {},
): ResolvedMds {
  return { ...resolveMds({ blob })!, roots: [root], ...over };
}

Deno.test("mds blob: kept until nextUpdate, refreshed after, rollbacks refused, then fail closed", async () => {
  const pki = await testPki();
  const signer = await blobSigner(pki);
  const chain = [signer.cert, pki.intermediate];
  let next: BlobPayload = payload({ no: 10, nextUpdate: day(NOW + DAY) });
  let calls = 0;
  const mds = mdsWith(pki.root, async () => {
    calls++;
    return await signBlob(next, signer.key, chain);
  });
  assertEquals((await currentMdsBlob(mds, NOW)).no, 10);
  assertEquals((await currentMdsBlob(mds, NOW + 1000)).no, 10);
  assertEquals(calls, 1); // held until nextUpdate
  // Past nextUpdate: refreshed.
  next = payload({ no: 11, nextUpdate: day(NOW + 5 * DAY) });
  const after = NOW + 2 * DAY;
  assertEquals((await currentMdsBlob(mds, after)).no, 11);
  assertEquals(calls, 2);
  // An older BLOB (a replay) is refused: the held one serves through its grace day…
  next = payload({ no: 9, nextUpdate: day(NOW + 30 * DAY) });
  const due = NOW + 5 * DAY + 3600_000;
  assertEquals((await currentMdsBlob(mds, due)).no, 11);
  // …retries are spaced five minutes apart…
  assertEquals((await currentMdsBlob(mds, due + 1000)).no, 11);
  assertEquals(calls, 3);
  // …and past the grace day registrations fail closed.
  await assertRejects(() => currentMdsBlob(mds, NOW + 7 * DAY), WebAuthnError);
});

Deno.test("mds blob: a BLOB already past its nextUpdate is refused", async () => {
  const pki = await testPki();
  const signer = await blobSigner(pki);
  const stale = payload({ nextUpdate: day(NOW - 3 * DAY) });
  const mds = mdsWith(pki.root, () => signBlob(stale, signer.key, [signer.cert, pki.intermediate]));
  await assertRejects(() => currentMdsBlob(mds, NOW), WebAuthnError, "out of date");
});

Deno.test("mds fetch: https only, a size cap and a timeout", async () => {
  if (!resolveMds({ url: "https://mirror.example/blob" })) throw new Error("resolve");
  let threw = false;
  try {
    resolveMds({ url: "http://mirror.example/blob" });
  } catch {
    threw = true;
  }
  assert(threw, "a plaintext URL is refused");
  const realFetch = globalThis.fetch;
  try {
    // A declared length over the cap is refused before reading.
    globalThis.fetch = () =>
      Promise.resolve(new Response("x".repeat(64), { headers: { "content-length": "64" } }));
    const capped = { ...resolveMds({ maxBytes: 16 })!, roots: [] };
    await assertRejects(() => currentMdsBlob(capped, NOW), WebAuthnError, "unavailable");
    // A streamed body over the cap too.
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(8));
            },
          }),
        ),
      );
    const streamed = { ...resolveMds({ maxBytes: 64 })!, roots: [] };
    await assertRejects(() => currentMdsBlob(streamed, NOW), WebAuthnError, "too large");
    // A server that never answers is abandoned at the timeout.
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const slow = { ...resolveMds({ timeoutMs: 50 })!, roots: [] };
    await assertRejects(() => currentMdsBlob(slow, NOW), WebAuthnError, "unavailable");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- registrations --------------------------------------------------------------------

type Vector = { registration: Record<string, string> };
const V = vectors.vectors as unknown as Record<string, Vector>;
const VECTOR_CA = hexBytes(vectors.attestationCaCert);

function register(name: string): Promise<RegistrationResult> {
  const r = V[name].registration;
  return verifyRegistration(
    {
      clientDataJSON: hexBytes(r.clientDataJSON),
      attestationObject: hexBytes(r.attestationObject),
    },
    {
      origins: ["https://example.org"],
      rpId: "example.org",
      requireUserVerification: false,
      challenge: b64u(hexBytes(r.challenge)),
    },
  );
}

function aaguidOf(result: RegistrationResult): string {
  const h = Array.from(result.aaguid, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A ResolvedMds whose BLOB lists `entries`, signed under a throwaway root. */
async function mdsListing(entries: unknown[], over: Partial<ResolvedMds> = {}) {
  const pki = await testPki();
  const signer = await blobSigner(pki);
  const jwt = await signBlob(payload({ entries }), signer.key, [signer.cert, pki.intermediate]);
  return mdsWith(pki.root, () => Promise.resolve(jwt), over);
}

const entry = (aaguid: string, roots: Uint8Array[], statusReports: unknown[] = []) => ({
  aaguid,
  statusReports,
  metadataStatement: { attestationRootCertificates: roots.map(b64) },
});

Deno.test("mds registration: a packed x5c chaining to its metadata roots registers", async () => {
  const result = await register("packed-es256");
  assertEquals(result.attestationType, "basic");
  assert(result.attestationCertificates?.length);
  const ok = await mdsListing([entry(aaguidOf(result), [VECTOR_CA], [{
    status: "FIDO_CERTIFIED_L1",
    effectiveDate: "2024-01-01",
  }])]);
  await checkMdsAttestation(ok, result, NOW);
});

Deno.test("mds registration: an x5c that doesn't chain to the metadata roots is refused", async () => {
  const result = await register("packed-es256");
  const other = await testPki("Vendor Root");
  const mds = await mdsListing([entry(aaguidOf(result), [other.root])]);
  await assertRejects(() => checkMdsAttestation(mds, result, NOW), WebAuthnError, "chain");
  // No roots listed at all.
  const empty = await mdsListing([entry(aaguidOf(result), [])]);
  await assertRejects(() => checkMdsAttestation(empty, result, NOW), WebAuthnError, "chain");
});

Deno.test("mds registration: an AAGUID without metadata is refused unless allowed", async () => {
  const result = await register("packed-es256");
  const mds = await mdsListing([]);
  await assertRejects(() => checkMdsAttestation(mds, result, NOW), WebAuthnError, "no FIDO");
  await checkMdsAttestation({ ...mds, allowUnknownAuthenticators: true }, result, NOW);
});

Deno.test("mds registration: a compromised authenticator is refused", async () => {
  const result = await register("packed-es256");
  const id = aaguidOf(result);
  const refusedFor = async (reports: unknown[]) => {
    const mds = await mdsListing([entry(id, [VECTOR_CA], reports)]);
    await assertRejects(() => checkMdsAttestation(mds, result, NOW), WebAuthnError, "compromised");
  };
  for (
    const status of [
      "USER_VERIFICATION_BYPASS",
      "ATTESTATION_KEY_COMPROMISE",
      "USER_KEY_REMOTE_COMPROMISE",
      "USER_KEY_PHYSICAL_COMPROMISE",
      "REVOKED",
    ]
  ) {
    await refusedFor([
      { status: "FIDO_CERTIFIED", effectiveDate: "2023-01-01" },
      { status, effectiveDate: "2024-01-01" },
    ]);
  }
  // A revocation stays, whatever comes after it.
  await refusedFor([
    { status: "REVOKED", effectiveDate: "2023-01-01" },
    { status: "FIDO_CERTIFIED", effectiveDate: "2024-01-01" },
  ]);
  // A bypass fixed by a later update is no longer the latest status.
  const fixed = await mdsListing([entry(id, [VECTOR_CA], [
    { status: "UPDATE_AVAILABLE", effectiveDate: "2024-06-01" },
    { status: "USER_VERIFICATION_BYPASS", effectiveDate: "2024-01-01" },
  ])]);
  await checkMdsAttestation(fixed, result, NOW);
});

Deno.test("mds registration: none / self attestation needs allowUnattested", async () => {
  const none = await register("none-es256");
  const self = await register("packed-self-es256");
  const mds = await mdsListing([]);
  for (const result of [none, self]) {
    assert(result.attestationType !== "basic");
    await assertRejects(() => checkMdsAttestation(mds, result, NOW), WebAuthnError, "required");
    await checkMdsAttestation({ ...mds, allowUnattested: true }, result, NOW);
  }
  // Allowed unattested, a model whose metadata reports a compromise is still refused.
  const revoked = await mdsListing([entry(aaguidOf(self), [], [{ status: "REVOKED" }])], {
    allowUnattested: true,
  });
  assert(self.aaguid.some((b) => b !== 0), "the vector names a model");
  await assertRejects(() => checkMdsAttestation(revoked, self, NOW), WebAuthnError);
});

// ---- wiring: off by default --------------------------------------------------------------

const BASE: AuthConfig = {
  secret: "x".repeat(40),
  canonicalOrigin: "https://example.org",
  providers: [],
  adapter: inMemoryAuthAdapter(),
};

Deno.test("mds wiring: off by default — no direct attestation asked, no metadata fetched", async () => {
  const rp = resolvePasskeys({ ...BASE, passkeys: { userVerification: "preferred" } })!;
  assertEquals(rp.mds, null);
  assertEquals(creationOptions(rp, { id: "u1" }, [], "c").attestation, "none");
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched++;
    return Promise.reject(new Error("no network in this test"));
  };
  try {
    const r = V["packed-es256"].registration;
    const record = await verifyNewPasskey(
      rp,
      {
        id: b64u(hexBytes(r.credential_id)),
        type: "public-key",
        response: {
          clientDataJSON: b64u(hexBytes(r.clientDataJSON)),
          attestationObject: b64u(hexBytes(r.attestationObject)),
        },
      } as Parameters<typeof verifyNewPasskey>[1],
      b64u(hexBytes(r.challenge)),
      "u1",
    );
    assert(record.id);
    // With MDS on, the same registration consults the metadata (here: unreachable → refused).
    const on = resolvePasskeys({
      ...BASE,
      adapter: inMemoryAuthAdapter(),
      passkeys: { userVerification: "preferred", attestation: { mds: {} } },
    })!;
    assert(on.mds);
    assertEquals(creationOptions(on, { id: "u1" }, [], "c").attestation, "direct");
    await assertRejects(
      () =>
        verifyNewPasskey(
          on,
          {
            id: b64u(hexBytes(r.credential_id)),
            type: "public-key",
            response: {
              clientDataJSON: b64u(hexBytes(r.clientDataJSON)),
              attestationObject: b64u(hexBytes(r.attestationObject)),
            },
          } as Parameters<typeof verifyNewPasskey>[1],
          b64u(hexBytes(r.challenge)),
          "u1",
        ),
      WebAuthnError,
      "unavailable",
    );
    assertEquals(fetched, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("mds registration: a format denext can't verify registers only as unattested", async () => {
  const r = V["none-es256"].registration;
  const ao = hexBytes(r.attestationObject);
  // Rename `fmt: "none"` to a four-letter format nobody here verifies.
  const at = ao.findIndex((_, i) =>
    ao[i] === 0x64 && String.fromCharCode(...ao.slice(i + 1, i + 5)) === "none"
  );
  assert(at > 0);
  ao.set(new TextEncoder().encode("tpmx"), at + 1);
  const expected = {
    origins: ["https://example.org"],
    rpId: "example.org",
    requireUserVerification: false,
    challenge: b64u(hexBytes(r.challenge)),
  };
  const response = { clientDataJSON: hexBytes(r.clientDataJSON), attestationObject: ao };
  await assertRejects(() => verifyRegistration(response, expected), WebAuthnError, "unsupported");
  const result = await verifyRegistration(response, { ...expected, acceptUnverifiedFormats: true });
  assertEquals([result.fmt, result.attestationType], ["none", "none"]);
  const mds = await mdsListing([]);
  await assertRejects(() => checkMdsAttestation(mds, result, NOW), WebAuthnError, "required");
  await checkMdsAttestation({ ...mds, allowUnattested: true }, result, NOW);
});
