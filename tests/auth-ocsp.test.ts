// OCSP (RFC 6960) revocation checks for the FIDO Metadata Service paths
// (packages/auth/src/ocsp.ts, packages/auth/src/revocation.ts): the DER request, the response's
// signature (the issuer's or a delegated responder's), its CertID and freshness, the cache, the
// fall-back to the CRL, and the soft / hard failure policy (`passkeys.attestation.revocation`).
//
// Two sources of vectors: responses built and really signed at test time by the throwaway CA of
// tests/_x509-test-ca.ts, and an independent set generated with OpenSSL 3.6.3's `openssl ocsp`
// (tests/fixtures/ocsp/openssl.json — its `source` field records how), which pins the request
// encoding byte for byte and the response parsing to another implementation. fetch is a stub,
// never the network.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildOcspRequest,
  OCSP_FAILURE_BACKOFF_MS,
  OcspCache,
  ocspUrlsOf,
  parseOcspResponse,
} from "../packages/auth/src/ocsp.ts";
import { RevocationChecker } from "../packages/auth/src/revocation.ts";
import { RevocationError, type RevocationMode } from "../packages/auth/src/crl.ts";
import {
  checkMdsAttestation,
  type ResolvedMds,
  resolveMds,
} from "../packages/auth/src/fido-mds.ts";
import {
  type ParsedCertificate,
  parseX509Certificate,
  verifyCertificateChain,
  verifyWithSpki,
} from "../packages/auth/src/x509-chain.ts";
import {
  b64,
  leafOf,
  makeCert,
  makeCrl,
  makeOcspResponse,
  type OcspEntry,
  signBlob,
  TEST_NOW,
  testKey,
  testPki,
} from "./_x509-test-ca.ts";
import openssl from "./fixtures/ocsp/openssl.json" with { type: "json" };

const NOW = TEST_NOW;
const DAY = 86_400_000;
const OCSP_URL = "http://ocsp.test/";
const CRL_URL = "http://crl.test/intermediate.crl";
const INTERMEDIATE = "Test Root Intermediate";
const der = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A fetch stub serving `bodies` by URL (a number is an HTTP status), recording calls. */
function stubFetch(bodies: Record<string, Uint8Array | number>) {
  const calls: { url: string; method?: string; type: string | null }[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, type: new Headers(init?.headers).get("content-type") });
    const answer = bodies[url];
    if (answer === undefined) return Promise.reject(new TypeError("network down"));
    const status = typeof answer === "number" ? answer : 200;
    return Promise.resolve(
      new Response(typeof answer === "number" ? "no" : answer as BodyInit, { status }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function checker(mode: RevocationMode, fetch: typeof globalThis.fetch, warnings: string[] = []) {
  return new RevocationChecker(
    { mode, timeoutMs: 1000, maxBytes: 64 * 1024, fetch, warn: (m) => void warnings.push(m) },
    verifyWithSpki,
  );
}

const issuerOf = (key: Awaited<ReturnType<typeof testKey>>) => ({ cn: INTERMEDIATE, key });

/** A leaf (serial 77) naming OCSP_URL (and CRL_URL with `crl`), under a fresh test PKI. */
async function setup(o: { crl?: boolean; serial?: number } = {}) {
  const pki = await testPki();
  const serial = o.serial ?? 77;
  const { cert } = await leafOf(pki, {
    ocspUrls: [OCSP_URL],
    ...(o.crl ? { crlUrls: [CRL_URL] } : {}),
    serial,
  });
  return { pki, leaf: cert, serial, issuer: issuerOf(pki.intermediateKey) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** `verifyCertificateChain` of `s.leaf` with an OCSP + CRL check over a stubbed fetch. */
function chain(
  s: Setup,
  mode: RevocationMode,
  bodies: Parameters<typeof stubFetch>[0],
  warnings: string[] = [],
) {
  const stub = stubFetch(bodies);
  const revocation = checker(mode, stub.fetch, warnings);
  return {
    stub,
    run: (now = NOW) =>
      verifyCertificateChain(
        [s.leaf, s.pki.intermediate],
        [s.pki.root],
        now,
        (cert, issuer, at) => revocation.check(cert, issuer, at),
      ),
  };
}

const answer = (s: Setup, entry: Partial<OcspEntry> = {}, extra = {}) =>
  makeOcspResponse({
    issuer: s.issuer,
    entries: [{ serial: s.serial, status: "good", ...entry }],
    ...extra,
  });

// ---- the wire format ----------------------------------------------------------------------

Deno.test("ocsp: the request is byte-identical to OpenSSL's (SHA-1 CertID, no nonce)", async () => {
  const ca = parseX509Certificate(der(openssl.ca));
  for (
    const [leafB64, requestB64] of [
      [openssl.goodLeaf, openssl.goodRequest],
      [openssl.revokedLeaf, openssl.revokedRequest],
    ]
  ) {
    const leaf = parseX509Certificate(der(leafB64));
    const request = await buildOcspRequest(
      { serial: leaf.serial, issuer: leaf.issuer, ocspUrls: ocspUrlsOf(leaf.extensions) },
      ca.spki,
    );
    assertEquals(b64(request), requestB64);
  }
  assertEquals(ocspUrlsOf(parseX509Certificate(der(openssl.goodLeaf)).extensions), [
    "http://ocsp.test/",
  ]);
});

Deno.test("ocsp: OpenSSL's responses — good from a delegated responder, revoked from the CA", async () => {
  const now = Date.parse(openssl.thisUpdate) + 3_600_000;
  const ca = parseX509Certificate(der(openssl.ca));
  const status = async (leafB64: string, response: string) => {
    const leaf = parseX509Certificate(der(leafB64));
    const cache = new OcspCache(
      {
        timeoutMs: 1000,
        maxBytes: 64 * 1024,
        fetch: stubFetch({ [OCSP_URL]: der(response) }).fetch,
      },
      verifyWithSpki,
    );
    return await cache.status(
      { serial: leaf.serial, issuer: leaf.issuer, ocspUrls: ocspUrlsOf(leaf.extensions) },
      ca.spki,
      now,
    );
  };
  assertEquals(await status(openssl.goodLeaf, openssl.goodResponseDelegated), "good");
  assertEquals(await status(openssl.revokedLeaf, openssl.revokedResponseByCa), "revoked");
  // An answer for another certificate establishes nothing.
  assertEquals(await status(openssl.goodLeaf, openssl.revokedResponseByCa), "unknown");
  const parsed = parseOcspResponse(der(openssl.goodResponseDelegated))!;
  assertEquals(parsed.certs.length, 1, "the delegated responder's certificate is carried");
  assertEquals(parsed.responses[0].status, "good");
});

Deno.test("ocsp: a non-successful responseStatus, or another response type, is no answer", async () => {
  const s = await setup();
  assertEquals(parseOcspResponse(await answer(s, {}, { responseStatus: 3 })), null);
});

Deno.test("ocsp: AIA yields http(s) OCSP responders only, at most four", async () => {
  const pki = await testPki();
  const urls = ["ldap://dir.test/x", ...Array.from({ length: 6 }, (_, i) => `http://o${i}.test/`)];
  const { cert } = await leafOf(pki, { ocspUrls: urls });
  const parsed = parseX509Certificate(cert);
  assertEquals(ocspUrlsOf(parsed.extensions), [
    "http://o0.test/",
    "http://o1.test/",
    "http://o2.test/",
    "http://o3.test/",
  ]);
  const { cert: none } = await leafOf(pki);
  assertEquals(ocspUrlsOf(parseX509Certificate(none).extensions), []);
});

// ---- revocation through path validation --------------------------------------------------

Deno.test("ocsp: a good answer passes; a revoked one refuses, under either policy", async () => {
  const s = await setup();
  const good = chain(s, "require", { [OCSP_URL]: await answer(s) });
  await good.run();
  assertEquals(good.stub.calls.length, 1);
  assertEquals(good.stub.calls[0].method, "POST");
  assertEquals(good.stub.calls[0].type, "application/ocsp-request");
  for (const mode of ["require", "best-effort"] as const) {
    const revoked = chain(s, mode, { [OCSP_URL]: await answer(s, { status: "revoked" }) });
    await assertRejects(() => revoked.run(), RevocationError, "revoked");
  }
});

Deno.test("ocsp: a SHA-256 CertID answer is matched too", async () => {
  const s = await setup();
  await chain(s, "require", { [OCSP_URL]: await answer(s, { hash: "SHA-256" }) }).run();
  const revoked = chain(s, "require", {
    [OCSP_URL]: await answer(s, { hash: "SHA-256", status: "revoked" }),
  });
  await assertRejects(() => revoked.run(), RevocationError, "revoked");
});

Deno.test("ocsp: a delegated responder signed by the issuer with OCSPSigning is believed", async () => {
  const s = await setup();
  const responderKey = await testKey();
  const responder = await makeCert({
    subject: "Test OCSP Responder",
    key: responderKey,
    issuer: s.issuer,
    ca: false,
    ocspSigning: true,
  });
  const revoked = await answer(s, { status: "revoked" }, {
    signer: responderKey,
    certs: [responder],
  });
  await assertRejects(
    () => chain(s, "best-effort", { [OCSP_URL]: revoked }).run(),
    RevocationError,
    "revoked",
  );
});

Deno.test("ocsp: hard refuses every answer that can't be used; soft goes on, warning once", async () => {
  const s = await setup();
  const strangerKey = await testKey();
  const noEku = await testKey();
  const noEkuCert = await makeCert({ subject: "Not a Responder", key: noEku, issuer: s.issuer });
  const foreignKey = await testKey();
  const foreignCert = await makeCert({
    subject: "Foreign Responder",
    key: foreignKey,
    issuer: { cn: INTERMEDIATE, key: await testKey() }, // the issuer's name, another key
    ocspSigning: true,
  });
  const unusable: [string, Parameters<typeof stubFetch>[0]][] = [
    ["network down", {}],
    ["HTTP 500", { [OCSP_URL]: 500 }],
    ["not DER", { [OCSP_URL]: Uint8Array.of(1, 2, 3) }],
    ["tryLater", { [OCSP_URL]: await answer(s, {}, { responseStatus: 3 }) }],
    ["unknown", { [OCSP_URL]: await answer(s, { status: "unknown" }) }],
    ["another serial", { [OCSP_URL]: await answer(s, { serial: 5 }) }],
    ["another issuer", {
      [OCSP_URL]: await answer(s, { issuer: { cn: "Other CA", key: s.issuer.key } }),
    }],
    ["forged signature", { [OCSP_URL]: await answer(s, {}, { signer: strangerKey }) }],
    ["responder without OCSPSigning", {
      [OCSP_URL]: await answer(s, {}, { signer: noEku, certs: [noEkuCert] }),
    }],
    ["responder another key issued", {
      [OCSP_URL]: await answer(s, {}, { signer: foreignKey, certs: [foreignCert] }),
    }],
    ["stale", { [OCSP_URL]: await answer(s, { nextUpdate: NOW - 1000 }) }],
    ["no nextUpdate", { [OCSP_URL]: await answer(s, { nextUpdate: null }) }],
    ["thisUpdate an hour ahead", { [OCSP_URL]: await answer(s, { thisUpdate: NOW + 3_600_000 }) }],
    ["over-size", { [OCSP_URL]: new Uint8Array(65 * 1024) }],
  ];
  for (const [name, bodies] of unusable) {
    await assertRejects(
      () => chain(s, "require", bodies).run(),
      RevocationError,
      "no revocation status",
      name,
    );
    const warnings: string[] = [];
    const soft = chain(s, "best-effort", bodies, warnings);
    await soft.run();
    await soft.run(NOW + OCSP_FAILURE_BACKOFF_MS + 1);
    assertEquals(warnings.length, 1, name);
  }
  const off = chain(s, "off", {});
  await off.run();
  assertEquals(off.stub.calls, []);
});

Deno.test("ocsp: a thisUpdate within the five-minute clock skew is accepted", async () => {
  const s = await setup();
  await chain(s, "require", { [OCSP_URL]: await answer(s, { thisUpdate: NOW + 60_000 }) }).run();
});

Deno.test("ocsp: an answer is cached until its nextUpdate; no answer is not re-asked for five minutes", async () => {
  const s = await setup();
  const ok = chain(s, "require", { [OCSP_URL]: await answer(s, { nextUpdate: NOW + DAY }) });
  await ok.run();
  await ok.run(NOW + 60_000);
  assertEquals(ok.stub.calls.length, 1, "served from the cache");
  await assertRejects(() => ok.run(NOW + 2 * DAY), RevocationError, "no revocation status");
  assertEquals(ok.stub.calls.length, 2, "asked again once past nextUpdate");

  const down = chain(s, "require", {});
  await assertRejects(() => down.run(), RevocationError);
  await assertRejects(() => down.run(NOW + 1000), RevocationError);
  assertEquals(down.stub.calls.length, 1, "backed off");
  await assertRejects(() => down.run(NOW + OCSP_FAILURE_BACKOFF_MS + 1), RevocationError);
  assertEquals(down.stub.calls.length, 2);
});

Deno.test("ocsp: concurrent checks of one certificate share one request", async () => {
  const s = await setup();
  const ok = chain(s, "require", { [OCSP_URL]: await answer(s) });
  await Promise.all([ok.run(), ok.run(), ok.run()]);
  assertEquals(ok.stub.calls.length, 1);
});

// ---- OCSP and the CRL together -----------------------------------------------------------

Deno.test("revocation: OCSP settles it first; with no OCSP answer the CRL decides", async () => {
  const s = await setup({ crl: true });
  const listing = await makeCrl({ issuer: s.issuer, revoked: [s.serial] });
  const clean = await makeCrl({ issuer: s.issuer, revoked: [] });
  // A good OCSP answer: the CRL is never fetched.
  const ocspGood = chain(s, "require", { [OCSP_URL]: await answer(s), [CRL_URL]: listing });
  await ocspGood.run();
  assertEquals(ocspGood.stub.calls.map((c) => c.url), [OCSP_URL]);
  // The responder is down: the CRL lists it — refused; doesn't — passes, even under hard.
  await assertRejects(
    () => chain(s, "require", { [CRL_URL]: listing }).run(),
    RevocationError,
    "revoked",
  );
  await chain(s, "require", { [CRL_URL]: clean }).run();
  // Neither: hard refuses.
  await assertRejects(() => chain(s, "require", {}).run(), RevocationError, "no revocation");
});

Deno.test("revocation: a certificate naming no responder and no CRL has nothing to check", async () => {
  const pki = await testPki();
  const { cert } = await leafOf(pki);
  const stub = stubFetch({});
  const revocation = checker("require", stub.fetch);
  await verifyCertificateChain(
    [cert, pki.intermediate],
    [pki.root],
    NOW,
    (c: ParsedCertificate, issuer, at) => revocation.check(c, issuer, at),
  );
  assertEquals(stub.calls, []);
});

// ---- the passkeys configuration ------------------------------------------------------------

Deno.test("attestation.revocation: hard by default (soft with an offline blob), soft on request; mds.revocation wins", () => {
  assertEquals(resolveMds({})?.revocation, "require");
  assertEquals(resolveMds({ blob: "x" })?.revocation, "best-effort");
  assertEquals(resolveMds({ blob: "x" }, "hard")?.revocation, "require");
  assertEquals(resolveMds({}, "soft")?.revocation, "best-effort");
  assertEquals(resolveMds({}, "hard")?.revocation, "require");
  assertEquals(resolveMds({ revocation: "off" }, "hard")?.revocation, "off");
  assertEquals(resolveMds({ revocation: "require" }, "soft")?.revocation, "require");
  let threw = false;
  try {
    resolveMds({}, "sometimes" as never);
  } catch {
    threw = true;
  }
  assert(threw, "an unknown policy is a config error");
});

Deno.test("attestation.revocation: a revoked x5c is refused; an unreachable responder and CRL refuse by default and register with soft", async () => {
  const pki = await testPki();
  const signer = await testKey();
  const blobLeaf = await makeCert({
    subject: "MDS Signer",
    key: signer,
    issuer: issuerOf(pki.intermediateKey),
    dns: ["mds.fidoalliance.org"],
  });
  const aaguid = "0123456789abcdef0123456789abcdef";
  const jwt = await signBlob(
    {
      no: 1,
      nextUpdate: new Date(NOW + 10 * DAY).toISOString().slice(0, 10),
      entries: [{
        aaguid: aaguid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
        metadataStatement: { attestationRootCertificates: [b64(pki.root)] },
        statusReports: [],
      }],
    },
    signer,
    [blobLeaf, pki.intermediate],
  );
  const { cert: attestation } = await leafOf(pki, {
    ocspUrls: [OCSP_URL],
    crlUrls: [CRL_URL],
    serial: 42,
  });
  const result = {
    aaguid: Uint8Array.from(aaguid.match(/../g)!, (h) => parseInt(h, 16)),
    attestationType: "basic" as const,
    attestationCertificates: [attestation, pki.intermediate],
  };
  const issuer = issuerOf(pki.intermediateKey);
  // Resolved as a fetched BLOB is (no `blob` option), then handed the test BLOB.
  const mds = (
    bodies: Parameters<typeof stubFetch>[0],
    policy?: "soft" | "hard",
  ): ResolvedMds => ({
    ...resolveMds({}, policy)!,
    blob: jwt,
    roots: [pki.root],
    fetch: stubFetch(bodies).fetch,
  });
  const ocsp = (status: "good" | "revoked") =>
    makeOcspResponse({ issuer, entries: [{ serial: 42, status }] });
  await checkMdsAttestation(mds({ [OCSP_URL]: await ocsp("good") }), result, NOW);
  const revoked = mds({ [OCSP_URL]: await ocsp("revoked") }, "soft");
  await assertRejects(
    () => checkMdsAttestation(revoked, result, NOW),
    Error,
    "revoked",
  );
  // The OCSP responder and the CRL are both unreachable: refused by default and under hard…
  for (const policy of [undefined, "hard"] as const) {
    await assertRejects(
      () => checkMdsAttestation(mds({}, policy), result, NOW),
      Error,
      "no revocation status",
    );
  }
  // …registered under soft.
  await checkMdsAttestation(mds({}, "soft"), result, NOW);
});
