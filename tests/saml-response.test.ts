// verifySamlResponse: golden Responses signed by xmlsec1 (an independent XML-DSig
// implementation), in-test signed Responses, and the known SAML attack classes — signature
// wrapping (XSW1–XSW8), comment injection, key confusion, algorithm downgrade, DOCTYPE/XXE,
// replay and every condition check — each refused with its stable code.

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  inMemorySamlReplayCache,
  SamlError,
  type SamlReplayCache,
  verifySamlResponse,
  type VerifySamlResponseOptions,
} from "../packages/auth/src/saml/mod.ts";
import {
  directSignature,
  indexIds,
  verifyEnvelopedSignature,
} from "../packages/auth/src/saml/dsig.ts";
import { parseXml, type XmlElement } from "../packages/auth/src/saml/xml.ts";
import {
  ALG,
  ecKey,
  encode,
  IDP_ENTITY,
  marker,
  NOW,
  responseXml,
  rsaKey,
  sign,
  type SignOptions,
  SP,
  T0,
  type TestKey,
} from "./_saml-helpers.ts";

const rsa = await rsaKey();
const rsa512 = await rsaKey("SHA-512");
const ec = await ecKey();
const ec384 = await ecKey("P-384");
const attacker = await rsaKey();

const FIXTURES = new URL("./fixtures/saml/", import.meta.url);
const fixture = (name: string) => Deno.readTextFileSync(new URL(name, FIXTURES));
const GOLDEN_RSA = fixture("idp-rsa.crt");
const GOLDEN_EC = fixture("idp-ec.crt");

const idpFor = (...certificates: string[]) => ({
  entityId: IDP_ENTITY,
  ssoUrl: "https://idp.example.org/sso",
  certificates,
});

function verify(xml: string, over: Partial<VerifySamlResponseOptions> = {}) {
  return verifySamlResponse({
    samlResponse: encode(xml),
    idp: idpFor(rsa.certificate),
    sp: SP,
    replayCache: inMemorySamlReplayCache(),
    now: NOW,
    expectedInResponseTo: "_req1",
    ...over,
  });
}

async function refused(xml: string, code: string, over: Partial<VerifySamlResponseOptions> = {}) {
  const err = await assertRejects(() => verify(xml, over), SamlError);
  assertEquals(err.code, code, err.message);
}

/** A Response whose Assertion is signed by `key` (the default fixture shape). */
function signedAssertion(
  fields: Parameters<typeof responseXml>[0] = {},
  options: Partial<SignOptions> = {},
): Promise<string> {
  return sign(responseXml(fields), "_assert1", { key: rsa, ...options });
}

/** A Response signed (only) at the Response level. */
function signedResponse(fields: Parameters<typeof responseXml>[0] = {}, key: TestKey = rsa) {
  return sign(
    responseXml({ responseSig: marker("_resp1"), assertionSig: "", ...fields }),
    "_resp1",
    { key },
  );
}

const ASSERTION_OPEN = "<saml:Assertion";
const ASSERTION_CLOSE = "</saml:Assertion>";

function assertionOf(xml: string): string {
  return xml.slice(
    xml.indexOf(ASSERTION_OPEN),
    xml.indexOf(ASSERTION_CLOSE) + ASSERTION_CLOSE.length,
  );
}
const stripSig = (s: string) => s.replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, "");
const forge = (s: string) =>
  s.replace("alice@example.com</saml:NameID>", "attacker@evil.com</saml:NameID>");
const responseOf = (xml: string) => xml.slice(xml.indexOf("<samlp:Response"));

// --- golden fixtures (xmlsec1) -------------------------------------------------------------

const GOLDEN_CLAIMS = {
  issuer: IDP_ENTITY,
  assertionId: "_assert1",
  nameId: "alice@example.com",
  nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  sessionIndex: "_session1",
  inResponseTo: "_req1",
  notOnOrAfter: (T0 + 300_000) / 1000,
  attributes: {
    email: ["alice@example.com"],
    groups: ["admins", 'R&D <team> "q" \ttab'],
    "display name": ["Alice Ålesund 𝔄"],
  },
};

for (
  const [name, certs] of [
    ["rsa-assertion-signed.xml", [GOLDEN_RSA]],
    ["rsa-response-signed.xml", [GOLDEN_RSA]],
    ["rsa-both-signed.xml", [GOLDEN_RSA]],
    ["ec-assertion-signed.xml", [GOLDEN_RSA, GOLDEN_EC]],
  ] as const
) {
  Deno.test(`saml golden: ${name} (signed by xmlsec1) verifies`, async () => {
    const claims = await verify(fixture(name), { idp: idpFor(...certs) });
    assertEquals(claims, GOLDEN_CLAIMS);
  });
}

Deno.test("saml golden: a one-byte change to an xmlsec1 fixture is refused", async () => {
  const xml = fixture("rsa-assertion-signed.xml").replace(
    "alice@example.com</saml:NameID>",
    "alicf@example.com</saml:NameID>",
  );
  await refused(xml, "bad_signature", { idp: idpFor(GOLDEN_RSA) });
  const resp = fixture("rsa-response-signed.xml").replace("_session1", "_session2");
  await refused(resp, "bad_signature", { idp: idpFor(GOLDEN_RSA) });
});

Deno.test("saml golden: the wrong configured certificate is refused", async () => {
  await refused(fixture("rsa-assertion-signed.xml"), "bad_signature", { idp: idpFor(GOLDEN_EC) });
  await refused(fixture("ec-assertion-signed.xml"), "bad_signature", { idp: idpFor(GOLDEN_RSA) });
});

Deno.test("saml golden: requireSignedAssertion refuses a Response-only signature", async () => {
  await refused(fixture("rsa-response-signed.xml"), "unsigned", {
    idp: idpFor(GOLDEN_RSA),
    requireSignedAssertion: true,
  });
  await verify(fixture("rsa-both-signed.xml"), {
    idp: idpFor(GOLDEN_RSA),
    requireSignedAssertion: true,
  });
});

// --- valid, in-test signed -----------------------------------------------------------------

Deno.test("saml: a signed Assertion verifies and yields its claims", async () => {
  const claims = await verify(await signedAssertion());
  assertEquals(claims.nameId, "alice@example.com");
  assertEquals(claims.attributes, { email: ["alice@example.com"], groups: ["admins", "staff"] });
  assertEquals(claims.inResponseTo, "_req1");
  assertEquals(claims.notOnOrAfter, (T0 + 300_000) / 1000);
});

Deno.test("saml: a signed Response with an unsigned Assertion verifies", async () => {
  const claims = await verify(await signedResponse());
  assertEquals(claims.assertionId, "_assert1");
});

Deno.test("saml: both signed, RSA-SHA512, ECDSA P-256/P-384, InclusiveNamespaces", async () => {
  const both = await sign(
    await signedAssertion({ responseSig: marker("_resp1") }),
    "_resp1",
    { key: rsa },
  );
  await verify(both);
  await verify(
    await signedAssertion({}, {
      key: rsa512,
      signatureAlgorithm: ALG.rsaSha512,
      digestAlgorithm: ALG.sha512,
    }),
    { idp: idpFor(rsa512.certificate) },
  );
  await verify(await signedAssertion({}, { key: ec }), {
    idp: idpFor(rsa.certificate, ec.certificate),
  });
  await verify(await signedAssertion({}, { key: ec384 }), { idp: idpFor(ec384.certificate) });
  // xsi:type="xs:string" needs xs in scope: declared on the Response, pulled in by PrefixList.
  const typed = responseXml({
    assertionTail:
      `<saml:AttributeStatement><saml:Attribute Name="typed"><saml:AttributeValue xsi:type="xs:string">v</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`,
  }).replace(
    "<samlp:Response ",
    `<samlp:Response xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `,
  );
  const claims = await verify(await sign(typed, "_assert1", { key: rsa, prefixList: "xs xsi" }));
  assertEquals(claims.attributes.typed, ["v"]);
});

Deno.test("saml: a key rollover list tries every configured certificate", async () => {
  await verify(await signedAssertion(), {
    idp: idpFor(attacker.certificate, `\n${pem(rsa.certificate)}\n`),
  });
});

function pem(b64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END CERTIFICATE-----`;
}

Deno.test("saml: #WithComments c14n is accepted; comments never enter the digest", async () => {
  const xml = await signedAssertion(
    { assertionTail: "<!-- note -->" },
    {
      canonicalization: ALG.excC14nComments,
      transforms:
        `<ds:Transform Algorithm="${ALG.enveloped}"/><ds:Transform Algorithm="${ALG.excC14nComments}"/>`,
    },
  );
  await verify(xml);
  // Adding or removing a comment inside the signed Assertion leaves the digest unchanged.
  await verify(xml.replace("<!-- note -->", "<!-- other -->"));
});

Deno.test("saml: multi-valued, merged and structured attributes", async () => {
  const claims = await verify(
    await signedAssertion({
      assertionTail: `<saml:AttributeStatement>` +
        `<saml:Attribute Name="groups"><saml:AttributeValue>  ops </saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="eptid"><saml:AttributeValue><saml:NameID>x</saml:NameID></saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="__proto__"><saml:AttributeValue/></saml:Attribute>` +
        `</saml:AttributeStatement>`,
    }),
  );
  assertEquals(claims.attributes.groups, ["admins", "staff", "ops"]);
  assertEquals(claims.attributes.eptid, []);
  assertEquals(Object.getOwnPropertyDescriptor(claims.attributes, "__proto__")?.value, [""]);
  assertEquals(Object.getPrototypeOf(claims.attributes), Object.prototype);
});

Deno.test("saml: an Attribute without a Name is refused", async () => {
  await refused(
    await signedAssertion({
      assertionTail:
        `<saml:AttributeStatement><saml:Attribute><saml:AttributeValue>x</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`,
    }),
    "malformed_response",
  );
});

// --- signature wrapping --------------------------------------------------------------------

async function xswVariants(): Promise<
  Record<string, { xml: string; level: "response" | "assertion" }>
> {
  const s = await signedAssertion();
  const a = assertionOf(s);
  const evil = forge(stripSig(a));
  const evilNewId = evil.replace(`ID="_assert1"`, `ID="_evil"`);
  const r = responseOf(await signedResponse());
  const evilR = forge(r.replace(`ID="_resp1"`, `ID="_evil"`));
  const close = "</samlp:Response>";
  return {
    // Response-level: the original Response hidden inside / beside the attacker's Response.
    XSW1: {
      xml: evilR.replace("</ds:Signature>", `<ds:Object>${r}</ds:Object></ds:Signature>`),
      level: "response",
    },
    XSW2: { xml: evilR.replace("<ds:Signature", `${r}<ds:Signature`), level: "response" },
    // Assertion-level permutations.
    XSW3: { xml: s.replace(a, evilNewId + a), level: "assertion" },
    XSW3_sameId: { xml: s.replace(a, evil + a), level: "assertion" },
    XSW4: {
      xml: s.replace(a, evilNewId.replace(/<\/saml:Assertion>$/, a + ASSERTION_CLOSE)),
      level: "assertion",
    },
    XSW5: { xml: s.replace(a, forge(a)).replace(close, stripSig(a) + close), level: "assertion" },
    XSW6: {
      xml: s.replace(
        a,
        forge(a).replace("</ds:Signature>", `<ds:Object>${a}</ds:Object></ds:Signature>`),
      ),
      level: "assertion",
    },
    XSW7: {
      xml: s.replace(a, evilNewId).replace(
        "<samlp:Status>",
        `<samlp:Extensions>${a}</samlp:Extensions><samlp:Status>`,
      ),
      level: "assertion",
    },
    XSW8: {
      xml: s.replace(
        a,
        forge(a).replace("</ds:Signature>", `<ds:Object>${stripSig(a)}</ds:Object></ds:Signature>`),
      ),
      level: "assertion",
    },
  };
}

/** What the dsig layer alone says about the element a naive reader would take. */
async function dsigVerdict(xml: string, level: "response" | "assertion"): Promise<string> {
  try {
    const doc = parseXml(xml);
    const target = level === "response"
      ? doc.root
      : doc.root.children.find((c): c is XmlElement =>
        c.type === "element" && c.local === "Assertion"
      )!;
    const sig = directSignature(target);
    if (!sig) return "unsigned";
    await verifyEnvelopedSignature(indexIds(doc), target, sig, [rsa.certificate]);
    return "ok";
  } catch (err) {
    return (err as SamlError).code;
  }
}

Deno.test("saml XSW1–XSW8: every wrapping permutation is refused", async () => {
  for (const [name, { xml, level }] of Object.entries(await xswVariants())) {
    await refused(xml, "multiple_assertions");
    // Even without the assertion count, the element read is never a verified one.
    const verdict = await dsigVerdict(xml, level);
    assertNotEquals(verdict, "ok", name);
    assertEquals(
      ["signature_wrapping", "bad_signature", "unsigned"].includes(verdict),
      true,
      `${name}: ${verdict}`,
    );
  }
});

Deno.test("saml XSW: single-assertion wrapping is refused as signature_wrapping", async () => {
  const r = responseOf(await signedResponse());
  const hidden = r.replace(assertionOf(r), "");
  const evilR = forge(r.replace(`ID="_resp1"`, `ID="_evil"`));
  await refused(
    evilR.replace("</ds:Signature>", `<ds:Object>${hidden}</ds:Object></ds:Signature>`),
    "signature_wrapping",
  );
  // A Reference that names another element.
  await refused(await signedAssertion({}, { uri: "#_resp1" }), "signature_wrapping");
  await refused(await signedAssertion({}, { uri: "" }), "signature_wrapping");
  await refused(await signedAssertion({}, { uri: "_assert1" }), "signature_wrapping");
  // A decoy element carrying the signed ID.
  await refused(
    await signedAssertion({
      responseExtra: `<samlp:Extensions><e:x xmlns:e="urn:e" ID="_assert1"/></samlp:Extensions>`,
    }),
    "signature_wrapping",
  );
  await refused(
    (await signedAssertion()).replace(`ID="_resp1"`, `ID="_assert1"`),
    "signature_wrapping",
  );
  await refused(
    await signedAssertion({
      responseExtra: `<samlp:Extensions><e:x xmlns:e="urn:e" Id="d" id="d"/></samlp:Extensions>`,
    }),
    "signature_wrapping",
  );
  // Two signatures on one element.
  const s = await signedAssertion();
  const sig = s.match(/<ds:Signature[\s\S]*?<\/ds:Signature>/)![0];
  await refused(s.replace(sig, sig + sig), "signature_wrapping");
  // The signed element's ID must be an NCName.
  await refused(
    await sign(responseXml({ assertionId: "1bad", assertionSig: marker("1bad") }), "1bad", {
      key: rsa,
    }),
    "signature_wrapping",
  );
});

Deno.test("saml: verifyEnvelopedSignature refuses a signature that is not the element's child", async () => {
  const doc = parseXml(await signedAssertion());
  const assertion = doc.root.children.find((c): c is XmlElement =>
    c.type === "element" && c.local === "Assertion"
  )!;
  const err = await assertRejects(
    () =>
      verifyEnvelopedSignature(indexIds(doc), doc.root, directSignature(assertion)!, [
        rsa.certificate,
      ]),
    SamlError,
  );
  assertEquals(err.code, "signature_wrapping");
});

Deno.test("saml: an Assertion in Extensions or Advice is refused", async () => {
  const s = await signedAssertion();
  const a = assertionOf(s);
  await refused(
    s.replace(
      "<samlp:Status>",
      `<samlp:Extensions>${
        stripSig(a).replace(`"_assert1"`, `"_x"`)
      }</samlp:Extensions><samlp:Status>`,
    ),
    "multiple_assertions",
  );
  await refused(
    await signedAssertion({
      assertionTail: `<saml:Advice>${stripSig(a).replace(`"_assert1"`, `"_x"`)}</saml:Advice>`,
    }),
    "multiple_assertions",
  );
  // The only Assertion, but not where a Response signature vouches for it.
  await refused(
    s.replace(a, "").replace(
      "<samlp:Status>",
      `<samlp:Extensions>${a}</samlp:Extensions><samlp:Status>`,
    ),
    "malformed_response",
  );
  await refused(s.replace(a, ""), "malformed_response");
});

Deno.test("saml: two Assertions are refused", async () => {
  const s = await signedAssertion();
  const a = assertionOf(s);
  await refused(
    s.replace(a, a + stripSig(a).replace(`"_assert1"`, `"_assert2"`)),
    "multiple_assertions",
  );
});

// --- comment injection ---------------------------------------------------------------------

Deno.test("saml: comment injection in NameID / Issuer / Audience / AttributeValue is refused", async () => {
  // Each is validly signed: comments are not covered by the digest, which is the whole point.
  await refused(
    await signedAssertion({ nameId: "alice@example.com<!---->.evil.com" }),
    "unexpected_markup",
  );
  await refused(
    await signedAssertion({ nameId: "alice<!-- x -->@example.com" }),
    "unexpected_markup",
  );
  await refused(await signedAssertion({ nameId: "alice<b>x</b>" }), "unexpected_markup");
  await refused(await signedAssertion({ issuer: `${IDP_ENTITY}<!---->` }), "unexpected_markup");
  await refused(await signedAssertion({ audience: `${SP.entityId}<!---->` }), "unexpected_markup");
  await refused(
    await signedAssertion({
      assertionTail:
        `<saml:AttributeStatement><saml:Attribute Name="role"><saml:AttributeValue>user<!---->admin</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`,
    }),
    "unexpected_markup",
  );
});

// --- key and signature integrity -----------------------------------------------------------

Deno.test("saml: unsigned, wrong key, KeyInfo-swapped and tampered Responses are refused", async () => {
  await refused(responseXml({ assertionSig: "" }), "unsigned");
  await refused(await signedAssertion({}, { key: attacker }), "bad_signature");
  // The attacker's certificate in KeyInfo is never consulted.
  await refused(
    await signedAssertion({}, { key: attacker, keyInfoCertificate: attacker.certificate }),
    "bad_signature",
  );
  const s = await signedAssertion();
  await refused(
    s.replace("alice@example.com</saml:NameID>", "mallory@example.com</saml:NameID>"),
    "bad_signature",
  );
  await refused(s.replace("_session1", "_session9"), "bad_signature");
  const digest = s.match(/<ds:DigestValue>([^<]+)</)![1];
  const flipped = (digest[0] === "A" ? "B" : "A") + digest.slice(1);
  await refused(s.replace(digest, flipped), "bad_signature");
  await refused(s.replace(digest, "!!"), "bad_signature");
  const value = s.match(/<ds:SignatureValue>([^<]+)</)![1];
  await refused(s.replace(value, (value[0] === "A" ? "B" : "A") + value.slice(1)), "bad_signature");
  await refused(s.replace(value, "@@"), "bad_signature");
  // An ECDSA signature against an RSA-only trust list, and an RSA key claimed as ECDSA.
  await refused(await signedAssertion({}, { key: ec }), "bad_signature");
  await refused(
    await signedAssertion({}, { key: rsa, signatureAlgorithm: ALG.ecdsaSha256 }),
    "bad_signature",
  );
});

Deno.test("saml: malformed Signature structures are refused", async () => {
  const s = await signedAssertion();
  const sigValue = s.match(/<ds:SignatureValue>[^<]+<\/ds:SignatureValue>/)![0];
  await refused(s.replace(sigValue, ""), "bad_signature");
  await refused(s.replace(sigValue, sigValue + "<ds:Bogus/>"), "bad_signature");
  await refused(s.replace(sigValue, sigValue + "<x:KeyInfo xmlns:x='urn:x'/>"), "bad_signature");
  await refused(s.replace("<ds:SignedInfo>", "<ds:SignedInfo>text"), "bad_signature");
  const ref = s.match(/<ds:Reference[\s\S]*?<\/ds:Reference>/)![0];
  await refused(s.replace(ref, ref + ref), "bad_signature");
  await refused(s.replace(/<ds:SignatureMethod[^>]*\/>/, ""), "bad_signature");
  await refused(s.replace(/<ds:DigestMethod[^>]*\/>/, ""), "bad_signature");
  await refused(s.replace(/<ds:Transforms>[\s\S]*?<\/ds:Transforms>/, ""), "bad_signature");
  await refused(
    s.replace("<ds:Transforms>", `<ds:Transforms><e:t xmlns:e="urn:e"/>`),
    "bad_signature",
  );
  await refused(s.replace(/<ds:DigestValue>/, "<ds:DigestValue><!---->"), "bad_signature");
});

// --- algorithm allow-list ------------------------------------------------------------------

Deno.test("saml: algorithms outside the allow-list are refused", async () => {
  const t = (algs: string[], inner = "") =>
    algs.map((a) => `<ds:Transform Algorithm="${a}">${inner}</ds:Transform>`).join("");
  const XPATH = "http://www.w3.org/TR/1999/REC-xpath-19991116";
  const XSLT = "http://www.w3.org/TR/1999/REC-xslt-19991116";
  const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  const cases: Partial<SignOptions>[] = [
    { signatureAlgorithm: ALG.rsaSha1 },
    { signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#hmac-sha1" },
    { digestAlgorithm: ALG.sha1 },
    // Inherited object keys are not algorithms.
    { signatureAlgorithm: "constructor" },
    { digestAlgorithm: "toString" },
    { signatureAlgorithm: "" },
    { canonicalization: C14N },
    { transforms: t([ALG.enveloped, XPATH, ALG.excC14n]) },
    { transforms: t([ALG.enveloped, XSLT]) },
    { transforms: t([ALG.enveloped]) },
    { transforms: t([ALG.excC14n, ALG.enveloped]) },
    { transforms: t([ALG.enveloped, C14N]) },
    {
      transforms:
        `<ds:Transform Algorithm="${ALG.enveloped}"><ds:XPath>x</ds:XPath></ds:Transform>` +
        t([ALG.excC14n]),
    },
    { transforms: t([ALG.enveloped]) + t([ALG.excC14n], `<ds:XPath>x</ds:XPath>`) },
  ];
  for (const options of cases) {
    await refused(await signedAssertion({}, options), "unsupported_algorithm");
  }
  const s = await signedAssertion();
  await refused(
    s.replace(
      /(<ds:SignatureMethod[^>]*)\/>/,
      `$1><ds:HMACOutputLength>8</ds:HMACOutputLength></ds:SignatureMethod>`,
    ),
    "unsupported_algorithm",
  );
  await refused(
    s.replace(/(<ds:DigestMethod[^>]*)\/>/, `$1><e:p xmlns:e="urn:e"/></ds:DigestMethod>`),
    "unsupported_algorithm",
  );
  await refused(
    s.replace(
      `<ds:CanonicalizationMethod Algorithm="${ALG.excC14n}"/>`,
      `<ds:CanonicalizationMethod Algorithm="${ALG.excC14n}"><e:p xmlns:e="urn:e"/></ds:CanonicalizationMethod>`,
    ),
    "unsupported_algorithm",
  );
});

// --- XML hazards and envelope --------------------------------------------------------------

Deno.test("saml: DOCTYPE / XXE / billion laughs and garbage input are refused", async () => {
  const body = (await signedAssertion()).replace(/^<\?xml[^>]*>\n/, "");
  await refused(
    `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>${body}`,
    "doctype_forbidden",
  );
  await refused(
    `<!DOCTYPE r [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>${body}`,
    "doctype_forbidden",
  );
  await assertRejects(
    () =>
      verifySamlResponse({
        samlResponse: "not base64!",
        idp: idpFor(rsa.certificate),
        sp: SP,
        replayCache: inMemorySamlReplayCache(),
      }),
    SamlError,
    "base64",
  );
  const huge = "A".repeat(400_000);
  const err = await assertRejects(
    () =>
      verifySamlResponse({
        samlResponse: huge,
        idp: idpFor(rsa.certificate),
        sp: SP,
        replayCache: inMemorySamlReplayCache(),
      }),
    SamlError,
  );
  assertEquals(err.code, "malformed_xml");
  await refused(
    `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>`,
    "malformed_response",
  );
  await refused(
    (await signedAssertion()).replace(`Version="2.0" IssueInstant`, `Version="1.1" IssueInstant`),
    "malformed_response",
  );
});

Deno.test("saml: a non-success Status and EncryptedAssertion are refused", async () => {
  await refused(
    await signedAssertion({ status: "urn:oasis:names:tc:SAML:2.0:status:Requester" }),
    "status_not_success",
  );
  await refused(
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r" Version="2.0"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"/></samlp:Status></samlp:Response>`,
    "status_not_success",
  );
  await refused(
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r" Version="2.0"/>`,
    "malformed_response",
  );
  const enc =
    `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedAssertion>`;
  await refused(await signedAssertion({ responseTail: enc }), "encrypted_assertion_unsupported");
  const s = await signedAssertion();
  await refused(s.replace(assertionOf(s), enc), "encrypted_assertion_unsupported");
  await refused(
    s.replace(
      /<saml:NameID[^>]*>[^<]*<\/saml:NameID>/,
      `<saml:EncryptedID><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedID>`,
    ),
    "encrypted_assertion_unsupported",
  );
});

// --- conditions ----------------------------------------------------------------------------

const at = (ms: number) => new Date(ms).toISOString();

Deno.test("saml: validity windows (with clock skew) are enforced", async () => {
  const s = await signedAssertion();
  // NotOnOrAfter = T0+300s, skew 60s.
  await verify(s, { now: T0 + 359_999 });
  await refused(s, "expired", { now: T0 + 360_000 });
  await refused(s, "expired", { now: T0 + 301_000, clockSkewSeconds: 0 });
  // NotBefore = T0-30s (IssueInstant moved earlier so it is not the binding check).
  const early = await signedAssertion({ issueInstant: at(T0 - 60_000) });
  await verify(early, { now: T0 - 90_000 });
  await refused(early, "not_yet_valid", { now: T0 - 90_001 });
  await refused(await signedAssertion({ notBefore: at(T0 + 200_000) }), "not_yet_valid");
  await refused(await signedAssertion({ confirmationNotOnOrAfter: at(T0) }), "expired");
  await refused(await signedAssertion({ sessionNotOnOrAfter: at(T0) }), "expired");
  await refused(await signedAssertion({ issueInstant: at(T0 + 600_000) }), "not_yet_valid");
  await refused(await signedAssertion({ notOnOrAfter: "yesterday" }), "malformed_response");
  await refused(
    await signedAssertion({ notOnOrAfter: "2026-13-45T99:99:99Z" }),
    "malformed_response",
  );
  await verify(await signedAssertion({ notOnOrAfter: "2026-10-13T12:05:00.5+00:00" }));
});

Deno.test("saml: the confirmation's own window, NotBefore and NotOnOrAfter", async () => {
  const tmpl = responseXml().replace(
    /(<saml:SubjectConfirmationData[^>]*) NotOnOrAfter="[^"]*"/,
    "$1",
  );
  await refused(await sign(tmpl, "_assert1", { key: rsa }), "malformed_response");
  const future = responseXml().replace(
    "<saml:SubjectConfirmationData ",
    `<saml:SubjectConfirmationData NotBefore="${at(T0 + 600_000)}" `,
  );
  await refused(await sign(future, "_assert1", { key: rsa }), "not_yet_valid");
});

Deno.test("saml: audience, recipient, destination, issuer and confirmation method", async () => {
  await refused(await signedAssertion({ audience: "https://other.example.com" }), "bad_audience");
  const noRestriction = responseXml().replace(
    /<saml:AudienceRestriction>[\s\S]*?<\/saml:AudienceRestriction>/,
    "",
  );
  await refused(await sign(noRestriction, "_assert1", { key: rsa }), "bad_audience");
  const twoRestrictions = responseXml().replace(
    "</saml:Conditions>",
    `<saml:AudienceRestriction><saml:Audience>https://other.example.com</saml:Audience></saml:AudienceRestriction></saml:Conditions>`,
  );
  await refused(await sign(twoRestrictions, "_assert1", { key: rsa }), "bad_audience");
  await refused(
    await signedAssertion({ recipient: "https://evil.example.com/acs" }),
    "bad_recipient",
  );
  await refused(
    await signedAssertion({ destination: "https://evil.example.com/acs" }),
    "bad_destination",
  );
  // An unsigned Response may omit Destination; a signed one may not.
  await verify(await signedAssertion({ destination: null }));
  await refused(await signedResponse({ destination: null }), "bad_destination");
  await refused(await signedAssertion({ issuer: "https://evil.example.org" }), "bad_issuer");
  await refused(
    await signedAssertion({ responseIssuer: "https://evil.example.org" }),
    "bad_issuer",
  );
  await verify(await signedAssertion({ responseIssuer: null }));
  const formatted = responseXml().replace(
    `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>{{sig`,
    `<saml:Issuer Format="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">${IDP_ENTITY}</saml:Issuer>{{sig`,
  );
  await refused(await sign(formatted, "_assert1", { key: rsa }), "bad_issuer");
  const entityFormat = formatted.replace("nameid-format:transient", "nameid-format:entity");
  await verify(await sign(entityFormat, "_assert1", { key: rsa }));
  await refused(
    await signedAssertion({ method: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key" }),
    "bad_subject_confirmation",
  );
  // A failing bearer confirmation is reported even when a later one is not bearer.
  const second = responseXml({ recipient: "https://evil.example.com/acs" }).replace(
    "</saml:Subject>",
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:sender-vouches"/></saml:Subject>`,
  );
  await refused(await sign(second, "_assert1", { key: rsa }), "bad_recipient");
});

Deno.test("saml: structural requirements of the Assertion", async () => {
  const strip = (re: RegExp) => sign(responseXml().replace(re, ""), "_assert1", { key: rsa });
  await refused(await strip(/<saml:AuthnStatement[^>]*\/>/), "malformed_response");
  await refused(await strip(/<saml:Conditions[\s\S]*?<\/saml:Conditions>/), "malformed_response");
  await refused(await signedAssertion({ nameId: "" }), "malformed_response");
  await refused(await signedAssertion({ issuer: "" }), "bad_issuer");
  const noInstant = responseXml().replace(/(<saml:Assertion[^>]*) IssueInstant="[^"]*"/, "$1");
  await refused(await sign(noInstant, "_assert1", { key: rsa }), "malformed_response");
  const twoSubjects = responseXml().replace("</saml:Subject>", "</saml:Subject><saml:Subject/>");
  await refused(await sign(twoSubjects, "_assert1", { key: rsa }), "malformed_response");
  const noStatusCode = (await signedAssertion()).replace(/<samlp:StatusCode[^>]*\/>/, "");
  await refused(noStatusCode, "malformed_response");
});

// --- InResponseTo --------------------------------------------------------------------------

Deno.test("saml: InResponseTo semantics", async () => {
  const solicited = await signedAssertion();
  await refused(solicited, "in_response_to_mismatch", { expectedInResponseTo: "_other" });
  await refused(solicited, "in_response_to_mismatch", {
    expectedInResponseTo: null,
    allowIdpInitiated: true,
  });
  assertEquals(
    (await verify(solicited, { expectedInResponseTo: undefined })).inResponseTo,
    "_req1",
  );
  const unsolicited = await signedAssertion({ inResponseTo: null, responseInResponseTo: null });
  await refused(unsolicited, "idp_initiated_disallowed", { expectedInResponseTo: undefined });
  await refused(unsolicited, "idp_initiated_disallowed", { expectedInResponseTo: null });
  await refused(unsolicited, "in_response_to_mismatch", {
    expectedInResponseTo: "_req1",
    allowIdpInitiated: true,
  });
  const claims = await verify(unsolicited, { expectedInResponseTo: null, allowIdpInitiated: true });
  assertEquals(claims.inResponseTo, undefined);
  await verify(unsolicited, { expectedInResponseTo: undefined, allowIdpInitiated: true });
  await refused(await signedAssertion({ responseInResponseTo: "_x" }), "in_response_to_mismatch");
  // Only the Response carries it: trusted when the Response is signed, ignored when not.
  assertEquals((await verify(await signedResponse({ inResponseTo: null }))).inResponseTo, "_req1");
  const unsignedEnvelope = await signedAssertion({ inResponseTo: null });
  await refused(unsignedEnvelope, "in_response_to_mismatch");
  await refused(unsignedEnvelope, "idp_initiated_disallowed", { expectedInResponseTo: undefined });
});

// --- replay --------------------------------------------------------------------------------

Deno.test("saml: a replayed Assertion is refused the second time", async () => {
  const xml = await signedAssertion();
  const claims: [string, number][] = [];
  const inner = inMemorySamlReplayCache();
  const cache: SamlReplayCache = {
    claim(id, expiresAt) {
      claims.push([id, expiresAt]);
      return inner.claim(id, expiresAt);
    },
  };
  await verify(xml, { replayCache: cache });
  await refused(xml, "replay", { replayCache: cache });
  // Kept until NotOnOrAfter + skew.
  assertEquals(claims[0], ["_assert1", (T0 + 300_000) / 1000 + 60]);
  // An async store works too.
  const asyncCache: SamlReplayCache = { claim: () => Promise.resolve(false) };
  await refused(xml, "replay", { replayCache: asyncCache });
});

Deno.test("saml: inMemorySamlReplayCache prunes expired ids", () => {
  const cache = inMemorySamlReplayCache();
  assertEquals(cache.claim("a", 1), true);
  assertEquals(cache.claim("a", 1), false);
  assertEquals(cache.claim("b", Date.now() / 1000 + 3600), true); // prunes "a"
  assertEquals(cache.claim("a", 1), true);
  assertEquals(cache.claim("b", 0), false);
});

Deno.test("saml: an unusable configured certificate is a configuration error", async () => {
  await refused(await signedAssertion(), "bad_certificate", { idp: idpFor("not a certificate") });
});

// --- c14n tricks ---------------------------------------------------------------------------

Deno.test("saml c14n: equivalent serializations verify; meaning-changing ones are refused", async () => {
  const s = await signedAssertion();
  // Attribute order, whitespace inside tags, and redundant re-declarations are c14n no-ops.
  await verify(
    s.replace(
      `<saml:Assertion ID="_assert1" Version="2.0"`,
      `<saml:Assertion  Version="2.0"\n   ID="_assert1"`,
    ),
  );
  await verify(
    s.replace(
      "<saml:Subject>",
      `<saml:Subject xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns="">`,
    ),
  );
  // An unused namespace or an xml:* attribute OUTSIDE the signed element does not reach it
  // (exclusive c14n: neither is inherited) …
  await verify(
    s.replace("<samlp:Response ", `<samlp:Response xmlns:junk="urn:junk" xml:lang="fr" `),
  );
  // … but the same inside it changes the signed bytes.
  await refused(
    s.replace(`<saml:Assertion ID`, `<saml:Assertion xml:lang="fr" ID`),
    "bad_signature",
  );
  await refused(
    s.replace("<saml:Subject>", `<saml:Subject xml:space="preserve">`),
    "bad_signature",
  );
  // Re-binding the prefix the signed content uses to another namespace.
  await refused(
    s.replace("<saml:NameID ", `<saml:NameID xmlns:saml="urn:evil" `).replace(
      "</saml:NameID>",
      "</saml:NameID>",
    ),
    "bad_signature",
  );
  // A default namespace that an unprefixed child would pick up.
  await refused(
    s.replace("</saml:Subject>", `<Extra xmlns="urn:evil"/></saml:Subject>`),
    "bad_signature",
  );
  // Whitespace inside a value is content.
  await refused(s.replace(">alice@example.com<", "> alice@example.com<"), "bad_signature");
});

Deno.test("saml c14n: InclusiveNamespaces pulls an outer binding into the signed bytes", async () => {
  const typed = responseXml({
    assertionTail:
      `<saml:AttributeStatement><saml:Attribute Name="t"><saml:AttributeValue xsi:type="xs:string">v</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`,
  }).replace(
    "<samlp:Response ",
    `<samlp:Response xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `,
  );
  const signed = await sign(typed, "_assert1", { key: rsa, prefixList: "xs xsi" });
  await verify(signed);
  // Re-binding `xs` on the (unsigned) Response changes what xsi:type="xs:string" means: the
  // PrefixList renders xs at the signed apex, so the digest no longer matches.
  await refused(
    signed.replace(
      `xmlns:xs="http://www.w3.org/2001/XMLSchema"`,
      `xmlns:xs="urn:evil:types"`,
    ),
    "bad_signature",
  );
  // A prefix the list names but that is not in scope is simply not rendered.
  const notInScope = await sign(responseXml(), "_assert1", {
    key: rsa,
    prefixList: "nope #default",
  });
  await verify(notInScope);
});
