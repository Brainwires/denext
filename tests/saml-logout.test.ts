// SAML Single Logout primitives: golden LogoutRequest / LogoutResponse messages signed by
// xmlsec1 (HTTP-POST) and by `openssl dgst` over a Python-built query (HTTP-Redirect), the SP's
// own signed messages, and the attacks — unsigned, bad signature, wrong destination, replay,
// expiry, a redirect query with reordered or duplicated parameters, an XML signature smuggled
// into a redirect message, comment injection, a DEFLATE bomb — each refused with its code.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildAuthnRequest,
  buildLogoutRequest,
  buildLogoutResponse,
  inMemorySamlReplayCache,
  parseIdpMetadata,
  peekLogoutMessage,
  SamlError,
  type SamlIdpConfig,
  type SamlSpConfig,
  spMetadataXml,
  type VerifyLogoutOptions,
  verifyLogoutRequest,
  verifyLogoutResponse,
} from "../packages/auth/src/saml/mod.ts";
import { ecKey, encode, IDP_ENTITY, marker, rsaKey, sign, SP, T0 } from "./_saml-helpers.ts";
import {
  IDP_SLO_URL,
  inflateParam,
  logoutRequestXml,
  logoutResponseXml,
  redirectQuery,
  RSA_SHA256,
  SLO_URL,
  spKey,
  verifySpRedirect,
} from "./_saml-enc-helpers.ts";

const FIXTURES = new URL("./fixtures/saml/", import.meta.url);
const fixture = (name: string) => Deno.readTextFileSync(new URL(name, FIXTURES));
const GOLDEN_IDP = fixture("enc-idp.crt");

const idp = await rsaKey();
const attacker = await rsaKey();
const ec = await ecKey();
const spSigning = await spKey();

const NOW = T0 + 30_000;
const SP_SLO: SamlSpConfig = { ...SP, sloUrl: SLO_URL };
const idpFor = (...certificates: string[]): SamlIdpConfig => ({
  entityId: IDP_ENTITY,
  ssoUrl: "https://idp.example.org/sso",
  sloUrl: IDP_SLO_URL,
  certificates,
});

function options(
  input: VerifyLogoutOptions["input"],
  over: Partial<VerifyLogoutOptions> = {},
): VerifyLogoutOptions {
  return {
    input,
    idp: idpFor(idp.certificate),
    sp: SP_SLO,
    replayCache: inMemorySamlReplayCache(),
    now: NOW,
    ...over,
  };
}

const post = (xml: string, extra: Record<string, string> = {}) => ({
  form: new URLSearchParams({ SAMLRequest: encode(xml), ...extra }),
});
const postResponse = (xml: string) => ({
  form: new URLSearchParams({ SAMLResponse: encode(xml) }),
});

async function refusedRequest(
  input: VerifyLogoutOptions["input"],
  code: string,
  over: Partial<VerifyLogoutOptions> = {},
) {
  const err = await assertRejects(() => verifyLogoutRequest(options(input, over)), SamlError);
  assertEquals(err.code, code, err.message);
}

/** A LogoutRequest signed (enveloped) by `key`, for the HTTP-POST binding. */
function signedRequest(over: Parameters<typeof logoutRequestXml>[0] = {}, key = idp) {
  const id = over.id ?? "_lr1";
  return sign(logoutRequestXml({ sig: marker(id), ...over }), id, { key });
}

// --- golden ----------------------------------------------------------------------------------

Deno.test("saml slo golden: an xmlsec1-signed HTTP-POST LogoutRequest verifies", async () => {
  const req = await verifyLogoutRequest(
    options(post(fixture("slo-request-post-signed.xml")), { idp: idpFor(GOLDEN_IDP) }),
  );
  assertEquals(req, {
    id: "_logout1",
    issuer: IDP_ENTITY,
    nameId: "alice@example.com",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    sessionIndexes: ["_session1"],
  });
  const forged = fixture("slo-request-post-signed.xml").replace("alice@", "mallory@");
  await refusedRequest(post(forged), "bad_signature", { idp: idpFor(GOLDEN_IDP) });
});

Deno.test("saml slo golden: openssl-signed HTTP-Redirect LogoutRequest and LogoutResponse", async () => {
  const query = fixture("slo-request-redirect.txt").trim();
  const req = await verifyLogoutRequest(options({ query }, { idp: idpFor(GOLDEN_IDP) }));
  assertEquals(req.id, "_logout2");
  assertEquals(req.relayState, "relay-1");
  assertEquals(req.sessionIndexes, ["_session1"]);
  await refusedRequest({ query: query.replace("relay-1", "relay-9") }, "bad_signature", {
    idp: idpFor(GOLDEN_IDP),
  });
  const res = await verifyLogoutResponse({
    ...options({ query: fixture("slo-response-redirect.txt").trim() }, {
      idp: idpFor(GOLDEN_IDP),
    }),
    expectedInResponseTo: "_spreq1",
  });
  assertEquals(res, {
    id: "_logoutresp1",
    inResponseTo: "_spreq1",
    success: true,
    status: "urn:oasis:names:tc:SAML:2.0:status:Success",
    relayState: "relay-2",
  });
});

// --- valid in-test messages ----------------------------------------------------------------

Deno.test("saml slo: signed requests over both bindings, with every SessionIndex", async () => {
  const xml = logoutRequestXml({ sessionIndexes: ["_s1", "_s2"] });
  const viaRedirect = await verifyLogoutRequest(
    options({ query: await redirectQuery("SAMLRequest", xml, idp, { relayState: "r & s" }) }),
  );
  assertEquals(viaRedirect.sessionIndexes, ["_s1", "_s2"]);
  assertEquals(viaRedirect.relayState, "r & s");
  const viaPost = await verifyLogoutRequest(
    options(post(await signedRequest({ sessionIndexes: [] }), { RelayState: "x" })),
  );
  assertEquals(viaPost.sessionIndexes, []);
  assertEquals(viaPost.relayState, "x");
  // ECDSA over the redirect binding, against an EC certificate.
  await verifyLogoutRequest(
    options(
      {
        query: await redirectQuery("SAMLRequest", xml, ec, {
          sigAlg: "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
        }),
      },
      { idp: idpFor(idp.certificate, ec.certificate) },
    ),
  );
  // Parameters in another order on the wire: the signed octets are rebuilt in the spec's order.
  const q = await redirectQuery("SAMLRequest", xml, idp, { relayState: "r" });
  const [msg, relay, alg, sig] = q.slice(1).split("&");
  await verifyLogoutRequest(options({ query: `?${sig}&${alg}&${relay}&${msg}&extra=1` }));
});

// --- refusals --------------------------------------------------------------------------------

Deno.test("saml slo: unsigned and wrongly signed requests are refused", async () => {
  const xml = logoutRequestXml();
  await refusedRequest(post(xml), "unsigned");
  await refusedRequest(
    { query: await redirectQuery("SAMLRequest", xml, idp, { unsigned: true }) },
    "unsigned",
  );
  await refusedRequest(post(await signedRequest({}, attacker)), "bad_signature");
  await refusedRequest(
    { query: await redirectQuery("SAMLRequest", xml, attacker) },
    "bad_signature",
  );
  // SigAlg present, Signature missing (and the reverse).
  const q = await redirectQuery("SAMLRequest", xml, idp);
  await refusedRequest({ query: q.replace(/&Signature=[^&]*/, "") }, "unsigned");
  await refusedRequest({ query: q.replace(/&SigAlg=[^&]*/, "") }, "unsigned");
  await refusedRequest({ query: q.replace(/Signature=[^&]*/, "Signature=%%") }, "bad_binding");
  await refusedRequest({ query: q.replace(/Signature=[^&]*/, "Signature=!!") }, "bad_signature");
  // A tampered message under a valid signature.
  const signed = await signedRequest();
  await refusedRequest(post(signed.replace("alice@", "mallory@")), "bad_signature");
  // RSA-SHA1 and unknown algorithms.
  await refusedRequest(
    {
      query: await redirectQuery("SAMLRequest", xml, idp, {
        sigAlg: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
      }),
    },
    "unsupported_algorithm",
  );
  await refusedRequest(
    { query: await redirectQuery("SAMLRequest", xml, idp, { sigAlg: "constructor" }) },
    "unsupported_algorithm",
  );
});

Deno.test("saml slo: a redirect signature over reordered or duplicated parameters is refused", async () => {
  const xml = logoutRequestXml();
  // Signed over RelayState-first octets: what the SP rebuilds (spec order) does not match.
  const reordered = await redirectQuery("SAMLRequest", xml, idp, {
    relayState: "r",
    signedOctets: ({ message, relay, sigAlg }) => [relay, message, sigAlg].join("&"),
  });
  await refusedRequest({ query: reordered }, "bad_signature");
  // Signed without the RelayState that travels with it.
  const withoutRelay = await redirectQuery("SAMLRequest", xml, idp, {
    relayState: "r",
    signedOctets: ({ message, sigAlg }) => [message, sigAlg].join("&"),
  });
  await refusedRequest({ query: withoutRelay }, "bad_signature");
  const q = await redirectQuery("SAMLRequest", xml, idp, { relayState: "r" });
  const [msg, relay, alg, sig] = q.slice(1).split("&");
  for (const dup of [msg, relay, alg, sig]) {
    await refusedRequest({ query: `${q}&${dup}` }, "bad_binding");
  }
  // A second copy under an encoded name is the same parameter.
  await refusedRequest({ query: `${q}&Relay%53tate=x` }, "bad_binding");
  // Both message parameters, or neither.
  await refusedRequest({ query: `${q}&SAMLResponse=AA` }, "bad_binding");
  await refusedRequest({ query: `?${relay}&${alg}&${sig}` }, "bad_binding");
  // The same over HTTP-POST.
  const form = new URLSearchParams({ SAMLRequest: encode(await signedRequest()) });
  form.append("SAMLRequest", encode(xml));
  await refusedRequest({ form }, "bad_binding");
  const both = new URLSearchParams({ SAMLRequest: "AA", SAMLResponse: "AA" });
  await refusedRequest({ form: both }, "bad_binding");
});

Deno.test("saml slo: destination, issuer, freshness and replay", async () => {
  await refusedRequest(
    post(await signedRequest({ destination: "https://evil/slo" })),
    "bad_destination",
  );
  await refusedRequest(post(await signedRequest({ destination: null })), "bad_destination");
  await refusedRequest(post(await signedRequest()), "bad_destination", { sp: SP });
  await refusedRequest(post(await signedRequest({ issuer: "https://evil" })), "bad_issuer");
  await refusedRequest(post(await signedRequest({ issuer: null })), "bad_issuer");
  // IssueInstant older than five minutes (plus skew), or in the future.
  await refusedRequest(post(await signedRequest()), "expired", { now: T0 + 361_000 });
  await verifyLogoutRequest(options(post(await signedRequest()), { now: T0 + 359_000 }));
  await refusedRequest(post(await signedRequest()), "not_yet_valid", { now: T0 - 61_000 });
  await refusedRequest(
    post(await signedRequest({ notOnOrAfter: new Date(T0 - 40_000).toISOString() })),
    "expired",
  );
  await refusedRequest(post(await signedRequest({ issueInstant: "soon" })), "malformed_response");
  // Replay: the same message id twice.
  const cache = inMemorySamlReplayCache();
  const input = post(await signedRequest());
  await verifyLogoutRequest(options(input, { replayCache: cache }));
  await refusedRequest(input, "replay", { replayCache: cache });
  // …and the same id over the other binding.
  const sameId = { query: await redirectQuery("SAMLRequest", logoutRequestXml(), idp) };
  await refusedRequest(sameId, "replay", { replayCache: cache });
  const q = { query: await redirectQuery("SAMLRequest", logoutRequestXml({ id: "_lr2" }), idp) };
  await verifyLogoutRequest(options(q, { replayCache: cache }));
  await refusedRequest(q, "replay", { replayCache: cache });
});

Deno.test("saml slo: the message itself — shape, comment injection, XML signatures, wrapping", async () => {
  await refusedRequest(
    post(await signedRequest({ nameId: "alice@example.com<!---->.evil" })),
    "unexpected_markup",
  );
  await refusedRequest(post(await signedRequest({ nameId: "" })), "malformed_response");
  await refusedRequest(
    post(await signedRequest({ sessionIndexes: ["_s<!---->1"] })),
    "unexpected_markup",
  );
  await refusedRequest(
    post(await signedRequest({ extra: `<saml:EncryptedID/>` })),
    "encrypted_assertion_unsupported",
  );
  await refusedRequest(
    post(await signedRequest({ extra: `<saml:NameID>bob@example.com</saml:NameID>` })),
    "malformed_response",
  );
  const versioned = (await signedRequest()).replace(`Version="2.0"`, `Version="1.1"`);
  await refusedRequest(post(versioned), "bad_signature");
  // A LogoutResponse where a request is expected.
  await refusedRequest(
    post(await sign(logoutResponseXml({ sig: marker("_lresp1") }), "_lresp1", { key: idp })),
    "malformed_response",
  );
  // HTTP-Redirect messages never carry an XML signature.
  const withSig = await signedRequest();
  await refusedRequest({ query: await redirectQuery("SAMLRequest", withSig, idp) }, "bad_binding");
  // Wrapping: the signed request hidden inside an evil one that reuses its signature.
  const evil = logoutRequestXml({ id: "_evil", nameId: "bob@example.com" });
  const sig = withSig.match(/<ds:Signature[\s\S]*?<\/ds:Signature>/)![0];
  await refusedRequest(
    post(evil.replace("</saml:Issuer>", `</saml:Issuer>${sig}`)),
    "signature_wrapping",
  );
  await refusedRequest(
    post(
      evil.replace("_evil", "_lr1").replace(
        "</samlp:LogoutRequest>",
        `<samlp:Extensions>${withSig}</samlp:Extensions></samlp:LogoutRequest>`,
      ).replace("</saml:Issuer>", `</saml:Issuer>${sig}`),
    ),
    "signature_wrapping",
  );
  // DOCTYPE, garbage, a DEFLATE bomb (signed, so it reaches the inflater), bad base64.
  await refusedRequest(post(`<!DOCTYPE x>${logoutRequestXml()}`), "doctype_forbidden");
  await refusedRequest({ form: new URLSearchParams({ SAMLRequest: "!!" }) }, "malformed_xml");
  const bomb = new Uint8Array(
    await new Response(
      new Blob([new Uint8Array(4 * 1024 * 1024)]).stream().pipeThrough(
        new CompressionStream("deflate-raw"),
      ),
    ).arrayBuffer(),
  );
  await refusedRequest(
    { query: await redirectQuery("SAMLRequest", "", idp, { deflated: bomb }) },
    "bad_binding",
  );
  await refusedRequest(
    { query: await redirectQuery("SAMLRequest", "", idp, { deflated: new Uint8Array([1, 2, 3]) }) },
    "malformed_xml",
  );
  await refusedRequest({ query: `?SAMLRequest=${"A".repeat(1_100_000)}` }, "bad_binding");
  await refusedRequest(
    { form: new URLSearchParams({ SAMLRequest: "A".repeat(400_000) }) },
    "malformed_xml",
  );
});

Deno.test("saml slo: LogoutResponse InResponseTo, status and replay", async () => {
  const verifyRes = (xml: string, over: Partial<VerifyLogoutOptions> = {}, expected = "_spreq1") =>
    verifyLogoutResponse({ ...options(postResponse(xml), over), expectedInResponseTo: expected });
  const signedRes = (over: Parameters<typeof logoutResponseXml>[0] = {}) =>
    sign(logoutResponseXml({ sig: marker("_lresp1"), ...over }), "_lresp1", { key: idp });
  assertEquals((await verifyRes(await signedRes())).success, true);
  const partial = await verifyRes(
    await signedRes({ status: "urn:oasis:names:tc:SAML:2.0:status:Responder" }),
  );
  assertEquals(partial.success, false);
  for (
    const xml of [
      await signedRes({ inResponseTo: "_other" }),
      await signedRes({ inResponseTo: null }),
    ]
  ) {
    const err = await assertRejects(() => verifyRes(xml), SamlError);
    assertEquals(err.code, "in_response_to_mismatch");
  }
  const cache = inMemorySamlReplayCache();
  const xml = await signedRes();
  await verifyRes(xml, { replayCache: cache });
  assertEquals(
    (await assertRejects(() => verifyRes(xml, { replayCache: cache }), SamlError)).code,
    "replay",
  );
  assertEquals(
    (await assertRejects(() => verifyRes(logoutResponseXml()), SamlError)).code,
    "unsigned",
  );
  // A request where a response is expected.
  assertEquals(
    (await assertRejects(
      () =>
        verifyLogoutResponse({
          ...options(post(logoutRequestXml())),
          input: post(logoutRequestXml({ sig: marker("_lr1") })),
          expectedInResponseTo: "_x",
        }),
      SamlError,
    )).code,
    "unsigned",
  );
  const signedRequestXml = await sign(logoutRequestXml({ sig: marker("_lr1") }), "_lr1", {
    key: idp,
  });
  assertEquals(
    (await assertRejects(
      () =>
        verifyLogoutResponse({ ...options(post(signedRequestXml)), expectedInResponseTo: "_x" }),
      SamlError,
    )).code,
    "malformed_response",
  );
});

Deno.test("saml slo: peekLogoutMessage reads kind, issuer and RelayState unverified", async () => {
  const q = await redirectQuery("SAMLResponse", logoutResponseXml(), idp, { relayState: "rs" });
  assertEquals(await peekLogoutMessage({ query: q }), {
    kind: "LogoutResponse",
    issuer: IDP_ENTITY,
    relayState: "rs",
  });
  assertEquals(await peekLogoutMessage(post(logoutRequestXml({ issuer: null }))), {
    kind: "LogoutRequest",
  });
  const err = await assertRejects(
    () =>
      peekLogoutMessage(
        post(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>`),
      ),
    SamlError,
  );
  assertEquals(err.code, "malformed_response");
});

// --- what the SP sends -----------------------------------------------------------------------

const SIGNING_SP: SamlSpConfig = {
  ...SP_SLO,
  signingKey: spSigning.pem,
  signingCertificate: spSigning.certificate,
};

Deno.test("saml slo: buildLogoutRequest is a signed HTTP-Redirect LogoutRequest", async () => {
  const { id, url } = await buildLogoutRequest({
    sp: SIGNING_SP,
    idp: { ...idpFor(idp.certificate), sloUrl: `${IDP_SLO_URL}?tenant=a` },
    nameId: "alice@example.com",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    sessionIndex: "_session1",
    relayState: "rs",
    now: T0,
  });
  assert(url.startsWith(`${IDP_SLO_URL}?tenant=a&SAMLRequest=`));
  assert(await verifySpRedirect(url, spSigning.spki));
  const u = new URL(url);
  assertEquals(u.searchParams.get("SigAlg"), RSA_SHA256);
  assertEquals(u.searchParams.get("RelayState"), "rs");
  const xml = await inflateParam(url, "SAMLRequest");
  assertStringIncludes(xml, `ID="${id}"`);
  assertStringIncludes(xml, `Destination="${IDP_SLO_URL}?tenant=a"`);
  assertStringIncludes(xml, `<saml:Issuer>${SP.entityId}</saml:Issuer>`);
  assertStringIncludes(xml, `<samlp:SessionIndex>_session1</samlp:SessionIndex>`);
  assertStringIncludes(xml, `IssueInstant="2026-10-13T12:00:00Z"`);
  // A JWK signing key works too; without a key or an IdP endpoint there is no SLO.
  const jwkUrl = (await buildLogoutRequest({
    sp: { ...SIGNING_SP, signingKey: spSigning.jwk },
    idp: idpFor(idp.certificate),
    nameId: "a",
  })).url;
  assert(await verifySpRedirect(jwkUrl, spSigning.spki));
  const noKey = await assertRejects(
    () => buildLogoutRequest({ sp: SP_SLO, idp: idpFor(idp.certificate), nameId: "a" }),
    SamlError,
  );
  assertEquals(noKey.code, "bad_key");
  const noSlo = await assertRejects(
    () =>
      buildLogoutRequest({
        sp: SIGNING_SP,
        idp: { ...idpFor(idp.certificate), sloUrl: undefined },
        nameId: "a",
      }),
    SamlError,
  );
  assertEquals(noSlo.code, "bad_metadata");
});

Deno.test("saml slo: buildLogoutResponse answers at the ResponseLocation, signed", async () => {
  const url = await buildLogoutResponse({
    sp: SIGNING_SP,
    idp: { ...idpFor(idp.certificate), sloResponseUrl: "https://idp.example.org/slo/response" },
    inResponseTo: "_logout1",
    relayState: "back",
  });
  assert(url.startsWith("https://idp.example.org/slo/response?SAMLResponse="));
  assert(await verifySpRedirect(url, spSigning.spki));
  const xml = await inflateParam(url, "SAMLResponse");
  assertStringIncludes(xml, `InResponseTo="_logout1"`);
  assertStringIncludes(xml, `Value="urn:oasis:names:tc:SAML:2.0:status:Success"`);
  const err = await assertRejects(
    () =>
      buildLogoutResponse({
        sp: SIGNING_SP,
        idp: { ...idpFor(idp.certificate), sloUrl: undefined },
        inResponseTo: "_x",
      }),
    SamlError,
  );
  assertEquals(err.code, "bad_metadata");
});

Deno.test("saml slo: AuthnRequests are signed when the SP has a signing key", async () => {
  const { url } = await buildAuthnRequest({
    sp: SIGNING_SP,
    idp: idpFor(idp.certificate),
    relayState: "x",
  });
  assert(await verifySpRedirect(url, spSigning.spki));
  const unsigned = await buildAuthnRequest({ sp: SP, idp: idpFor(idp.certificate) });
  assertEquals(new URL(unsigned.url).searchParams.has("Signature"), false);
});

Deno.test("saml slo: SP metadata advertises SLO and the signing certificate; IdP SLO parsed", () => {
  const xml = spMetadataXml(SIGNING_SP);
  assertStringIncludes(xml, `AuthnRequestsSigned="true"`);
  assertStringIncludes(xml, `<md:KeyDescriptor use="signing">`);
  assertStringIncludes(
    xml,
    `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SLO_URL}"/>`,
  );
  assertStringIncludes(
    xml,
    `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${SLO_URL}"/>`,
  );
  const idpMeta =
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP_ENTITY}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${idp.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp/post"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp/slo" ResponseLocation="https://idp/slo-resp"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  const parsed = parseIdpMetadata(idpMeta);
  assertEquals(parsed.sloUrl, "https://idp/slo");
  assertEquals(parsed.sloResponseUrl, "https://idp/slo-resp");
});
