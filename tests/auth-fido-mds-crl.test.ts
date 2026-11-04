// Certificate revocation lists for the FIDO Metadata Service checks (packages/auth/src/crl.ts):
// every certificate of a validated path that names a CRL distribution point is checked against
// its issuer's CRL — a listed one is refused — and `revocation` decides what an unavailable or
// unusable CRL means (`require` refuses, `best-effort` goes on, `off` fetches nothing). The CRL
// fetch is bounded (timeout, size cap, http/https only), a usable CRL is cached until its
// `nextUpdate`, and a failed fetch is not retried for five minutes. Certificates and CRLs are
// built and really signed at test time (tests/_x509-test-ca.ts); fetch is a stub, never the
// network.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  cappedBytes,
  CrlCache,
  crlUrlsOf,
  FAILURE_BACKOFF_MS,
  parseCrl,
  RevocationError,
  type RevocationMode,
} from "../packages/auth/src/crl.ts";
import {
  checkMdsAttestation,
  type ResolvedMds,
  resolveMds,
  revocationCheckOf,
  verifyMdsBlob,
} from "../packages/auth/src/fido-mds.ts";
import { verifyCertificateChain, verifyWithSpki } from "../packages/auth/src/x509-chain.ts";
import {
  b64,
  leafOf,
  makeCert,
  makeCrl,
  signBlob,
  TEST_NOW,
  testKey,
  type TestKeyPair,
  testPki,
} from "./_x509-test-ca.ts";

const NOW = TEST_NOW;
const DAY = 86_400_000;
const CRL_URL = "http://crl.test/intermediate.crl";
const INTERMEDIATE = "Test Root Intermediate";

/** A fetch stub serving `bodies` by URL, counting calls. */
function stubFetch(bodies: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) return Promise.reject(new TypeError("network down"));
    if (typeof body === "number") return Promise.resolve(new Response("no", { status: body }));
    return Promise.resolve(new Response(body as BodyInit));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function cache(mode: RevocationMode, fetch: typeof globalThis.fetch, warnings: string[] = []) {
  return new CrlCache(
    { mode, timeoutMs: 1000, maxBytes: 64 * 1024, fetch, warn: (m) => void warnings.push(m) },
    verifyWithSpki,
  );
}

interface Setup {
  pki: Awaited<ReturnType<typeof testPki>>;
  leaf: Uint8Array;
  serial: number;
  issuer: { cn: string; key: TestKeyPair };
}

/** A leaf (serial 77) naming CRL_URL, issued by the test intermediate. */
async function setup(serial = 77): Promise<Setup> {
  const pki = await testPki();
  const { cert } = await leafOf(pki, { crlUrls: [CRL_URL], serial });
  return { pki, leaf: cert, serial, issuer: { cn: INTERMEDIATE, key: pki.intermediateKey } };
}

/** `verifyCertificateChain` with a revocation check over a stubbed fetch. */
function chain(s: Setup, mode: RevocationMode, bodies: Record<string, Uint8Array | number>) {
  const stub = stubFetch(bodies);
  const check = cache(mode, stub.fetch);
  return {
    stub,
    run: (now = NOW) =>
      verifyCertificateChain(
        [s.leaf, s.pki.intermediate],
        [s.pki.root],
        now,
        (cert, issuer, at) =>
          check.check(
            { serial: cert.serial, issuer: cert.issuer, crlUrls: crlUrlsOfCert(cert) },
            issuer.spki,
            at,
          ),
      ),
  };
}

function crlUrlsOfCert(cert: { extensions: Map<string, { value: Uint8Array }> }): string[] {
  const ext = cert.extensions.get("551d1f");
  return ext ? crlUrlsOf(ext.value) : [];
}

// ---- the CRL itself -------------------------------------------------------------------------

Deno.test("crl: a signed CRL parses — issuer, times, revoked serials", async () => {
  const s = await setup();
  const crl = parseCrl(await makeCrl({ issuer: s.issuer, revoked: [5, 77] }));
  assertEquals(crl.revoked, new Set(["05", "4d"]));
  assertEquals(crl.thisUpdate, NOW - DAY - (NOW - DAY) % 1000);
  assert(crl.nextUpdate! > NOW);
  assertEquals(crl.unusable, false);
});

Deno.test("crl: the distribution point extension yields its http(s) URIs only", async () => {
  const pki = await testPki();
  const { cert } = await leafOf(pki, {
    crlUrls: ["http://a.test/x.crl", "ldap://dir.test/cn=x", "https://b.test/y.crl"],
  });
  const parsed = await verifyCertificateChain([cert, pki.intermediate], [pki.root], NOW);
  assertEquals(crlUrlsOfCert(parsed), ["http://a.test/x.crl", "https://b.test/y.crl"]);
});

// ---- revocation through path validation -----------------------------------------------------

Deno.test("crl: a certificate its issuer's CRL lists is refused; one it doesn't list passes", async () => {
  const s = await setup();
  const clean = chain(s, "require", {
    [CRL_URL]: await makeCrl({ issuer: s.issuer, revoked: [5] }),
  });
  await clean.run();
  const revoked = chain(s, "require", {
    [CRL_URL]: await makeCrl({ issuer: s.issuer, revoked: [5, s.serial] }),
  });
  await assertRejects(() => revoked.run(), RevocationError, "revoked");
  // best-effort refuses a listed certificate too: only an unavailable CRL is skipped.
  const lax = chain(s, "best-effort", {
    [CRL_URL]: await makeCrl({ issuer: s.issuer, revoked: [s.serial] }),
  });
  await assertRejects(() => lax.run(), RevocationError, "revoked");
});

Deno.test("crl: require refuses when no usable CRL can be had; best-effort goes on; off fetches none", async () => {
  const s = await setup();
  const forged = await makeCrl({ issuer: { cn: INTERMEDIATE, key: await testKey() }, revoked: [] });
  const unusable: Record<string, Uint8Array | number>[] = [
    {}, // network down
    { [CRL_URL]: 503 },
    { [CRL_URL]: Uint8Array.of(1, 2, 3) }, // not a CRL
    { [CRL_URL]: forged }, // signed by another key under the issuer's name
    { [CRL_URL]: await makeCrl({ issuer: { cn: "Someone Else", key: s.pki.intermediateKey } }) },
    { [CRL_URL]: await makeCrl({ issuer: s.issuer, nextUpdate: NOW - DAY }) }, // stale
    { [CRL_URL]: await makeCrl({ issuer: s.issuer, thisUpdate: NOW + DAY }) }, // not yet
    { [CRL_URL]: await makeCrl({ issuer: s.issuer, nextUpdate: null }) }, // no nextUpdate
    // A delta CRL indicator (critical) this reader doesn't apply.
    { [CRL_URL]: await makeCrl({ issuer: s.issuer, unknownCritical: "2.5.29.27" }) },
  ];
  for (const [i, bodies] of unusable.entries()) {
    await assertRejects(
      () => chain(s, "require", bodies).run(),
      RevocationError,
      "no usable",
      `#${i}`,
    );
    await chain(s, "best-effort", bodies).run();
  }
  const off = chain(s, "off", {});
  await off.run();
  assertEquals(off.stub.calls, []);
});

Deno.test("crl: a certificate with no distribution point has nothing to check", async () => {
  const pki = await testPki();
  const { cert } = await leafOf(pki);
  const stub = stubFetch({});
  const check = cache("require", stub.fetch);
  await verifyCertificateChain(
    [cert, pki.intermediate],
    [pki.root],
    NOW,
    (c, issuer, at) =>
      check.check(
        { serial: c.serial, issuer: c.issuer, crlUrls: crlUrlsOfCert(c) },
        issuer.spki,
        at,
      ),
  );
  assertEquals(stub.calls, []);
});

Deno.test("crl: an over-size CRL is refused, not read whole", async () => {
  const s = await setup();
  const big = new Uint8Array(65 * 1024);
  await assertRejects(() => chain(s, "require", { [CRL_URL]: big }).run(), RevocationError);
});

Deno.test("crl: a declared content-length over the cap is refused before the body is read", async () => {
  // The body is a valid CRL that lists nothing: read, it would say "good". Its declared length
  // says it is over the cap, so it is cancelled unread and the check has no usable CRL.
  const s = await setup();
  const crl = await makeCrl({ issuer: s.issuer, revoked: [] });
  let pulled = 0;
  // No eager pull (`highWaterMark: 0`): the stream is pulled only when something reads it.
  const bodyOf = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(crl);
        controller.close();
      },
    }, { highWaterMark: 0 });
  assertEquals(
    await cappedBytes(
      new Response(bodyOf(), { headers: { "content-length": String(64 * 1024 + 1) } }),
      64 * 1024,
    ),
    null,
  );
  assertEquals(pulled, 0, "never read");
  const fetch = (() =>
    Promise.resolve(
      new Response(bodyOf(), { headers: { "content-length": String(64 * 1024 + 1) } }),
    )) as typeof globalThis.fetch;
  const check = cache("require", fetch);
  await assertRejects(
    () =>
      verifyCertificateChain(
        [s.leaf, s.pki.intermediate],
        [s.pki.root],
        NOW,
        (cert, issuer, at) =>
          check.check(
            { serial: cert.serial, issuer: cert.issuer, crlUrls: crlUrlsOfCert(cert) },
            issuer.spki,
            at,
          ),
      ),
    RevocationError,
    "no usable",
  );
  assertEquals(pulled, 0);
  // Under the cap, the same body reads and judges the certificate.
  const small = cache(
    "require",
    (() =>
      Promise.resolve(
        new Response(bodyOf(), { headers: { "content-length": String(crl.byteLength) } }),
      )) as typeof globalThis.fetch,
  );
  await verifyCertificateChain(
    [s.leaf, s.pki.intermediate],
    [s.pki.root],
    NOW,
    (cert, issuer, at) =>
      small.check(
        { serial: cert.serial, issuer: cert.issuer, crlUrls: crlUrlsOfCert(cert) },
        issuer.spki,
        at,
      ),
  );
  assertEquals(pulled, 1);
});

Deno.test("crl: a partitioned or indirect CRL is unusable, even when it lists the certificate", async () => {
  // A CRL scoped to some revocation reasons, or an indirect one, doesn't carry every revocation
  // this reader would need: it must not count as a complete answer — neither "revoked" (it may
  // list the certificate under a reason the reader can't interpret) nor "good".
  const s = await setup();
  for (const kind of ["onlySomeReasons", "indirect"] as const) {
    const listing = await makeCrl({
      issuer: s.issuer,
      revoked: [s.serial],
      issuingDistributionPoint: kind,
    });
    assertEquals(parseCrl(listing).unusable, true, kind);
    await assertRejects(
      () => chain(s, "require", { [CRL_URL]: listing }).run(),
      RevocationError,
      "no usable",
      kind,
    );
    await chain(s, "best-effort", { [CRL_URL]: listing }).run();
  }
  // The positive control: an issuingDistributionPoint that only says "end-entity certificates"
  // keeps the CRL usable, and the listed certificate is refused.
  const complete = await makeCrl({
    issuer: s.issuer,
    revoked: [s.serial],
    issuingDistributionPoint: "userCertsOnly",
  });
  assertEquals(parseCrl(complete).unusable, false);
  await assertRejects(
    () => chain(s, "require", { [CRL_URL]: complete }).run(),
    RevocationError,
    "revoked",
  );
});

Deno.test("crl: a usable CRL is cached until its nextUpdate; a failure is not retried for five minutes", async () => {
  const s = await setup();
  const crl = await makeCrl({ issuer: s.issuer, nextUpdate: NOW + DAY });
  const ok = chain(s, "require", { [CRL_URL]: crl });
  await ok.run();
  await ok.run(NOW + 60_000);
  assertEquals(ok.stub.calls.length, 1, "served from the cache");
  await assertRejects(() => ok.run(NOW + 2 * DAY), RevocationError, "no usable");
  assertEquals(ok.stub.calls.length, 2, "re-fetched once past nextUpdate");

  const down = chain(s, "require", {});
  await assertRejects(() => down.run(), RevocationError);
  await assertRejects(() => down.run(NOW + 1000), RevocationError);
  assertEquals(down.stub.calls.length, 1, "backed off");
  await assertRejects(() => down.run(NOW + FAILURE_BACKOFF_MS + 1), RevocationError);
  assertEquals(down.stub.calls.length, 2);
});

Deno.test("crl: best-effort warns once per distribution point", async () => {
  const s = await setup();
  const warnings: string[] = [];
  const check = cache("best-effort", stubFetch({}).fetch, warnings);
  const cert = { serial: Uint8Array.of(s.serial), issuer: new Uint8Array(), crlUrls: [CRL_URL] };
  await check.check(cert, new Uint8Array(), NOW);
  await check.check(cert, new Uint8Array(), NOW + FAILURE_BACKOFF_MS + 1);
  assertEquals(warnings.length, 1);
});

// ---- the MDS configuration -------------------------------------------------------------------

Deno.test("mds revocation: require by default, best-effort with an offline blob, validated", () => {
  assertEquals(resolveMds({})?.revocation, "require");
  assertEquals(resolveMds({ blob: "x" })?.revocation, "best-effort");
  assertEquals(resolveMds({ blob: "x" }, "hard")?.revocation, "require");
  assertEquals(resolveMds({ blob: "x", revocation: "require" })?.revocation, "require");
  assertEquals(resolveMds({ revocation: "off" })?.revocation, "off");
  let threw = false;
  try {
    resolveMds({ revocation: "sometimes" as never });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("mds revocation: a BLOB signed by a revoked certificate is refused", async () => {
  const pki = await testPki();
  const signer = await testKey();
  const leaf = await makeCert({
    subject: "MDS Signer",
    key: signer,
    issuer: { cn: INTERMEDIATE, key: pki.intermediateKey },
    dns: ["mds.fidoalliance.org"],
    crlUrls: [CRL_URL],
    serial: 99,
  });
  const jwt = await signBlob(
    { no: 1, nextUpdate: new Date(NOW + 10 * DAY).toISOString().slice(0, 10), entries: [] },
    signer,
    [leaf, pki.intermediate],
  );
  const issuer = { cn: INTERMEDIATE, key: pki.intermediateKey };
  const mds = (bodies: Record<string, Uint8Array>): ResolvedMds => ({
    ...resolveMds({ revocation: "require" })!,
    roots: [pki.root],
    fetch: stubFetch(bodies).fetch,
  });
  const good = mds({ [CRL_URL]: await makeCrl({ issuer, revoked: [] }) });
  assertEquals((await verifyMdsBlob(jwt, good.roots, NOW, revocationCheckOf(good))).no, 1);
  const bad = mds({ [CRL_URL]: await makeCrl({ issuer, revoked: [99] }) });
  await assertRejects(() => verifyMdsBlob(jwt, bad.roots, NOW, revocationCheckOf(bad)));
});

Deno.test("mds revocation: an attestation whose x5c holds a revoked certificate is refused", async () => {
  const pki = await testPki();
  const signer = await testKey();
  const blobLeaf = await makeCert({
    subject: "MDS Signer",
    key: signer,
    issuer: { cn: INTERMEDIATE, key: pki.intermediateKey },
    dns: ["mds.fidoalliance.org"],
  });
  const aaguid = "0123456789abcdef0123456789abcdef";
  const jwt = await signBlob(
    {
      no: 1,
      nextUpdate: new Date(NOW + 10 * DAY).toISOString().slice(0, 10),
      entries: [{
        aaguid: `${aaguid.slice(0, 8)}-${aaguid.slice(8, 12)}-${aaguid.slice(12, 16)}-${
          aaguid.slice(16, 20)
        }-${aaguid.slice(20)}`,
        metadataStatement: { attestationRootCertificates: [b64(pki.root)] },
        statusReports: [],
      }],
    },
    signer,
    [blobLeaf, pki.intermediate],
  );
  const { cert: attestation } = await leafOf(pki, { crlUrls: [CRL_URL], serial: 42 });
  const result = {
    aaguid: Uint8Array.from(aaguid.match(/../g)!, (h) => parseInt(h, 16)),
    attestationType: "basic" as const,
    attestationCertificates: [attestation, pki.intermediate],
  };
  const issuer = { cn: INTERMEDIATE, key: pki.intermediateKey };
  const mds = (revoked: number[]) =>
    makeCrl({ issuer, revoked }).then((crl): ResolvedMds => ({
      ...resolveMds({ blob: jwt, revocation: "require" })!,
      roots: [pki.root],
      fetch: stubFetch({ [CRL_URL]: crl }).fetch,
    }));
  await checkMdsAttestation(await mds([]), result, NOW);
  const revoked = await mds([42]);
  await assertRejects(() => checkMdsAttestation(revoked, result, NOW), Error, "revoked");
});
